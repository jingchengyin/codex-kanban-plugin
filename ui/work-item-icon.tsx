import { useRef, useState } from "react";
import {
  Bell,
  BookOpen,
  Boxes,
  BriefcaseBusiness,
  Bug,
  Building2,
  CalendarDays,
  Camera,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  CircleCheck,
  CircleDot,
  Clock3,
  Cloud,
  Code2,
  Coffee,
  Compass,
  Container,
  Cpu,
  Database,
  Filter,
  Flag,
  FlaskConical,
  Gem,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Globe,
  HardDrive,
  Headphones,
  Heart,
  Image,
  Layers,
  Leaf,
  Lightbulb,
  ListChecks,
  ListTodo,
  Mail,
  Megaphone,
  MessagesSquare,
  Milestone,
  Music,
  Network,
  Paintbrush,
  Palette,
  PenTool,
  Rocket,
  Scan,
  Search,
  Server,
  Settings2,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Star,
  Target,
  Terminal,
  Timer,
  Trophy,
  UserRound,
  Users,
  Video,
  Workflow,
  Wrench,
  Zap,
} from "lucide-react";
import {
  resolveWorkItemIcon,
  resolveWorkItemIconColor,
  workItemIcons,
  workItemIconColors,
  type WorkItemIconName,
  type WorkItemIconColor,
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
  terminal: { component: Terminal, label: "终端" },
  "git-branch": { component: GitBranch, label: "分支" },
  "git-pull-request": { component: GitPullRequest, label: "合并请求" },
  "git-commit": { component: GitCommitHorizontal, label: "提交" },
  cpu: { component: Cpu, label: "处理器" },
  workflow: { component: Workflow, label: "工作流" },
  network: { component: Network, label: "网络" },
  cloud: { component: Cloud, label: "云服务" },
  server: { component: Server, label: "服务器" },
  "hard-drive": { component: HardDrive, label: "硬盘" },
  container: { component: Container, label: "容器" },
  boxes: { component: Boxes, label: "组件" },
  globe: { component: Globe, label: "地球" },
  search: { component: Search, label: "搜索" },
  scan: { component: Scan, label: "扫描" },
  filter: { component: Filter, label: "过滤" },
  settings: { component: Settings2, label: "设置" },
  sliders: { component: SlidersHorizontal, label: "调节" },
  timer: { component: Timer, label: "计时器" },
  clock: { component: Clock3, label: "时钟" },
  calendar: { component: CalendarDays, label: "日历" },
  checklist: { component: ListChecks, label: "检查清单" },
  "check-circle": { component: CircleCheck, label: "完成" },
  "circle-dot": { component: CircleDot, label: "圆点" },
  milestone: { component: Milestone, label: "里程碑" },
  "list-todo": { component: ListTodo, label: "待办列表" },
  briefcase: { component: BriefcaseBusiness, label: "公文包" },
  building: { component: Building2, label: "建筑" },
  users: { component: Users, label: "团队" },
  user: { component: UserRound, label: "用户" },
  messages: { component: MessagesSquare, label: "讨论" },
  mail: { component: Mail, label: "邮件" },
  bell: { component: Bell, label: "通知" },
  megaphone: { component: Megaphone, label: "公告" },
  "pen-tool": { component: PenTool, label: "钢笔" },
  paintbrush: { component: Paintbrush, label: "画笔" },
  image: { component: Image, label: "图片" },
  camera: { component: Camera, label: "相机" },
  video: { component: Video, label: "视频" },
  music: { component: Music, label: "音乐" },
  headphones: { component: Headphones, label: "耳机" },
  heart: { component: Heart, label: "爱心" },
  star: { component: Star, label: "星标" },
  sparkles: { component: Sparkles, label: "星光" },
  trophy: { component: Trophy, label: "奖杯" },
  gem: { component: Gem, label: "宝石" },
  leaf: { component: Leaf, label: "叶子" },
  coffee: { component: Coffee, label: "咖啡" },
} as const;

const colorLabels = {
  blue: "蓝色",
  violet: "紫色",
  pink: "粉色",
  red: "红色",
  orange: "橙色",
  amber: "金色",
  green: "绿色",
  teal: "青绿色",
  cyan: "青色",
  slate: "灰蓝色",
} as const;

/** 看板标签和事项列表共用图标及配色，旧事项自动使用默认颜色。 */
export function WorkItemIcon({
  icon,
  color,
  itemId,
  size = 14,
}: {
  icon?: WorkItemIconName;
  color?: WorkItemIconColor;
  itemId?: string;
  size?: number;
}) {
  const item = { icon, iconColor: color, id: itemId };
  const Icon = icons[resolveWorkItemIcon(item)].component;
  return (
    <Icon
      className="work-item-icon"
      size={size}
      style={{ color: `var(--work-icon-${resolveWorkItemIconColor(item)})` }}
      aria-hidden="true"
    />
  );
}

/** 在一个展开面板中搜索图标和选色，支持键盘操作与 Esc 收起。 */
export function WorkItemIconPicker({
  value,
  color,
  onChange,
  onColorChange,
  disabled = false,
}: {
  value: WorkItemIconName;
  color?: WorkItemIconColor;
  onChange: (icon: WorkItemIconName) => void;
  onColorChange: (color: WorkItemIconColor) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const details = useRef<HTMLDetailsElement>(null);
  const selectedColor = resolveWorkItemIconColor({
    icon: value,
    iconColor: color,
  });
  const displayed = workItemIcons.filter((icon) =>
    `${icon} ${icons[icon].label} ${t(icons[icon].label)}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  function close() {
    details.current!.open = false;
    details.current!.querySelector("summary")?.focus();
  }
  return (
    <details
      className="work-item-icon-picker"
      ref={details}
      onToggle={(event) => {
        if (!event.currentTarget.open) setQuery("");
      }}
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
        <WorkItemIcon icon={value} color={color} size={18} />
        <span>{t("事项图标")}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </summary>
      <div className="work-item-icon-panel">
        <div
          className="work-item-color-options"
          role="group"
          aria-label={t("图标颜色")}
        >
          {workItemIconColors.map((candidate) => (
            <button
              key={candidate}
              className="work-item-color-option"
              type="button"
              title={t(colorLabels[candidate])}
              aria-label={t("选择颜色：{name}", {
                name: t(colorLabels[candidate]),
              })}
              aria-pressed={selectedColor === candidate}
              disabled={disabled}
              onClick={() => onColorChange(candidate)}
            >
              <span
                style={{ backgroundColor: `var(--work-icon-${candidate})` }}
              >
                {selectedColor === candidate && (
                  <Check size={12} aria-hidden="true" />
                )}
              </span>
            </button>
          ))}
        </div>
        <label className="work-item-icon-search">
          <Search size={14} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("搜索图标…")}
            aria-label={t("搜索图标")}
            disabled={disabled}
          />
        </label>
        <div
          className="work-item-icon-options"
          role="group"
          aria-label={t("事项图标")}
        >
          {displayed.map((icon) => (
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
              <WorkItemIcon
                icon={icon}
                color={value === icon ? color : undefined}
                size={18}
              />
            </button>
          ))}
        </div>
        {!displayed.length && (
          <p className="work-item-icon-empty">{t("没有匹配的图标")}</p>
        )}
      </div>
    </details>
  );
}
