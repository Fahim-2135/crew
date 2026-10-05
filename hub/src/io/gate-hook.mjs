#!/usr/bin/env node
// Crew's PreToolUse hook for its agents' runs ("coworker" mode). Most tool calls go straight
// through. One that can't be undone or reaches other people (core/gate.mjs) becomes a quick
// OK on the user's phone and in the Crew window; the run waits here for their answer and then goes
// ahead, or is told no. Outside a Crew run (no CREW_JOB) it does nothing.

import { gateFor } from "../core/gate.mjs";
import { askOwner } from "./quick-ok.mjs";

const decide = (decision, reason) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
};

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

if (!process.env.CREW_JOB) process.exit(0);

let call;
try {
  call = JSON.parse(raw);
} catch {
  process.exit(0);
}
const gate = gateFor({
  tool: String(call.tool_name ?? ""),
  input: call.tool_input ?? {},
  tainted: process.env.CREW_TAINTED === "1",
});
if (!gate.ask) process.exit(0);

const answer = await askOwner({
  tool: call.tool_name,
  summary: gate.summary,
  reason: gate.reason,
});
decide(answer.allow ? "allow" : "deny", answer.reason);
