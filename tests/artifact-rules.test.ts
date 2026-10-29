import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactRulesStore } from "../server/artifact-rules.js";

const prefix = "https://bytedance.sg.larkoffice.com/docx";

test("artifact rules persist normalized distinct URL prefixes and can be cleared", async () => {
  const home = await mkdtemp(join(tmpdir(), "taskboard-artifact-rules-"));
  try {
    const store = new ArtifactRulesStore(home);
    assert.deepEqual(await store.read(), { urlPrefixes: [] });
    const rules = await store.save({
      urlPrefixes: [` ${prefix}/ `, prefix, "https://example.com/"],
    });
    assert.deepEqual(rules, { urlPrefixes: [prefix, "https://example.com"] });
    assert.deepEqual(await new ArtifactRulesStore(home).read(), rules);
    assert.ok(
      (
        await readFile(join(home, "kanban", "artifact-rules.json"), "utf8")
      ).includes(prefix),
    );
    assert.deepEqual(await store.save({ urlPrefixes: [] }), {
      urlPrefixes: [],
    });
    assert.deepEqual(await new ArtifactRulesStore(home).read(), {
      urlPrefixes: [],
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("artifact rules reject invalid URL prefixes without replacing saved rules", async () => {
  const home = await mkdtemp(join(tmpdir(), "taskboard-artifact-rules-"));
  try {
    const store = new ArtifactRulesStore(home);
    const rules = await store.save({ urlPrefixes: [prefix] });
    for (const value of [
      "",
      "docx",
      "file:///tmp/docx",
      "javascript:alert(1)",
      "https://user:secret@example.com/docx",
      `${prefix}?view=1`,
      `${prefix}#title`,
    ]) {
      await assert.rejects(async () => store.save({ urlPrefixes: [value] }));
      assert.deepEqual(await store.read(), rules);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
