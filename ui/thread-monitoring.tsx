import { ArrowUpRight } from "lucide-react";
import type { Thread } from "../shared/types";
import { openConversation } from "./client";
import { useI18n } from "./i18n";

/** 直接使用快照中的双向监听关系，筛选卡片时仍可跳转到另一条对话。 */
export function ThreadMonitoring({
  thread,
  onError,
}: {
  thread: Pick<Thread, "monitoring" | "monitoredBy">;
  onError: (message: string) => void;
}) {
  const { t } = useI18n();
  const relations = [
    ...(thread.monitoring ?? []).map((target) => ({
      ...target,
      direction: "outgoing",
      label: t("监听 {title}", { title: target.title }),
    })),
    ...(thread.monitoredBy ?? []).map((source) => ({
      ...source,
      direction: "incoming",
      label: t("被 {title} 监听", { title: source.title }),
    })),
  ];
  if (!relations.length) return null;

  return (
    <ul className="thread-monitoring" aria-label={t("监听关系")}>
      {relations.map((relation) => (
        <li key={`${relation.direction}:${relation.id}`}>
          <a
            href={`codex://threads/${relation.id}`}
            title={relation.label}
            onClick={(event) => {
              event.preventDefault();
              // 由宿主打开对话，避免在看板 iframe 内导航。
              void openConversation(relation.id).catch((reason) =>
                onError(
                  reason instanceof Error ? reason.message : "无法打开对话",
                ),
              );
            }}
          >
            <span>{relation.label}</span>
            <ArrowUpRight size={12} aria-hidden="true" />
          </a>
        </li>
      ))}
    </ul>
  );
}
