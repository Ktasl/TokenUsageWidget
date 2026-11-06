import type { MetricLine } from "@/lib/plugin-types"

export const isSupplementaryUsageLine = (line: MetricLine) => line.label === "Local estimated cost" || line.label === "Extra usage spent"
const validDollars = (value: number) => Number.isFinite(value) && value >= 0
const dollars = (value: number) => `US$ ${value.toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export function SupplementaryUsagePanel({ lines, hasTokenReport = false, stale = false }: {
  lines: MetricLine[]; hasTokenReport?: boolean; stale?: boolean
}) {
  const estimate = lines.find((line): line is Extract<MetricLine, { type: "text" }> => line.type === "text" && line.label === "Local estimated cost" &&
    /^\$\d+(?:\.\d{1,2})?$/.test(line.value) && Number.isFinite(Number(line.value.slice(1))) &&
    /^\d{4}-\d{2}-\d{2} ～ \d{4}-\d{2}-\d{2}；有金額紀錄 \d+\/\d+ 天$/.test(line.subtitle ?? ""))
  const extra = lines.find((line) => line.label === "Extra usage spent" && ((line.type === "progress" && line.format.kind === "dollars" &&
    validDollars(line.used) && validDollars(line.limit) && line.limit > 0) || (line.type === "text" && /^\$\d+(?:\.\d{1,2})?$/.test(line.value) && Number.isFinite(Number(line.value.slice(1))))))
  return <details className="my-3 rounded-xl border border-border p-3 text-xs" aria-label="額外用量資訊">
    <summary className="cursor-pointer font-medium">額外資訊</summary>
    {stale && <p className="mt-2 text-amber-600">上次成功資料，尚未取得最新額外資訊</p>}
    <div className="mt-3 space-y-3">
      <section aria-label="本機估算費用">
        <h3 className="font-medium">本機估算費用（Cost）</h3>
        {estimate ? <><p className="mt-1 text-sm font-semibold tabular-nums">{dollars(Number(estimate.value.slice(1)))}</p><p className="mt-1 text-muted-foreground">{estimate.subtitle}</p></> : <p className="mt-1 text-muted-foreground">來源未提供可信的費用紀錄</p>}
        <p className="mt-1 text-muted-foreground">依本機紀錄與 API 定價估算；不是月費或實際帳單，缺資料不視為零。</p>
      </section>
      <section aria-label="額外用量費用">
        <h3 className="font-medium">額外用量（Extra Usage）</h3>
        {extra?.type === "progress" ? <p className="mt-1 tabular-nums">本月已用 {dollars(extra.used)}／上限 {dollars(extra.limit)}</p> :
          extra?.type === "text" ? <p className="mt-1 tabular-nums">本月已用 {dollars(Number(extra.value.slice(1)))}</p> : <p className="mt-1 text-muted-foreground">來源未提供額外用量費用</p>}
        {extra && <p className="mt-1 text-muted-foreground">供應商回傳的本月額外用量；與本機估算費用分開計算，不相加。</p>}
      </section>
      <section aria-label="每日用量趨勢說明">
        <h3 className="font-medium">每日用量趨勢（Usage Trend）</h3>
        <p className="mt-1 text-muted-foreground">{hasTokenReport ? "請在上方本機 Token 統計切換本週、上週或最近 7 天；沿用同一份每日紀錄。" : "來源未提供可用的每日 Token 紀錄。"}</p>
      </section>
    </div>
  </details>
}
