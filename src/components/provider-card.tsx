import { Fragment, useMemo } from "react"
import { AlertCircle, ExternalLink, Hourglass, RefreshCw } from "lucide-react"
import { openUrl } from "@tauri-apps/plugin-opener"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { SkeletonLines } from "@/components/skeleton-lines"
import { UsageSparkline } from "@/components/usage-sparkline"
import { PluginError } from "@/components/plugin-error"
import { useNowTicker } from "@/hooks/use-now-ticker"
import { REFRESH_COOLDOWN_MS, type DisplayMode, type ResetTimerDisplayMode, type TimeFormatMode } from "@/lib/settings"
import type { ManifestLine, MetricLine, PluginLink } from "@/lib/plugin-types"
import { groupLinesByType } from "@/lib/group-lines-by-type"
import { clamp01, formatCountNumber, formatFixedPrecisionNumber } from "@/lib/utils"
import { calculateDeficit, calculatePaceStatus, type PaceStatus } from "@/lib/pace-status"
import { formatDeficitText, getPaceStatusText } from "@/lib/pace-tooltip"
import { isMoneyLine, tokenUsageText } from "@/lib/token-usage"
import { countUnit, formatRelativeTime, metricLabel } from "@/lib/locale"
import { formatResetAbsoluteLabel, formatResetRelativeLabel, formatResetTooltipText } from "@/lib/reset-tooltip"
import { SupplementaryUsagePanel, isSupplementaryUsageLine } from "@/components/supplementary-usage-panel"
import { TokenReportPanel } from "@/components/token-report-panel"
import type { TokenUsageReport } from "@/lib/token-report"
import { quotaMetricKey, useRecentQuotaPace } from "@/hooks/use-recent-quota-pace"
import type { RecentQuotaForecast } from "@/lib/recent-quota-pace"

interface ProviderCardProps {
  providerId?: string
  name: string
  iconUrl?: string
  brandColor?: string
  dashboard?: boolean
  plan?: string
  links?: PluginLink[]
  showSeparator?: boolean
  loading?: boolean
  error?: string | null
  lines?: MetricLine[]
  skeletonLines?: ManifestLine[]
  lastManualRefreshAt?: number | null
  lastUpdatedAt?: number | null
  tokenUsageReport?: TokenUsageReport
  onRetry?: () => void
  scopeFilter?: "overview" | "all"
  displayMode: DisplayMode
  resetTimerDisplayMode?: ResetTimerDisplayMode
  timeFormatMode?: TimeFormatMode
  onResetTimerDisplayModeToggle?: () => void
}

const PACE_VISUALS: Record<PaceStatus, { dotClass: string }> = {
  ahead: { dotClass: "bg-green-500" },
  "on-track": { dotClass: "bg-yellow-500" },
  behind: { dotClass: "bg-red-500" },
}

