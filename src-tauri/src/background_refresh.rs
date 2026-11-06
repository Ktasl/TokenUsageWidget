use crate::plugin_engine::runtime::{MetricLine, PluginOutput};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Emitter};

const MAX_PROVIDERS: usize = 17;
const POLL_SECONDS: u64 = 15;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub output: PluginOutput,
    pub fetched_at: u64,
}

#[derive(Default)]
struct Schedule {
    plugin_ids: Vec<String>,
    interval_ms: u64,
    next_due: Option<u64>,
    pending_until: u64,
}

impl Schedule {
    fn configure(&mut self, mut ids: Vec<String>, interval_ms: u64, now: u64) {
        ids.sort();
        ids.dedup();
        if self.plugin_ids == ids && self.interval_ms == interval_ms { return; }
        self.plugin_ids = ids;
        self.interval_ms = interval_ms;
        self.next_due = if self.plugin_ids.is_empty() { None } else { Some(now.saturating_add(interval_ms)) };
        // Do not release an older background batch merely because preferences changed.
    }

    fn take_due(&mut self, now: u64, hidden: bool) -> Option<Vec<String>> {
        if !hidden || self.plugin_ids.is_empty() || now < self.pending_until || self.next_due.is_none_or(|due| now < due) {
            return None;
        }
        let rounds = (self.plugin_ids.len() as u64).div_ceil(4);
        self.pending_until = now.saturating_add((rounds * 30 + 15) * 1000);
        // Sleep/wake resumes once; never replay every missed interval.
        self.next_due = Some(now.saturating_add(self.interval_ms));
        Some(self.plugin_ids.clone())
    }
}

#[derive(Default)]
struct BackgroundState {
    schedule: Schedule,
    snapshots: HashMap<String, Snapshot>,
}

fn state() -> &'static Mutex<BackgroundState> {
    static STATE: OnceLock<Mutex<BackgroundState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(BackgroundState::default()))
}

fn epoch_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64
}

fn validate_configuration(ids: &[String], known: &HashSet<String>, interval_minutes: u64) -> Result<u64, String> {
    if ![5, 15, 30, 60].contains(&interval_minutes) {
        return Err("不支援的背景更新間隔".into());
    }
    if ids.len() > MAX_PROVIDERS || ids.iter().any(|id| !known.contains(id)) {
        return Err("背景更新包含未知服務".into());
    }
    Ok(interval_minutes * 60 * 1000)
}

#[tauri::command]
pub fn configure_background_refresh(app: AppHandle, plugin_ids: Vec<String>, interval_minutes: u64) -> Result<(), String> {
    let known = {
        let app_state = app.state::<Mutex<crate::AppState>>();
        let locked = app_state.lock().map_err(|_| "無法讀取服務清單".to_string())?;
        locked.plugins.iter().map(|plugin| plugin.manifest.id.clone()).collect::<HashSet<_>>()
    };
    let interval_ms = validate_configuration(&plugin_ids, &known, interval_minutes)?;
    {
        let mut locked = state().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        locked.schedule.configure(plugin_ids, interval_ms, epoch_ms());
        let enabled = locked.schedule.plugin_ids.iter().cloned().collect::<HashSet<_>>();
        locked.snapshots.retain(|id, _| enabled.contains(id));
    }
    start_loop(app);
    Ok(())
}

pub(crate) fn start_loop(app: AppHandle) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() { return; }
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(POLL_SECONDS)).await;
            crate::menubar_summary::tick(&app);
            // Unknown visibility is not permission to start a duplicate native query.
            let hidden = app.get_webview_window("main").and_then(|window| window.is_visible().ok()).is_some_and(|visible| !visible);
            let ids = {
                let mut locked = state().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                locked.schedule.take_due(epoch_ms(), hidden)
            };
            let Some(ids) = ids else { continue; };
            let batch_id = format!("background-{}", uuid::Uuid::new_v4());
            if crate::start_probe_batch(app.clone(), app.state::<Mutex<crate::AppState>>(), Some(batch_id), Some(ids)).await.is_err() {
                // No source response, credential, plugin payload or private path in logs.
                log::error!("native background refresh could not start");
            }
        }
    });
}

