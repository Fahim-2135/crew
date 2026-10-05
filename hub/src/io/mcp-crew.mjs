#!/usr/bin/env node
// The `crew` MCP server Claude Code starts for every Crew run: it gives the agent one tool,
// `request_approval`, and forwards each call to the hub. Zero dependencies: newline-delimited
// JSON-RPC 2.0 on stdin/stdout (verified against Claude Code 2.1.288 in spike 0.6).
//
// The hub writes the run's identity into this server's environment (CREW_JOB, CREW_AGENT),
// and where to reach it (CREW_PORT, CREW_TOKEN_FILE).

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { ACTIONS } from "../core/approvals.mjs";
import { owner, Owner } from "../core/owner.mjs";

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

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], isError });

async function requestApproval(args) {
  const token = readFileSync(process.env.CREW_TOKEN_FILE ?? "", "utf8").trim();
  const res = await fetch(`http://127.0.0.1:${process.env.CREW_PORT}/v1/approvals`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      jobId: Number(process.env.CREW_JOB),
      agent: process.env.CREW_AGENT,
      ...args,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    return text(
      `Not queued: ${body.error ?? `HTTP ${res.status}`}. Fix the request and try again.`,
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
    send({ id: req.id, result: { tools: [TOOL] } });
  } else if (req.method === "tools/call") {
    let result;
    try {
      result =
        req.params?.name === TOOL.name
          ? await requestApproval(req.params.arguments ?? {})
          : text(`unknown tool ${req.params?.name}`, true);
    } catch (err) {
      result = text(`Crew could not be reached: ${err?.message ?? err}`, true);
    }
    send({ id: req.id, result });
  } else if (req.id !== undefined) {
    send({ id: req.id, error: { code: -32601, message: `unknown method ${req.method}` } });
  }
});
