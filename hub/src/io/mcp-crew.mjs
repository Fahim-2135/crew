#!/usr/bin/env node
// The `crew` MCP server Claude Code starts for every Crew run: it gives the agent its Crew tools
// (`request_approval`, `ask_teammate`, `schedule_check` / `list_checks` / `cancel_check`,
// and `set_progress`)
// and forwards each call to the hub. Zero dependencies: newline-delimited
// JSON-RPC 2.0 on stdin/stdout (verified against Claude Code 2.1.288 in spike 0.6).
//
// The hub writes the run's identity into this server's environment (CREW_JOB, CREW_AGENT),
// and where to reach it (CREW_PORT, CREW_TOKEN_FILE).

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { ACTIONS } from "../core/approvals.mjs";
import { owner, Owner } from "../core/owner.mjs";
import { ASK_WAIT_MS } from "../core/teamtalk.mjs";

const TOOL = {
  name: "request_approval",
  description: [
    `Ask ${owner()} to approve one of Crew's own actions. Everything else you just do with your tools (Crew asks them for a quick OK by itself when a call can't be undone or reaches people); use this only for these types.`,
    "Types: patch.apply {repo, patch} applies a patch file you wrote inside the brain to a git repo, as a commit on its own branch (never pushed); git.push {repo, remote, branch}; command {command, cwd} runs one exact command line; agent.create {id, title, description, instructions, web, icon} adds a new department agent to the team (Crew creates its files once they approve); agent.update {id, instructions, change} replaces your own standing instructions (the complete new text), keeping your tools and scope.",
    `Write \`summary\` as the one line ${owner()} hears first. After calling this, end your turn: Crew tells you their answer later.`,
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      type: { type: "string", enum: Object.keys(ACTIONS) },
      summary: { type: "string", description: "One plain line, under 200 characters" },
      why: { type: "string", description: "Why it is needed, in a sentence or two" },
      payload: { type: "object", description: "The exact action; fields depend on type" },
    },
    required: ["type", "summary", "payload"],
  },
};

/** ask_teammate, with the team's ids in its description (filled in at tools/list). */
const askTool = (team) => ({
  name: "ask_teammate",
  description: [
    "Ask a teammate a question in the middle of your task and wait for the answer (up to 10 minutes): research, a fact from their memory, a check, a short draft.",
    team.length ? `Teammates: ${team.map((a) => `${a.id} (${a.title})`).join(", ")}.` : "",
    "For bigger work that can wait, write a request in their inbox instead: Crew wakes them and sends you their reply.",
  ]
    .filter(Boolean)
    .join(" "),
  inputSchema: {
    type: "object",
    properties: {
      agent: { type: "string", description: "The teammate's id" },
      question: {
        type: "string",
        description: "What you need, with the context they need to answer it",
      },
    },
    required: ["agent", "question"],
  },
});

/** Checks the agent schedules for itself (hub core/checks.mjs). */
const CHECK_TOOLS = [
  {
    name: "schedule_check",
    description: [
      "Leave yourself a check for later: Crew runs it when it is due, even if nobody has messaged you. Use it on your own for anything with a time ahead that could go wrong, something you are waiting on, a result worth checking later, or a retry.",
      'when: "in 2h", "in 3 days", or a local time "YYYY-MM-DD HH:MM". For a check that repeats, add every ("3h", "1 day", at least hourly) and until (when to stop, within 30 days).',
      "what: full instructions to your future self (it won't remember this chat): what to look at, where, and what counts as a problem.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        when: { type: "string" },
        what: { type: "string" },
        why: { type: "string", description: "One line on why, shown to the user" },
        every: { type: "string" },
        until: { type: "string" },
      },
      required: ["when", "what"],
    },
  },
  {
    name: "list_checks",
    description: "Your scheduled checks: open ones first, with their ids and next run.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cancel_check",
    description: "Remove one of your checks that is no longer needed.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
];

const PROGRESS_TOOL = {
  name: "set_progress",
  description:
    "Show your plan for a bigger task as a short checklist, and keep it current: call it at the start, and whenever a step starts or finishes. The user sees it live on the PC and the phone, so they can see how far you are without interrupting you. Send the whole list each time.",
  inputSchema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        description: "Up to 12 steps, in order",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "A few words" },
            status: { type: "string", enum: ["todo", "doing", "done"] },
          },
          required: ["text", "status"],
        },
      },
    },
    required: ["steps"],
  },
};

async function setProgress(args) {
  const { ok, status, body } = await hub("POST", `/v1/jobs/${process.env.CREW_JOB}/progress`, {
    steps: args.steps,
  });
  if (!ok) return text(`Not shown: ${body.error ?? `HTTP ${status}`}.`, true);
  const done = body.steps.filter((s) => s.status === "done").length;
  return text(`Checklist shown: ${done} of ${body.steps.length} done.`);
}