/** Colored dot indicator showing pace status */
function PaceIndicator({
  status,
  detailText,
  isLimitReached,
}: {
  status: PaceStatus
  detailText?: string | null
  isLimitReached?: boolean
}) {
  const colorClass = PACE_VISUALS[status].dotClass

  const statusText = getPaceStatusText(status)

  return (
    <Tooltip>
      <TooltipTrigger
        render={(props) => (
          <span
            {...props}
            className={`inline-block w-2 h-2 rounded-full ${colorClass}`}
            aria-label={isLimitReached ? "額度已用盡" : statusText}
          />
        )}
      />
      <TooltipContent side="top" className="text-xs text-center">
        {isLimitReached ? (
          "額度已用盡"
        ) : (
          <>
            <div>週期平均：{statusText}</div>
            {detailText && <div className="text-[10px] opacity-60">{detailText}</div>}
          </>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

export function ProviderCard({
  providerId,
  name,
  iconUrl,
  brandColor,
  dashboard = false,
  plan,
  links = [],
  showSeparator = true,
  loading = false,
  error = null,
  lines = [],
  skeletonLines = [],
  lastManualRefreshAt,
  lastUpdatedAt,
  tokenUsageReport,
  onRetry,
  scopeFilter = "all",
  displayMode,
  resetTimerDisplayMode = "relative",
  timeFormatMode = "auto",
  onResetTimerDisplayModeToggle,
}: ProviderCardProps) {
  const cooldownRemainingMs = useMemo(() => {
    if (!lastManualRefreshAt) return 0
    const remaining = REFRESH_COOLDOWN_MS - (Date.now() - lastManualRefreshAt)
    return remaining > 0 ? remaining : 0
  }, [lastManualRefreshAt])

  // Filter lines based on scope - match by label since runtime lines can differ from manifest
  const overviewLabels = new Set(
    skeletonLines
      .filter(line => line.scope === "overview")
      .map(line => line.label)
  )
  const filteredSkeletonLines = scopeFilter === "all"
    ? skeletonLines
    : skeletonLines.filter(line => line.scope === "overview")
  const showSupplementary = dashboard || Boolean(tokenUsageReport) || providerId === "claude" || providerId === "codex"
  const tokenIssue = lines.find((line) => line.type === "badge" && line.label === "Token usage")
  const tokenLines = dashboard ? lines.flatMap((line) => {
    const value = tokenUsageText(line)
    return value ? [{ label: line.label, value }] : []
  }) : []
  const filteredLines = (scopeFilter === "all"
    ? lines
    : lines.filter(line => line.type === "progress"
      ? Number.isFinite(line.used) && Number.isFinite(line.limit) && line.limit > 0
      : overviewLabels.has(line.label)))
    .filter(line => !showSupplementary || !isSupplementaryUsageLine(line))
    .filter(line => !tokenUsageReport || line.type === "progress" || line.type === "badge" || (line.type === "text" && line.label === "Note"))
    .filter(line => !tokenUsageReport || (!tokenUsageText(line) && !(line.type === "badge" && line.label === "Token usage")))
    .filter(line => !dashboard || (!isMoneyLine(line) && line !== tokenIssue && !(line.type === "text" && tokenUsageText(line))))

  const hasResetCountdown = filteredLines.some(
    (line) => line.type === "progress" && Boolean(line.resetsAt)
  )

  // "has ever loaded" — true if either we have a prior success timestamp,
  // or the parent is passing lines directly (tests + legacy state paths).
  const hasStaleData = lastUpdatedAt != null || filteredLines.length > 0 || tokenLines.length > 0
  const isRefreshingWithData = loading && hasStaleData

  const tickerIntervalMs = cooldownRemainingMs > 0 ? 1000 : 30_000

  const now = useNowTicker({
    enabled: cooldownRemainingMs > 0 || hasResetCountdown,
    intervalMs: tickerIntervalMs,
    stopAfterMs: cooldownRemainingMs > 0 && !hasResetCountdown ? cooldownRemainingMs : null,
  })
  const recentForecasts = useRecentQuotaPace({ providerId, sourceId: tokenUsageReport?.sourceId, lines, observedAt: lastUpdatedAt, now: Math.max(now, Date.now()),
    stale: Boolean(error) || (lastUpdatedAt != null && now - lastUpdatedAt > 10 * 60_000), displayMode })

  const inCooldown = !error && lastManualRefreshAt
    ? now - lastManualRefreshAt < REFRESH_COOLDOWN_MS
    : false

  const visibleLinks = useMemo(
    () =>
      links
        .map((link) => ({
          label: link.label.trim(),
          url: link.url.trim(),
        }))
        .filter(
          (link) =>
            link.label.length > 0 &&
            link.url.length > 0 &&
            (link.url.startsWith("https://") || link.url.startsWith("http://"))
        ),
    [links]
  )

  // Format remaining cooldown time as "Xm Ys"
  const formatRemainingTime = () => {
    if (!lastManualRefreshAt) return ""
    const remainingMs = REFRESH_COOLDOWN_MS - (now - lastManualRefreshAt)
    if (remainingMs <= 0) return ""
    const totalSeconds = Math.ceil(remainingMs / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    if (minutes > 0) {
      return `${minutes} 分 ${seconds} 秒後可重新整理`
    }
    return `${seconds} 秒後可重新整理`
  }

  return (
    <section aria-label={`${name} 額度`} className={dashboard ? "min-w-0 rounded-2xl border border-border/70 bg-card p-4 shadow-sm" : undefined}>
      <div className={dashboard ? undefined : "py-3"}>
        <div className="flex items-center justify-between mb-2">
          <div className="relative flex min-w-0 items-center gap-1">
            {iconUrl && <span aria-hidden="true" className="mr-1 size-7 shrink-0" style={{ backgroundColor: brandColor ?? "currentColor", maskImage: `url("${iconUrl}")`, WebkitMaskImage: `url("${iconUrl}")`, maskSize: "contain", WebkitMaskSize: "contain", maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat", maskPosition: "center", WebkitMaskPosition: "center" }} />}
            <h2 className="min-w-0 truncate text-base font-semibold" style={{ transform: "translateZ(0)" }}>{name}</h2>
            {onRetry && (
              loading ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="ml-1 pointer-events-none opacity-50"
                  style={{ transform: "translateZ(0)", backfaceVisibility: "hidden" }}
                  tabIndex={-1}
                >
                  <RefreshCw className="h-3 w-3 animate-spin" />
                </Button>
              ) : inCooldown ? (
                <Tooltip>
                  <TooltipTrigger
                    className="ml-1"
                    render={(props) => (
                      <span {...props} className={props.className}>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="pointer-events-none opacity-50"
                          style={{ transform: "translateZ(0)", backfaceVisibility: "hidden" }}
                          tabIndex={-1}
                        >
                          <Hourglass className="h-3 w-3" />
                        </Button>
                      </span>
                    )}
                  />
                  <TooltipContent side="top">
                    {formatRemainingTime()}
                  </TooltipContent>
                </Tooltip>
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    className="ml-1"
                    render={(props) => (
                      <Button
                        {...props}
                        variant="ghost"
                        size="icon-xs"
                        aria-label="重新整理"
                        onClick={(e) => {
                          e.currentTarget.blur()
                          onRetry()
                        }}
                        className="opacity-0 hover:opacity-100 focus-visible:opacity-100"
                        style={{ transform: "translateZ(0)", backfaceVisibility: "hidden" }}
                      >
                        <RefreshCw className="h-3 w-3" />
                      </Button>
                    )}
                  />
                  {lastUpdatedAt != null && (
                    <TooltipContent side="top">
                      更新於 {formatRelativeTime(Date.now() - lastUpdatedAt)}
                    </TooltipContent>
                  )}
                </Tooltip>
              )
            )}
          </div>
          {plan && (
            <Badge
              variant="outline"
              className="truncate min-w-0 max-w-[50%]"
              title={plan}
            >
              {plan}
            </Badge>
          )}
        </div>
        {visibleLinks.length > 0 && (
          <div className="mb-2 -mt-0.5 flex flex-wrap gap-1.5">
            {visibleLinks.map((link) => (
              <Button
                key={`${link.label}-${link.url}`}
                variant="outline"
                size="xs"
                className="h-6 max-w-full text-[11px]"
                onClick={() => {
                  openUrl(link.url).catch(console.error)
                }}
              >
                <span className="truncate">{link.label}</span>
                <ExternalLink className="size-3 opacity-70" />
              </Button>
            ))}
          </div>
        )}
        {tokenUsageReport && <TokenReportPanel report={tokenUsageReport} now={now} stale={Boolean(error) || (lastUpdatedAt != null && now - lastUpdatedAt > 10 * 60_000)} />}
        {dashboard && !tokenUsageReport && (
          <div className="mb-4 rounded-xl bg-muted/40 p-3" aria-label={`${name} Token 用量`}>
            <h3 className="mb-2 text-xs font-medium text-muted-foreground">Token 用量</h3>
            {tokenLines.length > 0 ? (
              <dl className="space-y-2">
                {tokenLines.map((line, index) => (
                  <div key={`${line.label}-${index}`} className="flex items-baseline justify-between gap-3">
                    <dt className="min-w-0 text-xs text-muted-foreground">{metricLabel(line.label)}</dt>
                    <dd className="shrink-0 text-base font-semibold tabular-nums">{line.value}</dd>
                  </div>
                ))}
              </dl>
            ) : <p className="text-sm text-muted-foreground">{loading ? "正在更新用量…" : tokenIssue?.type === "badge" ? tokenIssue.text : "未提供 Token 用量"}</p>}
          </div>
        )}

        {showSupplementary && <SupplementaryUsagePanel lines={lines} hasTokenReport={Boolean(tokenUsageReport)} stale={Boolean(error) || (lastUpdatedAt != null && now - lastUpdatedAt > 10 * 60_000)} />}

        {hasStaleData && (loading || error) && (
          <p role="status" className="mb-2 text-xs text-muted-foreground">
            {error ? "資料可能已過期，顯示上次成功資料" : "正在更新，顯示上次成功資料"}
            {lastUpdatedAt != null && <span className="block">上次成功更新：{new Date(lastUpdatedAt).toLocaleString("zh-TW")}</span>}
          </p>
        )}

        {error && !hasStaleData && <PluginError message={error} />}

        {error && hasStaleData && (
          <Tooltip>
            <TooltipTrigger
              render={(props) => (
                <div
                  {...props}
                  className="flex items-center gap-1.5 mb-2 text-xs text-destructive"
                >
                  <AlertCircle className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate">{error}</span>
                </div>
              )}
            />
            <TooltipContent side="top" className="max-w-xs break-words text-xs">
              {error}
            </TooltipContent>
          </Tooltip>
        )}

        {loading && !hasStaleData && !error && (
          <SkeletonLines lines={filteredSkeletonLines.map(line => ({ ...line, label: metricLabel(line.label) }))} />
        )}

        {!loading && !error && filteredLines.length === 0 && <p className="py-3 text-sm text-muted-foreground">尚無額度資料</p>}

        {hasStaleData && (
          <div className="space-y-4">
            {groupLinesByType(filteredLines).map((group, gi) =>
              group.kind === "text" ? (
                <div key={gi} className="space-y-1">
                  {group.lines.map((line, li) => (
                    <MetricLineRenderer
                      key={`${line.label}-${gi}-${li}`}
                      line={line}
                      displayMode={displayMode}
                      resetTimerDisplayMode={resetTimerDisplayMode}
                      timeFormatMode={timeFormatMode}
                      onResetTimerDisplayModeToggle={onResetTimerDisplayModeToggle}
                      now={now}
                      refreshing={isRefreshingWithData}
                      stale={Boolean(error) || (lastUpdatedAt != null && now - lastUpdatedAt > 10 * 60_000)}
                      recentForecast={line.type === "progress" ? recentForecasts.get(quotaMetricKey(line)) : null}
                    />
                  ))}
                </div>
              ) : (
                <Fragment key={gi}>
                  {group.lines.map((line, li) => (
                    <MetricLineRenderer
                      key={`${line.label}-${gi}-${li}`}
                      line={line}
                      displayMode={displayMode}
                      resetTimerDisplayMode={resetTimerDisplayMode}
                      timeFormatMode={timeFormatMode}
                      onResetTimerDisplayModeToggle={onResetTimerDisplayModeToggle}
                      now={now}
                      refreshing={isRefreshingWithData}
                      stale={Boolean(error) || (lastUpdatedAt != null && now - lastUpdatedAt > 10 * 60_000)}
                      recentForecast={line.type === "progress" ? recentForecasts.get(quotaMetricKey(line)) : null}
                    />
                  ))}
                </Fragment>
              )
            )}
          </div>
        )}

      </div>
      {showSeparator && !dashboard && <Separator />}
    </section>
  )
}

function MetricLineRenderer({
  line,
  displayMode,
  resetTimerDisplayMode,
  timeFormatMode,
  onResetTimerDisplayModeToggle,
  now,
  refreshing,
  stale = false,
  recentForecast,
}: {
  line: MetricLine
  displayMode: DisplayMode
  resetTimerDisplayMode: ResetTimerDisplayMode
  timeFormatMode: TimeFormatMode
  onResetTimerDisplayModeToggle?: () => void
  now: number
  refreshing?: boolean
  stale?: boolean
  recentForecast?: RecentQuotaForecast | null
}) {
  if (line.type === "text") {
    return (
      <div>
        <div className="flex justify-between items-center h-[18px] gap-2">
          <span className="text-xs text-muted-foreground min-w-0 truncate" title={metricLabel(line.label)}>
            {metricLabel(line.label)}
          </span>
          <span
            className="text-xs text-muted-foreground truncate flex-shrink-0 max-w-[45%] text-right"
            style={line.color ? { color: line.color } : undefined}
            title={line.value}
          >
            {line.value}
          </span>
        </div>
        {line.subtitle && (
          <div className="text-[10px] text-muted-foreground text-right -mt-0.5">{line.subtitle}</div>
        )}
      </div>
    )
  }

  if (line.type === "badge") {
    return (
      <div>
        <div className="flex justify-between items-center h-[22px]">
          <span className="text-sm text-muted-foreground flex-shrink-0">{metricLabel(line.label)}</span>
          <Badge
            variant="outline"
            className="truncate min-w-0 max-w-[60%]"
            style={
              line.color
                ? { color: line.color, borderColor: line.color }
                : undefined
            }
            title={line.text}
          >
            {line.text}
          </Badge>
        </div>
        {line.subtitle && (
          <div className="text-xs text-muted-foreground text-right -mt-0.5">{line.subtitle}</div>
        )}
      </div>
    )
  }

  if (line.type === "barChart") {
    return (
      <UsageSparkline label={metricLabel(line.label)} points={line.points} note={line.note} color={line.color} />
    )
  }

  if (line.type === "progress") {
    const resetsAtMs = line.resetsAt ? Date.parse(line.resetsAt) : Number.NaN
    const periodDurationMs = line.periodDurationMs
    const hasPaceContext = !stale && Number.isFinite(resetsAtMs) && Number.isFinite(periodDurationMs)
    const hasTimeMarkerContext = hasPaceContext && periodDurationMs! > 0
    const shownAmount =
      displayMode === "used"
        ? line.used
        : Math.max(0, line.limit - line.used)
    const percent = Math.round(clamp01(shownAmount / line.limit) * 10000) / 100
    const amountPrefix = displayMode === "left" ? "剩餘 " : "已用 "

    const primaryText =
      line.format.kind === "percent"
        ? `${amountPrefix}${Math.round(shownAmount)}%`
        : line.format.kind === "dollars"
          ? `${amountPrefix}$${formatFixedPrecisionNumber(shownAmount)}`
          : `${amountPrefix}${formatCountNumber(shownAmount)} ${countUnit(line.format.suffix)}`

    const resetLabel = line.resetsAt
      ? resetTimerDisplayMode === "absolute"
        ? formatResetAbsoluteLabel(now, line.resetsAt, timeFormatMode)
        : formatResetRelativeLabel(now, line.resetsAt)
      : null
    const resetTooltipText = line.resetsAt
      ? formatResetTooltipText({
          nowMs: now,
          resetsAtIso: line.resetsAt,
          visibleMode: resetTimerDisplayMode,
          timeFormatMode,
        })
      : null

    const secondaryText =
      resetLabel ??
      (line.format.kind === "percent"
        ? `上限 ${formatCountNumber(line.limit)}%`
        : line.format.kind === "dollars"
          ? `上限 $${formatFixedPrecisionNumber(line.limit)}`
          : `上限 ${formatCountNumber(line.limit)} ${countUnit(line.format.suffix)}`)

    // Calculate pace status if we have reset time and period duration
    const paceResult = hasPaceContext
      ? calculatePaceStatus(line.used, line.limit, resetsAtMs, periodDurationMs!, now)
      : null
    const paceStatus = paceResult?.status ?? null
    const paceMarkerValue = hasTimeMarkerContext && paceStatus && paceStatus !== "on-track"
      ? (() => {
          const periodStartMs = resetsAtMs - periodDurationMs!
          const elapsedFraction = clamp01((now - periodStartMs) / periodDurationMs!)
          const elapsedPercent = elapsedFraction * 100
          return displayMode === "used" ? elapsedPercent : 100 - elapsedPercent
        })()
      : undefined
    const isLimitReached = line.used >= line.limit
    const paceDetailText =
      hasPaceContext && !isLimitReached
        ? recentForecast?.detailText ?? "近期增量不足，暫不預測耗盡時間"
        : null

    const deficit = hasPaceContext && !isLimitReached
      ? calculateDeficit(line.used, line.limit, resetsAtMs, periodDurationMs!, now)
      : null
    const deficitText = deficit !== null
      ? formatDeficitText(deficit, line.format, displayMode)
      : null
    const runsOutText = hasPaceContext && !isLimitReached ? recentForecast?.runsOutText : null

    return (
      <div>
        <div className="text-sm font-medium mb-1.5 flex items-center gap-1.5">
          {metricLabel(line.label)}
          {paceStatus && (
            <PaceIndicator status={paceStatus} detailText={paceDetailText} isLimitReached={isLimitReached} />
          )}
        </div>
        <Progress
          aria-label={metricLabel(line.label)}
          value={percent}
          indicatorColor={line.color}
          markerValue={paceMarkerValue}
          refreshing={refreshing}
        />
        <div className="flex justify-between items-center mt-1.5">
          <span className="text-xs text-muted-foreground tabular-nums">
            {primaryText}
          </span>
          {secondaryText && (
            resetTooltipText ? (
              <Tooltip>
                <TooltipTrigger
                  render={(props) =>
                    resetLabel && onResetTimerDisplayModeToggle ? (
                      <button
                        {...props}
                        type="button"
                        onClick={onResetTimerDisplayModeToggle}
                        className="text-xs text-muted-foreground tabular-nums hover:text-foreground transition-colors"
                      >
                        {secondaryText}
                      </button>
                    ) : (
                      <span {...props} className="text-xs text-muted-foreground tabular-nums">
                        {secondaryText}
                      </span>
                    )
                  }
                />
                <TooltipContent side="top">{resetTooltipText}</TooltipContent>
              </Tooltip>
            ) : resetLabel && onResetTimerDisplayModeToggle ? (
              <button
                type="button"
                onClick={onResetTimerDisplayModeToggle}
                className="text-xs text-muted-foreground tabular-nums hover:text-foreground transition-colors"
              >
                {secondaryText}
              </button>
            ) : (
              <span className="text-xs text-muted-foreground">
                {secondaryText}
              </span>
            )
          )}
        </div>
        {(deficitText || runsOutText) && (
          <div className="flex justify-between items-center mt-0.5">
            {deficitText && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {deficitText}
              </span>
            )}
            {runsOutText && (
              <span className="text-xs text-muted-foreground tabular-nums ml-auto">
                {runsOutText}
              </span>
            )}
          </div>
        )}
      </div>
    )
  }

  return null
}
