use super::*;
use std::sync::{Arc, Barrier, atomic::{AtomicUsize, Ordering}};

fn values() -> Values {
    WHITELISTED_ENV_VARS.into_iter().map(|name| (name.to_owned(),
        (name == "CLAUDE_CONFIG_DIR").then(|| "/fixture/config with spaces".to_owned()))).collect()
}

fn fixture_output() -> Vec<u8> {
    let mut bytes = format!("noisy startup banner\n{START}\0").into_bytes();
    for name in WHITELISTED_ENV_VARS {
        bytes.extend_from_slice(name.as_bytes());
        bytes.push(0);
        if name == "CLAUDE_CONFIG_DIR" { bytes.extend_from_slice(b"\x1b[31m/fixture/config with spaces\x1b[0m\n"); }
        bytes.push(0);
    }
    bytes.extend_from_slice(format!("{END}\0trailing shell noise").as_bytes());
    bytes
}

fn fixture_command(script: &str) -> Command {
    // Never loads user profiles, reads real account files, or inherits login variables.
    let mut command = Command::new("/bin/sh");
    command.env_clear().env("PATH", "/usr/bin:/bin").args(["-c", script]);
    command
}

#[test]
fn capture_parses_only_complete_allowlisted_records_including_absence() {
    assert_eq!(parse_capture(&fixture_output()).unwrap(), values());
    assert_eq!(parse_capture(b"startup error without any markers"), Err(EnvError::InvalidOutput));
    let mut truncated = fixture_output();
    truncated.truncate(truncated.len() / 2);
    assert_eq!(parse_capture(&truncated), Err(EnvError::InvalidOutput));
    let wrong_key = String::from_utf8(fixture_output()).unwrap().replace("CODEX_HOME", "PRIVATE_SECRET");
    assert_eq!(parse_capture(wrong_key.as_bytes()), Err(EnvError::InvalidOutput));
    let complete = fixture_output();
    let end = complete.windows(END.len()).position(|part| part == END.as_bytes()).unwrap() + END.len();
    assert_eq!(parse_capture(&complete[..end]), Err(EnvError::InvalidOutput), "END must have its terminator");
}

#[test]
fn generated_script_captures_all_variables_in_one_hermetic_shell() {
    let mut command = fixture_command(&capture_script());
    command.env("CLAUDE_CONFIG_DIR", "/fixture/config with spaces");
    command.env("PRIVATE_SECRET", "must-never-be-captured");
    let result = capture_command(&mut command, Duration::from_secs(3)).unwrap();
    assert_eq!(result, values());
    assert!(!result.contains_key("PRIVATE_SECRET"));
}

#[test]
fn real_zsh_and_bash_handle_missing_variables_with_errexit() {
    for program in ["/bin/zsh", "/bin/bash"] {
        let mut command = Command::new(program);
        command.env_clear().env("PATH", "/usr/bin:/bin")
            .env("CLAUDE_CONFIG_DIR", "/fixture/config with spaces")
            .env("PRIVATE_SECRET", "must-never-be-captured");
        let script = format!("set -e; {}", capture_script());
        if program.ends_with("zsh") { command.args(["-dfc", &script]); }
        else { command.args(["--noprofile", "--norc", "-c", &script]); }
        assert_eq!(capture_command(&mut command, Duration::from_secs(3)).unwrap(), values());
    }
}

#[test]
fn unexported_shell_variables_do_not_change_account_identity() {
    for program in ["/bin/zsh", "/bin/bash"] {
        let mut command = Command::new(program);
        command.env_clear().env("PATH", "/usr/bin:/bin");
        let script = format!("CLAUDE_CONFIG_DIR=/fixture/not-exported; {}", capture_script());
        if program.ends_with("zsh") { command.args(["-dfc", &script]); }
        else { command.args(["--noprofile", "--norc", "-c", &script]); }
        let result = capture_command(&mut command, Duration::from_secs(3)).unwrap();
        assert_eq!(result["CLAUDE_CONFIG_DIR"], None);
    }
}

