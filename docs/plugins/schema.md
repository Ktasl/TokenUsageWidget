# Plugin Schema

Plugin structure, manifest format, output schema, and lifecycle.

## Architecture Overview

```
Auto-update timer fires (or app loads)
       |
Tauri command `run_plugin_probes(pluginIds?)`
       |
For each enabled plugin:
  -> Create fresh QuickJS sandbox
  -> Inject host APIs (`ctx.host.*`)
  -> Evaluate plugin.js
  -> Call `probe(ctx)`
  -> Parse returned `{ lines: MetricLine[] }`
       |
Return `PluginOutput[]` to frontend
       |
UI renders via ProviderCard component
```

Key points:

- Each probe runs in **isolated QuickJS runtime** (no shared state between plugins or calls)
- Plugins are **synchronous or Promise-based** (unresolved promises timeout)
- **Auto-update timer** - runs on app load and on configurable interval (5/15/30/60 min)

## Plugin Directory Layout

```
plugins/<id>/
  plugin.json    <- manifest (required)
  plugin.js      <- entry script (required)
  icon.svg       <- plugin icon (required)
```

Bundled plugins live under `src-tauri/resources/bundled_plugins/<id>/`.

## Manifest Schema (`plugin.json`)

```json
{
  "schemaVersion": 1,
  "id": "my-provider",
  "name": "My Provider",
  "version": "0.0.1",
  "entry": "plugin.js",
  "icon": "icon.svg",
  "links": [{ "label": "Status", "url": "https://status.example.com" }],
  "lines": [
    { "type": "badge", "label": "Plan", "scope": "overview" },
    { "type": "progress", "label": "Usage", "scope": "overview", "primaryOrder": 1 },
    { "type": "text", "label": "Details", "scope": "detail" }
  ]
}
```

| Field           | Type   | Required | Description                                |
| --------------- | ------ | -------- | ------------------------------------------ |
| `schemaVersion` | number | Yes      | Always `1`                                 |
| `id`            | string | Yes      | Unique identifier (kebab-case recommended) |
| `name`          | string | Yes      | Display name shown in UI                   |
| `version`       | string | Yes      | Semver version                             |
| `entry`         | string | Yes      | Relative path to JS entry file             |
| `icon`          | string | Yes      | Relative path to SVG icon file             |
| `links`         | array  | No       | Optional quick links shown on detail page  |
| `lines`         | array  | Yes      | Output shape used for loading skeletons    |

Validation rules:

- `entry` must be relative (not absolute)
- `entry` must exist within the plugin directory
- `id` must match `globalThis.__openusage_plugin.id`
- `icon` must be relative and point to an SVG file (use `fill="currentColor"` for theme compatibility)
- `links[].url` (if provided) must be an `http://` or `https://` URL

### Links Array (Optional)

| Field   | Type   | Required | Description |
|---------|--------|----------|-------------|
| `label` | string | Yes      | Link text shown in the provider detail quick-actions row |
| `url`   | string | Yes      | External destination opened in the browser (`http/https` only) |

## Output Shape Declaration

Plugins must declare their output shape in `plugin.json`. This enables the UI to render
loading skeletons instantly while probes execute asynchronously.

### Lines Array

| Field     | Type    | Required | Description                                       |
|-----------|---------|----------|---------------------------------------------------|
| `type`    | string  | Yes      | One of: `text`, `progress`, `badge`, `barChart`   |
| `label`   | string  | Yes      | Static label shown in the UI for this line        |
| `scope`   | string  | Yes      | `"overview"` or `"detail"` - where line appears   |
| `primaryOrder` | number | No | Lower number = higher priority; orders this progress line among the tray-icon candidates (see below) |
| `period`  | string  | No       | `"weekly"` marks this line as the provider's weekly metric (see below) |

- `"overview"` - shown on both Overview tab and plugin detail pages
- `"detail"` - shown only on plugin detail pages

### Primary Progress (Tray Icon)

Progress lines can declare `primaryOrder` (a number) to prefer a metric in the system tray. Each provider uses the first candidate with valid runtime quota: finite used/limit values and a positive limit. If its declared primary metrics are absent or invalid, it tries the manifest's overview progress lines in their declared order. A provider with no primary metric can also appear through this overview fallback. For example, Antigravity can show Gemini Flash or Claude quota when Gemini Pro is unavailable.

Settings also lets the user choose a menu bar metric per provider, or use automatic selection. A valid saved choice takes priority over the global Weekly/default preference. If that metric is temporarily missing or invalid, automatic selection is used until the chosen quota is available again; its saved choice is kept. Metric labels and provider output are not renamed.

