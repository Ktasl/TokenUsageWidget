import { useCallback, useEffect, useRef, useState } from "react"
import { resolveResource } from "@tauri-apps/api/path"
import { TrayIcon } from "@tauri-apps/api/tray"
import type { PluginMeta } from "@/lib/plugin-types"
import type { DisplayMode, MenubarIconStyle, MenubarMetric, PluginSettings } from "@/lib/settings"
import { getEnabledPluginIds } from "@/lib/settings"
import { getTrayIconSizePx, renderTrayBarsIcon, type TrayProviderItem } from "@/lib/tray-bars-icon"
import { getTrayPrimaryBars, type TrayPrimaryBar } from "@/lib/tray-primary-progress"
import { formatTrayPercentText, formatTrayTooltip } from "@/lib/tray-tooltip"
import type { PluginState } from "@/hooks/app/types"
import { APP_DISPLAY_NAME } from "@/lib/app-edition"
import { useNativeMenubarSummary } from "@/hooks/app/use-native-menubar-summary"
import type { MenubarSummaryGroup } from "@/lib/menubar-summary"

type TrayUpdateReason = "probe" | "settings" | "init"

type UseTrayIconArgs = {
  pluginsMeta: PluginMeta[]
  pluginSettings: PluginSettings | null
  pluginStates: Record<string, PluginState>
  displayMode: DisplayMode
  menubarIconStyle: MenubarIconStyle
  menubarMetric: MenubarMetric
  activeView: string
}

export type TraySettingsPreview = {
  bars: TrayPrimaryBar[]
  providerBars: TrayPrimaryBar[]
  providerIconUrl?: string
  providerPercentText: string
  providerItems: TrayProviderItem[]
  summaryGroups?: MenubarSummaryGroup[]
  summaryIconUrls?: Record<string, string | undefined>
}

const EMPTY_TRAY_SETTINGS_PREVIEW: TraySettingsPreview = {
  bars: [],
  providerBars: [],
  providerPercentText: "--%",
  providerItems: [],
}

function isNativeStyle(style: MenubarIconStyle): boolean {
  return style === "quota" || style === "compact"
}

function isSameTraySettingsPreview(a: TraySettingsPreview, b: TraySettingsPreview): boolean {
  if (a.providerIconUrl !== b.providerIconUrl) return false
  if (a.providerPercentText !== b.providerPercentText) return false
  if (a.bars.length !== b.bars.length) return false
  if (a.providerBars.length !== b.providerBars.length) return false
  if (a.providerItems.length !== b.providerItems.length) return false
  for (let i = 0; i < a.providerItems.length; i += 1) {
    const left = a.providerItems[i]
    const right = b.providerItems[i]
    if (left.id !== right.id || left.fraction !== right.fraction || left.iconUrl !== right.iconUrl) return false
  }
  for (let i = 0; i < a.bars.length; i += 1) {
    if (a.bars[i]?.id !== b.bars[i]?.id) return false
    if (a.bars[i]?.fraction !== b.bars[i]?.fraction) return false
  }
  for (let i = 0; i < a.providerBars.length; i += 1) {
    if (a.providerBars[i]?.id !== b.providerBars[i]?.id) return false
    if (a.providerBars[i]?.fraction !== b.providerBars[i]?.fraction) return false
  }
  return true
}

