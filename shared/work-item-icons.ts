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
  return workItemIcons[hash % workItemIcons.length];
}