/// Called only inside the existing generation-current commit lock.
/// This memory starts empty and never imports disk-cache timestamps as fresh.
pub(crate) fn remember(app: &AppHandle, output: &PluginOutput) {
    if output.lines.iter().any(|line| matches!(line, MetricLine::Badge { label, .. } if label == "Error")) { return; }
    let mut locked = state().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if !locked.schedule.plugin_ids.contains(&output.provider_id) { return; }
    let snapshot = Snapshot { output: output.clone(), fetched_at: epoch_ms() };
    locked.snapshots.insert(output.provider_id.clone(), snapshot.clone());
    drop(locked);
    crate::menubar_summary::success(app, &output.provider_id);
    // An IPC event can update an active renderer; reopening also pulls memory snapshots.
    if app.emit("probe:background-result", snapshot).is_err() { log::error!("background usage delivery failed"); }
}

#[tauri::command]
pub fn get_background_usage() -> Vec<Snapshot> {
    let locked = state().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut snapshots = locked.snapshots.iter().filter(|(id, _)| locked.schedule.plugin_ids.contains(id)).map(|(_, snapshot)| snapshot.clone()).collect::<Vec<_>>();
    snapshots.sort_by(|a, b| a.output.provider_id.cmp(&b.output.provider_id));
    snapshots
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configured() -> Schedule {
        let mut schedule = Schedule::default();
        schedule.configure(vec!["claude".into(), "codex".into()], 300_000, 1_000);
        schedule
    }

    #[test]
    fn queries_only_when_hidden_due_and_enabled() {
        let mut schedule = configured();
        assert!(schedule.take_due(300_999, true).is_none());
        assert!(schedule.take_due(301_000, false).is_none());
        assert_eq!(schedule.take_due(301_000, true).unwrap().len(), 2);
        assert!(schedule.take_due(301_001, true).is_none());
        schedule.configure(vec![], 300_000, 301_002);
        assert!(schedule.take_due(u64::MAX, true).is_none());
    }

    #[test]
    fn wakes_once_after_sleep_and_does_not_replay_missed_intervals() {
        let mut schedule = configured();
        let wake = 24 * 60 * 60 * 1000;
        assert!(schedule.take_due(wake, true).is_some());
        assert_eq!(schedule.next_due, Some(wake + 300_000));
        assert!(schedule.take_due(wake + 15_000, true).is_none());
        assert!(schedule.take_due(wake + 300_000, true).is_some());
    }

    #[test]
    fn identical_configuration_preserves_due_and_real_changes_reset_interval() {
        let mut schedule = configured();
        schedule.configure(vec!["codex".into(), "claude".into(), "codex".into()], 300_000, 200_000);
        assert_eq!(schedule.next_due, Some(301_000));
        schedule.configure(vec!["codex".into()], 900_000, 200_000);
        assert_eq!(schedule.next_due, Some(1_100_000));
    }

    #[test]
    fn pending_deadline_covers_queued_workers_and_survives_configuration_changes() {
        let mut schedule = Schedule::default();
        schedule.configure((0..17).map(|n| format!("provider{n}")).collect(), 300_000, 0);
        assert!(schedule.take_due(300_000, true).is_some());
        assert_eq!(schedule.pending_until, 465_000); // 5 rounds * 30s + 15s.
        schedule.configure(vec!["codex".into()], 1, 300_001);
        assert!(schedule.take_due(300_002, true).is_none());
        assert!(schedule.take_due(465_000, true).is_some());
    }

    #[test]
    fn rejects_unknown_services_and_unsupported_intervals() {
        let known = HashSet::from(["claude".to_string(), "codex".to_string()]);
        assert_eq!(validate_configuration(&["claude".into()], &known, 5).unwrap(), 300_000);
        assert!(validate_configuration(&[], &known, 5).is_ok());
        assert!(validate_configuration(&["unknown".into()], &known, 5).is_err());
        assert!(validate_configuration(&["codex".into()], &known, 1).is_err());
    }
}