export function useTrayIcon({
  pluginsMeta,
  pluginSettings,
  pluginStates,
  displayMode,
  menubarIconStyle,
  menubarMetric,
  activeView,
}: UseTrayIconArgs) {
  const trayRef = useRef<TrayIcon | null>(null)
  const trayGaugeIconPathRef = useRef<string | null>(null)
  const trayUpdateTimerRef = useRef<number | null>(null)
  const trayUpdatePendingRef = useRef(false)
  const trayUpdateQueuedRef = useRef(false)
  const [trayReady, setTrayReady] = useState(false)
  const [traySettingsPreview, setTraySettingsPreview] = useState<TraySettingsPreview>(
    EMPTY_TRAY_SETTINGS_PREVIEW
  )

  const pluginsMetaRef = useRef(pluginsMeta)
  const pluginSettingsRef = useRef(pluginSettings)
  const pluginStatesRef = useRef(pluginStates)
  const displayModeRef = useRef(displayMode)
  const menubarIconStyleRef = useRef(menubarIconStyle)
  const menubarMetricRef = useRef(menubarMetric)
  const activeViewRef = useRef(activeView)
  const lastTrayProviderIdRef = useRef<string | null>(null)
  const paintRef = useRef<Promise<unknown>>(Promise.resolve())
  const beforeConfigure = useCallback(() => paintRef.current, [])
  const nativeSummary = useNativeMenubarSummary(isNativeStyle(menubarIconStyle), pluginSettings, beforeConfigure, menubarIconStyle === "compact" ? "compact" : "quota")
  const nativeOwnedRef = useRef(nativeSummary.owned)
  nativeOwnedRef.current = nativeSummary.owned
  menubarIconStyleRef.current = menubarIconStyle

  useEffect(() => {
    pluginsMetaRef.current = pluginsMeta
  }, [pluginsMeta])

  useEffect(() => {
    pluginSettingsRef.current = pluginSettings
  }, [pluginSettings])

  useEffect(() => {
    displayModeRef.current = displayMode
  }, [displayMode])

  useEffect(() => {
    menubarIconStyleRef.current = menubarIconStyle
  }, [menubarIconStyle])

  useEffect(() => {
    menubarMetricRef.current = menubarMetric
  }, [menubarMetric])

  useEffect(() => {
    activeViewRef.current = activeView
  }, [activeView])

  const scheduleTrayIconUpdate = useCallback((
    _reason: TrayUpdateReason,
    delayMs = 0,
  ) => {
    if (trayUpdateTimerRef.current !== null) {
      window.clearTimeout(trayUpdateTimerRef.current)
      trayUpdateTimerRef.current = null
    }

    trayUpdateTimerRef.current = window.setTimeout(() => {
      trayUpdateTimerRef.current = null
      if (trayUpdatePendingRef.current) {
        trayUpdateQueuedRef.current = true
        return
      }
      trayUpdatePendingRef.current = true

      const finalizeUpdate = () => {
        trayUpdatePendingRef.current = false
        if (!trayUpdateQueuedRef.current) return
        trayUpdateQueuedRef.current = false
        scheduleTrayIconUpdate("probe", 0)
      }

      const tray = trayRef.current
      if (!tray || isNativeStyle(menubarIconStyleRef.current) || nativeOwnedRef.current) {
        finalizeUpdate()
        return
      }

      const maybeSetTitle = (tray as TrayIcon & { setTitle?: (value: string) => Promise<void> }).setTitle
      const setTitleFn =
        typeof maybeSetTitle === "function" ? (value: string) => maybeSetTitle.call(tray, value) : null
      const supportsNativeTrayTitle = setTitleFn !== null
      const setTrayTitle = (title: string) => {
        if (setTitleFn) {
          return setTitleFn(title)
        }
        return Promise.resolve()
      }

      const maybeSetTooltip = (tray as TrayIcon & { setTooltip?: (value: string) => Promise<void> }).setTooltip
      const setTooltipFn =
        typeof maybeSetTooltip === "function" ? (value: string) => maybeSetTooltip.call(tray, value) : null
      const setTrayTooltip = (tooltip: string) => {
        if (setTooltipFn) {
          return setTooltipFn(tooltip)
        }
        return Promise.resolve()
      }

      const restoreGaugeIcon = () => {
        const gaugePath = trayGaugeIconPathRef.current
        if (gaugePath) {
          paintRef.current = Promise.all([
            tray.setIcon(gaugePath),
            tray.setIconAsTemplate(true),
            setTrayTitle(""),
            setTrayTooltip(APP_DISPLAY_NAME),
          ])
            .catch((e) => {
              console.error("Failed to restore tray gauge icon:", e)
            })
            .finally(() => {
              finalizeUpdate()
            })
        } else {
          finalizeUpdate()
        }
      }

      const currentSettings = pluginSettingsRef.current
      if (!currentSettings) {
        setTraySettingsPreview(EMPTY_TRAY_SETTINGS_PREVIEW)
        restoreGaugeIcon()
        return
      }

      const enabledPluginIds = getEnabledPluginIds(currentSettings)
      if (enabledPluginIds.length === 0) {
        setTraySettingsPreview(EMPTY_TRAY_SETTINGS_PREVIEW)
        restoreGaugeIcon()
        return
      }

      const style = menubarIconStyleRef.current
      const preferWeekly = menubarMetricRef.current === "weekly"
      const sizePx = getTrayIconSizePx(window.devicePixelRatio)
      const nextActiveView = activeViewRef.current
      const activeProviderId =
        nextActiveView !== "home" && nextActiveView !== "settings" ? nextActiveView : null

      let trayProviderId: string | null = null
      if (activeProviderId && enabledPluginIds.includes(activeProviderId)) {
        trayProviderId = activeProviderId
      } else if (
        lastTrayProviderIdRef.current &&
        enabledPluginIds.includes(lastTrayProviderIdRef.current)
      ) {
        trayProviderId = lastTrayProviderIdRef.current
      } else {
        trayProviderId = enabledPluginIds[0] ?? null
      }

      const barsForPreview = getTrayPrimaryBars({
        pluginsMeta: pluginsMetaRef.current,
        pluginSettings: currentSettings,
        pluginStates: pluginStatesRef.current,
        maxBars: 4,
        displayMode: displayModeRef.current,
        preferWeekly,
      })

      const allProviderBars = getTrayPrimaryBars({
        pluginsMeta: pluginsMetaRef.current,
        pluginSettings: currentSettings,
        pluginStates: pluginStatesRef.current,
        maxBars: Infinity,
        displayMode: displayModeRef.current,
        preferWeekly,
      })
      const providerItems: TrayProviderItem[] = allProviderBars.flatMap((bar) =>
        typeof bar.fraction === "number" && Number.isFinite(bar.fraction)
          ? [{
              id: bar.id,
              fraction: bar.fraction,
              percentText: formatTrayPercentText(bar.fraction),
              iconUrl: pluginsMetaRef.current.find((plugin) => plugin.id === bar.id)?.iconUrl,
            }]
          : []
      )
      const iconProviderId = style === "provider" && providerItems.length > 0
        ? providerItems[0].id
        : trayProviderId

      const providerBars = iconProviderId
        ? getTrayPrimaryBars({
            pluginsMeta: pluginsMetaRef.current,
            pluginSettings: currentSettings,
            pluginStates: pluginStatesRef.current,
            maxBars: 1,
            displayMode: displayModeRef.current,
            pluginId: iconProviderId,
            preferWeekly,
          })
        : []

      const providerIconUrl = iconProviderId
        ? pluginsMetaRef.current.find((plugin) => plugin.id === iconProviderId)?.iconUrl
        : undefined
      const providerPercentText = formatTrayPercentText(providerBars[0]?.fraction)

      const nextPreview: TraySettingsPreview = {
        bars: barsForPreview,
        providerBars,
        providerIconUrl,
        providerPercentText,
        providerItems,
      }
      setTraySettingsPreview((prev) =>
        isSameTraySettingsPreview(prev, nextPreview) ? prev : nextPreview
      )

      const tooltipBars = style === "provider" ? allProviderBars.filter((bar) =>
        typeof bar.fraction === "number" && Number.isFinite(bar.fraction)
      ) : getTrayPrimaryBars({
        pluginsMeta: pluginsMetaRef.current,
        pluginSettings: currentSettings,
        pluginStates: pluginStatesRef.current,
        maxBars: 20, // Preserve the other styles' tooltip behavior.
        displayMode: displayModeRef.current,
        preferWeekly,
      })
      const tooltip = formatTrayTooltip(tooltipBars, pluginsMetaRef.current, preferWeekly)
      const updateTooltip = () => setTrayTooltip(tooltip)

      if (style === "bars") {
        paintRef.current = renderTrayBarsIcon({
          bars: barsForPreview,
          sizePx,
          style: "bars",
        })
          .then(async (img) => {
            if (isNativeStyle(menubarIconStyleRef.current) || nativeOwnedRef.current) return
            await tray.setIcon(img)
            await tray.setIconAsTemplate(true)
            await setTrayTitle("")
            await updateTooltip()
          })
          .catch((e) => {
            console.error("Failed to update tray icon:", e)
          })
          .finally(() => {
            finalizeUpdate()
          })
        return
      }

      if (!trayProviderId) {
        restoreGaugeIcon()
        return
      }
      lastTrayProviderIdRef.current = trayProviderId

      if (style === "donut") {
        paintRef.current = renderTrayBarsIcon({
          bars: providerBars,
          sizePx,
          style: "donut",
          providerIconUrl,
        })
          .then(async (img) => {
            if (isNativeStyle(menubarIconStyleRef.current) || nativeOwnedRef.current) return
            await tray.setIcon(img)
            await tray.setIconAsTemplate(true)
            await setTrayTitle("")
            await updateTooltip()
          })
          .catch((e) => {
            console.error("Failed to update tray icon:", e)
          })
          .finally(() => {
            finalizeUpdate()
          })
        return
      }

      paintRef.current = renderTrayBarsIcon({
        bars: providerBars,
        sizePx,
        style: "provider",
        percentText: supportsNativeTrayTitle ? undefined : providerPercentText,
        providerIconUrl,
        providerItems: providerItems.length > 1 ? providerItems : undefined,
      })
        .then(async (img) => {
          if (isNativeStyle(menubarIconStyleRef.current) || nativeOwnedRef.current) return
          await tray.setIcon(img)
          await tray.setIconAsTemplate(true)
          await setTrayTitle(providerItems.length > 1 ? "" : providerPercentText)
          await updateTooltip()
        })
        .catch((e) => {
          console.error("Failed to update tray icon:", e)
        })
        .finally(() => {
          finalizeUpdate()
        })
    }, delayMs)
  }, [])

  useEffect(() => {
    pluginStatesRef.current = pluginStates
    // A probe timer may have run before React committed a late startup result.
    // Repaint from the committed state as well, using the existing probe debounce.
    if (trayReady) scheduleTrayIconUpdate("probe", 500)
  }, [pluginStates, scheduleTrayIconUpdate, trayReady])

  const trayInitializedRef = useRef(false)
  useEffect(() => {
    if (trayInitializedRef.current) return
    let cancelled = false

    ;(async () => {
      try {
        const tray = await TrayIcon.getById("tray")
        if (cancelled) return
        trayRef.current = tray
        trayInitializedRef.current = true

        try {
          trayGaugeIconPathRef.current = await resolveResource("icons/tray-icon.png")
        } catch (e) {
          console.error("Failed to resolve tray gauge icon resource:", e)
        }

        if (cancelled) return
        setTrayReady(true)
      } catch (e) {
        console.error("Failed to load tray icon handle:", e)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!trayReady) return
    if (!pluginSettings) return
    if (pluginsMeta.length === 0) return
    scheduleTrayIconUpdate("init", 0)
  }, [pluginsMeta.length, pluginSettings, scheduleTrayIconUpdate, trayReady])

  useEffect(() => {
    if (!trayReady) return
    scheduleTrayIconUpdate("settings", 0)
  }, [activeView, menubarIconStyle, menubarMetric, nativeSummary.owned, scheduleTrayIconUpdate, trayReady])

  useEffect(() => {
    return () => {
      if (trayUpdateTimerRef.current !== null) {
        window.clearTimeout(trayUpdateTimerRef.current)
        trayUpdateTimerRef.current = null
      }
      trayUpdatePendingRef.current = false
      trayUpdateQueuedRef.current = false
    }
  }, [])

  return {
    scheduleTrayIconUpdate,
    traySettingsPreview: nativeSummary.summary ? { ...traySettingsPreview, summaryGroups: nativeSummary.summary.groups,
      summaryIconUrls: Object.fromEntries(pluginsMeta.map(plugin => [plugin.id, plugin.iconUrl])),
    } : traySettingsPreview,
    summaryError: nativeSummary.error,
  }
}
