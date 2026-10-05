// `crew setup`: a new brain from the kit, with the starter team, safe to run twice.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBrain, writeSettings } from "../src/io/setup.mjs";
import { parseAgentFile } from "../src/core/agents.mjs";

test("a new brain: the kit, the brief filled in, four agents, and git", () => {
  const root = mkdtempSync(join(tmpdir(), "crew-setup-"));
  const brainDir = join(root, "crew-brain");
  const agentsDir = join(root, "claude", "agents", "crew");
  try {
    const out = createBrain({
      brainDir,
      agentsDir,
      owner: "Maya",
      focus: "a podcast about urban gardening",
      today: "2026-10-05",
    });
    assert.deepEqual(out.created, ["ceo", "research", "writer", "builder"]);

    const brief = readFileSync(join(brainDir, "BRIEF.md"), "utf8");
    assert.match(brief, /works for \*\*Maya\*\*/);
    assert.match(brief, /urban gardening/);
    assert.match(brief, /Updated 2026-10-05/);
    assert.doesNotMatch(brief, /\{\{/);
    for (const file of ["AGENTS.md", "README.md", ".gitignore", "config/agents.json", "lessons"]) {
      assert.ok(existsSync(join(brainDir, file)), file);
    }

    const writer = readFileSync(join(agentsDir, "crew-writer.md"), "utf8");
    const def = parseAgentFile(writer);
    assert.equal(def.name, "crew-writer", "named so it never shadows an agent the user has");
    assert.match(def.body, /You are \*\*Writer\*\*, one of Maya's departments/);
    assert.doesNotMatch(
      writer,
      /guard\.mjs|private\/|coder\/|Fahim/,
      "nothing from Fahim's own brain",
    );
    assert.ok(existsSync(join(brainDir, "departments", "builder", "memory", "MEMORY.md")));

    const scopes = JSON.parse(readFileSync(join(brainDir, "config", "agents.json"), "utf8")).agents;
    assert.deepEqual(scopes.ceo.write, ["**"], "the CEO keeps its write-anywhere scope");
    assert.equal(scopes.research.write[0], "departments/research/**");

    if (out.git) assert.ok(existsSync(join(brainDir, ".git")));

    // Again: nothing is overwritten.
    const again = createBrain({
      brainDir,
      agentsDir,
      owner: "Someone else",
      focus: "",
      today: "2026-10-06",
    });
    assert.deepEqual(again.created, []);
    assert.match(readFileSync(join(brainDir, "BRIEF.md"), "utf8"), /Maya/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("settings merge into config.json", () => {
  const home = mkdtempSync(join(tmpdir(), "crew-home-"));
  try {
    writeSettings(home, { owner: "Maya", maxRuns: 2 });
    writeSettings(home, { brain: "D:/brains/maya" });
    assert.deepEqual(JSON.parse(readFileSync(join(home, "config.json"), "utf8")), {
      owner: "Maya",
      maxRuns: 2,
      brain: "D:/brains/maya",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
