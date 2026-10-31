import { useId, useState } from "react";
import { ExternalLink, FileText, GitPullRequest } from "lucide-react";
import type { Thread } from "../shared/types";
import type { DetectedArtifact, WorkItem } from "../shared/work-items";
import { openArtifactLink, openConversation, openDetectedFile } from "./client";
import { useI18n } from "./i18n";

/** 看板和工作事项共用成果列表，默认显示三条，方案文件交给 Codex 原生预览。 */
export function DetectedArtifacts({
  artifacts,
  links = [],
  threads,
  onError,
  showSource = true,
}: {
  artifacts: DetectedArtifact[];
  links?: WorkItem["links"];
  threads: Thread[];
  onError: (message: string) => void;
  showSource?: boolean;
}) {
  const { t } = useI18n();
  const [opening, setOpening] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const total = links.length + artifacts.length;
  // 手工链接与自动成果共用三条预览额度，并保持原来的展示顺序。
  const limit = expanded ? total : 3;
  const visibleLinks = links.slice(0, limit);
  const visibleArtifacts = artifacts.slice(
    0,
    Math.max(0, limit - links.length),
  );
  if (!total) return null;
  const report = (reason: unknown) =>
    onError(reason instanceof Error ? reason.message : "无法打开成果");
  return (
    <>
      <div id={listId}>
        {visibleLinks.length > 0 && (
          <div className="work-artifacts">
            {visibleLinks.map((link, index) => (
              <a
                key={`${link.url}-${index}`}
                href={link.url}
                onClick={(event) => {
                  event.preventDefault();
                  void openArtifactLink(link.url).catch(report);
                }}
              >
                <ExternalLink size={12} />
                {link.label || link.url}
              </a>
            ))}
          </div>
        )}
        {visibleArtifacts.length > 0 && (
          <ul className="detected-artifacts">
            {visibleArtifacts.map((artifact) => {
              const source = showSource
                ? threads.find((thread) => thread.id === artifact.threadId)
                : undefined;
              const content = (
                <>
                  {artifact.kind === "mergeRequest" ? (
                    <GitPullRequest size={14} />
                  ) : (
                    <FileText size={14} />
                  )}
                  <span>{artifact.label}</span>
                  {artifact.kind !== "planFile" && <ExternalLink size={12} />}
                </>
              );
              return (
                <li key={artifact.id}>
                  {artifact.kind !== "planFile" ? (
                    <a
                      className="detected-artifact-target"
                      href={artifact.url}
                      title={artifact.url}
                      onClick={(event) => {
                        event.preventDefault();
                        void openArtifactLink(artifact.url).catch(report);
                      }}
                    >
                      {content}
                    </a>
                  ) : (
                    <button
                      type="button"
                      className="detected-artifact-target"
                      title={artifact.path}
                      disabled={opening === artifact.id}
                      onClick={() => {
                        setOpening(artifact.id);
                        void openDetectedFile(artifact.path)
                          .catch(report)
                          .finally(() => setOpening(null));
                      }}
                    >
                      {content}
                    </button>
                  )}
                  {showSource && (
                    <button
                      type="button"
                      className="artifact-source"
                      title={source?.title ?? artifact.threadId}
                      onClick={() =>
                        void openConversation(artifact.threadId).catch(report)
                      }
                    >
                      {t("自动识别 · 来源对话")}
                      {source ? ` · ${source.title}` : ""}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {total > 3 && (
        <button
          type="button"
          className="detected-artifacts-toggle"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t("收起") : `More (${total - 3})`}
        </button>
      )}
    </>
  );
}
