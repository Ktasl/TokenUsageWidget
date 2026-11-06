use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TokenModel {
    name: String,
    total_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TokenDay {
    date: String,
    total_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cached_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    models: Option<Vec<TokenModel>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TokenUsageReport {
    status: String,
    timezone: String,
    source: String,
    account_scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_version: Option<String>,
    days: Vec<TokenDay>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

fn valid_date(value: &str) -> bool {
    let fields: Vec<_> = value.split('-').collect();
    if fields.len() != 3 || value.len() != 10 { return false; }
    let Ok(year) = fields[0].parse::<i32>() else { return false; };
    let Ok(month) = fields[1].parse::<u8>() else { return false; };
    let Ok(day) = fields[2].parse::<u8>() else { return false; };
    time::Month::try_from(month).ok().and_then(|m| time::Date::from_calendar_date(year, m, day).ok()).is_some()
}

pub fn parse(json: &str) -> Option<TokenUsageReport> {
    if json.len() > 2_000_000 { return None; }
    let mut report: TokenUsageReport = serde_json::from_str(json).ok()?;
    if !matches!(report.status.as_str(), "ok" | "invalid" | "unavailable" | "unverified") || report.timezone != "Asia/Taipei" || report.source != "local-logs" || report.account_scope != "local-directory" || report.days.len() > 400 { return None; }
    if report.source_id.as_ref().is_some_and(|s| s.len() < 8 || s.len() > 128 || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')) { return None; }
    if report.source_version.as_ref().is_some_and(|s| s.len() > 32 || !s.chars().all(|c| c.is_ascii_digit() || c == '.')) { return None; }
    if report.reason.as_deref().is_some_and(|s| !matches!(s, "no_runner" | "timed_out" | "probe_budget_exhausted" | "runner_failed" | "legacy_duplicate_risk" | "timezone_unconfirmed" | "invalid_daily" | "invalid_models" | "conflicting_models" | "conflicting_daily" | "invalid_report")) { return None; }
    if report.status != "ok" && !report.days.is_empty() { return None; }
    const MAX: u64 = 9_007_199_254_740_991;
    let mut unique = BTreeMap::new();
    for day in report.days {
        if !valid_date(&day.date) || day.total_tokens > MAX || [day.input_tokens, day.output_tokens, day.cached_tokens].into_iter().flatten().any(|n| n > MAX) { return None; }
        if let Some(models) = &day.models {
            let mut names = std::collections::HashSet::new();
            let mut total = 0_u64;
            for model in models {
                if model.name.is_empty() || model.name.len() > 120 || !model.name.as_bytes()[0].is_ascii_alphanumeric() || !model.name.chars().all(|c| c.is_ascii_alphanumeric() || "._:+-".contains(c)) || !names.insert(&model.name) || model.total_tokens > MAX { return None; }
                total = total.checked_add(model.total_tokens)?;
            }
            if total > day.total_tokens { return None; }
        }
        if let Some(old) = unique.insert(day.date.clone(), day.clone()) { if old != day { return None; } }
    }
    report.days = unique.into_values().collect();
    Some(report)
}

pub fn invalid() -> TokenUsageReport {
    TokenUsageReport { status: "invalid".into(), timezone: "Asia/Taipei".into(), source: "local-logs".into(), account_scope: "local-directory".into(), source_id: None, source_version: None, days: vec![], reason: Some("invalid_report".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn value(days: serde_json::Value) -> serde_json::Value { serde_json::json!({"status":"ok","timezone":"Asia/Taipei","source":"local-logs","accountScope":"local-directory","days":days}) }
    #[test]
    fn explicit_zero_and_duplicate_are_preserved_without_extra_fields() {
        let day = serde_json::json!({"date":"2026-10-25","totalTokens":0});
        let r = parse(&value(serde_json::json!([day,day])).to_string()).unwrap();
        assert_eq!(r.days.len(),1);
        assert_eq!(r.days[0].total_tokens,0);
    }
    #[test]
    fn invalid_or_conflicting_daily_reports_are_rejected() {
        for day in [serde_json::json!({"date":"2026-02-30","totalTokens":1}), serde_json::json!({"date":"2026-10-25","totalTokens":-1}),serde_json::json!({"date":"2026-10-25","totalTokens":1,"secret":"not exported"})] { assert!(parse(&value(serde_json::json!([day])).to_string()).is_none()); }
        assert!(parse(&value(serde_json::json!([{"date":"2026-10-25","totalTokens":1},{"date":"2026-10-25","totalTokens":2}])).to_string()).is_none());
    }
}