Rules:
- Only `type: "progress"` lines are candidates (`primaryOrder` is ignored on other types)
- Lower `primaryOrder` wins; the frontend walks the ordered list and uses the first one with valid quota before trying overview progress lines
- Plugin style shows every enabled provider with a numeric quota, in plugin order, as its icon and percentage. There is no four-provider limit in this style. A valid 0% remains visible; providers without quota data are omitted until data is available.
- Bars style shows up to 4 enabled plugins; a missing value appears as a track without fill.
- Donut style follows the selected provider, or the last selected provider when returning to Overview or Settings.
- The display mode still selects used or remaining quota. Each provider shows one selected metric; Weekly replaces the default metric rather than adding another percentage.
- These icons share one menu bar item. Clicking it still opens the existing overview panel with all enabled providers.

Example:

```json
{
  "lines": [
    { "type": "badge", "label": "Plan", "scope": "overview" },
    { "type": "progress", "label": "Plan usage", "scope": "overview", "primaryOrder": 1 },
    { "type": "progress", "label": "Overage", "scope": "overview", "primaryOrder": 2 },
    { "type": "text", "label": "Resets", "scope": "detail" }
  ]
}
```

### Weekly Metric (Menubar)

A provider can mark one progress line with `"period": "weekly"`. When the user sets the menubar metric to **Weekly** (Settings → Menubar Icon), the tray icon and tooltip show this line instead of the provider's primary metric.

Weekly is preferred when it has valid quota. If it is absent or invalid, the provider falls back to its primary metrics and then overview progress lines. A separate primary line is not required. `period` only recognizes `"weekly"` (other values are ignored), and only the first `"period": "weekly"` line is used.

```json
{
  "lines": [
    { "type": "progress", "label": "Session", "scope": "overview", "primaryOrder": 1 },
    { "type": "progress", "label": "Weekly", "scope": "overview", "period": "weekly" }
  ]
}
```

## Entry Point Structure

Plugins must register themselves on the global object:

```javascript
globalThis.__openusage_plugin = {
  id: "my-provider",  // Must match manifest.id
  probe: function(ctx) { ... }
}
```

## Output Schema

`probe(ctx)` must return (or resolve to):

```javascript
{ lines: MetricLine[], tokenUsageReport?: TokenUsageReport }
```

### Local Token Report (TokenUsageWidget)

The Claude/Codex adapters may also emit a detail text line labeled `Local estimated cost`: a dollar value and a subtitle with the accepted local date range and known-cost day coverage. This is an estimate from local records/API pricing, not a subscription invoice. Duplicate/conflicting cost observations are not added, and future Taipei dates are excluded. `Extra usage spent` remains a separate provider-reported metric; the UI never adds it to the local estimate or treats missing cost as zero.

Antigravity emits a quota progress line only for a finite source fraction in `[0,1]`. A missing or invalid fraction is an explicit unknown text line, not exhausted quota. An explicit zero remains valid; missing/invalid reset information is omitted rather than invented.

`tokenUsageReport` is optional and separate from quota lines. A failed optional report must not discard a quota that was already fetched. It contains only daily statistics, never session content or credentials.

```typescript
type TokenUsageReport = {
  status: "ok" | "unavailable" | "invalid" | "unverified"
  timezone: "Asia/Taipei"
  source: "local-logs"
  accountScope: "local-directory"
  sourceId?: string // opaque dataset identity, not a path or authenticated account ID
  sourceVersion?: string
  reason?: string // fixed classification, never a raw error or response
  days: Array<{
    date: string // valid YYYY-MM-DD in the confirmed source timezone
    totalTokens: number
    inputTokens?: number
    outputTokens?: number
    cachedTokens?: number
    models?: Array<{ name: string; totalTokens: number }>
  }>
}
```

Counts must be explicit nonnegative safe integers. Missing counts are unknown; an explicit zero is valid. The total comes from the source and is never reconstructed by adding overlapping input/cache fields. Model totals must not exceed the daily total; the remainder is unclassified. Identical duplicate days are deduplicated; conflicting days invalidate the report instead of being added.

The Claude/Codex adapters request 31 calendar days, including today, in Asia/Taipei. Weeks start Monday. Future days are excluded; a missing day is not zero. Daily aggregates do not retain reliable project, conversation, child-agent or authenticated-account attribution. A local directory may contain more than one account's records. Antigravity has no Token report without an actual source.

Unavailable/invalid reports have no accepted days. Reasons include `no_runner`, `timed_out`, `probe_budget_exhausted`, `runner_failed`, `timezone_unconfirmed`, `legacy_duplicate_risk`, and fixed invalid/conflicting daily/model classifications. Codex legacy 18.0.11 reports are withheld because its aggregated output cannot safely resolve known duplicate records.

### Line Types

