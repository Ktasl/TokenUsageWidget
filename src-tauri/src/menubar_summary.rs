//! Native menu-bar quota summary; the renderer clock does not depend on WebKit.
use crate::background_refresh::{self, Snapshot};
use crate::plugin_engine::runtime::{MetricLine, ProgressFormat};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const FRESH_MS: u64 = 10 * 60 * 1000;
const PAINT_ERROR: &str = "無法繪製選單列摘要，請切換顯示樣式後重試";

#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum SummaryStyle { #[default] Quota, Compact }
fn parse_style(style: Option<&str>) -> Result<SummaryStyle, String> {
    match style.unwrap_or("quota") {
        "quota" => Ok(SummaryStyle::Quota), "compact" => Ok(SummaryStyle::Compact),
        _ => Err("不支援的選單列主題".into()),
    }
}

#[derive(Clone, Default)]
struct Configuration {
    style: SummaryStyle,
    enabled: bool,
    plugin_ids: Vec<String>,
    gemini_metric: String,
    metric_selections: HashMap<String, String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SummaryRow {
    pub key: String,
    pub label: String,
    pub remaining_percent: Option<u8>,
    pub countdown: Option<String>,
    pub status: &'static str,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct SummaryGroup {
    pub id: String,
    pub name: String,
    pub rows: Vec<SummaryRow>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryState {
    style: SummaryStyle,
    pub enabled: bool,
    pub plugin_ids: Vec<String>,
    pub gemini_metric: String,
    pub groups: Vec<SummaryGroup>,
    pub error: Option<String>,
}

#[derive(Default)]
struct State {
    config: Configuration,
    generation: u64,
    failed: HashSet<String>,
    last_requested_minute: Option<u64>,
    error: Option<String>,
}
fn accepts_generation(locked: &State, generation: u64) -> bool {
    locked.config.enabled && locked.generation == generation
}
fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State::default()))
}
fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(u64::MAX as u128) as u64
}
fn reset_ms(value: &str) -> Option<u64> {
    let date = time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()?;
    u64::try_from(date.unix_timestamp_nanos() / 1_000_000).ok()
}
fn countdown(end: u64, now: u64) -> String {
    let minutes = end.saturating_sub(now).div_ceil(60_000);
    if minutes >= 1440 { format!("{}d{:02}h{:02}m", minutes / 1440, (minutes / 60) % 24, minutes % 60) }
    else if minutes >= 60 { format!("{}h{:02}m", minutes / 60, minutes % 60) }
    else { format!("{}m", minutes) }
}
fn unknown(key: &str, label: &str, status: &'static str) -> SummaryRow {
    SummaryRow { key: key.into(), label: label.into(), remaining_percent: None, countdown: None, status }
}
fn progress<'a>(snapshot: Option<&'a Snapshot>, label: &str) -> Option<&'a MetricLine> {
    snapshot?.output.lines.iter().find(|line| matches!(line, MetricLine::Progress { label: actual, format: ProgressFormat::Percent, .. } if actual == label))
}
fn row(key: &str, label: &str, line: Option<&MetricLine>, snapshot: Option<&Snapshot>, failed: bool, now: u64) -> SummaryRow {
    if failed { return unknown(key, label, "error"); }
    let Some(snapshot) = snapshot else { return unknown(key, label, "missing"); };
    if snapshot.fetched_at > now || now - snapshot.fetched_at > FRESH_MS { return unknown(key, label, "stale"); }
    if snapshot.output.lines.iter().any(|line| matches!(line, MetricLine::Badge { label, .. } if label == "Error")) {
        return unknown(key, label, "error");
    }
    let Some(MetricLine::Progress { used, limit, resets_at, format: ProgressFormat::Percent, .. }) = line else { return unknown(key, label, "missing"); };
    if !used.is_finite() || !limit.is_finite() || *used < 0.0 || *limit <= 0.0 { return unknown(key, label, "missing"); }
    let remaining_percent = Some(((1.0 - used / limit).clamp(0.0, 1.0) * 100.0).round() as u8);
    let end = resets_at.as_deref().and_then(reset_ms);
    if end.is_some_and(|end| end <= now) { return unknown(key, label, "expired"); }
    SummaryRow { key: key.into(), label: label.into(), remaining_percent,
        countdown: end.map(|end| countdown(end, now)), status: if end.is_some() { "fresh" } else { "missing" } }
}
fn groups(config: &Configuration, snapshots: &[Snapshot], failed: &HashSet<String>, now: u64) -> Vec<SummaryGroup> {
    config.plugin_ids.iter().map(|id| {
        let snapshot = snapshots.iter().find(|snapshot| snapshot.output.provider_id == *id);
        let has_error = failed.contains(id);
        let (name, rows) = if id == "claude" || id == "codex" {
            (if id == "claude" { "Claude" } else { "Codex" }.into(), vec![
                row("session", "Session", progress(snapshot, "Session"), snapshot, has_error, now),
                row("weekly", "Weekly", progress(snapshot, "Weekly"), snapshot, has_error, now),
            ])
        } else if id == "antigravity" {
            let requested = if config.gemini_metric == "flash" { "Gemini Flash" } else { "Gemini Pro" };
            let gemini = progress(snapshot, requested);
            let label = if config.gemini_metric != "flash" && gemini.is_none() { "Gemini Flash" } else { requested };
            ("AG".into(), vec![
                row("gemini", label, progress(snapshot, label), snapshot, has_error, now),
                row("claude", "Claude", progress(snapshot, "Claude"), snapshot, has_error, now),
            ])
        } else {
            let selected = config.metric_selections.get(id).and_then(|label| progress(snapshot, label));
            let primary = selected.or_else(|| snapshot.and_then(|snapshot| snapshot.output.lines.iter().find(|line| matches!(line, MetricLine::Progress { format: ProgressFormat::Percent, .. }))));
            let name = id.chars().filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-').take(14).collect();
            (name, vec![row("primary", "Quota", primary, snapshot, has_error, now)])
        };
        SummaryGroup { id: id.clone(), name, rows }
    }).collect()
}
fn summary(locked: &State, now: u64) -> SummaryState {
    SummaryState { style: locked.config.style, enabled: locked.config.enabled, plugin_ids: locked.config.plugin_ids.clone(),
        gemini_metric: if locked.config.gemini_metric.is_empty() { "pro".into() } else { locked.config.gemini_metric.clone() },
        groups: groups(&locked.config, &background_refresh::get_background_usage(), &locked.failed, now), error: locked.error.clone() }
}
fn row_tag(row: &SummaryRow) -> &'static str {
    match row.key.as_str() { "session" => "S", "weekly" => "W", "gemini" => "G", "claude" => "C", _ => "Q" }
}
fn row_text(row: &SummaryRow) -> String {
    match (row.remaining_percent, row.countdown.as_deref()) {
        (Some(percent), Some(time)) => format!("{} {}% {}", row_tag(row), percent, time),
        (Some(percent), None) => format!("{} {}% --", row_tag(row), percent),
        _ => format!("{} -- 待更新", row_tag(row)),
    }
}
fn text_rows(group: &SummaryGroup) -> [String; 2] {
    let first = group.rows.first().map(row_text).unwrap_or_else(|| "-- 待更新".into());
    let second = group.rows.get(1).map(row_text).unwrap_or_default();
    [format!("{} {}", group.name, first), if second.is_empty() { String::new() } else { format!("{}{}", " ".repeat(group.name.len()+1), second) }]
}

