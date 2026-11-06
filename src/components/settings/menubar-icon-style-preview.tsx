import { getBarFillLayout, getTrayIconSizePx } from "@/lib/tray-bars-icon";
import type { MenubarIconStyle } from "@/lib/settings";
import type { TraySettingsPreview } from "@/hooks/app/use-tray-icon";
import { cn } from "@/lib/utils";
import geminiIcon from "@/assets/menubar/gemini.svg";
import claudeIcon from "../../../plugins/claude/icon.svg";

const TRAY_PREVIEW_SIZE_PX = getTrayIconSizePx(1);

const PREVIEW_BAR_TRACK_PX = 20;

function getPreviewBarLayout(fraction: number): { fillPercent: number; remainderPercent: number } {
  const { fillW, remainderDrawW } = getBarFillLayout(PREVIEW_BAR_TRACK_PX, fraction);
  return {
    fillPercent: (fillW / PREVIEW_BAR_TRACK_PX) * 100,
    remainderPercent: (remainderDrawW / PREVIEW_BAR_TRACK_PX) * 100,
  };
}

function ProviderIconMask({
  iconUrl,
  isActive,
  sizePx,
}: {
  iconUrl?: string;
  isActive: boolean;
  sizePx: number;
}) {
  const colorClass = isActive ? "bg-primary-foreground" : "bg-foreground";
  if (iconUrl) {
    return (
      <div
        aria-hidden
        className={cn("shrink-0", colorClass)}
        style={{
          width: `${sizePx}px`,
          height: `${sizePx}px`,
          WebkitMaskImage: `url(${JSON.stringify(iconUrl)})`,
          WebkitMaskSize: "contain",
          WebkitMaskRepeat: "no-repeat",
          WebkitMaskPosition: "center",
          maskImage: `url(${JSON.stringify(iconUrl)})`,
          maskSize: "contain",
          maskRepeat: "no-repeat",
          maskPosition: "center",
        }}
      />
    );
  }
  const textClass = isActive ? "text-primary-foreground" : "text-foreground";

  return (
    <svg aria-hidden viewBox="0 0 26 26" className={cn("shrink-0", textClass)} style={{ width: `${sizePx}px`, height: `${sizePx}px` }}>
      <circle cx="13" cy="13" r="9" fill="none" stroke="currentColor" strokeWidth="3.5" opacity={0.3} />
    </svg>
  );
}

