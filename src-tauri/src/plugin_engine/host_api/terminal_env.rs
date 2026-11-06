use super::{ProbeDeadline, WHITELISTED_ENV_VARS, read_env_from_process, sanitize_env_value};
use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock, TryLockError};
use std::time::{Duration, Instant};

// The actual login shell took 13.4s before reaching our command on a cold start.
// Keep one shared capture inside the existing 30s probe, leaving quota/statistics
// to use only the remaining probe budget rather than retrying per variable.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(20);
const RETRY_DELAY: Duration = Duration::from_secs(30);
const POLL: Duration = Duration::from_millis(10);
const MAX_OUTPUT: u64 = 64 * 1024;
const START: &str = "__TOKEN_USAGE_ENV_START__";
const END: &str = "__TOKEN_USAGE_ENV_END__";

type Values = HashMap<String, Option<String>>;

// Fixed labels only: neither shell output, paths nor variable values reach errors/logs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum EnvError {
    TimedOut,
    CaptureFailed,
    InvalidOutput,
}

#[derive(Default)]
struct Snapshot {
    values: Option<Values>,
    failure: Option<(EnvError, Instant)>,
}

#[derive(Default)]
struct TerminalEnvironment(Mutex<Snapshot>);

impl TerminalEnvironment {
    fn get<F>(&self, name: &str, deadline: ProbeDeadline, capture: F) -> Result<Option<String>, EnvError>
    where
        F: FnOnce(Duration) -> Result<Values, EnvError>,
    {
        let timeout = deadline.clamp_duration(CAPTURE_TIMEOUT).ok_or(EnvError::TimedOut)?;
        let end = Instant::now() + timeout;
        // Keep the lock across capture so concurrent probes share one bounded attempt.
        let mut snapshot = loop {
            match self.0.try_lock() {
                Ok(snapshot) => break snapshot,
                Err(TryLockError::Poisoned(_)) => return Err(EnvError::CaptureFailed),
                Err(TryLockError::WouldBlock) => {
                    if Instant::now() >= end { return Err(EnvError::TimedOut); }
                    std::thread::sleep(POLL.min(end.saturating_duration_since(Instant::now())));
                }
            }
        };
        if let Some(values) = &snapshot.values {
            return Ok(values.get(name).cloned().flatten());
        }
        if let Some((error, retry_after)) = snapshot.failure {
            if Instant::now() < retry_after { return Err(error); }
        }
        let remaining = end.checked_duration_since(Instant::now()).ok_or(EnvError::TimedOut)?;
        let started = Instant::now();
        let result = capture(remaining);
        match result {
            Ok(values) => {
                let value = values.get(name).cloned().flatten();
                snapshot.values = Some(values);
                snapshot.failure = None;
                log::info!("env_capture outcome=success elapsed_ms={}", started.elapsed().as_millis());
                Ok(value)
            }
            Err(error) => {
                snapshot.failure = Some((error, Instant::now() + RETRY_DELAY));
                // The default log level is Error; retain the fixed failure reason there.
                log::error!("env_capture outcome={:?} elapsed_ms={}", error, started.elapsed().as_millis());
                Err(error)
            }
        }
    }
}

pub(super) fn resolve(name: &str, deadline: ProbeDeadline) -> Result<Option<String>, EnvError> {
    resolve_with_process(name, read_env_from_process(name), || {
        static CACHE: OnceLock<TerminalEnvironment> = OnceLock::new();
        CACHE.get_or_init(TerminalEnvironment::default).get(name, deadline, |timeout| {
            let mut command = Command::new(selected_shell(std::env::var("SHELL").ok().as_deref()));
            command.args(["-ilc", &capture_script()]);
            capture_command(&mut command, timeout)
        })
    })
}

fn resolve_with_process<F>(name: &str, value: Option<String>, fallback: F) -> Result<Option<String>, EnvError>
where F: FnOnce() -> Result<Option<String>, EnvError>,
{
    if !WHITELISTED_ENV_VARS.contains(&name) { return Ok(None); }
    if value.is_some() { return Ok(value); }
    fallback()
}

