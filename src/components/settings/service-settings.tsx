import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Checkbox } from "@/components/ui/checkbox";
import { metricLabel } from "@/lib/locale";
import { cn } from "@/lib/utils";

export interface PluginConfig {
  id: string;
  name: string;
  enabled: boolean;
  metricOptions?: { value: string; label: string }[];
  selectedMetric?: string;
}

function SortableService({ plugin, onToggle, onMetricChange }: {
  plugin: PluginConfig;
  onToggle: (id: string) => void;
  onMetricChange?: (id: string, label: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: plugin.id });
  const options = plugin.metricOptions ?? [];
  const selected = plugin.selectedMetric ?? "";
  const unavailable = selected !== "" && !options.some((option) => option.value === selected);
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("rounded-xl border border-border/60 bg-background/70 p-3", isDragging && "opacity-50 ring-1 ring-ring")}>
      <div className="flex items-center gap-2.5">
        <button type="button" aria-label={`調整 ${plugin.name} 順序`}
          className="touch-none cursor-grab rounded p-1 text-muted-foreground hover:bg-muted active:cursor-grabbing"
          {...attributes} {...listeners}>
          <span aria-hidden className="block text-base leading-4 tracking-[-2px]">⠿</span>
        </button>
        <label className="flex flex-1 cursor-pointer items-center justify-between gap-2 text-sm font-medium">
          <span className={cn(!plugin.enabled && "text-muted-foreground")}>{plugin.name}</span>
          <Checkbox checked={plugin.enabled} onCheckedChange={() => onToggle(plugin.id)} aria-label={`啟用 ${plugin.name}`} />
        </label>
      </div>
      {(options.length > 0 || selected) ? (
        <label className="mt-3 flex flex-col gap-1.5 text-xs text-muted-foreground">
          選單列模型／額度
          <div className="relative"><select aria-label={`${plugin.name} 的選單列模型／額度`} value={selected}
            onChange={(event) => onMetricChange?.(plugin.id, event.target.value)}
            className="w-full appearance-none rounded-lg border border-border bg-background py-2 pl-2.5 pr-8 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring">
            <option value="">自動選擇</option>
            {unavailable && <option value={selected}>{metricLabel(selected)}（暫無資料）</option>}
            {options.map((option) => <option key={option.value} value={option.value}>{metricLabel(option.label)}</option>)}
          </select><span aria-hidden className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">⌄</span></div>
        </label>
      ) : (
        <p className="mt-2 pl-7 text-xs leading-relaxed text-muted-foreground">尚無可選額度，取得資料後即可選擇。</p>
      )}
    </div>
  );
}

export function ServiceSettings({ plugins, onReorder, onToggle, onMetricChange }: {
  plugins: PluginConfig[];
  onReorder: (orderedIds: string[]) => void;
  onToggle: (id: string) => void;
  onMetricChange?: (id: string, label: string) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const oldIndex = plugins.findIndex((plugin) => plugin.id === active.id);
    const newIndex = plugins.findIndex((plugin) => plugin.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    onReorder(arrayMove(plugins, oldIndex, newIndex).map((plugin) => plugin.id));
  };
  return (
    <section className="space-y-3" aria-label="服務與模型設定">
      <div className="px-1">
        <h3 className="text-sm font-semibold">我的 AI 服務</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">啟用要追蹤的服務，拖曳左側把手調整順序。</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">每項服務可指定選單列額度；指定項目沒有有效資料時，會自動使用其他可用額度。</p>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={plugins.map((plugin) => plugin.id)} strategy={verticalListSortingStrategy}>
          <div className="grid grid-cols-1 items-start gap-2 @min-[620px]:grid-cols-2">{plugins.map((plugin) => <SortableService key={plugin.id} plugin={plugin} onToggle={onToggle} onMetricChange={onMetricChange} />)}</div>
        </SortableContext>
      </DndContext>
    </section>
  );
}
