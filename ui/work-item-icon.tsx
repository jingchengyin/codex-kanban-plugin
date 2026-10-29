import { useRef } from "react";
import {
  BookOpen,
  Bug,
  ChartNoAxesCombined,
  ChevronDown,
  Code2,
  Compass,
  Database,
  Flag,
  FlaskConical,
  Layers,
  Lightbulb,
  Palette,
  Rocket,
  Shield,
  Target,
  Wrench,
  Zap,
} from "lucide-react";
import {
  resolveWorkItemIcon,
  workItemIcons,
  type WorkItemIconName,
} from "../shared/work-item-icons";
import { useI18n } from "./i18n";
import "./work-item-icon.css";

const icons = {
  rocket: { component: Rocket, label: "火箭" },
  target: { component: Target, label: "目标" },
  lightbulb: { component: Lightbulb, label: "灵感" },
  code: { component: Code2, label: "代码" },
  bug: { component: Bug, label: "缺陷" },
  wrench: { component: Wrench, label: "工具" },
  layers: { component: Layers, label: "图层" },
  flask: { component: FlaskConical, label: "实验" },
  book: { component: BookOpen, label: "文档" },
  chart: { component: ChartNoAxesCombined, label: "图表" },
  shield: { component: Shield, label: "盾牌" },
  database: { component: Database, label: "数据库" },
  palette: { component: Palette, label: "调色板" },
  compass: { component: Compass, label: "指南针" },
  zap: { component: Zap, label: "闪电" },
  flag: { component: Flag, label: "旗帜" },
} as const;

/** 看板标签和事项列表共用同一套图标，旧事项也能稳定显示。 */
export function WorkItemIcon({
  icon,
  itemId,
  size = 14,
}: {
  icon?: WorkItemIconName;
  itemId?: string;
  size?: number;
}) {
  const Icon = icons[resolveWorkItemIcon({ icon, id: itemId })].component;
  return <Icon className="work-item-icon" size={size} aria-hidden="true" />;
}

/** 使用原生展开控件选择图标，支持键盘打开、选择和 Esc 收起。 */
export function WorkItemIconPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: WorkItemIconName;
  onChange: (icon: WorkItemIconName) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const details = useRef<HTMLDetailsElement>(null);
  function close() {
    details.current!.open = false;
    details.current!.querySelector("summary")?.focus();
  }
  return (
    <details
      className="work-item-icon-picker"
      ref={details}
      onKeyDown={(event) => {
        if (event.key === "Escape" && details.current?.open) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <summary
        aria-label={t("选择事项图标")}
        aria-disabled={disabled || undefined}
        onClick={(event) => {
          if (disabled) event.preventDefault();
        }}
      >
        <WorkItemIcon icon={value} size={18} />
        <span>{t("事项图标")}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </summary>
      <div
        className="work-item-icon-options"
        role="group"
        aria-label={t("事项图标")}
      >
        {workItemIcons.map((icon) => (
          <button
            key={icon}
            type="button"
            title={t(icons[icon].label)}
            aria-label={t("选择图标：{name}", { name: t(icons[icon].label) })}
            aria-pressed={value === icon}
            disabled={disabled}
            onClick={() => {
              onChange(icon);
              close();
            }}
          >
            <WorkItemIcon icon={icon} size={18} />
          </button>
        ))}
      </div>
    </details>
  );
}
