// Approvals: how an agent asks the user for something it is not allowed to do itself, and how
// their answer is recorded. Pure: validation, codes, the decision rules and expiry.
//
// Agents do most things themselves (coworker mode; core/gate.mjs asks for quick OKs). These
// typed requests are for Crew's own actions: creating or changing an agent, and a few actions
// the hub carries out itself. Once the user approves, the hub does exactly what they saw,
// without a model in the loop: the agent cannot widen or change it after the fact.

import { isAbsolute } from "node:path";
import { AGENT_ID, RESERVED } from "./agents.mjs";
import { ICON_NAMES } from "../../../shared/faces.mjs";
import { owner, Owner } from "./owner.mjs";

/** What each kind of request needs, and how the hub carries it out once approved. */
export const ACTIONS = Object.freeze({
  "patch.apply": {
    executor: "hub",
    fields: { repo: "absolute path", patch: "path to a patch file inside the brain" },
    expiresMs: 24 * 3600_000,
  },
  "git.push": {
    executor: "hub",
    fields: { repo: "absolute path", remote: "remote name", branch: "branch name" },
    expiresMs: 24 * 3600_000,
  },
  command: {
    executor: "hub",
    fields: { command: "the exact command line", cwd: "absolute path" },
    expiresMs: 24 * 3600_000,
  },
  post: {
    executor: "fahim",
    fields: { platform: "where", text: "the exact text" },
    expiresMs: 7 * 24 * 3600_000,
  },
  "mail.send": {
    executor: "fahim",
    fields: { to: "recipient", subject: "subject", text: "the exact text" },
    expiresMs: 7 * 24 * 3600_000,
  },
  "agent.create": {
    executor: "hub",
    fields: {
      id: "lowercase letters and digits, 3-20 long, e.g. reviews",
      title: "the name on screen, e.g. Reviews",
      description: "one or two sentences: what it does and when to use it",
      instructions: "its standing instructions: role, what it owns, how it works, what to report",
      web: "yes or no: may it search and read the web",
      icon: "one of the 25 icon names (crown, bulb, … propeller), or auto",
    },
    expiresMs: 7 * 24 * 3600_000,
  },
  "agent.update": {
    executor: "hub",
    fields: {
      id: "the agent whose standing instructions change (your own id)",
      instructions:
        "the complete new instructions: your whole current text with the change made, keeping the memory, handoff and finish paragraphs",
      change: "two or three sentences: what changes, and which feedback it answers",
    },
    expiresMs: 7 * 24 * 3600_000,
  },
});

/** Remind the user once a request has waited this long. */
export const REMIND_AFTER_MS = 2 * 3600_000;

const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;
const REMOTE = /^[A-Za-z0-9._-]{1,50}$/;

/**
 * Check a request before it is stored. Returns the cleaned payload, or throws with a message
 * the agent can act on.
 * @param {{ type: string, summary: string, why?: string, payload: Record<string, unknown> }} request
 * @param {{ brainDir: string }} context
 */
export function validateRequest(request, context) {
  const spec = ACTIONS[request?.type];
  if (!spec) throw new Error(`unknown action type; use one of: ${Object.keys(ACTIONS).join(", ")}`);
  const summary = String(request.summary ?? "").trim();
  if (!summary) throw new Error(`summary is required: one line ${owner()} reads or hears first`);
  if (summary.length > 200) throw new Error("summary is too long: keep it under 200 characters");

  const p = request.payload ?? {};
  const missing = Object.keys(spec.fields).filter((f) => !String(p[f] ?? "").trim());
  if (missing.length) {
    throw new Error(
      `payload is missing ${missing.join(", ")} (${missing.map((f) => `${f}: ${spec.fields[f]}`).join("; ")})`,
    );
  }
  const payload = Object.fromEntries(Object.keys(spec.fields).map((f) => [f, String(p[f]).trim()]));

  if ("repo" in payload && !isAbsolute(payload.repo))
    throw new Error("repo must be an absolute path");
  if ("cwd" in payload && !isAbsolute(payload.cwd)) throw new Error("cwd must be an absolute path");
  if (request.type === "git.push") {
    if (!REMOTE.test(payload.remote)) throw new Error("remote is not a plain remote name");
    if (!BRANCH.test(payload.branch) || payload.branch.startsWith("-")) {
      throw new Error("branch is not a plain branch name");
    }
  }
  if (request.type === "patch.apply") {
    const brain = norm(context.brainDir);
    const patch = norm(payload.patch);
    if (!isAbsolute(payload.patch) || !patch.startsWith(brain + "/")) {
      throw new Error("patch must be an absolute path to a file you wrote inside the brain");
    }
  }
  if (request.type === "agent.create") {
    payload.id = payload.id.toLowerCase();
    if (!AGENT_ID.test(payload.id)) {
      throw new Error("id must be 3-20 lowercase letters and digits, starting with a letter");
    }
    if (RESERVED.includes(payload.id)) throw new Error(`${payload.id} is already taken`);
    if (payload.title.length > 24) throw new Error("title is too long: 24 characters at most");
    if (payload.description.length > 400) throw new Error("description: 400 characters at most");
    if (payload.instructions.length > 6000)
      throw new Error("instructions: 6000 characters at most");
    const web = payload.web.toLowerCase();
    if (web !== "yes" && web !== "no") throw new Error("web must be yes or no");
    payload.web = web;
    payload.icon = payload.icon.toLowerCase();
    if (payload.icon !== "auto" && !ICON_NAMES.includes(payload.icon)) {
      throw new Error(`icon must be auto or one of: ${ICON_NAMES.join(", ")}`);
    }
  }
  if (request.type === "agent.update") {
    payload.id = payload.id.toLowerCase();
    if (!AGENT_ID.test(payload.id)) throw new Error("id is not an agent name");
    if (payload.instructions.length > 8000)
      throw new Error("instructions: 8000 characters at most");
    if (payload.change.length > 600) throw new Error("change: 600 characters at most");
  }
  if (request.type === "command" && /[\r\n]/.test(payload.command)) {
    throw new Error("command must be a single line");
  }
  return { type: request.type, summary, why: String(request.why ?? "").trim(), payload };
}

