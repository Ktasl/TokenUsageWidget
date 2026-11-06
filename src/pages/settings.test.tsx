import { cleanup, render, screen, within } from "@testing-library/react"
import type { ReactNode } from "react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

let latestOnDragEnd: ((event: any) => void) | undefined

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children, onDragEnd }: { children: ReactNode; onDragEnd?: (event: any) => void }) => {
    latestOnDragEnd = onDragEnd
    return <div data-testid="dnd-context">{children}</div>
  },
  closestCenter: vi.fn(),
  PointerSensor: class {},
  KeyboardSensor: class {},
  useSensor: vi.fn((_sensor: any, options?: any) => ({ sensor: _sensor, options })),
  useSensors: vi.fn((...sensors: any[]) => sensors),
}))

vi.mock("@dnd-kit/sortable", () => ({
  arrayMove: (items: any[], from: number, to: number) => {
    const next = [...items]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    return next
  },
  SortableContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  sortableKeyboardCoordinates: vi.fn(),
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  verticalListSortingStrategy: vi.fn(),
}))

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => "" } },
}))

import { SettingsPage } from "@/pages/settings"

const defaultProps = {
  plugins: [{ id: "a", name: "Alpha", enabled: true }],
  onReorder: vi.fn(),
  onToggle: vi.fn(),
  onMetricChange: vi.fn(),
  autoUpdateInterval: 15 as const,
  onAutoUpdateIntervalChange: vi.fn(),
  themeMode: "system" as const,
  onThemeModeChange: vi.fn(),
  displayMode: "used" as const,
  onDisplayModeChange: vi.fn(),
  resetTimerDisplayMode: "relative" as const,
  onResetTimerDisplayModeChange: vi.fn(),
  timeFormatMode: "auto" as const,
  onTimeFormatModeChange: vi.fn(),
  menubarIconStyle: "provider" as const,
  onMenubarIconStyleChange: vi.fn(),
  menubarMetric: "default" as const,
  onMenubarMetricChange: vi.fn(),
  traySettingsPreview: {
    providerItems: [{ id: "a", fraction: 0.7, percentText: "70%", iconUrl: "icon-a" }],
    bars: [{ id: "a", fraction: 0.7 }],
    providerBars: [{ id: "a", fraction: 0.7 }],
    providerIconUrl: "icon-a",
    providerPercentText: "70%",
  },
  globalShortcut: null,
  onGlobalShortcutChange: vi.fn(),
  startOnLogin: false,
  onStartOnLoginChange: vi.fn(),
}

afterEach(() => {
  cleanup()
})

async function openServices() { await userEvent.click(screen.getByRole("tab", { name: "服務與模型" })) }
async function openSystem() { await userEvent.click(screen.getByRole("tab", { name: "更新與系統" })) }