```typescript
type MetricLine =
  | { type: "text"; label: string; value: string; color?: string; subtitle?: string }
  | {
      type: "progress";
      label: string;
      used: number;
      limit: number;
      format:
        | { kind: "percent" }
        | { kind: "dollars" }
        | { kind: "count"; suffix: string };
      resetsAt?: string; // ISO timestamp
      periodDurationMs?: number; // period length in ms for pace tracking
      color?: string;
    }
  | { type: "badge"; label: string; text: string; color?: string; subtitle?: string }
  | {
      type: "barChart";
      label: string;
      points: Array<{ label: string; value: number; valueLabel?: string }>;
      note?: string;
      color?: string;
    }
```

- `color`: optional hex string (e.g. `#22c55e`)
- `subtitle`: optional text displayed below the line in smaller muted text
- `resetsAt`: optional ISO timestamp (UI shows "Resets in ..." automatically)
- `periodDurationMs`: optional period length in milliseconds (enables pace indicator when combined with `resetsAt`)

### Text Line

Simple label/value pair.

```javascript
ctx.line.text({ label: "Account", value: "user@example.com" })
ctx.line.text({ label: "Status", value: "Active", color: "#22c55e", subtitle: "Since Jan 2024" })
```

### Progress Line

Shows a progress bar with optional formatting.

```javascript
ctx.line.progress({ label: "Usage", used: 42, limit: 100, format: { kind: "percent" } })
// Renders (depending on user settings): "42%" or "58% left"

ctx.line.progress({ label: "Spend", used: 12.34, limit: 100, format: { kind: "dollars" } })
// Renders: "$12.34" or "$87.66 left"

ctx.line.progress({
  label: "Session",
  used: 75,
  limit: 100,
  format: { kind: "percent" },
  resetsAt: ctx.util.toIso("2026-02-01T00:00:00Z"),
})
// UI will show: "Resets in …"
```

### Bar Chart Line

Shows a compact vertical bar chart for small history snapshots.

```javascript
ctx.line.barChart({
  label: "Usage Trend",
  points: [
    { label: "Feb 1", value: 1200, valueLabel: "1.2K tokens" },
    { label: "Feb 2", value: 2400, valueLabel: "2.4K tokens" },
  ],
  note: "Estimated from local logs",
})
```

### Badge Line

Status indicator with colored border.

```javascript
ctx.line.badge({ label: "Plan", text: "Pro", color: "#000000" })
ctx.line.badge({ label: "Status", text: "Connected", color: "#22c55e", subtitle: "Last sync 5m ago" })
```

## Error Handling

| Condition                  | Result                                        |
| -------------------------- | --------------------------------------------- |
| Plugin throws a string     | Error badge with that string                  |
| Plugin throws non-string   | Error badge with a generic fallback message   |
| Promise rejects            | Error badge                                   |
| Promise never resolves     | Error badge (timeout)                         |
| Invalid line type          | Error badge                                   |
| Missing `lines` array      | Error badge                                   |
| Invalid progress values    | Error badge (line-specific validation error)  |

Prefer throwing short, actionable strings (not `Error` objects).

## Minimal Example

A complete, working plugin that fetches data and displays all three line types.

**`plugin.json`:**

```json
{
  "schemaVersion": 1,
  "id": "minimal",
  "name": "Minimal Example",
  "version": "0.0.1",
  "entry": "plugin.js",
  "icon": "icon.svg",
  "lines": [
    { "type": "badge", "label": "Status", "scope": "overview" },
    { "type": "progress", "label": "Usage", "scope": "overview", "primaryOrder": 1 },
    { "type": "text", "label": "Fetched at", "scope": "detail" }
  ]
}
```

**`plugin.js`:**

```javascript
(function () {
  globalThis.__openusage_plugin = {
    id: "minimal",
    probe: function (ctx) {
      let resp
      try {
        resp = ctx.host.http.request({
          method: "GET",
          url: "https://httpbin.org/json",
          timeoutMs: 5000,
        })
      } catch (e) {
        throw "Request failed. Check your connection."
      }

      if (resp.status !== 200) {
        throw "Request failed (HTTP " + resp.status + "). Try again later."
      }

      let data
      try {
        data = JSON.parse(resp.bodyText)
      } catch {
        throw "Invalid JSON. Try again later."
      }

      return {
        lines: [
          ctx.line.badge({ label: "Status", text: "Connected", color: "#22c55e" }),
          ctx.line.progress({
            label: "Usage",
            used: 42,
            limit: 100,
            format: { kind: "percent" },
            resetsAt: ctx.util.toIso("2026-02-01T00:00:00Z"),
          }),
          ctx.line.text({ label: "Fetched at", value: ctx.nowIso }),
        ],
      }
    },
  }
})()
```

## Best Practices

- Wrap all host API calls in try/catch
- Throw short, user-friendly strings (not raw exception objects)
- Use `ctx.app.pluginDataDir` for plugin-specific state/config
- Keep probes fast (users wait on refresh)
- Validate API responses before accessing nested fields

## See Also

- [Host API Reference](./api.md) - Full documentation of `ctx.host.*` APIs
