import { ProviderCard } from "@/components/provider-card"
import { RetirementNotice } from "@/components/retirement-notice"
import type { PluginDisplayState } from "@/lib/plugin-types"
import type { DisplayMode, ResetTimerDisplayMode, TimeFormatMode } from "@/lib/settings"
import { isMoneyLine } from "@/lib/token-usage"
import { formatCountNumber } from "@/lib/utils"
import { quotaGuidance } from "@/lib/quota-guidance"
import { WidgetControls } from "@/components/widget-controls"
import { UsageExports } from "@/components/usage-exports"
import { saveUsageExport } from "@/lib/save-usage-export"

interface OverviewPageProps {
  plugins: PluginDisplayState[]
  onRetryPlugin?: (pluginId: string) => void
  onOpenSettings?: () => void
  displayMode: DisplayMode
  resetTimerDisplayMode: ResetTimerDisplayMode
  timeFormatMode?: TimeFormatMode
  onResetTimerDisplayModeToggle?: () => void
}

export function OverviewPage({
  plugins,
  onRetryPlugin,
  onOpenSettings,
  displayMode,
  resetTimerDisplayMode,
  timeFormatMode = "auto",
  onResetTimerDisplayModeToggle,
}: OverviewPageProps) {
  const quotas = plugins.map((plugin) => (plugin.data?.lines ?? []).filter((line) =>
    !isMoneyLine(line) && line.type === "progress" && Number.isFinite(line.used) && Number.isFinite(line.limit) && line.limit > 0
  ))
  const readyCount = quotas.filter((lines) => lines.length > 0).length
  const exhaustedCount = quotas.filter((lines) => lines.some((line) => line.type === "progress" && line.used >= line.limit)).length
  const guidance = quotaGuidance(plugins)

  return (
    <div className="space-y-5">
      <RetirementNotice />
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Token 與額度總覽</h1>
        <p className="mt-1 text-sm text-muted-foreground">集中查看已啟用服務與模型的額度，不必逐一切換。</p>
        <WidgetControls />
      </header>
      {plugins.length === 0 ? (
        <div className="rounded-2xl border border-dashed p-8 text-center">
          <p className="font-medium">尚未啟用服務</p>
          <p className="mt-2 text-sm text-muted-foreground">請到設定勾選要顯示的服務，額度會集中顯示在這裡。</p>
          {onOpenSettings && <button type="button" onClick={onOpenSettings} className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">選擇服務</button>}
        </div>
      ) : (
        <>
          {guidance && <p role="status" className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-xs">{guidance}</p>}
          <dl className="grid grid-cols-3 gap-3 rounded-2xl border bg-muted/30 p-4">
            {[["已啟用服務", plugins.length], ["有額度資料", readyCount], ["有額度已用盡", exhaustedCount]].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums">{formatCountNumber(Number(value))}</dd>
              </div>
            ))}
          </dl>
          <div className="grid grid-cols-1 items-start gap-4 min-[720px]:grid-cols-2" aria-label="所有已啟用服務的額度">
            {plugins.map((plugin) => (
              <ProviderCard
                key={plugin.meta.id}
                providerId={plugin.meta.id}
                name={plugin.meta.name}
                iconUrl={plugin.meta.iconUrl}
                brandColor={plugin.meta.brandColor}
                dashboard
                plan={plugin.data?.plan}
                showSeparator={false}
                loading={plugin.loading}
                error={plugin.error}
                lines={plugin.data?.lines ?? []}
                skeletonLines={plugin.meta.lines}
                lastManualRefreshAt={plugin.lastManualRefreshAt}
                lastUpdatedAt={plugin.lastUpdatedAt}
                tokenUsageReport={plugin.data?.tokenUsageReport}
                onRetry={onRetryPlugin ? () => onRetryPlugin(plugin.meta.id) : undefined}
                scopeFilter="overview"
                displayMode={displayMode}
                resetTimerDisplayMode={resetTimerDisplayMode}
                timeFormatMode={timeFormatMode}
                onResetTimerDisplayModeToggle={onResetTimerDisplayModeToggle}
              />
            ))}
          </div>
          <UsageExports plugins={plugins} saveFile={saveUsageExport} />
        </>
      )}
    </div>
  )
}