const when = (ms) =>
  new Date(ms).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

async function checkTool(name, args) {
  if (name === "schedule_check") {
    const { ok, status, body } = await hub("POST", "/v1/checks", {
      jobId: Number(process.env.CREW_JOB),
      ...args,
    });
    if (!ok) return text(`Not scheduled: ${body.error ?? `HTTP ${status}`}.`, true);
    const c = body.check;
    return text(
      `Scheduled check ${c.id}: first run ${when(c.at)}${c.every ? `, then every ${Math.round(c.every / 3_600_000)}h until ${when(c.until)}` : ""}.`,
    );
  }
  const { ok, status, body } =
    name === "list_checks"
      ? await hub("GET", `/v1/checks?agent=${encodeURIComponent(process.env.CREW_AGENT ?? "")}`)
      : await hub("POST", `/v1/checks/${encodeURIComponent(String(args.id ?? ""))}/cancel`, {
          by: "agent",
        });
  if (!ok) return text(`Failed: ${body.error ?? `HTTP ${status}`}.`, true);
  if (name === "cancel_check") return text(`Check ${body.check.id} is ${body.check.status}.`);
  const open = body.checks.filter((c) => c.status === "active");
  if (!open.length) return text("You have no open checks.");
  return text(
    open
      .map(
        (c) => `${c.id}: next ${when(c.at)}${c.every ? " (repeats)" : ""}: ${c.what.slice(0, 160)}`,
      )
      .join("\n"),
  );
}

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], isError });

/** One call to the hub: { ok, status, body }. */
async function hub(method, path, payload) {
  const token = readFileSync(process.env.CREW_TOKEN_FILE ?? "", "utf8").trim();
  const res = await fetch(`http://127.0.0.1:${process.env.CREW_PORT}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}

async function teammates() {
  try {
    const { ok, body } = await hub("GET", "/v1/agents");
    return ok ? body.agents.filter((a) => a.id !== process.env.CREW_AGENT) : [];
  } catch {
    return [];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function askTeammate(args) {
  const { ok, status, body } = await hub("POST", "/v1/ask", {
    jobId: Number(process.env.CREW_JOB),
    agent: args.agent,
    question: args.question,
  });
  if (!ok) return text(`Not asked: ${body.error ?? `HTTP ${status}`}.`, true);
  const id = body.job.id;
  const until = Date.now() + ASK_WAIT_MS;
  while (Date.now() < until) {
    await sleep(2000);
    const r = await hub("GET", `/v1/jobs/${id}`).catch(() => null);
    const job = r?.body?.job;
    if (!job || job.status === "queued" || job.status === "running") continue;
    if (job.status === "done") return text(job.result || "(they answered with nothing)");
    return text(
      `${args.agent} couldn't answer (${job.status}). Carry on without it, or put the request in their inbox.`,
      true,
    );
  }
  await hub("POST", `/v1/jobs/${id}/cancel`).catch(() => null);
  return text(
    `No answer from ${args.agent} in time. Carry on without it, or put the request in their inbox so they pick it up later.`,
    true,
  );
}

async function requestApproval(args) {
  const { ok, status, body } = await hub("POST", "/v1/approvals", {
    jobId: Number(process.env.CREW_JOB),
    agent: process.env.CREW_AGENT,
    ...args,
  });
  if (!ok)
    return text(
      `Not queued: ${body.error ?? `HTTP ${status}`}. Fix the request and try again.`,
      true,
    );
  return text(`Queued as ${body.approval.code}. ${Owner()} will be asked. End your turn now.`);
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.method === "initialize") {
    send({
      id: req.id,
      result: {
        protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "crew", version: "0.1.0" },
      },
    });
  } else if (req.method === "tools/list") {
    send({
      id: req.id,
      result: { tools: [TOOL, askTool(await teammates()), ...CHECK_TOOLS, PROGRESS_TOOL] },
    });
  } else if (req.method === "tools/call") {
    let result;
    try {
      const args = req.params?.arguments ?? {};
      result =
        req.params?.name === TOOL.name
          ? await requestApproval(args)
          : req.params?.name === "ask_teammate"
            ? await askTeammate(args)
            : CHECK_TOOLS.some((t) => t.name === req.params?.name)
              ? await checkTool(req.params.name, args)
              : req.params?.name === PROGRESS_TOOL.name
                ? await setProgress(args)
                : text(`unknown tool ${req.params?.name}`, true);
    } catch (err) {
      result = text(`Crew could not be reached: ${err?.message ?? err}`, true);
    }
    send({ id: req.id, result });
  } else if (req.id !== undefined) {
    send({ id: req.id, error: { code: -32601, message: `unknown method ${req.method}` } });
  }
});
