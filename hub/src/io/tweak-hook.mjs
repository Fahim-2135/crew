#!/usr/bin/env node
// Crew's tweak hook, run by Claude Code after every tool call (PostToolUse) and when the agent is
// about to finish (Stop) in a Crew run. It asks the hub for notes the user sent this run with
// "Tell it now" and hands them to the agent: as context after the step it just took, or, at the
// end, by keeping it going with them. Silent when there are none or the hub can't be reached.

import { readFileSync } from "node:fs";
import { owner } from "../core/owner.mjs";
import { tweakContext } from "../core/tweaks.mjs";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

const job = process.env.CREW_JOB;
if (!job) process.exit(0);

let event = {};
try {
  event = JSON.parse(raw);
} catch {
  /* no input: treat as after a step */
}
// A subagent's steps don't take the user's notes; the main conversation does.
if (event.agent_id) process.exit(0);

let texts = [];
try {
  const token = readFileSync(process.env.CREW_TOKEN_FILE ?? "", "utf8").trim();
  const res = await fetch(
    `http://127.0.0.1:${process.env.CREW_PORT ?? "7788"}/v1/jobs/${job}/tweaks/take`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(3000),
    },
  );
  if (res.ok) texts = (await res.json()).texts ?? [];
} catch {
  process.exit(0);
}
if (!texts.length) process.exit(0);

const context = tweakContext(texts, owner());
if (event.hook_event_name === "Stop") {
  // About to finish: keep going with the note instead.
  process.stdout.write(JSON.stringify({ decision: "block", reason: context }));
} else {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context },
    }),
  );
}