fn selected_shell(shell: Option<&str>) -> String {
    shell.map(str::trim).filter(|shell| {
        let path = std::path::Path::new(shell);
        path.is_absolute() && path.file_name().is_some_and(|name| {
            ["zsh", "bash", "fish"].iter().any(|allowed| name == *allowed)
        })
    }).unwrap_or("/bin/zsh").to_owned()
}

fn capture_script() -> String {
    let mut script = format!("printf '{START}\\000'; ");
    // Only the existing allowlist is requested. Never dump or persist the full environment.
    // Absolute printenv works on macOS 13 and avoids dependence on env -0 or shell functions.
    for name in WHITELISTED_ENV_VARS {
        // printenv returns 1 for an unset variable. Treat that as a missing value,
        // even when a login profile enables errexit, without changing its options.
        script.push_str(&format!("printf '{name}\\000'; /usr/bin/printenv {name} || :; printf '\\000'; "));
    }
    script.push_str(&format!("printf '{END}\\000'"));
    script
}

fn parse_capture(bytes: &[u8]) -> Result<Values, EnvError> {
    let start = format!("{START}\0");
    let offset = bytes.windows(start.len()).position(|part| part == start.as_bytes())
        .ok_or(EnvError::InvalidOutput)? + start.len();
    let mut fields = bytes[offset..].split(|byte| *byte == 0);
    let mut values = Values::new();
    for name in WHITELISTED_ENV_VARS {
        if fields.next() != Some(name.as_bytes()) { return Err(EnvError::InvalidOutput); }
        let raw = fields.next().ok_or(EnvError::InvalidOutput)?;
        let raw = std::str::from_utf8(raw).map_err(|_| EnvError::InvalidOutput)?;
        values.insert(name.to_owned(), sanitize_env_value(raw));
    }
    if fields.next() != Some(END.as_bytes()) || fields.next().is_none() {
        return Err(EnvError::InvalidOutput);
    }
    Ok(values)
}

fn read_capture(mut stdout: impl Read) -> Result<Values, EnvError> {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        let count = stdout.read(&mut chunk).map_err(|_| EnvError::CaptureFailed)?;
        if count == 0 { return parse_capture(&bytes); }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.len() as u64 > MAX_OUTPUT { return Err(EnvError::InvalidOutput); }
        // A complete, strictly validated frame commits the snapshot. Login-shell
        // hooks or their children can keep stdout open after the data is ready.
        if let Ok(values) = parse_capture(&bytes) { return Ok(values); }
    }
}

fn capture_command(command: &mut Command, timeout: Duration) -> Result<Values, EnvError> {
    if timeout.is_zero() { return Err(EnvError::TimedOut); }
    let end = Instant::now() + timeout;
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|_| EnvError::CaptureFailed)?;
    let stdout = child.stdout.take().ok_or(EnvError::CaptureFailed)?;
    let reader = std::thread::spawn(move || read_capture(stdout));
    let mut status = None;
    let result = loop {
        if Instant::now() >= end { break Err(EnvError::TimedOut); }
        if status.is_none() {
            match child.try_wait() {
                Ok(exited) => status = exited,
                Err(_) => break Err(EnvError::CaptureFailed),
            }
        }
        if reader.is_finished() {
            let result = reader.join().unwrap_or(Err(EnvError::CaptureFailed));
            if result.is_err() && status.is_some_and(|status| !status.success()) {
                break Err(EnvError::CaptureFailed);
            }
            break result;
        }
        std::thread::sleep(POLL.min(end.saturating_duration_since(Instant::now())));
    };
    // On success, no need to wait for shell exit or EOF. On timeout, never join an
    // unfinished reader. Both paths clean up the process group owned by this capture.
    let _ = super::kill_ccusage_on_timeout(&mut child);
    let _ = child.kill();
    let _ = child.wait();
    result
}

#[cfg(test)]
mod tests;
