import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GitMetadata } from "../shared/types.js";

const exec = promisify(execFile);
type GitDirectories = { gitDir: string; commonDir: string };

/** 缓存仓库定位，直接读取 HEAD，避免轮询面板时反复启动 Git。 */
export class GitMetadataReader {
  private directories = new Map<
    string,
    { at: number; value: Promise<GitDirectories | null> }
  >();
  private active = 0;
  private waiting: (() => void)[] = [];

  /** 限制并发 Git 进程，目录失效或 Git 不可用时只隐藏仓库信息。 */
  private async locate(cwd: string): Promise<GitDirectories | null> {
    if (this.active >= 8)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      const { stdout } = await exec(
        "git",
        [
          "-C",
          cwd,
          "rev-parse",
          "--path-format=absolute",
          "--git-dir",
          "--git-common-dir",
        ],
        { timeout: 2000 },
      );
      const [gitDir, commonDir] = stdout.trim().split("\n");
      return gitDir && commonDir ? { gitDir, commonDir } : null;
    } catch {
      return null;
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  /** 每次读取当前 HEAD，因此缓存目录不会延迟分支切换的展示。 */
  async read(cwd: string): Promise<GitMetadata | null> {
    if (!cwd) return null;
    let cached = this.directories.get(cwd);
    if (!cached || Date.now() - cached.at >= 5000) {
      cached = { at: Date.now(), value: this.locate(cwd) };
      this.directories.set(cwd, cached);
    }
    const directories = await cached.value;
    if (!directories) return null;
    try {
      const head = (
        await readFile(join(directories.gitDir, "HEAD"), "utf8")
      ).trim();
      const prefix = "ref: refs/heads/";
      return {
        branch: head.startsWith(prefix) ? head.slice(prefix.length) : null,
        // 子模块也可能使用 .git 文件；只有独立的 commonDir 才表示 linked worktree。
        isWorktree: directories.gitDir !== directories.commonDir,
      };
    } catch {
      return null;
    }
  }
}
