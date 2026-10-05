// After a run, Crew commits exactly the files that run wrote, and nothing the user has in progress.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { commitRun } from "../src/io/brain-git.mjs";

const git = (cwd, ...args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

function repo() {
  const brain = mkdtempSync(join(tmpdir(), "crew-brain-git-"));
  git(brain, "init", "-q", "-b", "main");
  git(brain, "config", "user.name", "Test");
  git(brain, "config", "user.email", "test@example.com");
  mkdirSync(join(brain, "departments", "ops", "memory"), { recursive: true });
  writeFileSync(join(brain, "BRIEF.md"), "brief\n");
  writeFileSync(join(brain, "index.json"), "{}\n");
  git(brain, "add", "-A");
  git(brain, "commit", "-q", "-m", "start");
  return brain;
}

test("commits only the run's files (and the regenerated index), not the user's edits", () => {
  const brain = repo();
  try {
    const note = join(brain, "departments", "ops", "memory", "ops--admob.md");
    writeFileSync(note, "AdMob verified.\n");
    writeFileSync(join(brain, "index.json"), '{"notes":1}\n');
    writeFileSync(join(brain, "BRIEF.md"), "Maya is still editing this\n");
    git(brain, "add", "BRIEF.md"); // even staged work of his stays out

    const out = commitRun(brain, [note, "C:/somewhere/else.md"], "brain: crew ops (chat job 7)");
    assert.equal(out.ok, true, out.detail);
    const files = git(brain, "show", "--name-only", "--format=%s", "HEAD")
      .stdout.trim()
      .split("\n");
    assert.equal(files[0], "brain: crew ops (chat job 7)");
    assert.deepEqual(files.slice(1).filter(Boolean).sort(), [
      "departments/ops/memory/ops--admob.md",
      "index.json",
    ]);
    // Their edit is still there, uncommitted.
    assert.match(git(brain, "status", "--short").stdout, /BRIEF\.md/);

    assert.deepEqual(commitRun(brain, [note], "again"), { ok: true, detail: "no changes" });
    assert.equal(commitRun(brain, [], "none").detail, "nothing in the brain to commit");
  } finally {
    rmSync(brain, { recursive: true, force: true });
  }
});

test("a commit the brain's hook refuses is left unstaged", () => {
  const brain = repo();
  try {
    const hook = join(brain, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho 'secret found' >&2\nexit 1\n", { mode: 0o755 });
    const note = join(brain, "departments", "ops", "memory", "ops--key.md");
    writeFileSync(note, "key: sk-not-really\n");
    const out = commitRun(brain, [note], "brain: crew ops");
    assert.equal(out.ok, false);
    assert.match(out.detail, /secret found/);
    assert.equal(git(brain, "diff", "--cached", "--name-only").stdout.trim(), "");
  } finally {
    rmSync(brain, { recursive: true, force: true });
  }
});
