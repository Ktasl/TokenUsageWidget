import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { MenubarIconStylePreview } from "./menubar-icon-style-preview"
import type { TraySettingsPreview } from "@/hooks/app/use-tray-icon"

const preview: TraySettingsPreview = { bars: [], providerBars: [], providerItems: [], providerPercentText: "--%", summaryIconUrls: { claude: "claude.svg", antigravity: "agy.svg" } }
const row = (key: string, remainingPercent: number | null) => ({ key, label: key, remainingPercent, countdown: "3h20m", status: "fresh" as const })

describe("compact native theme preview", () => {
  it("shows large session and weekly values including zero with a brand icon and no countdown", () => {
    const { container } = render(<MenubarIconStylePreview style="compact" isActive traySettingsPreview={{ ...preview, summaryGroups: [{ id: "claude", name: "Claude", rows: [row("session", 0), row("weekly", 100)] }] }} />)
    expect(screen.getByText("0%")).toHaveClass("text-[17px]")
    expect(screen.getByText("100%")).toBeInTheDocument()
    expect(screen.getByText("S")).toBeInTheDocument()
    expect(screen.getByText("W")).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/3h20m|Claude/)
    expect(container.querySelector('[style*="claude.svg"]')).not.toBeNull()
  })
  it("keeps AG Gemini and Claude distinct with their icons and does not invent unknown values", () => {
    const { container } = render(<MenubarIconStylePreview style="compact" isActive={false} traySettingsPreview={{ ...preview, summaryGroups: [{ id: "antigravity", name: "AG", rows: [row("gemini", 100), row("claude", null)] }] }} />)
    expect(screen.getByText("100%")).toBeInTheDocument()
    expect(screen.getByText("--%")).toBeInTheDocument()
    const masks = Array.from(container.querySelectorAll<HTMLElement>('[aria-hidden]'))
    expect(masks).toHaveLength(3)
    expect(masks.every(mask => Boolean(mask.style.maskImage))).toBe(true)
    expect(container.querySelector('[style*="agy.svg"]')).not.toBeNull()
    expect(masks[1].style.maskImage).not.toBe(masks[2].style.maskImage)
    expect(container.textContent).not.toMatch(/3h20m|G|C/)
  })
  it("uses unknown placeholders before any native data arrives", () => {
    render(<MenubarIconStylePreview style="compact" isActive={false} traySettingsPreview={preview} />)
    expect(screen.getAllByText("--%")).toHaveLength(2)
  })
  it("retains the detailed countdown theme unchanged", () => {
    render(<MenubarIconStylePreview style="quota" isActive={false} traySettingsPreview={{ ...preview, summaryGroups: [{ id: "claude", name: "Claude", rows: [row("session", 63), row("weekly", 18)] }] }} />)
    expect(screen.getByText("S 63% · 3h20m")).toBeInTheDocument()
    expect(screen.getByText("W 18% · 3h20m")).toBeInTheDocument()
  })
})