#[test]
fn slow_login_profile_over_five_seconds_serves_codex_and_claude_from_one_capture() {
    use std::fs;
    let dir = std::env::temp_dir().join(format!("token-env-slow-profile-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir_all(&dir).unwrap();
    // Only this synthetic profile is loaded; global profiles and the user's files are disabled.
    fs::write(dir.join(".zshrc"), "sleep 6\nexport CODEX_HOME='/fixture/codex'\nexport CLAUDE_CONFIG_DIR='/fixture/claude'\n").unwrap();
    let cache = Arc::new(TerminalEnvironment::default());
    let barrier = Arc::new(Barrier::new(2));
    let calls = Arc::new(AtomicUsize::new(0));
    let started = Instant::now();
    let threads: Vec<_> = ["CODEX_HOME", "CLAUDE_CONFIG_DIR"].into_iter().map(|name| {
        let (cache, barrier, calls, dir) = (cache.clone(), barrier.clone(), calls.clone(), dir.clone());
        std::thread::spawn(move || {
            barrier.wait();
            cache.get(name, ProbeDeadline::at(started + Duration::from_secs(30)), |timeout| {
                calls.fetch_add(1, Ordering::SeqCst);
                assert!(timeout > Duration::from_secs(5) && timeout <= Duration::from_secs(20));
                let mut command = Command::new("/bin/zsh");
                command.env_clear().env("PATH", "/usr/bin:/bin").env("ZDOTDIR", &dir)
                    .args(["-dilc", &capture_script()]);
                capture_command(&mut command, timeout)
            }).unwrap()
        })
    }).collect();
    let result: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(result, [Some("/fixture/codex".to_string()), Some("/fixture/claude".to_string())]);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(started.elapsed() >= Duration::from_secs(6));
    assert!(started.elapsed() < Duration::from_secs(12));
}

#[test]
fn successful_snapshot_caches_values_and_missing_keys_together() {
    let cache = TerminalEnvironment::default();
    let calls = AtomicUsize::new(0);
    for name in WHITELISTED_ENV_VARS.into_iter().cycle().take(32) {
        let result = cache.get(name, ProbeDeadline::none(), |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(values())
        }).unwrap();
        assert_eq!(result, values()[name]);
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn concurrent_missing_variables_share_one_capture() {
    let cache = Arc::new(TerminalEnvironment::default());
    let calls = Arc::new(AtomicUsize::new(0));
    let barrier = Arc::new(Barrier::new(8));
    let threads: Vec<_> = WHITELISTED_ENV_VARS.into_iter().take(8).map(|name| {
        let (cache, calls, barrier) = (cache.clone(), calls.clone(), barrier.clone());
        std::thread::spawn(move || {
            barrier.wait();
            cache.get(name, ProbeDeadline::none(), |_| {
                calls.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(40));
                Ok(values())
            }).unwrap()
        })
    }).collect();
    for thread in threads { thread.join().unwrap(); }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn failed_capture_has_cooldown_and_can_recover_without_restart() {
    let cache = TerminalEnvironment::default();
    assert_eq!(cache.get("CODEX_HOME", ProbeDeadline::none(), |_| Err(EnvError::TimedOut)), Err(EnvError::TimedOut));
    assert_eq!(cache.get("CLAUDE_CONFIG_DIR", ProbeDeadline::none(), |_| panic!("failure must not run once per variable")), Err(EnvError::TimedOut));
    let mut snapshot = cache.0.lock().unwrap();
    assert!(snapshot.values.is_none(), "failure must not cache missing settings");
    snapshot.failure.as_mut().unwrap().1 = Instant::now();
    drop(snapshot);
    assert_eq!(cache.get("CLAUDE_CONFIG_DIR", ProbeDeadline::none(), |_| Ok(values())).unwrap(), values()["CLAUDE_CONFIG_DIR"]);
}

#[test]
fn capture_budget_is_shared_and_never_extends_probe_deadline() {
    let cache = TerminalEnvironment::default();
    let end = Instant::now() + Duration::from_millis(100);
    cache.get("CODEX_HOME", ProbeDeadline::at(end), |timeout| {
        assert!(timeout <= Duration::from_millis(100));
        Ok(values())
    }).unwrap();
    let cache = TerminalEnvironment::default();
    cache.get("CODEX_HOME", ProbeDeadline::none(), |timeout| {
        assert!(timeout <= CAPTURE_TIMEOUT);
        Ok(values())
    }).unwrap();
    assert_eq!(cache.get("CODEX_HOME", ProbeDeadline::at(Instant::now()), |_| panic!("expired probe")), Err(EnvError::TimedOut));
}

#[test]
fn cold_capture_and_optional_statistics_stay_inside_the_original_probe_budget() {
    let started = Instant::now();
    let probe_end = started + Duration::from_secs(30);
    // A full 20s environment allowance plus a 600ms quota response must not
    // start another independent 8s statistics budget beyond the return reserve.
    let after_quota = started + CAPTURE_TIMEOUT + Duration::from_millis(600);
    let query = super::super::ccusage_query_deadline(ProbeDeadline::at(probe_end), after_quota).unwrap();
    assert_eq!(query.expires_at, Some(probe_end - Duration::from_secs(2)));
    assert!(query.expires_at.unwrap() - after_quota < Duration::from_secs(8));
}

#[test]
fn waiting_for_another_capture_obeys_callers_remaining_budget() {
    let cache = TerminalEnvironment::default();
    let _held = cache.0.lock().unwrap();
    let started = Instant::now();
    assert_eq!(cache.get("CODEX_HOME", ProbeDeadline::at(started + Duration::from_millis(30)), |_| panic!("lock held")), Err(EnvError::TimedOut));
    assert!(started.elapsed() < Duration::from_millis(250));
}

#[test]
fn process_values_win_without_capturing_and_blocked_keys_never_reach_fallback() {
    assert_eq!(resolve_with_process("CLAUDE_CONFIG_DIR", Some("/fixture/process".into()), || panic!("process wins")).unwrap(), Some("/fixture/process".into()));
    assert_eq!(resolve_with_process("PRIVATE_SECRET", Some("fixture".into()), || panic!("blocked key")).unwrap(), None);
    assert_eq!(selected_shell(Some("/bin/bash")), "/bin/bash");
    assert_eq!(selected_shell(Some("/opt/homebrew/bin/fish")), "/opt/homebrew/bin/fish");
    assert_eq!(selected_shell(Some("relative/zsh")), "/bin/zsh");
    assert_eq!(selected_shell(Some("/bin/sh")), "/bin/zsh");
}

#[test]
fn failed_process_and_incomplete_output_are_not_valid_empty_environments() {
    assert_eq!(capture_command(&mut fixture_command("exit 1"), Duration::from_secs(3)), Err(EnvError::CaptureFailed));
    assert_eq!(capture_command(&mut fixture_command("printf 'unexpected login output'"), Duration::from_secs(3)), Err(EnvError::InvalidOutput));
}

#[test]
fn shell_output_limit_rejects_oversized_capture() {
    assert_eq!(capture_command(&mut fixture_command("printf '%065537d' 0"), Duration::from_secs(3)), Err(EnvError::InvalidOutput));
}

#[cfg(unix)]
#[test]
fn slow_shell_and_exited_parent_with_inherited_pipe_are_bounded_and_cleaned() {
    use std::fs;
    for exited_parent in [false, true] {
        let dir = std::env::temp_dir().join(format!("token-env-fixture-{}-{}-{}", std::process::id(), exited_parent,
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&dir).unwrap();
        let pid_file = dir.join("child.pid");
        let script = format!("sleep 20 &\nprintf '%s' $! > '{}'\n{}", pid_file.display(), if exited_parent { "exit 0" } else { "wait" });
        let started = Instant::now();
        assert_eq!(capture_command(&mut fixture_command(&script), Duration::from_secs(2)), Err(EnvError::TimedOut));
        assert!(started.elapsed() < Duration::from_secs(4));
        let pid: i32 = fs::read_to_string(pid_file).expect("fixture really started").trim().parse().unwrap();
        let end = Instant::now() + Duration::from_millis(750);
        while unsafe { libc::kill(pid, 0) == 0 } && Instant::now() < end { std::thread::sleep(POLL); }
        assert!(unsafe { libc::kill(pid, 0) != 0 }, "fixture descendant must be cleaned");
    }
}

#[cfg(unix)]
#[test]
fn complete_snapshot_returns_without_waiting_for_parent_or_inherited_pipe() {
    use std::fs;
    for exited_parent in [false, true] {
        let dir = std::env::temp_dir().join(format!("token-env-complete-pipe-{}-{}-{}", std::process::id(), exited_parent,
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&dir).unwrap();
        let pid_file = dir.join("descendant.pid");
        let script = format!("sleep 20 &\nprintf '%s' $! > '{}'\n{}\n{}", pid_file.display(), capture_script(), if exited_parent { "exit 0" } else { "wait" });
        let started = Instant::now();
        let result = capture_command(&mut fixture_command(&script), Duration::from_secs(3)).unwrap();
        assert!(result.values().all(Option::is_none));
        assert!(started.elapsed() < Duration::from_secs(2), "complete data must not wait for pipe EOF or parent exit");
        let pid: i32 = fs::read_to_string(pid_file).expect("fixture started").trim().parse().unwrap();
        let end = Instant::now() + Duration::from_millis(750);
        while unsafe { libc::kill(pid, 0) == 0 } && Instant::now() < end { std::thread::sleep(POLL); }
        assert!(unsafe { libc::kill(pid, 0) != 0 }, "completed capture must clean its descendant");
    }
}
