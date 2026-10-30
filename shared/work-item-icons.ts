/** 事项图标使用固定标识，供保存校验和界面选择共用。 */
export const workItemIcons = [
  "rocket",
  "target",
  "lightbulb",
  "code",
  "bug",
  "wrench",
  "layers",
  "flask",
  "book",
  "chart",
  "shield",
  "database",
  "palette",
  "compass",
  "zap",
  "flag",
  "terminal",
  "git-branch",
  "git-pull-request",
  "git-commit",
  "cpu",
  "workflow",
  "network",
  "cloud",
  "server",
  "hard-drive",
  "container",
  "boxes",
  "globe",
  "search",
  "scan",
  "filter",
  "settings",
  "sliders",
  "timer",
  "clock",
  "calendar",
  "checklist",
  "check-circle",
  "circle-dot",
  "milestone",
  "list-todo",
  "briefcase",
  "building",
  "users",
  "user",
  "messages",
  "mail",
  "bell",
  "megaphone",
  "pen-tool",
  "paintbrush",
  "image",
  "camera",
  "video",
  "music",
  "headphones",
  "heart",
  "star",
  "sparkles",
  "trophy",
  "gem",
  "leaf",
  "coffee",
] as const;

export type WorkItemIconName = (typeof workItemIcons)[number];

/** 新事项只在创建时随机选择，后续保存沿用已有图标。 */
export function randomWorkItemIcon(): WorkItemIconName {
  return workItemIcons[Math.floor(Math.random() * workItemIcons.length)];
}

/** 旧事项按 ID 补出固定图标，刷新时保持一致，无需改写数据库。 */
export function resolveWorkItemIcon(item: {
  id?: string;
  icon?: WorkItemIconName;
}): WorkItemIconName {
  if (item.icon) return item.icon;
  let hash = 0;
  for (const character of item.id ?? "")
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  // 旧记录沿用最初 16 个图标，扩充图标库时不改变已有分配。
  return workItemIcons[hash % 16];
}

/** 图标颜色使用受控名称，深浅色主题分别提供对应色值。 */
export const workItemIconColors = [
  "blue",
  "violet",
  "pink",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "cyan",
  "slate",
] as const;

export type WorkItemIconColor = (typeof workItemIconColors)[number];

/** 未手动选色时按图标提供默认配色，旧事项也能直接显示彩色图标。 */
export function resolveWorkItemIconColor(item: {
  id?: string;
  icon?: WorkItemIconName;
  iconColor?: WorkItemIconColor;
}): WorkItemIconColor {
  return (
    item.iconColor ??
    workItemIconColors[
      workItemIcons.indexOf(resolveWorkItemIcon(item)) %
        workItemIconColors.length
    ]
  );
}