fn columns_text(groups: &[SummaryGroup]) -> Vec<[String; 2]> {
    if groups.is_empty() { vec![["TU".into(), "--".into()]] }
    else { groups.iter().map(text_rows).collect() }
}

#[cfg(target_os = "macos")]
mod render;
#[cfg(target_os = "macos")]
use render::draw;
#[cfg(not(target_os = "macos"))]
fn draw(_: &AppHandle, _: &[SummaryGroup], _: SummaryStyle, _: u64) -> Result<bool, String> { Err(PAINT_ERROR.into()) }

fn publish_error(app: &AppHandle, generation: u64, disable: bool) {
    let mut locked = state().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if locked.generation != generation { return; }
    locked.error = Some(PAINT_ERROR.into());
    if disable { locked.config.enabled = false; locked.generation += 1; }
    let output = summary(&locked, now_ms());
    if app.emit("menubar:summary-updated", output).is_err() { log::error!("menubar summary error delivery failed"); }
}
fn request_refresh(app: &AppHandle, force: bool, reply: Option<tauri::async_runtime::Sender<Result<SummaryState, String>>>) -> Result<(), String> {
    let generation = {
        let mut locked = state().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let minute = now_ms() / 60_000;
        if !locked.config.enabled || (!force && locked.last_requested_minute == Some(minute)) { return Ok(()); }
        locked.last_requested_minute = Some(minute);
        locked.generation
    };
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let mut output = {
            let locked = state().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if !accepts_generation(&locked, generation) {
                if let Some(reply) = reply { let _ = reply.try_send(Ok(summary(&locked, now_ms()))); }
                return;
            }
            summary(&locked, now_ms())
        };
        let result = draw(&handle, &output.groups, output.style, generation);
        let mut locked = state().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if !accepts_generation(&locked, generation) {
            if let Some(reply) = reply { let _ = reply.try_send(Ok(summary(&locked, now_ms()))); }
            return;
        }
        if result.is_err() { log::error!("menubar summary drawing failed"); }
        locked.error = result.as_ref().err().cloned();
        output.error = locked.error.clone();
        if handle.emit("menubar:summary-updated", &output).is_err() { log::error!("menubar summary update delivery failed"); }
        if let Some(reply) = reply { let _ = reply.try_send(result.map(|_| output)); }
    }).map_err(|_| PAINT_ERROR.to_string())
}

