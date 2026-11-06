import { useState } from "react"
import { summarizeTokens, type TokenPeriod, type TokenUsageReport } from "@/lib/token-report"
import { formatCountNumber } from "@/lib/utils"

const reasons: Record<string, string> = {
  no_runner: "Token 統計工具尚未就緒", timed_out: "Token 統計逾時，額度不受影響",
  probe_budget_exhausted: "本次先更新額度，Token 統計稍後再試",
  legacy_duplicate_risk: "舊版統計工具可能重複計數，暫不提供累計",
  timezone_unconfirmed: "來源時區未確認，暫不提供每週統計",
}
const count = (value: number | null) => value === null ? "未取得資料" : `${formatCountNumber(value)} Token`

export function TokenReportPanel({ report, now = Date.now(), stale = false }: { report: TokenUsageReport; now?: number; stale?: boolean }) {
  const [period, setPeriod] = useState<TokenPeriod>("week")
  const current = summarizeTokens(report, "week", now)
  const previous = summarizeTokens(report, "previous", now)
  const selected = summarizeTokens(report, period, now)
  const max = Math.max(1, ...selected.days.map((day) => day.data?.totalTokens ?? 0))
  const total = selected.totalTokens
  return (
    <section className="my-3 rounded-xl bg-muted/40 p-3" aria-label="每週 Token 統計">
      <h3 className="text-xs font-medium text-muted-foreground">本機 Token 統計</h3>
      <p className="mt-1 text-[10px] text-muted-foreground">台灣時間・週一起算・本機紀錄，非登入帳號帳單</p>
      {stale && <p className="mt-1 text-xs text-amber-600">上次成功統計，尚未取得最新資料</p>}
      <dl className="my-3 grid grid-cols-2 gap-2">
        {[ ["本週累計", current], ["上週累計", previous] ] .map(([label, summary]) => {
          const s = summary as typeof current
          return <div key={String(label)}><dt className="text-xs text-muted-foreground">{String(label)}</dt><dd className="text-base font-semibold tabular-nums">{count(s.totalTokens)}</dd><dd className="text-[10px] text-muted-foreground">{s.start} ～ {s.end} · 有紀錄 {s.knownDays} 天</dd></div>
        })}
      </dl>
      {report.status !== "ok" || total === null ? <p className="text-xs text-muted-foreground">{reasons[report.reason ?? ""] ?? "來源資料不足，無法確認 Token 統計"}</p> : null}
      <p className="text-[10px] text-muted-foreground">本週與上週長度及紀錄涵蓋可能不同，避免直接換算增減百分比。</p>
      <div className="my-3 flex gap-1" aria-label="統計期間">
        {([["week", "本週"], ["previous", "上週"], ["recent", "最近 7 天"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={period === value} onClick={() => setPeriod(value)} className={`rounded-md border px-2 py-1 text-xs ${period === value ? "bg-primary text-primary-foreground" : "bg-background"}`}>{label}</button>)}
      </div>
      <p className="mb-2 text-xs tabular-nums">期間已知合計：{count(total)}</p>
      <div className="flex h-24 items-end gap-1" role="img" aria-label="每日 Token 用量，缺資料以虛線表示">
        {selected.days.map(({ date, data }) => <div key={date} className="flex h-full min-w-0 flex-1 flex-col justify-end gap-1 text-center" title={`${date}：${count(data?.totalTokens ?? null)}`}>
          <span className="text-[9px] text-muted-foreground">{data ? formatCountNumber(data.totalTokens) : "未知"}</span>
          <div className={data ? "min-h-1 rounded-t bg-primary/70" : "min-h-1 border-t border-dashed border-muted-foreground"} style={{ height: data ? `${Math.max(3, data.totalTokens / max * 55)}%` : 3 }} />
          <span className="text-[10px] text-muted-foreground">{date.slice(5)}</span>
        </div>)}
      </div>
      <p className="mt-2 text-[10px] text-muted-foreground">有紀錄 {selected.knownDays} 天／缺資料 {selected.missingDays} 天；無紀錄不代表零用量，今天尚未結束。</p>
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-muted-foreground">模型與輸入／輸出明細</summary>
        <dl className="mt-2 space-y-1">
          {selected.models.map((model) => <div key={model.name} className="flex justify-between gap-2"><dt className="break-all">{model.name}</dt><dd className="shrink-0 tabular-nums">{count(model.totalTokens)}{total && total > 0 ? ` · ${(100 * model.totalTokens / total).toFixed(1)}%` : ""}</dd></div>)}
          <div className="flex justify-between"><dt>模型未分類</dt><dd>{count(selected.unclassifiedTokens)}</dd></div>
          {([ ["inputTokens", "輸入"], ["outputTokens", "輸出"], ["cachedTokens", "快取（可能包含在輸入內）"] ] as const).map(([key, label]) => {
            const known = selected.days.flatMap((day) => day.data && day.data[key] !== undefined ? [day.data[key]!] : [])
            const sum = known.reduce((a, b) => a + b, 0)
            return <div key={key} className="flex justify-between gap-2"><dt>{label}</dt><dd>{count(known.length && Number.isSafeInteger(sum) ? sum : null)}</dd></div>
          })}
        </dl>
        <p className="mt-2 text-muted-foreground">分項可能只涵蓋部分日期；不與來源總量再次相加。專案／對話／子代理歸因尚未由每日來源提供。</p>
      </details>
    </section>
  )
}
