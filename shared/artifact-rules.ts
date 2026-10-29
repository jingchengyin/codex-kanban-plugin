import type { ArtifactRules } from "./work-items.js";

/** 规则顺序不影响解析结果，统一标识供两层磁盘缓存校验。 */
export function artifactRulesKey(rules: ArtifactRules): string {
  return JSON.stringify([...new Set(rules.urlPrefixes)].sort());
}