#[tauri::command]
pub async fn configure_menubar_summary(app: AppHandle, enabled: bool, plugin_ids: Vec<String>, gemini_metric: Option<String>, metric_selections: Option<HashMap<String, String>>, style: Option<String>) -> Result<SummaryState, String> {
    let style = parse_style(style.as_deref())?;
    let gemini_metric = gemini_metric.unwrap_or_else(|| "pro".into());
    if !["pro", "flash"].contains(&gemini_metric.as_str()) { return Err("不支援的 Gemini 額度選項".into()); }
    let known = {
        let app_state = app.state::<Mutex<crate::AppState>>();
        let app_state = app_state.lock().map_err(|_| PAINT_ERROR.to_string())?;
        app_state.plugins.iter().map(|plugin| plugin.manifest.id.clone()).collect::<HashSet<_>>()
    };
    if plugin_ids.len() > 17 || plugin_ids.iter().any(|id| !known.contains(id)) { return Err("選單列摘要包含未知服務".into()); }
    let generation = {
        let mut locked = state().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut seen = HashSet::new();
        let plugin_ids = plugin_ids.into_iter().filter(|id| seen.insert(id.clone())).collect();
        locked.config = Configuration { style, enabled, plugin_ids, gemini_metric, metric_selections: metric_selections.unwrap_or_default() };
        locked.generation += 1;
        locked.error = None;
        locked.last_requested_minute = None;
        if !enabled {
            let output = summary(&locked, now_ms());
            let _ = app.emit("menubar:summary-updated", &output);
            return Ok(output);
        }
        locked.generation
    };
    background_refresh::start_loop(app.clone());
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    if request_refresh(&app, true, Some(sender)).is_err() { publish_error(&app, generation, true); return Err(PAINT_ERROR.into()); }
    match tokio::time::timeout(Duration::from_secs(2), receiver.recv()).await {
        Ok(Some(Ok(output))) => Ok(output),
        _ => { publish_error(&app, generation, true); Err(PAINT_ERROR.into()) }
    }
}
#[tauri::command]
pub fn get_menubar_summary() -> SummaryState {
    summary(&state().lock().unwrap_or_else(|poisoned| poisoned.into_inner()), now_ms())
}
pub(crate) fn tick(app: &AppHandle) {
    let generation = state().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).generation;
    if request_refresh(app, false, None).is_err() { publish_error(app, generation, false); }
}
pub(crate) fn success(app: &AppHandle, provider: &str) {
    let generation = { let mut locked = state().lock().unwrap_or_else(|poisoned| poisoned.into_inner()); locked.failed.remove(provider); locked.generation };
    if request_refresh(app, true, None).is_err() { publish_error(app, generation, false); }
}
pub(crate) fn mark_error(app: &AppHandle, provider: &str) {
    let generation = { let mut locked = state().lock().unwrap_or_else(|poisoned| poisoned.into_inner()); locked.failed.insert(provider.into()); locked.generation };
    if request_refresh(app, true, None).is_err() { publish_error(app, generation, false); }
}

