use crate::plugin_engine::manifest::LoadedPlugin;
use crate::plugin_engine::runtime::{PluginOutput, error_output};

#[derive(Default)]
struct GenerationState {
    next: u64,
    latest: std::collections::HashMap<String, u64>,
}

/// Register before spawning workers, and commit cache writes under the same
/// short lock. A late older result must not replace a newer persisted snapshot.
#[derive(Default)]
pub(crate) struct ProbeGenerations(std::sync::Mutex<GenerationState>);

impl ProbeGenerations {
    pub(crate) fn register(&self, providers: &[String]) -> u64 {
        let mut state = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.next += 1;
        let generation = state.next;
        for provider in providers { state.latest.insert(provider.clone(), generation); }
        generation
    }

    pub(crate) fn commit_if_current(&self, provider: &str, generation: u64, commit: impl FnOnce()) -> bool {
        let state = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.latest.get(provider) != Some(&generation) { return false; }
        commit();
        true
    }
}

pub(crate) fn generations() -> &'static ProbeGenerations {
    static GENERATIONS: std::sync::OnceLock<ProbeGenerations> = std::sync::OnceLock::new();
    GENERATIONS.get_or_init(ProbeGenerations::default)
}

/// A crashed worker must still return a result so the UI can leave loading state.
pub(crate) fn run_safely(
    plugin: &LoadedPlugin,
    probe: impl FnOnce() -> PluginOutput,
) -> PluginOutput {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(probe)) {
        Ok(output) => output,
        Err(_) => {
            // Never format the panic payload: it may contain provider response data.
            log::error!("probe worker panicked; returning a failed result");
            error_output(plugin, "更新意外中止，請重試。".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_engine::manifest::PluginManifest;
    use crate::plugin_engine::runtime::MetricLine;
    use std::path::PathBuf;

    fn fake_plugin() -> LoadedPlugin {
        LoadedPlugin {
            manifest: PluginManifest {
                schema_version: 1,
                id: "test-provider".into(),
                name: "Test Provider".into(),
                version: "1.0.0".into(),
                entry: "plugin.js".into(),
                icon: "icon.svg".into(),
                brand_color: None,
                lines: vec![],
                links: vec![],
            },
            plugin_dir: PathBuf::new(),
            entry_script: String::new(),
            icon_data_url: "data:image/svg+xml;base64,test".into(),
        }
    }

    #[test]
    fn late_old_result_cannot_replace_two_newer_snapshots_or_publish_stale_events() {
        let generations = ProbeGenerations::default();
        let providers = vec!["codex".to_string(), "claude".to_string()];
        let old = generations.register(&providers);
        let mut cached = 13;
        let mut events = Vec::new();
        for quota in [91, 87] {
            let current = generations.register(&providers[..1]);
            assert!(generations.commit_if_current("codex", current, || { cached = quota; events.push(quota); }));
            assert!(!generations.commit_if_current("codex", old, || { cached = 13; events.push(13); }));
            assert_eq!(cached, quota);
        }
        assert_eq!(events, vec![91, 87]);
        // Refreshing Codex does not invalidate an unrelated Claude request.
        assert!(generations.commit_if_current("claude", old, || {}));
        assert!(!generations.commit_if_current("unknown", old, || panic!("unknown provider")));
    }

    #[test]
    fn panic_returns_failed_result_with_provider_identity() {
        let plugin = fake_plugin();
        let output = run_safely(&plugin, || panic!("private response must not be returned"));

        assert_eq!(output.provider_id, plugin.manifest.id);
        assert_eq!(output.display_name, plugin.manifest.name);
        assert_eq!(output.icon_url, plugin.icon_data_url);
        assert!(output.plan.is_none());
        assert!(matches!(
            &output.lines[..],
            [MetricLine::Badge { label, text, .. }]
                if label == "Error" && text == "更新意外中止，請重試。"
        ));
        assert!(!serde_json::to_string(&output).unwrap().contains("private response"));
    }

    #[test]
    fn successful_and_provider_error_outputs_are_preserved() {
        let plugin = fake_plugin();
        for output in [
            PluginOutput {
                provider_id: plugin.manifest.id.clone(),
                display_name: plugin.manifest.name.clone(),
                icon_url: plugin.icon_data_url.clone(),
                plan: Some("Test Plan".into()),
                token_usage_report: None,
                lines: vec![],
            },
            error_output(&plugin, "Expected fixture failure".into()),
        ] {
            let expected = serde_json::to_value(&output).unwrap();
            let actual = run_safely(&plugin, || output);
            assert_eq!(serde_json::to_value(actual).unwrap(), expected);
        }
    }
}