const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** Crockford base32 without look-alikes, for codes the user can read out loud. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A short code such as `A-7F3K`, unique among `taken`.
 * @param {() => number} random  returns [0, 1)
 * @param {Set<string>} taken
 */
export function approvalCode(random, taken) {
  for (;;) {
    let code = "A-";
    for (let i = 0; i < 4; i++) code += ALPHABET[Math.floor(random() * ALPHABET.length)];
    if (!taken.has(code)) return code;
  }
}

/**
 * Apply the user's decision. The first decision wins; repeating it (same nonce, or the same
 * answer from a second device) returns the stored outcome, so duplicate deliveries are safe.
 * A different answer after the fact is refused.
 * @param {{ status: string, decision: string | null, nonce: string | null, expiresAt: number }} approval
 * @param {{ decision: "approve" | "deny", nonce: string, now: number }} input
 * @returns {{ changed: boolean, status: string, error?: string }}
 */
export function decide(approval, input) {
  if (input.decision !== "approve" && input.decision !== "deny") {
    return { changed: false, status: approval.status, error: "decision must be approve or deny" };
  }
  if (approval.status !== "pending") {
    if (approval.nonce === input.nonce || approval.decision === input.decision) {
      return { changed: false, status: approval.status };
    }
    return { changed: false, status: approval.status, error: `already ${approval.status}` };
  }
  if (input.now >= approval.expiresAt) {
    return { changed: true, status: "expired", error: "this request has expired" };
  }
  return { changed: true, status: input.decision === "approve" ? "approved" : "denied" };
}

/** Pending requests that have run out of time. */
export function expired(approvals, now) {
  return approvals.filter((a) => a.status === "pending" && now >= a.expiresAt);
}

/** Pending requests old enough for a reminder that have not had one. */
export function needReminder(approvals, now) {
  return approvals.filter(
    (a) => a.status === "pending" && !a.remindedAt && now - a.createdAt >= REMIND_AFTER_MS,
  );
}

/**
 * The message the agent gets after the user's answer. Approved hub actions carry their outcome.
 * @param {{ code: string, summary: string, status: string, result?: string | null, note?: string | null }} a
 */
export function outcomeMessage(a) {
  const head = `Crew: ${Owner()}'s answer on ${a.code} ("${a.summary}"):`;
  switch (a.status) {
    case "executed":
      return `${head} approved, and it is done.\nResult: ${a.result ?? "done"}\nTell them in a line or two what happens next, if anything, as something you did; never mention Crew carrying it out.`;
    case "failed":
      return `${head} approved, but carrying it out failed.\n${a.result ?? ""}\nTell them what went wrong in plain words, and what you suggest.`;
    case "stale":
      return `${head} approved, but it was not carried out: the repository changed since you asked (${a.result ?? "precondition changed"}). Redo the draft against the current state if it is still needed.`;
    case "handed-over":
      return `${head} approved. They will do this one themselves (Crew has no way to post or send for them). Do not try to do it.`;
    case "denied":
      return `${head} no.${a.note ? ` Their note: ${a.note}` : ""} Do not do it; ask them if you are unsure what they want instead.`;
    case "expired":
      return `${head} no answer in time, so it expired and was not done. Raise it again only if it still matters.`;
    default:
      return `${head} ${a.status}.`;
  }
}
