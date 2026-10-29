import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { ArtifactRules } from "../shared/work-items.js";

export const artifactRulesInput = z
  .object({
    urlPrefixes: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(4000)
          .url()
          .refine((value) => {
            if (!URL.canParse(value)) return false;
            const url = new URL(value);
            return (
              ["http:", "https:"].includes(url.protocol) &&
              !url.username &&
              !url.password &&
              !url.search &&
              !url.hash
            );
          }, "每行填写一个有效的 HTTP 或 HTTPS 前缀，不含账号、查询参数或片段。")
          .transform((value) => new URL(value).href.replace(/\/+$/, "")),
      )
      .max(100),
  })
  .transform((rules) => ({ urlPrefixes: [...new Set(rules.urlPrefixes)] }));

/** 成果规则单独保存到插件目录，多个看板实例读取同一份配置。 */
export class ArtifactRulesStore {
  readonly path: string;

  constructor(home: string) {
    this.path = join(home, "kanban", "artifact-rules.json");
  }

  /** 首次打开保留内置规则，不创建文件或默认添加外部前缀。 */
  async read(): Promise<ArtifactRules> {
    try {
      return artifactRulesInput.parse(
        JSON.parse(await readFile(this.path, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { urlPrefixes: [] };
      throw new Error("读取成果解析规则失败，请检查配置文件后重试。");
    }
  }

  /** 整份替换规则，写完后再发布，避免其他看板读取到半份配置。 */
  async save(input: ArtifactRules): Promise<ArtifactRules> {
    const rules = artifactRulesInput.parse(input);
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(rules), { mode: 0o600 });
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
    }
    return rules;
  }
}
