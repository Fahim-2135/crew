#!/usr/bin/env node
// A stand-in for `claude -p --output-format stream-json`, for tests. It reads the prompt on
// stdin and answers in the same stream shape Claude Code 2.1.288 produced in the S0 spikes.
// Words in the prompt change its behaviour:
//   SLEEP     never answers (for timeout and kill tests)
//   FAIL      ends with an error result
//   BADTOOLS  reports Bash among its tools (the restriction did not hold)
//   WRITE     reports a Write tool call before answering
//   LIMITHIT  ends on the plan's usage limit (unless the prompt says the limit has reset)
//   TOOLS5    reports five Read tool calls before answering (real work: a skill review follows)
//   INUSE     refuses --session-id as "already in use" (only --resume works)

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const sessionId = flag("--resume") ?? flag("--session-id") ?? "no-session";
const tools = (flag("--tools") ?? "").split(",").filter(Boolean);
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;

const hitLimit = prompt.includes("LIMITHIT") && !prompt.includes("has reset now");

if (prompt.includes("INUSE") && flag("--session-id")) {
  process.stderr.write(`Error: Session ID ${sessionId} is already in use.
`);
  process.exit(1);
}

out({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  tools: prompt.includes("BADTOOLS") ? [...tools, "Bash"] : tools,
  model: flag("--model") ?? "sonnet",
});
out({
  type: "rate_limit_event",
  rate_limit_info: hitLimit
    ? {
        status: "rejected",
        resetsAt: Math.floor(Date.now() / 1000) + 7200,
        unifiedWindows: { five_hour: { utilization: 1 }, seven_day: { utilization: 0.3 } },
      }
    : {
        status: "allowed",
        resetsAt: 1791124200,
        unifiedWindows: { five_hour: { utilization: 0.25 }, seven_day: { utilization: 0.3 } },
      },
});

if (prompt.includes("SLEEP")) {
  setTimeout(() => {}, 600_000);
} else {
  if (prompt.includes("TOOLS5")) {
    for (let i = 0; i < 5; i++) {
      out({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Read", input: { file_path: `f${i}.md` } }],
        },
      });
    }
  }
  if (prompt.includes("WRITE")) {
    out({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Write", input: { file_path: "x.md", content: "x" } }],
      },
    });
  }
  const lastLine = prompt.trim().split("\n").pop();
  const limited = hitLimit;
  const failed = prompt.includes("FAIL") || limited;
  if (args.includes("--include-partial-messages")) {
    // Stream the reply in small pieces, the way partial messages arrive.
    const reply = `echo: ${lastLine}`;
    for (let i = 0; i < reply.length; i += 7) {
      out({
        type: "stream_event",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: reply.slice(i, i + 7) },
        },
      });
    }
    out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_stop" } });
  }
  out({
    type: "assistant",
    message: {
      content: [{ type: "text", text: `echo: ${lastLine}` }],
      usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 },
    },
  });
  out({
    type: "result",
    subtype: failed ? "error_during_execution" : "success",
    is_error: failed,
    result: limited
      ? "You've hit your session limit · resets 8:40pm (Asia/Dhaka)"
      : failed
        ? "boom"
        : `echo: ${lastLine}`,
    session_id: sessionId,
    num_turns: 1,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}
