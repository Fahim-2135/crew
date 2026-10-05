// Carrying out an approved action. No model is involved: the hub runs exactly the action
// The user saw. Repository actions check that nothing changed since the request (a moved HEAD or
// an edited patch file makes the approval stale), and a patch is never applied to the branch
// The user works on: it lands as a commit on its own `crew/<code>` branch, built in a temporary
// worktree. Nothing is ever pushed unless a separate `git.push` request is approved.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { owner, Owner, owners } from "../core/owner.mjs";

const OUTPUT_LIMIT = 1500;

/** The shell for `command` actions: Git Bash on Windows (what Claude Code itself uses). */
export function findShell(env = process.env) {
  const candidates = [
    env.CREW_SHELL,
    "C:/Program Files/Git/bin/bash.exe",
    "C:/Program Files (x86)/Git/bin/bash.exe",
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? "bash";
}

function git(repo, args, timeout = 60_000) {
  const out = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout,
  });
  return {
    ok: out.status === 0,
    stdout: (out.stdout ?? "").trim(),
    stderr: (out.stderr ?? "").trim(),
  };
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const tail = (text) => (text.length > OUTPUT_LIMIT ? `…${text.slice(-OUTPUT_LIMIT)}` : text);

/**
 * What must still be true when the action runs, captured when it is requested.
 * Throws when the request cannot be satisfied at all (not a repo, no such patch).
 * @param {{ type: string, payload: Record<string, string> }} request
 */
export function capturePreconditions(request) {
  const { type, payload } = request;
  if (type === "patch.apply" || type === "git.push") {
    const ref = type === "git.push" ? payload.branch : "HEAD";
    const head = git(payload.repo, ["rev-parse", "--verify", ref]);
    if (!head.ok)
      throw new Error(`${payload.repo} has no ${ref}: ${head.stderr || "not a git repository"}`);
    const pre = { head: head.stdout };
    if (type === "patch.apply") {
      if (!existsSync(payload.patch)) throw new Error(`no patch file at ${payload.patch}`);
      pre.patchSha = sha256(payload.patch);
      const check = git(payload.repo, ["apply", "--check", payload.patch]);
      if (!check.ok) throw new Error(`the patch does not apply cleanly: ${check.stderr}`);
    }
    return pre;
  }
  return {};
}

/**
 * Carry out an approved action.
 * @param {{ code: string, type: string, summary: string, payload: Record<string, string>,
 *   preconditions: Record<string, string> }} approval
 * @param {{ shell?: string }} [options]
 * @returns {Promise<{ status: "executed" | "failed" | "stale" | "handed-over", result: string }>}
 */
export async function execute(approval, options = {}) {
  const { type, payload, preconditions: pre } = approval;
  switch (type) {
    case "patch.apply":
      return applyPatch(approval);
    case "git.push": {
      const head = git(payload.repo, ["rev-parse", "--verify", payload.branch]);
      if (!head.ok || head.stdout !== pre.head) {
        return { status: "stale", result: `${payload.branch} moved since the request` };
      }
      const push = git(payload.repo, ["push", payload.remote, payload.branch], 120_000);
      return push.ok
        ? {
            status: "executed",
            result: tail(`Pushed ${payload.branch} to ${payload.remote}.\n${push.stderr}`),
          }
        : { status: "failed", result: tail(push.stderr || push.stdout) };
    }
    case "command": {
      // Asynchronous: a long command must not freeze the hub's API while it runs.
      const out = await runShell(options.shell ?? findShell(), payload.command, payload.cwd);
      const text = tail(out.output.trim() || "(no output)");
      return out.code === 0
        ? { status: "executed", result: text }
        : { status: "failed", result: `exit ${out.code ?? "?"}\n${text}` };
    }
    default:
      return { status: "handed-over", result: `${Owner()} does this one themselves.` };
  }
}

/** Run one command line in a shell, with a five-minute limit. */
function runShell(shell, command, cwd) {
  return new Promise((resolveRun) => {
    let output = "";
    const child = spawn(shell, ["-lc", command], { cwd, windowsHide: true });
    const timer = setTimeout(() => child.kill(), 5 * 60_000);
    child.stdout.on("data", (d) => (output = (output + d).slice(-8000)));
    child.stderr.on("data", (d) => (output = (output + d).slice(-8000)));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveRun({ code: null, output: String(err?.message ?? err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, output });
    });
  });
}

function applyPatch(approval) {
  const { payload, preconditions: pre, code, summary } = approval;
  const head = git(payload.repo, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok || head.stdout !== pre.head)
    return { status: "stale", result: "HEAD moved since the request" };
  if (!existsSync(payload.patch) || sha256(payload.patch) !== pre.patchSha) {
    return { status: "stale", result: "the patch file changed since the request" };
  }

  const branch = `crew/${code.toLowerCase()}`;
  const worktree = join(tmpdir(), `crew-${code.toLowerCase()}-${Date.now()}`);
  const added = git(payload.repo, ["worktree", "add", "-b", branch, worktree, pre.head]);
  if (!added.ok) return { status: "failed", result: tail(added.stderr) };
  try {
    const applied = git(worktree, ["apply", payload.patch]);
    if (!applied.ok) {
      git(payload.repo, ["branch", "-D", branch]);
      return { status: "failed", result: tail(applied.stderr) };
    }
    git(worktree, ["add", "-A"]);
    const commit = git(worktree, [
      "commit",
      "-m",
      `${summary}\n\nApproved by ${owner()} in Crew (${code}).`,
    ]);
    if (!commit.ok) {
      git(payload.repo, ["branch", "-D", branch]);
      return { status: "failed", result: tail(commit.stderr || commit.stdout) };
    }
    const sha = git(worktree, ["rev-parse", "--short", "HEAD"]).stdout;
    return {
      status: "executed",
      result: `Committed ${sha} on branch ${branch} in ${payload.repo}. Not pushed; ${owners()} own branch is untouched.`,
    };
  } finally {
    git(payload.repo, ["worktree", "remove", "--force", worktree]);
    rmSync(worktree, { recursive: true, force: true });
  }
}
