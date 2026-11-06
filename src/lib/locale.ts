export const DISPLAY_LOCALE = "zh-TW"

const METRIC_LABELS: Record<string, string> = {
  session: "本次工作階段", weekly: "每週額度", monthly: "每月額度",
  today: "今日", yesterday: "昨日", "last 30 days": "最近 30 天",
  todaytokens: "今日 Token 用量", yesterdaytokens: "昨日 Token 用量", last30daystokens: "最近 30 天 Token 用量",
  "extra usage spent": "額外使用量",
  daily: "每日額度", usage: "使用量", extrausage: "額外使用量",
  "extra usage": "額外使用量", credits: "點數", requests: "請求次數",
  tokens: "Token 數", "token usage": "Token 統計", balance: "餘額", cost: "費用", spending: "支出",
  "total cost": "總費用", "monthly cost": "本月費用", plan: "方案",
  "rate limit": "速率限制", "premium requests": "進階請求",
}

/** Translate display copy only; raw provider labels remain lookup keys. */
export function metricLabel(rawLabel: string): string {
  return METRIC_LABELS[rawLabel.trim().toLowerCase()] ?? rawLabel
}

export function countUnit(rawUnit: string): string {
  const units: Record<string, string> = {
    credits: "點數", credit: "點數", requests: "次請求", request: "次請求",
    tokens: "Token", token: "Token", messages: "則訊息", message: "則訊息",
  }
  return units[rawUnit.trim().toLowerCase()] ?? rawUnit
}

export function formatRelativeTime(diffMs: number): string {
  const seconds = Math.floor(Math.max(0, diffMs) / 1000)
  if (seconds < 60) return "剛剛"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分鐘前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小時前`
  return `${Math.floor(hours / 24)} 天前`
}
