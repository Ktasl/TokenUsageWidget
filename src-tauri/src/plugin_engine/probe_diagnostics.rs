use rquickjs::{Ctx, Exception, Function, Object};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

static NEXT_PROBE_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Initializing,
    Credentials,
    Quota,
    Tokens,
    Complete,
}

impl Stage {
    fn from_marker(marker: &str) -> Option<Self> {
        match marker {
            "credentials" => Some(Self::Credentials),
            "quota" => Some(Self::Quota),
            "tokens" => Some(Self::Tokens),
            "complete" => Some(Self::Complete),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Initializing => "initializing",
            Self::Credentials => "credentials",
            Self::Quota => "quota",
            Self::Tokens => "tokens",
            Self::Complete => "complete",
        }
    }

    fn index(self) -> usize {
        self as usize
    }
}

struct ProbeTimings {
    id: u64,
    provider: &'static str,
    started_at: Instant,
    stage_started_at: Instant,
    stage: Stage,
    elapsed: [Duration; 5],
}

impl ProbeTimings {
    fn new(plugin_id: &str, now: Instant) -> Self {
        Self {
            id: NEXT_PROBE_ID.fetch_add(1, Ordering::Relaxed),
            // Never include arbitrary plugin, account, URL or error strings in diagnostics.
            provider: if plugin_id == "claude" { "claude" } else { "other" },
            started_at: now,
            stage_started_at: now,
            stage: Stage::Initializing,
            elapsed: [Duration::ZERO; 5],
        }
    }

    fn mark(&mut self, marker: &str, now: Instant) -> bool {
        let Some(next) = Stage::from_marker(marker) else {
            return false;
        };
        if self.stage != next {
            self.elapsed[self.stage.index()] += now.saturating_duration_since(self.stage_started_at);
            self.stage = next;
            self.stage_started_at = now;
        }
        true
    }

    fn line(&self, outcome: &'static str, now: Instant) -> String {
        let mut elapsed = self.elapsed;
        elapsed[self.stage.index()] += now.saturating_duration_since(self.stage_started_at);
        format!(
            "probe_diag probe_id={} provider={} stage={} outcome={} total_ms={} initializing_ms={} credentials_ms={} quota_ms={} tokens_ms={} complete_ms={}",
            self.id,
            self.provider,
            self.stage.label(),
            outcome,
            now.saturating_duration_since(self.started_at).as_millis(),
            elapsed[0].as_millis(),
            elapsed[1].as_millis(),
            elapsed[2].as_millis(),
            elapsed[3].as_millis(),
            elapsed[4].as_millis(),
        )
    }
}

#[derive(Clone)]
pub(super) struct ProbeDiagnostics(Arc<Mutex<ProbeTimings>>);

impl ProbeDiagnostics {
    pub(super) fn new(plugin_id: &str) -> Self {
        Self(Arc::new(Mutex::new(ProbeTimings::new(plugin_id, Instant::now()))))
    }

    fn stage(&self, marker: &str) -> bool {
        let mut timings = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if !timings.mark(marker, Instant::now()) {
            return false;
        }
        log::info!("{}", timings.line("running", Instant::now()));
        true
    }

    pub(super) fn finish(&self, has_error: bool) {
        let timings = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let line = timings.line(if has_error { "error" } else { "ok" }, Instant::now());
        if has_error {
            log::error!("{}", line);
        } else {
            log::info!("{}", line);
        }
    }
}

pub(super) fn inject(ctx: &Ctx<'_>, diagnostics: ProbeDiagnostics) -> rquickjs::Result<()> {
    let probe_ctx: Object = ctx.globals().get("__openusage_ctx")?;
    let host: Object = probe_ctx.get("host")?;
    let probe = Object::new(ctx.clone())?;
    probe.set(
        "stage",
        Function::new(ctx.clone(), move |ctx_inner: Ctx<'_>, marker: String| {
            if diagnostics.stage(&marker) {
                Ok(())
            } else {
                Err(Exception::throw_message(&ctx_inner, "invalid probe stage"))
            }
        })?,
    )?;
    host.set("probe", probe)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rquickjs::{Context, Runtime};

    #[test]
    fn records_fixed_stages_and_elapsed_time_per_probe() {
        let now = Instant::now();
        let mut timings = ProbeTimings::new("claude", now);
        assert!(timings.mark("credentials", now + Duration::from_millis(2)));
        assert!(timings.mark("quota", now + Duration::from_millis(12)));
        assert!(timings.mark("tokens", now + Duration::from_millis(32)));
        let line = timings.line("error", now + Duration::from_millis(62));
        assert!(line.contains("provider=claude stage=tokens outcome=error total_ms=62"));
        assert!(line.contains("initializing_ms=2 credentials_ms=10 quota_ms=20 tokens_ms=30 complete_ms=0"));
        let another = ProbeTimings::new("claude", now);
        assert_ne!(timings.id, another.id);
        assert_eq!(another.stage, Stage::Initializing);
        assert_eq!(another.elapsed, [Duration::ZERO; 5]);
    }

    #[test]
    fn rejects_untrusted_markers_without_recording_them() {
        let now = Instant::now();
        let sensitive = "https://private.invalid/?token=SECRET account=private@example.invalid";
        let mut timings = ProbeTimings::new(sensitive, now);
        assert!(!timings.mark(sensitive, now));
        assert!(!timings.mark("initializing", now));
        assert!(!timings.mark("Tokens", now));
        let line = timings.line("error", now);
        assert!(line.contains("provider=other stage=initializing outcome=error"));
        for value in [sensitive, "SECRET", "private.invalid", "account=", "https://"] {
            assert!(!line.contains(value));
        }
    }

    #[test]
    fn injected_api_accepts_only_fixed_markers_and_hides_rejected_input() {
        let runtime = Runtime::new().expect("runtime");
        let context = Context::full(&runtime).expect("context");
        context.with(|ctx| {
            ctx.eval::<(), _>("globalThis.__openusage_ctx = { host: {} };").unwrap();
            let diagnostics = ProbeDiagnostics::new("claude");
            inject(&ctx, diagnostics.clone()).unwrap();
            ctx.eval::<(), _>("__openusage_ctx.host.probe.stage('credentials');").unwrap();
            let error: String = ctx.eval(
                "try { __openusage_ctx.host.probe.stage('SECRET-token'); } catch (e) { String(e) }",
            ).unwrap();
            assert!(error.contains("invalid probe stage"));
            assert!(!error.contains("SECRET"));
            let timings = diagnostics.0.lock().unwrap();
            assert_eq!(timings.stage, Stage::Credentials);
            assert!(!timings.line("error", Instant::now()).contains("SECRET"));
        });
    }
}
