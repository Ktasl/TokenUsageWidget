import { useState, type ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { GlobalShortcutSection } from "@/components/global-shortcut-section";
import { MenubarIconStylePreview } from "@/components/settings/menubar-icon-style-preview";
import { ServiceSettings, type PluginConfig } from "@/components/settings/service-settings";
import {
  AUTO_UPDATE_OPTIONS, DISPLAY_MODE_OPTIONS, MENUBAR_ICON_STYLE_OPTIONS, MENUBAR_METRIC_OPTIONS,
  RESET_TIMER_DISPLAY_OPTIONS, THEME_OPTIONS, TIME_FORMAT_OPTIONS,
  type AutoUpdateIntervalMinutes, type DisplayMode, type GlobalShortcut, type MenubarIconStyle,
  type MenubarMetric, type ResetTimerDisplayMode, type ThemeMode, type TimeFormatMode,
} from "@/lib/settings";
import { getTimeFormatter } from "@/lib/reset-tooltip";
import type { TraySettingsPreview } from "@/hooks/app/use-tray-icon";
import { cn } from "@/lib/utils";
import { APP_DISPLAY_NAME, IS_TEST_BUILD } from "@/lib/app-edition";

interface SettingsPageProps {
  plugins: PluginConfig[];
  onReorder: (orderedIds: string[]) => void;
  onToggle: (id: string) => void;
  onMetricChange?: (id: string, label: string) => void;
  autoUpdateInterval: AutoUpdateIntervalMinutes;
  onAutoUpdateIntervalChange: (value: AutoUpdateIntervalMinutes) => void;
  themeMode: ThemeMode;
  onThemeModeChange: (value: ThemeMode) => void;
  displayMode: DisplayMode;
  onDisplayModeChange: (value: DisplayMode) => void;
  resetTimerDisplayMode: ResetTimerDisplayMode;
  onResetTimerDisplayModeChange: (value: ResetTimerDisplayMode) => void;
  timeFormatMode: TimeFormatMode;
  onTimeFormatModeChange: (value: TimeFormatMode) => void;
  menubarIconStyle: MenubarIconStyle;
  onMenubarIconStyleChange: (value: MenubarIconStyle) => void;
  menubarMetric: MenubarMetric;
  onMenubarMetricChange: (value: MenubarMetric) => void;
  traySettingsPreview: TraySettingsPreview;
  globalShortcut: GlobalShortcut;
  onGlobalShortcutChange: (value: GlobalShortcut) => void;
  startOnLogin: boolean;
  onStartOnLoginChange: (value: boolean) => void;
}

function SettingCard({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <section className="rounded-xl border border-border/60 bg-card/70 p-3.5 shadow-sm">
    <h3 className="text-sm font-semibold">{title}</h3>
    <p className="mt-1 mb-3 text-xs leading-relaxed text-muted-foreground">{description}</p>
    {children}
  </section>;
}

function Choices<T extends string | number>({ label, options, value, onChange, example }: {
  label: string; options: { value: T; label: string }[]; value: T; onChange: (value: T) => void; example?: (value: T) => string;
}) {
  return <div className="flex gap-1 rounded-lg bg-muted/60 p-1" role="radiogroup" aria-label={label}>
    {options.map((option) => <Button key={option.value} type="button" role="radio" aria-label={option.label}
      aria-checked={option.value === value} variant={option.value === value ? "default" : "ghost"} size="sm"
      className={cn("min-w-0 flex-1 rounded-md px-1 text-xs", example && "h-auto flex-col gap-0.5 py-2")}
      onClick={() => onChange(option.value)}>
      <span>{option.label}</span>{example && <span className={cn("text-[10px] font-normal", option.value === value ? "text-primary-foreground/80" : "text-muted-foreground")}>{example(option.value)}</span>}
    </Button>)}
  </div>;
}

const categories = [
  { id: "display", label: "顯示與外觀" },
  { id: "services", label: "服務與模型" },
  { id: "system", label: "更新與系統" },
] as const;

export function SettingsPage(props: SettingsPageProps) {
  const [category, setCategory] = useState<(typeof categories)[number]["id"]>("display");
  const timeExample = (mode: TimeFormatMode) => getTimeFormatter(mode).format(new Date(2026, 1, 2, 11, 4));
  return (
    <div className="@container pb-4">
      <div className="sticky top-0 z-10 -mx-1 mb-4 bg-background/95 px-1 pt-2 pb-2 backdrop-blur">
        <div role="tablist" aria-label="設定分類" className="grid grid-cols-3 gap-1 rounded-xl border border-border/50 bg-muted/50 p-1">
          {categories.map((item, index) => <button key={item.id} id={`settings-tab-${item.id}`} type="button"
            role="tab" aria-selected={category === item.id} aria-controls={`settings-panel-${item.id}`} tabIndex={category === item.id ? 0 : -1}
            onClick={() => setCategory(item.id)}
            onKeyDown={(event) => {
              const next = event.key === "ArrowRight" ? (index + 1) % categories.length
                : event.key === "ArrowLeft" ? (index + categories.length - 1) % categories.length
                : event.key === "Home" ? 0 : event.key === "End" ? categories.length - 1 : null;
              if (next === null) return;
              event.preventDefault();
              setCategory(categories[next].id);
              document.getElementById(`settings-tab-${categories[next].id}`)?.focus();
            }}
            className={cn("rounded-lg px-1 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", category === item.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
            {item.label}
          </button>)}
        </div>
      </div>
      <div id={`settings-panel-${category}`} role="tabpanel" aria-labelledby={`settings-tab-${category}`} className="grid grid-cols-1 items-start gap-3 @min-[620px]:grid-cols-2">
        {category === "display" && <>
          <SettingCard title="選單列顯示" description="服務圖示會顯示所有已啟用且有有效額度的服務，數量沒有上限。">
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted/60 p-1 @min-[620px]:grid-cols-3" role="radiogroup" aria-label="選單列圖示樣式">
              {MENUBAR_ICON_STYLE_OPTIONS.map((option) => <Button key={option.value} type="button" role="radio" aria-label={option.label}
                aria-checked={option.value === props.menubarIconStyle} variant={option.value === props.menubarIconStyle ? "default" : "ghost"} size="sm"
                className={cn("h-auto min-w-0 flex-1 flex-col gap-2 rounded-md px-1 py-2.5", option.value === "compact" && "col-span-2 @min-[620px]:col-span-3", option.value === "provider" && props.traySettingsPreview.providerItems.length > 1 && "flex-[2]")}
                onClick={() => props.onMenubarIconStyleChange(option.value)}>
                <MenubarIconStylePreview style={option.value} isActive={option.value === props.menubarIconStyle} traySettingsPreview={props.traySettingsPreview} />
                <span className="text-[10px] font-normal">{option.label}</span>
              </Button>)}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">圖示大字是新安裝的預設樣式，以圖示與較大的百分比呈現，不顯示時間；既有樣式會保留。兩種額度樣式固定顯示剩餘額度：Claude／Codex 為 Session、Weekly；Antigravity 為 Gemini、Claude 並列。S／W 表示兩個週期，Gemini 與 Claude 各用自己的圖示。雙額度與倒數保留原有詳細資訊，倒數由原生背景更新。</p>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">預覽只列部分；實際依已啟用服務顯示。缺資料顯示 --，不當作零或 100%。</p>
            <p className="mt-4 mb-2 text-xs font-medium">自動選擇的額度偏好</p>
            <Choices label="選單列額度偏好" options={MENUBAR_METRIC_OPTIONS} value={props.menubarMetric} onChange={props.onMenubarMetricChange} />
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">額度偏好用於服務圖示、圓環與長條。圖示大字及雙額度與倒數的 Gemini 預設 Pro，可在「服務與模型」選 Flash；Claude 固定同時顯示，兩種額度不混加。</p>
          </SettingCard>
          <SettingCard title="額度顯示方式" description="選擇百分比與進度條表示已用量或剩餘額度。">
            <Choices label="額度顯示方式" options={DISPLAY_MODE_OPTIONS} value={props.displayMode} onChange={props.onDisplayModeChange} />
          </SettingCard>
          <SettingCard title="介面主題" description="跟隨系統外觀，或固定使用淺色與深色。">
            <Choices label="介面主題" options={THEME_OPTIONS} value={props.themeMode} onChange={props.onThemeModeChange} />
          </SettingCard>
          <SettingCard title="額度重設時間" description="以倒數時間或實際日期與時間顯示。">
            <Choices label="重設時間顯示方式" options={RESET_TIMER_DISPLAY_OPTIONS} value={props.resetTimerDisplayMode} onChange={props.onResetTimerDisplayModeChange}
              example={(value) => value === "relative" ? "5 小時 12 分鐘" : `今天 ${timeExample(props.timeFormatMode)}`} />
            <p className="mt-4 mb-2 text-xs font-medium">時間格式</p>
            <Choices label="時間格式" options={TIME_FORMAT_OPTIONS} value={props.timeFormatMode} onChange={props.onTimeFormatModeChange} example={timeExample} />
          </SettingCard>
        </>}
        {category === "services" && <div className="@min-[620px]:col-span-2"><ServiceSettings plugins={props.plugins} onReorder={props.onReorder} onToggle={props.onToggle} onMetricChange={props.onMetricChange} /></div>}
        {category === "system" && <>
          <SettingCard title="自動更新額度" description="定期取得服務用量；這個間隔不影響 App 版本更新。">
            <Choices label="額度更新間隔" options={AUTO_UPDATE_OPTIONS} value={props.autoUpdateInterval} onChange={props.onAutoUpdateIntervalChange} />
          </SettingCard>
          <div className="rounded-xl border border-border/60 bg-card/70 p-3.5 shadow-sm">
            <GlobalShortcutSection globalShortcut={props.globalShortcut} onGlobalShortcutChange={props.onGlobalShortcutChange} />
          </div>
          <SettingCard title="登入時啟動" description={`登入 macOS 後自動開啟 ${APP_DISPLAY_NAME}。`}>
            <label className="flex cursor-pointer items-center justify-between gap-2 text-sm">
              登入時自動啟動
              <Checkbox aria-label="登入時自動啟動" checked={props.startOnLogin} onCheckedChange={(checked) => props.onStartOnLoginChange(checked === true)} />
            </label>
          </SettingCard>
          {IS_TEST_BUILD && <SettingCard title="App 版本更新" description="這是獨立版本，已停用上游自動更新。">
            <span className="inline-flex rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">獨立版手動更新</span>
          </SettingCard>}
        </>}
      </div>
    </div>
  );
}
