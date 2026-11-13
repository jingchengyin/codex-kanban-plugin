import type { Thread } from "./types.js";

/** Keep local IDs stable; remote IDs include their host throughout the board. */
export function boardThreadId(hostId: string, threadId: string): string {
  return hostId === "local"
    ? threadId
    : `${encodeURIComponent(hostId)}/${threadId}`;
}

export function threadLocation(id: string): {
  hostId: string;
  threadId: string;
} {
  const separator = id.indexOf("/");
  return separator < 0
    ? { hostId: "local", threadId: id }
    : {
        hostId: decodeURIComponent(id.slice(0, separator)),
        threadId: id.slice(separator + 1),
      };
}

export function conversationUrl(id: string): string {
  const { hostId, threadId } = threadLocation(id);
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw new Error("对话 ID 格式无效");
  const url = new URL(`codex://threads/${threadId}`);
  if (hostId !== "local") url.searchParams.set("hostId", hostId);
  return url.toString();
}

export function projectKey(thread: Pick<Thread, "hostId" | "cwd">): string {
  return JSON.stringify([thread.hostId ?? "local", thread.cwd]);
}

/** Existing saved name filters continue to select local projects. */
export function matchesProject(
  thread: Thread,
  selected: string[] | undefined,
): boolean {
  return (
    !selected?.length ||
    selected.includes(projectKey(thread)) ||
    ((thread.hostId ?? "local") === "local" &&
      selected.includes(thread.project))
  );
}
