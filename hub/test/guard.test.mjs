import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { denyReason } from "../src/hooks/crew-guard.mjs";

const GUARD = fileURLToPath(new URL("../src/hooks/crew-guard.mjs", import.meta.url));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "crew-guard-"));
  const brain = join(root, "brain");
  mkdirSync(join(brain, "departments", "social"), { recursive: true });
  // Agent memory folders are junctions into the brain.
  const memory = join(root, "agent-memory-social");
  symlinkSync(join(brain, "departments", "social"), memory, "junction");
  return { root, brain, memory };
}

test("writes inside the brain pass, including through a junction into it", () => {
  const { root, brain, memory } = fixture();
  try {
    const write = (file_path) =>
      denyReason({ tool_name: "Write", tool_input: { file_path }, cwd: brain }, brain);
    assert.equal(write(join(brain, "departments", "social", "note.md")), null);
    assert.equal(write("departments/social/new/deep.md"), null);
    assert.equal(write(join(memory, "x.md")), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writes outside the brain are denied, for every write tool", () => {
  const { root, brain } = fixture();
  try {
    for (const tool_name of ["Write", "Edit", "MultiEdit"]) {
      const reason = denyReason(
        { tool_name, tool_input: { file_path: join(root, "outside.txt") }, cwd: brain },
        brain,
      );
      assert.match(reason, /\[crew guard\]/, tool_name);
    }
    assert.match(
      denyReason(
        { tool_name: "NotebookEdit", tool_input: { notebook_path: "../escape.ipynb" }, cwd: brain },
        brain,
      ),
      /outside/,
    );
    assert.match(
      denyReason(
        { tool_name: "Write", tool_input: { file_path: brain + "-evil/x.md" }, cwd: brain },
        brain,
      ),
      /outside/,
      "a sibling folder whose name starts with the brain's is still outside",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reads are never this guard's business", () => {
  assert.equal(
    denyReason({ tool_name: "Read", tool_input: { file_path: "C:/anything" } }, "C:/brain"),
    null,
  );
});

test("as a hook it prints a deny decision, or nothing", () => {
  const { root, brain } = fixture();
  try {
    const run = (payload) =>
      spawnSync(process.execPath, [GUARD, brain], {
        input: JSON.stringify(payload),
        encoding: "utf8",
      }).stdout;
    const denied = JSON.parse(
      run({ tool_name: "Write", tool_input: { file_path: join(root, "o.txt") }, cwd: brain }),
    );
    assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(
      run({ tool_name: "Write", tool_input: { file_path: join(brain, "ok.md") }, cwd: brain }),
      "",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