export function MenubarIconStylePreview({
  style,
  isActive,
  traySettingsPreview,
}: {
  style: MenubarIconStyle;
  isActive: boolean;
  traySettingsPreview: TraySettingsPreview;
}) {
  const textClass = isActive ? "text-primary-foreground" : "text-foreground";

  if (style === "compact") {
    const group = traySettingsPreview.summaryGroups?.[0];
    const rows = group?.rows ?? [{ key: "session", label: "Session", remainingPercent: null }, { key: "weekly", label: "Weekly", remainingPercent: null }];
    const providerIcon = (group ? traySettingsPreview.summaryIconUrls?.[group.id] : undefined) ?? traySettingsPreview.providerItems.find(item => item.id === group?.id)?.iconUrl ?? traySettingsPreview.providerIconUrl;
    const isAntigravity = group?.id === "antigravity";
    return <div className={cn("inline-flex max-w-full items-center gap-1 overflow-hidden", textClass)} title="圖示與剩餘百分比，不顯示時間">
      <ProviderIconMask iconUrl={providerIcon} isActive={isActive} sizePx={18} />
      {rows.map(row => <span key={row.key} className="inline-flex shrink-0 items-baseline gap-0.5" title={`${group?.name ?? "服務"} ${row.label}`}>
        {isAntigravity ? <ProviderIconMask iconUrl={row.key === "gemini" ? geminiIcon : claudeIcon} isActive={isActive} sizePx={18} /> :
          <span className="text-[8px] font-medium">{({ session: "S", weekly: "W" } as Record<string, string>)[row.key] ?? ""}</span>}
        <span className="text-[17px] font-semibold leading-none tabular-nums">{row.remainingPercent === null ? "--%" : `${row.remainingPercent}%`}</span>
      </span>)}
    </div>;
  }

  if (style === "quota") {
    const group = traySettingsPreview.summaryGroups?.[0];
    return <div className={cn("flex max-w-full items-center gap-1 overflow-hidden text-[9px] leading-tight", textClass)} title="Session／Weekly；Antigravity 為 Gemini／Claude">
      <span className="font-semibold">{group?.name ?? "Claude"}</span>
      <span className="text-left font-medium tabular-nums">
        {(group?.rows ?? [{ key: "S", label: "Session", remainingPercent: null, countdown: null }, { key: "W", label: "Weekly", remainingPercent: null, countdown: null }]).map(row =>
          <span key={row.key} className="block whitespace-nowrap">{({ session: "S", weekly: "W", gemini: "G", claude: "C" } as Record<string, string>)[row.key] ?? row.key} {row.remainingPercent === null ? "--%" : `${row.remainingPercent}%`} · {row.countdown ?? "--"}</span>)}
      </span>
    </div>;
  }

  if (style === "provider") {
    const items = traySettingsPreview.providerItems;
    if (items.length > 0) {
      return (
        <div className="inline-flex max-w-full items-center gap-2 overflow-hidden">
          {items.slice(0, 2).map((item) => (
            <span key={item.id} className="inline-flex shrink-0 items-center gap-0.5" title={`${item.id}: ${item.percentText}`}>
              <ProviderIconMask iconUrl={item.iconUrl} isActive={isActive} sizePx={TRAY_PREVIEW_SIZE_PX} />
              <span className={cn("text-[12px] font-semibold tabular-nums leading-none", textClass)}>
                {item.percentText}
              </span>
            </span>
          ))}
          {items.length > 2 && (
            <span className={cn("text-[10px] font-semibold", textClass)}>+{items.length - 2}</span>
          )}
        </div>
      );
    }
    return (
      <div className="inline-flex items-center gap-0.5">
        <ProviderIconMask
          iconUrl={traySettingsPreview.providerIconUrl}
          isActive={isActive}
          sizePx={TRAY_PREVIEW_SIZE_PX}
        />
        <span className={cn("text-[12px] font-semibold tabular-nums leading-none", textClass)}>
          {traySettingsPreview.providerPercentText}
        </span>
      </div>
    );
  }

  if (style === "bars") {
    const trackClass = isActive ? "bg-primary-foreground/15" : "bg-foreground/15";
    const remainderClass = isActive ? "bg-primary-foreground/20" : "bg-foreground/15";
    const fillClass = isActive ? "bg-primary-foreground" : "bg-foreground";
    const fractions = traySettingsPreview.bars.length > 0
      ? traySettingsPreview.bars.map((b) => b.fraction ?? 0)
      : [0.83, 0.7, 0.56];

    return (
      <div className="flex items-center">
        <div className="flex flex-col gap-0.5 w-5">
          {fractions.map((fraction, i) => {
            const { fillPercent, remainderPercent } = getPreviewBarLayout(fraction);
            return (
              <div key={i} className={cn("relative h-1 rounded-sm", trackClass)}>
                {remainderPercent > 0 && (
                  <span
                    aria-hidden
                    className={remainderClass}
                    style={{
                      position: "absolute",
                      right: 0,
                      top: 0,
                      bottom: 0,
                      width: `${remainderPercent}%`,
                      borderRadius: "1px 2px 2px 1px",
                    }}
                  />
                )}
                <div
                  className={cn("h-1", fillClass)}
                  style={{ width: `${fillPercent}%`, borderRadius: "2px 1px 1px 2px" }}
                />
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (style === "donut") {
    const fraction = traySettingsPreview.providerBars[0]?.fraction ?? 0;
    const clamped = Math.max(0, Math.min(1, fraction));
    return (
      <div className="inline-flex items-center gap-1">
        <ProviderIconMask
          iconUrl={traySettingsPreview.providerIconUrl}
          isActive={isActive}
          sizePx={TRAY_PREVIEW_SIZE_PX}
        />
        <svg aria-hidden viewBox="0 0 26 26" className={cn("shrink-0", textClass)} style={{ width: `${TRAY_PREVIEW_SIZE_PX}px`, height: `${TRAY_PREVIEW_SIZE_PX}px` }}>
          <circle
            cx="13" cy="13" r="9"
            fill="none" stroke="currentColor" strokeWidth="4"
            opacity={isActive ? 0.2 : 0.15}
          />
          {clamped > 0 && (
            <circle
              cx="13" cy="13" r="9"
              fill="none" stroke="currentColor" strokeWidth="4"
              strokeLinecap="butt"
              pathLength="100"
              strokeDasharray={`${Math.round(clamped * 100)} 100`}
              transform="rotate(-90 13 13)"
            />
          )}
        </svg>
      </div>
    );
  }

  return null;
}
