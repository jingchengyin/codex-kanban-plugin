import { useState } from "react";
import { ExternalLink, FileText, GitPullRequest } from "lucide-react";
import type { Thread } from "../shared/types";
import type { DetectedArtifact } from "../shared/work-items";
import { openArtifactLink, openConversation, openDetectedFile } from "./client";
import { useI18n } from "./i18n";

/** 看板和工作事项共用成果链接，方案文件交给 Codex 原生预览。 */
export function DetectedArtifacts({
  artifacts,
  threads,
  onError,
  showSource = true,
}: {
  artifacts: DetectedArtifact[];
  threads: Thread[];
  onError: (message: string) => void;
  showSource?: boolean;
}) {
  const { t } = useI18n();
  const [opening, setOpening] = useState<string | null>(null);
  if (!artifacts.length) return null;
  const report = (reason: unknown) =>
    onError(reason instanceof Error ? reason.message : "无法打开成果");
  return (
    <ul className="detected-artifacts">
      {artifacts.map((artifact) => {
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
  );
}
