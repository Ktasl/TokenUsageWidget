use super::*;

#[cfg(unix)]
fn prepare_executable_fixture(path: &Path) {
    use std::os::unix::process::CommandExt;
    // A newly written script can spend >2s before its first instruction, while
    // subsequent launches take milliseconds (see shell-isolation*.json). Keep
    // that fixture setup separate from the unchanged product timeout assertions.
    let mut child = std::process::Command::new(path)
        .arg("__fixture_ready__")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn().expect("start fixture preparation");
    let end = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.try_wait().expect("wait for fixture preparation") {
            assert!(status.success(), "fixture preparation must succeed");
            return;
        }
        if Instant::now() >= end {
            let _ = kill_ccusage_on_timeout(&mut child);
            let _ = child.kill();
            let _ = child.wait();
            panic!("fixture preparation timed out before product timing began");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn query_cap_applies_even_without_an_outer_deadline() {
    let now = Instant::now();
    for probe in [ProbeDeadline::none(), ProbeDeadline::at(now + Duration::from_secs(30))] {
        let budget = ccusage_query_deadline(probe, now).expect("query budget");
        assert_eq!(budget.expires_at, Some(now + CCUSAGE_QUERY_BUDGET));
    }
}

#[test]
fn short_probe_budget_reserves_time_to_return_existing_quota() {
    let now = Instant::now();
    let probe_end = now + Duration::from_secs(3);
    let budget = ccusage_query_deadline(ProbeDeadline::at(probe_end), now).expect("query budget");
    assert_eq!(budget.expires_at, Some(probe_end - CCUSAGE_PROBE_RETURN_RESERVE));
    for remaining in [Duration::ZERO, Duration::from_secs(1), CCUSAGE_PROBE_RETURN_RESERVE] {
        assert!(ccusage_query_deadline(ProbeDeadline::at(now + remaining), now).is_none());
    }
}

#[test]
fn expired_query_budget_does_not_start_a_runner() {
    let result = run_ccusage_query_with_runners(
        vec![(CcusageRunnerKind::Bunx, "never-executed".into())],
        &CcusageQueryOpts::default(),
        CcusageProvider::Claude,
        "claude",
        ProbeDeadline::at(Instant::now()),
        |_, _, _, _, _| panic!("expired optional query must not launch a runner"),
    );
    let result: serde_json::Value = serde_json::from_str(&result).unwrap();
    assert_eq!(result["status"], "runner_failed");
    assert_eq!(result["reason"], "timed_out");
}

#[cfg(unix)]
#[test]
fn runner_discovery_checks_files_without_executing_them() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("openusage-discovery-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let runner = dir.join("fake-runner");
    let marker = dir.join("must-not-exist");
    std::fs::write(&runner, format!("#!/bin/sh\necho executed > '{}'\nexit 0\n", marker.display())).unwrap();
    std::fs::set_permissions(&runner, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(ccusage_runner_available(runner.to_str().unwrap(), None));
    assert!(ccusage_runner_available("fake-runner", Some(dir.as_os_str())));
    assert!(!marker.exists(), "discovery must never run --version or any other command");
    assert!(!ccusage_runner_available("missing-runner", Some(dir.as_os_str())));
    assert!(!ccusage_runner_available(dir.to_str().unwrap(), None));
    std::fs::set_permissions(&runner, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(!ccusage_runner_available("fake-runner", Some(dir.as_os_str())));
}

#[cfg(unix)]
#[test]
fn exited_wrapper_with_inherited_pipes_still_obeys_timeout() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("openusage-exited-wrapper-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    for exit_code in [0, 1] {
        let script = dir.join(format!("runner-{exit_code}.sh"));
        let pid_file = dir.join(format!("descendant-{exit_code}.pid"));
        std::fs::write(&script, format!(r#"#!/bin/sh
if [ "$1" = "__fixture_ready__" ]; then exit 0; fi
sleep 10 &
echo $! > "{}"
printf '{{"daily":[]}}\n'
exit {}
"#, pid_file.display(), exit_code)).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        prepare_executable_fixture(&script);
        let started = Instant::now();
        let result = run_ccusage_with_runner_timeout(
            CcusageRunnerKind::Bunx, script.to_str().unwrap(), &CcusageQueryOpts::default(),
            CcusageProvider::Claude, "claude", CcusageCommandFlavor::Current,
            Duration::from_secs(2),
        );
        assert_eq!(result, CcusageRunnerResult::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(4), "parent exit must not cause blocking pipe-reader joins");
        let pid: i32 = std::fs::read_to_string(pid_file).unwrap().trim().parse().unwrap();
        let cleanup_end = Instant::now() + Duration::from_millis(500);
        while unsafe { libc::kill(pid, 0) == 0 } && Instant::now() < cleanup_end {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(unsafe { libc::kill(pid, 0) != 0 }, "inherited-pipe descendant should be killed");
    }
}

#[cfg(unix)]
#[test]
fn current_legacy_and_later_runners_share_one_query_deadline() {
    use std::os::unix::fs::PermissionsExt;

    let dir = std::env::temp_dir().join(format!(
        "openusage-query-budget-{}-{}", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("fake-runner.sh");
    let calls = dir.join("calls.log");
    std::fs::write(&script, format!(r#"#!/bin/sh
if [ "$1" = "__fixture_ready__" ]; then exit 0; fi
echo "$*" >> "{calls}"
count=$(wc -l < "{calls}")
if [ "$count" -le 2 ]; then
  sleep 0.05
  exit 1
fi
sleep 10
printf '{{"daily":[]}}\n'
"#, calls = calls.display())).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    prepare_executable_fixture(&script);
    let started = Instant::now();
    let deadline = ProbeDeadline::at(started + Duration::from_secs(3));
    let runners = [CcusageRunnerKind::Bunx, CcusageRunnerKind::Npx, CcusageRunnerKind::NpmExec]
        .into_iter().map(|kind| (kind, script.to_string_lossy().into_owned())).collect();
    let result = run_ccusage_query_with_runners(
        runners, &CcusageQueryOpts::default(), CcusageProvider::Claude, "claude", deadline,
        |kind, program, opts, provider, plugin_id| {
            run_ccusage_with_runner_deadline(kind, program, opts, provider, plugin_id, deadline)
        },
    );
    let result: serde_json::Value = serde_json::from_str(&result).unwrap();
    assert_eq!(result["reason"], "timed_out");
    assert!(started.elapsed() < Duration::from_secs(5), "fallback attempts must not each receive a fresh timeout");
    let calls = std::fs::read_to_string(calls).unwrap();
    assert_eq!(calls.lines().count(), 3, "only first current+legacy and second current may run");
    assert!(calls.lines().nth(1).unwrap().contains("ccusage@18.0.11"));
    // Fixture-only temp files; never reads or invokes a real package runner/account.
}

#[test]
fn timezone_is_validated_and_applied_to_both_pinned_versions() {
    for timezone in ["Asia/Taipei", "UTC"] {
        let opts: CcusageQueryOpts = serde_json::from_value(serde_json::json!({"timezone":timezone})).unwrap();
        for provider in [CcusageProvider::Claude, CcusageProvider::Codex] {
            for flavor in [CcusageCommandFlavor::Current, CcusageCommandFlavor::Legacy] {
                let args = ccusage_runner_args(CcusageRunnerKind::Npx, &opts, provider, flavor);
                assert!(args.windows(2).any(|pair| pair == ["--timezone", timezone]));
            }
        }
        let result = run_ccusage_query_with_runners(
            vec![(CcusageRunnerKind::Npx, "fixture".into())], &opts, CcusageProvider::Claude, "claude",
            ProbeDeadline::at(Instant::now()+Duration::from_secs(1)),
            |_, _, _, _, _| CcusageRunnerResult::Success(r#"{"daily":[],"sourceVersion":"20.0.2"}"#.into()),
        );
        let result: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(result["timezone"], timezone);
        assert_eq!(result["sourceVersion"], "20.0.2");
    }
    for invalid in ["", "local", "Asia/Invalid", "UTC --other"] {
        assert!(serde_json::from_value::<CcusageQueryOpts>(serde_json::json!({"timezone":invalid})).is_err());
    }
    let opts: CcusageQueryOpts = serde_json::from_str("{}").unwrap();
    assert!(opts.timezone.is_none());
    assert!(!ccusage_runner_args(CcusageRunnerKind::Npx, &opts, CcusageProvider::Codex, CcusageCommandFlavor::Current).contains(&"--timezone".into()));
}
