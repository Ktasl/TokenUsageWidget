use super::ProbeDeadline;
use std::io::{self, Read};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

// QuickJS interrupts only JavaScript, so synchronous native commands must share
// the caller's deadline too. Never log command arguments or captured output here.
pub(super) trait CommandOutput {
    fn output_before(&mut self, deadline: ProbeDeadline) -> io::Result<Output>;
}

impl CommandOutput for Command {
    fn output_before(&mut self, deadline: ProbeDeadline) -> io::Result<Output> {
        let timeout = deadline.clamp_duration(Duration::from_secs(30))
            .ok_or_else(timed_out)?;
        let end = Instant::now() + timeout;
        self.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            self.process_group(0);
        }
        let mut child = self.spawn()?;
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let out = thread::spawn(move || read_output(stdout));
        let err = thread::spawn(move || read_output(stderr));
        let mut status = None;
        let result = loop {
            if Instant::now() >= end { break Err(timed_out()); }
            if status.is_none() {
                match child.try_wait() {
                    Ok(exited) => status = exited,
                    Err(error) => break Err(error),
                }
            }
            // A parent exiting doesn't imply EOF: descendants may retain pipes.
            if let Some(status) = status {
                if out.is_finished() && err.is_finished() {
                    let stdout = out.join().unwrap_or_else(|_| Err(io::Error::other("command reader failed")));
                    let stderr = err.join().unwrap_or_else(|_| Err(io::Error::other("command reader failed")));
                    break stdout.and_then(|stdout| stderr.map(|stderr| Output { status, stdout, stderr }));
                }
            }
            thread::sleep(Duration::from_millis(5).min(end.saturating_duration_since(Instant::now())));
        };
        // Clean up the owned group even after parent exit. Never join unfinished
        // pipe readers; an optional descendant must not pin a probe worker.
        let _ = super::kill_ccusage_on_timeout(&mut child);
        let _ = child.kill();
        let _ = child.wait();
        result
    }
}

fn read_output(mut pipe: impl Read) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    pipe.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn timed_out() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "host command exceeded probe deadline")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expired_budget_never_starts_command() {
        let error = Command::new("/does/not/exist").output_before(ProbeDeadline::at(Instant::now())).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    }

    #[test]
    fn inherited_pipes_and_running_parent_both_obey_deadline_then_retry() {
        for tail in ["wait", "exit 0"] {
            let started = Instant::now();
            let error = Command::new("/bin/sh").args(["-c", &format!("sleep 20 & {tail}")])
                .output_before(ProbeDeadline::at(started + Duration::from_millis(80))).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::TimedOut);
            assert!(started.elapsed() < Duration::from_secs(1));
        }
        for value in ["91", "87"] {
            let output = Command::new("/bin/sh").args(["-c", &format!("printf {value}; printf warning >&2")])
                .output_before(ProbeDeadline::at(Instant::now() + Duration::from_secs(2))).unwrap();
            assert!(output.status.success());
            assert_eq!(output.stdout, value.as_bytes());
            assert_eq!(output.stderr, b"warning");
        }
    }

    #[test]
    fn drains_output_without_pipe_buffer_deadlock() {
        let output = Command::new("/bin/sh").args(["-c", "i=0; while [ $i -lt 10000 ]; do printf 1234567890; i=$((i+1)); done"])
            .output_before(ProbeDeadline::at(Instant::now() + Duration::from_secs(4))).unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout.len(), 100000);
    }
}
