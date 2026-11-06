import { describe, expect, it, vi } from "vitest"

vi.mock("@tauri-apps/api/image", () => ({
  Image: {
    new: vi.fn(async () => ({})),
  },
}))

import { getTrayIconSizePx, makeTrayBarsSvg, renderTrayBarsIcon } from "@/lib/tray-bars-icon"
import { Image } from "@tauri-apps/api/image"

describe("tray-bars-icon", () => {
  it("getTrayIconSizePx renders 18px at 1x and 36px at 2x", () => {
    expect(getTrayIconSizePx(1)).toBe(18)
    expect(getTrayIconSizePx(2)).toBe(36)
  })

  it("default style is provider", () => {
    const svg = makeTrayBarsSvg({
      bars: [],
      sizePx: 36,
    })
    expect(svg).toContain("<circle ")
    expect(svg).not.toContain("<rect ")
  })

  it("style=provider renders image and no bars", () => {
    const svg = makeTrayBarsSvg({
      bars: [],
      sizePx: 36,
      style: "provider",
      providerIconUrl: "data:image/svg+xml;base64,ABC",
    })
    expect(svg).toContain("<image ")
    expect(svg).not.toContain("<rect ")
    expect(svg).not.toContain("<path ")
  })

  it("style=bars renders bar SVG elements and no image", () => {
    const svg = makeTrayBarsSvg({
      bars: [{ id: "a", fraction: 0.5 }],
      sizePx: 36,
      style: "bars",
    })
    expect(svg).toContain("<rect ")
    expect(svg).toContain("<path ")
    expect(svg).not.toContain("<image ")
  })

  it("style=bars with empty bars renders a single empty track", () => {
    const svg = makeTrayBarsSvg({
      bars: [],
      sizePx: 36,
      style: "bars",
    })
    expect(svg).toContain("<rect ")
    expect(svg).not.toContain("<path ")
    expect(svg).not.toContain("<image ")
  })

  it("style=bars with high-end quantized fraction (0.95) renders bars (rect and path)", () => {
    const svg = makeTrayBarsSvg({
      bars: [{ id: "a", fraction: 0.95 }],
      sizePx: 36,
      style: "bars",
    })
    expect(svg).toContain("<rect ")
    expect(svg).toContain("<path ")
    expect(svg).not.toContain("<image ")
  })

  it("style=donut renders ring arc and centered provider icon", () => {
    const svg = makeTrayBarsSvg({
      bars: [{ id: "a", fraction: 0.42 }],
      sizePx: 36,
      style: "donut",
      providerIconUrl: "data:image/svg+xml;base64,ABC",
    })
    expect(svg).toContain('stroke-dasharray="')
    expect(svg).toContain("<image ")
    expect(svg).not.toContain("<rect ")
  })

  it("style=donut falls back to center glyph when provider icon is missing", () => {
    const svg = makeTrayBarsSvg({
      bars: [{ id: "a", fraction: 0.42 }],
      sizePx: 36,
      style: "donut",
    })
    expect(svg).toContain("<circle ")
    expect(svg).not.toContain("<image ")
    expect(svg).not.toContain("<rect ")
  })

  it("renders provider icon", () => {
    const svg = makeTrayBarsSvg({
      bars: [],
      sizePx: 36,
      providerIconUrl: "data:image/svg+xml;base64,ABC",
    })

    expect(svg).toContain("<image ")
    expect(svg).toContain('href="data:image/svg+xml;base64,ABC"')
    const viewBox = svg.match(/viewBox="0 0 (\d+) (\d+)"/)
    expect(viewBox).toBeTruthy()
    if (viewBox) {
      const width = Number(viewBox[1])
      const height = Number(viewBox[2])
      expect(width).toBe(height)
    }
  })

  it("falls back to circle glyph when provider icon is missing", () => {
    const svg = makeTrayBarsSvg({
      bars: [],
      sizePx: 36,
    })
    expect(svg).not.toContain("<image ")
    expect(svg).toContain("<circle ")
  })

  it("never renders svg text", () => {
    const svg = makeTrayBarsSvg({
      bars: [],
      sizePx: 18,
    })
    expect(svg).not.toContain("<text ")
  })

  it("renders svg text when percentage is provided", () => {
    const svg = makeTrayBarsSvg({
      bars: [],
      sizePx: 18,
      percentText: "70%",
    })
    expect(svg).toContain(">70%</text>")
  })

  it.each([18, 36])("draws every provider logo directly on canvas at %spx without a four-item limit", async (sizePx) => {
    const providerItems = Array.from({ length: 6 }, (_, index) => ({
      id: `provider-${index}`, fraction: index / 5,
      percentText: `${index * 20}%`, iconUrl: `provider-${index}.svg`,
    }))
    const originalImage = window.Image
    const loadedUrls: string[] = []
    const ctx = {
      clearRect: vi.fn(), drawImage: vi.fn(), fillText: vi.fn(),
      beginPath: vi.fn(), arc: vi.fn(), stroke: vi.fn(),
      getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) })),
    }
    const contextSpy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
    // The direct image URLs are intentionally tracked: wrapping them inside an
    // outer SVG regresses provider icons in real macOS 13 WebKit at 1x.
    window.Image = class {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      decoding = "async"
      set src(value: string) {
        loadedUrls.push(value)
        queueMicrotask(() => value === "broken.svg" ? this.onerror?.() : this.onload?.())
      }
    } as unknown as typeof window.Image
    try {
      await renderTrayBarsIcon({ bars: [], sizePx, providerItems })
      expect(loadedUrls).toEqual(providerItems.map((item) => item.iconUrl))
      expect(ctx.drawImage).toHaveBeenCalledTimes(6)
      expect(ctx.fillText.mock.calls.map((call) => call[0])).toEqual(providerItems.map((item) => item.percentText))
      const positions = ctx.drawImage.mock.calls.map((call) => Number(call[1]))
      expect(positions.every((value, index) => index === 0 || value > positions[index - 1])).toBe(true)
      const [, , width, height] = ctx.getImageData.mock.calls.at(-1)!
      expect(width).toBeGreaterThan(sizePx * providerItems.length)
      expect(height).toBe(sizePx)
      expect(Image.new).toHaveBeenLastCalledWith(expect.any(Uint8Array), width, sizePx)

      ctx.arc.mockClear()
      await renderTrayBarsIcon({ bars: [], sizePx, providerItems: [{ ...providerItems[0], iconUrl: undefined }, providerItems[1]] })
      expect(ctx.arc).toHaveBeenCalledOnce()
      await expect(renderTrayBarsIcon({ bars: [], sizePx, providerItems: [{ ...providerItems[0], iconUrl: "broken.svg" }, providerItems[1]] })).rejects.toThrow("Failed to load tray icon for provider-0")
    } finally {
      window.Image = originalImage
      contextSpy.mockRestore()
    }
  })

  it("renderTrayBarsIcon rasterizes SVG to an Image using canvas", async () => {
    const originalImage = window.Image
    const originalCreateElement = document.createElement.bind(document)

    // Stub Image loader to immediately fire onload once src is set.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).Image = class MockImage {
      onload: null | (() => void) = null
      onerror: null | (() => void) = null
      decoding = "async"
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    }

    // Stub canvas context
    const ctx = {
      clearRect: () => {},
      drawImage: () => {},
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
      }),
    }

    // Patch createElement for canvas only
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(document as any).createElement = (tag: string) => {
      const el = originalCreateElement(tag)
      if (tag === "canvas") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(el as any).getContext = () => ctx
      }
      return el
    }

    try {
      const img = await renderTrayBarsIcon({
        bars: [],
        sizePx: 18,
      })
      expect(img).toBeTruthy()
    } finally {
      window.Image = originalImage
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(document as any).createElement = originalCreateElement
    }
  })
})