describe("SettingsPage", () => {
  it("defaults to display and groups settings into three categories", async () => {
    render(<SettingsPage {...defaultProps} />)
    expect(screen.getByRole("tab", { name: "顯示與外觀" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByText("介面主題")).toBeInTheDocument()
    expect(screen.queryByText("我的 AI 服務")).not.toBeInTheDocument()
    await openServices()
    expect(screen.getByText("我的 AI 服務")).toBeInTheDocument()
    expect(screen.queryByText("介面主題")).not.toBeInTheDocument()
    await openSystem()
    expect(screen.getByText("自動更新額度")).toBeInTheDocument()
    expect(screen.queryByText("我的 AI 服務")).not.toBeInTheDocument()
  })

  it("supports keyboard category navigation", async () => {
    render(<SettingsPage {...defaultProps} />)
    screen.getByRole("tab", { name: "顯示與外觀" }).focus()
    await userEvent.keyboard("{ArrowRight}")
    expect(screen.getByRole("tab", { name: "服務與模型" })).toHaveFocus()
    expect(screen.getByRole("tab", { name: "服務與模型" })).toHaveAttribute("aria-selected", "true")
    await userEvent.keyboard("{End}")
    expect(screen.getByRole("tab", { name: "更新與系統" })).toHaveFocus()
    await userEvent.keyboard("{Home}")
    expect(screen.getByRole("tab", { name: "顯示與外觀" })).toHaveFocus()
  })

  it("toggles an enabled service through its labelled checkbox", async () => {
    const onToggle = vi.fn()
    render(<SettingsPage {...defaultProps} plugins={[{ id: "b", name: "Beta", enabled: false }]} onToggle={onToggle} />)
    await openServices()
    await userEvent.click(screen.getByRole("checkbox", { name: "啟用 Beta" }))
    expect(onToggle).toHaveBeenCalledOnce()
    expect(onToggle).toHaveBeenCalledWith("b")
  })

  it("reorders services on drag end", async () => {
    const onReorder = vi.fn()
    render(<SettingsPage {...defaultProps} plugins={[{ id: "a", name: "Alpha", enabled: true }, { id: "b", name: "Beta", enabled: true }]} onReorder={onReorder} />)
    await openServices()
    latestOnDragEnd?.({ active: { id: "a" }, over: { id: "b" } })
    expect(onReorder).toHaveBeenCalledWith(["b", "a"])
  })

  it("ignores missing, unchanged, and unknown drag targets", async () => {
    const onReorder = vi.fn()
    render(<SettingsPage {...defaultProps} onReorder={onReorder} />)
    await openServices()
    latestOnDragEnd?.({ active: { id: "a" }, over: null })
    latestOnDragEnd?.({ active: { id: "a" }, over: { id: "a" } })
    latestOnDragEnd?.({ active: { id: "a" }, over: { id: "unknown" } })
    expect(onReorder).not.toHaveBeenCalled()
  })

  it("selects a service metric while preserving its raw label", async () => {
    const onMetricChange = vi.fn()
    render(<SettingsPage {...defaultProps} onMetricChange={onMetricChange} plugins={[{
      id: "a", name: "Alpha", enabled: true, selectedMetric: "",
      metricOptions: [{ value: "Session", label: "Session" }, { value: "Weekly", label: "Weekly" }],
    }]} />)
    await openServices()
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Alpha 的選單列模型／額度" }), "Weekly")
    expect(onMetricChange).toHaveBeenCalledWith("a", "Weekly")
  })

  it("allows returning a service metric to automatic", async () => {
    const onMetricChange = vi.fn()
    render(<SettingsPage {...defaultProps} onMetricChange={onMetricChange} plugins={[{
      id: "a", name: "Alpha", enabled: true, selectedMetric: "Weekly", metricOptions: [{ value: "Weekly", label: "Weekly" }],
    }]} />)
    await openServices()
    await userEvent.selectOptions(screen.getByRole("combobox"), "")
    expect(onMetricChange).toHaveBeenCalledWith("a", "")
  })

  it("retains the selected label when it temporarily has no quota data", async () => {
    render(<SettingsPage {...defaultProps} plugins={[{ id: "a", name: "Alpha", enabled: true, selectedMetric: "GPT Custom", metricOptions: [{ value: "Weekly", label: "Weekly" }] }]} />)
    await openServices()
    expect(screen.getByRole("combobox")).toHaveValue("GPT Custom")
    expect(screen.getByRole("option", { name: "GPT Custom（暫無資料）" })).toBeInTheDocument()
    expect(screen.getByText(/指定項目沒有有效資料時/)).toBeInTheDocument()
  })

  it("explains when a service has no selectable quota", async () => {
    render(<SettingsPage {...defaultProps} />)
    await openServices()
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
    expect(screen.getByText("尚無可選額度，取得資料後即可選擇。")).toBeInTheDocument()
  })

  it("updates the refresh interval under system settings", async () => {
    const onAutoUpdateIntervalChange = vi.fn()
    render(<SettingsPage {...defaultProps} onAutoUpdateIntervalChange={onAutoUpdateIntervalChange} />)
    await openSystem()
    await userEvent.click(screen.getByRole("radio", { name: "30分鐘" }))
    expect(onAutoUpdateIntervalChange).toHaveBeenCalledWith(30)
  })

  it("updates the theme", async () => {
    const onThemeModeChange = vi.fn()
    render(<SettingsPage {...defaultProps} onThemeModeChange={onThemeModeChange} />)
    await userEvent.click(screen.getByRole("radio", { name: "深色" }))
    expect(onThemeModeChange).toHaveBeenCalledWith("dark")
  })

  it("updates remaining versus used display", async () => {
    const onDisplayModeChange = vi.fn()
    render(<SettingsPage {...defaultProps} onDisplayModeChange={onDisplayModeChange} />)
    await userEvent.click(screen.getByRole("radio", { name: "剩餘" }))
    expect(onDisplayModeChange).toHaveBeenCalledWith("left")
  })

  it("updates reset timer display", async () => {
    const onResetTimerDisplayModeChange = vi.fn()
    render(<SettingsPage {...defaultProps} onResetTimerDisplayModeChange={onResetTimerDisplayModeChange} />)
    await userEvent.click(screen.getByRole("radio", { name: "日期時間" }))
    expect(onResetTimerDisplayModeChange).toHaveBeenCalledWith("absolute")
  })

  it.each([["12小時制", "12h"], ["24小時制", "24h"]])("updates the time format to %s", async (label, value) => {
    const onTimeFormatModeChange = vi.fn()
    render(<SettingsPage {...defaultProps} onTimeFormatModeChange={onTimeFormatModeChange} />)
    await userEvent.click(screen.getByRole("radio", { name: label }))
    expect(onTimeFormatModeChange).toHaveBeenCalledWith(value)
  })

  it("states that the preview is abbreviated but the actual menu bar has no service cap", () => {
    render(<SettingsPage {...defaultProps} />)
    expect(screen.getByText("服務圖示會顯示所有已啟用且有有效額度的服務，數量沒有上限。")).toBeInTheDocument()
    expect(screen.getByText("預覽只列部分；實際依已啟用服務顯示。缺資料顯示 --，不當作零或 100%。")).toBeInTheDocument()
  })

  it("selects dual quota and explains Antigravity Gemini and Claude together", async () => {
    const change = vi.fn()
    render(<SettingsPage {...defaultProps} onMenubarIconStyleChange={change} />)
    await userEvent.click(screen.getByRole("radio", { name: "雙額度與倒數" }))
    expect(change).toHaveBeenCalledWith("quota")
    expect(screen.getByText(/Antigravity 為 Gemini、Claude 並列/)).toBeInTheDocument()
  })

  it("offers compact large icons alongside the saved detailed theme", async () => {
    const change = vi.fn()
    render(<SettingsPage {...defaultProps} menubarIconStyle="quota" onMenubarIconStyleChange={change} />)
    expect(screen.getByRole("radio", { name: "雙額度與倒數" })).toHaveAttribute("aria-checked", "true")
    await userEvent.click(screen.getByRole("radio", { name: "圖示大字" }))
    expect(change).toHaveBeenCalledWith("compact")
    expect(screen.getByText(/以圖示與較大的百分比呈現，不顯示時間/)).toBeInTheDocument()
    expect(screen.getByRole("radiogroup", { name: "選單列圖示樣式" }).querySelectorAll('[role="radio"]')).toHaveLength(5)
  })

  it("previews two service icons including zero and counts additional services", () => {
    render(<SettingsPage {...defaultProps} traySettingsPreview={{ ...defaultProps.traySettingsPreview, providerItems: [
      { id: "a", fraction: 0.7, percentText: "70%", iconUrl: "icon-a" },
      { id: "b", fraction: 0, percentText: "0%", iconUrl: "icon-b" },
      { id: "c", fraction: 0.4, percentText: "40%", iconUrl: "icon-c" },
    ] }} />)
    const provider = screen.getByRole("radio", { name: "服務圖示" })
    expect(provider).toHaveTextContent("70%")
    expect(provider).toHaveTextContent("0%")
    expect(provider).toHaveTextContent("+1")
    expect(provider.querySelector('[title="b: 0%"]')).toBeInTheDocument()
  })

  it("keeps the placeholder when no service has quota data", () => {
    render(<SettingsPage {...defaultProps} traySettingsPreview={{ ...defaultProps.traySettingsPreview, providerItems: [], providerPercentText: "--%" }} />)
    expect(screen.getByRole("radio", { name: "服務圖示" })).toHaveTextContent("--%")
  })

  it.each([["長條", "bars"], ["圓環", "donut"]])("changes the menu bar style to %s", async (label, value) => {
    const onMenubarIconStyleChange = vi.fn()
    render(<SettingsPage {...defaultProps} onMenubarIconStyleChange={onMenubarIconStyleChange} />)
    await userEvent.click(screen.getByRole("radio", { name: label }))
    expect(onMenubarIconStyleChange).toHaveBeenCalledWith(value)
  })

  it("changes the automatic quota preference to weekly", async () => {
    const onMenubarMetricChange = vi.fn()
    render(<SettingsPage {...defaultProps} onMenubarMetricChange={onMenubarMetricChange} />)
    const group = screen.getByRole("radiogroup", { name: "選單列額度偏好" })
    expect(within(group).getByRole("radio", { name: "預設" })).toBeInTheDocument()
    await userEvent.click(within(group).getByRole("radio", { name: "每週" }))
    expect(onMenubarMetricChange).toHaveBeenCalledWith("weekly")
  })

  it("toggles start on login under system settings", async () => {
    const onStartOnLoginChange = vi.fn()
    render(<SettingsPage {...defaultProps} onStartOnLoginChange={onStartOnLoginChange} />)
    await openSystem()
    await userEvent.click(screen.getByRole("checkbox", { name: "登入時自動啟動" }))
    expect(onStartOnLoginChange).toHaveBeenCalledWith(true)
  })
})
