// After a run that wrote to the brain: commit exactly the files that run wrote (plus the
// regenerated indexes), never anything else the user has in progress. The brain's own pre-commit
// hook runs its lint and gitleaks, so a note with a secret in it is refused, not committed.

import { spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";

/** Files the brain's index rebuild regenerates; committed along with the run's own. */
const GENERATED = ["index.json", "MAP.md"];

const git = (brain, args) =>
  spawnSync("git", ["-C", brain, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });

/**
 * @param {string} brain
 * @param {string[]} files  absolute paths the run wrote (others are ignored)
 * @param {string} message
 * @returns {{ ok: boolean, detail: string }}
 */
export function commitRun(brain, files, message) {
  const root = resolve(brain);
  const inside = [
    ...new Set(
      files
        .map((f) => relative(root, resolve(f)).replace(/\\/g, "/"))
        .filter((p) => p && !p.startsWith("..") && !p.startsWith("/") && !/^[a-z]:/i.test(p)),
    ),
  ];
  if (!inside.length) return { ok: true, detail: "nothing in the brain to commit" };
  const paths = [
    ...inside,
    ...GENERATED.filter((g) => git(brain, ["ls-files", "--error-unmatch", g]).status === 0),
  ];

  const add = git(brain, ["add", "--", ...paths]);
  if (add.status !== 0)
    return { ok: false, detail: `git add: ${(add.stderr || add.stdout).trim()}` };
  const changed = git(brain, ["diff", "--cached", "--quiet", "--", ...paths]);
  if (changed.status === 0) return { ok: true, detail: "no changes" };
  // `commit -- <paths>` commits only these, whatever else is staged.
  const commit = git(brain, ["commit", "-q", "-m", message, "--", ...paths]);
  if (commit.status !== 0) {
    // Leave nothing half-staged: the hook (lint or gitleaks) said no.
    git(brain, ["reset", "-q", "--", ...paths]);
    // What the hook said, without git's line-ending chatter.
    const said = `${commit.stderr}\n${commit.stdout}`
      .split("\n")
      .filter((l) => l.trim() && !/^warning: in the working copy of/.test(l))
      .join("\n");
    return { ok: false, detail: said.slice(0, 400) || `git commit exited ${commit.status}` };
  }
  return { ok: true, detail: git(brain, ["log", "-1", "--format=%h"]).stdout.trim() };
}