#[cfg(all(target_os = "macos", debug_assertions))]
pub(crate) fn render_synthetic_preview(path: &std::path::Path) -> Result<(), String> {
    use objc2_app_kit::NSBitmapImageFileType;
    use objc2_foundation::{NSDictionary, NSString};
    if objc2::MainThreadMarker::new().is_none() { return Err("合成預覽需在主執行緒執行".into()); }
    let sample = |key: &str, label: &str, percent: u8, time: &str| SummaryRow {
        key: key.into(), label: label.into(), remaining_percent: Some(percent), countdown: Some(time.into()), status: "fresh" };
    let groups = vec![
        SummaryGroup { id: "claude".into(), name: "Claude".into(), rows: vec![sample("session", "Session", 87, "3h24m"), sample("weekly", "Weekly", 72, "3d04h05m")] },
        SummaryGroup { id: "codex".into(), name: "Codex".into(), rows: vec![sample("session", "Session", 94, "4h00m"), sample("weekly", "Weekly", 99, "6d08h00m")] },
        SummaryGroup { id: "antigravity".into(), name: "AG".into(), rows: vec![sample("gemini", "Gemini Pro", 95, "4h53m"), sample("claude", "Claude", 0, "2h09m")] },
    ];
    for (style, output) in [(SummaryStyle::Quota, path.to_path_buf()), (SummaryStyle::Compact, path.with_file_name("native-preview-compact.png"))] {
    let (rep, _) = render::render_bitmap(&groups, style)?;
    let png = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }.ok_or_else(|| PAINT_ERROR.to_string())?;
    let output = output.to_str().ok_or_else(|| PAINT_ERROR.to_string())?;
    if !png.writeToFile_atomically(&NSString::from_str(output), true) { return Err(PAINT_ERROR.into()); }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_engine::runtime::{PluginOutput, ProgressFormat};

    const NOW: u64 = 1_800_000_000_000;
    fn metric(label: &str, used: f64, reset: Option<u64>) -> MetricLine {
        MetricLine::Progress { label: label.into(), used, limit: 100.0, format: ProgressFormat::Percent,
            resets_at: reset.map(|at| time::OffsetDateTime::from_unix_timestamp((at/1000) as i64).unwrap().format(&time::format_description::well_known::Rfc3339).unwrap()),
            period_duration_ms: None, color: None }
    }
    fn snapshot(provider: &str, lines: Vec<MetricLine>) -> Snapshot {
        Snapshot { output: PluginOutput { provider_id: provider.into(), display_name: provider.into(),
            plan: None, lines, icon_url: String::new(), token_usage_report: None }, fetched_at: NOW }
    }
    fn config(id: &str) -> Configuration {
        Configuration { enabled: true, plugin_ids: vec![id.into()], gemini_metric: "pro".into(), ..Default::default() }
    }
    #[test]
    fn claude_and_codex_keep_session_and_weekly_distinct_with_remaining_percent() {
        for provider in ["claude", "codex"] {
            let snapshots = vec![snapshot(provider, vec![metric("Session", 13.0, Some(NOW+3_600_000)), metric("Weekly", 28.0, Some(NOW+172_800_000))])];
            let output = groups(&config(provider), &snapshots, &HashSet::new(), NOW);
            assert_eq!(output[0].rows[0].remaining_percent, Some(87));
            assert_eq!(output[0].rows[0].countdown.as_deref(), Some("1h00m"));
            assert_eq!(output[0].rows[1].remaining_percent, Some(72));
            assert_eq!(output[0].rows[1].countdown.as_deref(), Some("2d00h00m"));
            let text = text_rows(&output[0]);
            assert!(text[0].starts_with(if provider == "claude" { "Claude S" } else { "Codex S" }));
            assert!(text[1].contains("W 72%"));
        }
    }
    #[test]
    fn antigravity_pro_falls_back_only_to_flash_and_keeps_claude_separate() {
        let snapshots = vec![snapshot("antigravity", vec![metric("Gemini Flash", 5.0, Some(NOW+60_000)), metric("Claude", 80.0, Some(NOW+120_000))])];
        let output = groups(&config("antigravity"), &snapshots, &HashSet::new(), NOW);
        assert_eq!(output[0].name, "AG");
        assert_eq!(output[0].rows[0].label, "Gemini Flash");
        assert_eq!(output[0].rows[0].remaining_percent, Some(95));
        assert_eq!(output[0].rows[1].remaining_percent, Some(20));
        let only_claude = vec![snapshot("antigravity", vec![metric("Claude", 80.0, Some(NOW+120_000))])];
        let output = groups(&config("antigravity"), &only_claude, &HashSet::new(), NOW);
        assert_eq!(output[0].rows[0].remaining_percent, None);
        assert_eq!(output[0].rows[1].remaining_percent, Some(20));
    }
    #[test]
    fn explicit_flash_never_selects_pro_or_claude() {
        let mut chosen = config("antigravity"); chosen.gemini_metric = "flash".into();
        let snapshots = vec![snapshot("antigravity", vec![metric("Gemini Pro", 5.0, Some(NOW+60_000)), metric("Claude", 80.0, Some(NOW+120_000))])];
        let output = groups(&chosen, &snapshots, &HashSet::new(), NOW);
        assert_eq!(output[0].rows[0].label, "Gemini Flash");
        assert_eq!(output[0].rows[0].remaining_percent, None);
    }
    #[test]
    fn stale_error_future_missing_and_elapsed_reset_never_forge_fresh_numbers() {
        let good = snapshot("claude", vec![metric("Session", 0.0, Some(NOW+60_000))]);
        let mut stale = good.clone(); stale.fetched_at = NOW-FRESH_MS-1;
        let mut future = good.clone(); future.fetched_at = NOW+1;
        for bad in [stale, future] {
            let output = groups(&config("claude"), &[bad], &HashSet::new(), NOW);
            assert_eq!(output[0].rows[0].remaining_percent, None);
            assert_eq!(output[0].rows[0].status, "stale");
        }
        let output = groups(&config("claude"), &[good.clone()], &HashSet::from(["claude".into()]), NOW);
        assert_eq!(output[0].rows[0].status, "error");
        assert_eq!(output[0].rows[0].remaining_percent, None);
        for reset in [Some(NOW), Some(NOW-1_000)] {
            let output = groups(&config("claude"), &[snapshot("claude", vec![metric("Session", 0.0, reset)])], &HashSet::new(), NOW);
            assert_eq!(output[0].rows[0].remaining_percent, None);
            assert!(text_rows(&output[0])[0].contains("-- 待更新"));
        }
        let output = groups(&config("claude"), &[], &HashSet::new(), NOW);
        assert_eq!(output[0].rows[0].status, "missing");
        assert_eq!(groups(&config("claude"), &[good], &HashSet::new(), NOW)[0].rows[0].remaining_percent, Some(100));
    }
    #[test]
    fn countdown_moves_by_wall_clock_without_new_source_or_webview() {
        let snapshots = vec![snapshot("codex", vec![metric("Session", 13.0, Some(NOW+120_000))])];
        assert_eq!(groups(&config("codex"), &snapshots, &HashSet::new(), NOW)[0].rows[0].countdown.as_deref(), Some("2m"));
        assert_eq!(groups(&config("codex"), &snapshots, &HashSet::new(), NOW+60_000)[0].rows[0].countdown.as_deref(), Some("1m"));
        assert_eq!(groups(&config("codex"), &snapshots, &HashSet::new(), NOW+120_000)[0].rows[0].status, "expired");
    }
    #[test]
    fn other_services_keep_one_selected_existing_quota() {
        let mut chosen = config("minimax"); chosen.metric_selections.insert("minimax".into(), "Weekly".into());
        let snapshots = vec![snapshot("minimax", vec![metric("Session", 90.0, Some(NOW+60_000)), metric("Weekly", 30.0, Some(NOW+120_000))])];
        let output = groups(&chosen, &snapshots, &HashSet::new(), NOW);
        assert_eq!(output[0].rows.len(), 1);
        assert_eq!(output[0].rows[0].remaining_percent, Some(70));
    }
    #[test]
    fn invalid_numeric_quota_remains_unknown() {
        for used in [f64::NAN, f64::INFINITY, -1.0] {
            let output = groups(&config("codex"), &[snapshot("codex", vec![metric("Session", used, Some(NOW+120_000))])], &HashSet::new(), NOW);
            assert_eq!(output[0].rows[0].remaining_percent, None);
        }
    }
    #[test]
    fn disabled_or_superseded_configurations_reject_queued_paints() {
        let mut locked = State { config: config("codex"), generation: 1, ..Default::default() };
        assert!(accepts_generation(&locked, 1));
        locked.config.enabled = false; locked.generation = 2;
        assert!(!accepts_generation(&locked, 1));
        locked.config.enabled = true; locked.generation = 3;
        assert!(!accepts_generation(&locked, 1));
        assert!(accepts_generation(&locked, 3));
    }
    #[test]
    fn returned_schema_is_camel_case_and_contains_only_summary_fields() {
        let output = SummaryState { style: SummaryStyle::Quota, enabled: true, plugin_ids: vec!["claude".into()], gemini_metric: "pro".into(),
            groups: groups(&config("claude"), &[snapshot("claude", vec![metric("Session", 13.0, Some(NOW+60_000))])], &HashSet::new(), NOW), error: None };
        let json = serde_json::to_value(output).unwrap();
        assert_eq!(json["pluginIds"], serde_json::json!(["claude"]));
        assert_eq!(json["geminiMetric"], "pro");
        assert_eq!(json["style"], "quota");
        assert_eq!(json["groups"][0]["rows"][0]["remainingPercent"], 87);
        assert!(json["error"].is_null());
        assert!(json.get("plugin_ids").is_none());
        assert!(json.get("output").is_none());
    }

    #[test]
    fn missing_reset_keeps_real_percentage_but_never_treats_cost_as_quota() {
        let output = groups(&config("codex"), &[snapshot("codex", vec![metric("Session", 6.0, None)])], &HashSet::new(), NOW);
        assert_eq!(output[0].rows[0].remaining_percent, Some(94));
        assert_eq!(output[0].rows[0].countdown, None);
        assert!(text_rows(&output[0])[0].contains("S 94% --"));
        let mut invalid_reset = metric("Session", 6.0, None);
        if let MetricLine::Progress { resets_at, .. } = &mut invalid_reset { *resets_at = Some("invalid-reset".into()); }
        let output = groups(&config("codex"), &[snapshot("codex", vec![invalid_reset])], &HashSet::new(), NOW);
        assert_eq!(output[0].rows[0].remaining_percent, Some(94));
        assert_eq!(output[0].rows[0].countdown, None);
        let mut cost = metric("Cost", 50.0, Some(NOW+60_000));
        if let MetricLine::Progress { format, .. } = &mut cost { *format = ProgressFormat::Dollars; }
        let output = groups(&config("minimax"), &[snapshot("minimax", vec![cost.clone(), metric("Quota", 6.0, Some(NOW+60_000))])], &HashSet::new(), NOW);
        assert_eq!(output[0].rows[0].remaining_percent, Some(94));
        let output = groups(&config("minimax"), &[snapshot("minimax", vec![cost])], &HashSet::new(), NOW);
        assert_eq!(output[0].rows[0].remaining_percent, None);
    }

    #[test]
    fn no_enabled_services_retains_a_visible_tray_entry() {
        let columns = columns_text(&[]);
        assert_eq!(columns, vec![["TU".to_string(), "--".to_string()]]);
        assert!(columns.iter().flatten().any(|text| !text.trim().is_empty()));
    }

    #[test]
    fn compact_style_is_explicit_and_detail_keeps_the_same_source_values() {
        assert_eq!(parse_style(None).unwrap(), SummaryStyle::Quota);
        assert_eq!(parse_style(Some("quota")).unwrap(), SummaryStyle::Quota);
        assert_eq!(parse_style(Some("compact")).unwrap(), SummaryStyle::Compact);
        assert!(parse_style(Some("unknown")).is_err());
        let mut selected = config("claude");
        let snapshots = vec![snapshot("claude", vec![metric("Session", 0.0, Some(NOW+120_000)), metric("Weekly", 100.0, Some(NOW+240_000))])];
        let detail = groups(&selected, &snapshots, &HashSet::new(), NOW);
        selected.style = SummaryStyle::Compact;
        assert_eq!(groups(&selected, &snapshots, &HashSet::new(), NOW), detail);
        assert_eq!(groups(&selected, &snapshots, &HashSet::new(), NOW+240_000)[0].rows[1].status, "expired");
        let value = SummaryState { style: SummaryStyle::Compact, enabled: true, plugin_ids: selected.plugin_ids, gemini_metric: "pro".into(), groups: detail, error: None };
        assert_eq!(serde_json::to_value(value).unwrap()["style"], "compact");
    }

}
