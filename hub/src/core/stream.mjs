// Parsing `claude -p --output-format stream-json --verbose` output, one line at a time, into
// the few events the hub acts on. Shapes recorded in spike 0.1 / 0.4 (Claude Code 2.1.288).

/**
 * @typedef {{ kind: "init", sessionId: string, tools: string[], model: string }} InitEvent
 * @typedef {{ kind: "text", text: string, contextTokens: number | null }} TextEvent
 * @typedef {{ kind: "tool", name: string, input: object }} ToolEvent
 * @typedef {{ kind: "limits", fiveHour: number | null, sevenDay: number | null,
 *   resetsAt: number | null, status: string | null }} LimitsEvent
 * @typedef {{ kind: "result", text: string, isError: boolean, sessionId: string | null,
 *   numTurns: number | null, usage: object | null, denials: object[] }} ResultEvent
 * @typedef {{ kind: "delta", text: string }} DeltaEvent  a piece of reply text, as it streams
 * @typedef {{ kind: "blockEnd" }} BlockEndEvent  the end of one content block
 * @typedef {InitEvent | TextEvent | ToolEvent | LimitsEvent | ResultEvent | DeltaEvent
 *   | BlockEndEvent} StreamEvent
 */

/**
 * Tokens the model read for one request: fresh input plus cache reads and writes. This is the
 * size of the conversation it saw, which is what thread rotation watches.
 * @param {any} usage
 */
export function contextTokens(usage) {
  if (!usage) return null;
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

/**
 * Turn one stream line into zero or more events. Unparseable lines and record types the hub
 * does not use return an empty list.
 * @param {string} line
 * @returns {StreamEvent[]}
 */
export function parseStreamLine(line) {
  if (!line || line[0] !== "{") return [];
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return [];
  }

  if (msg.type === "system" && msg.subtype === "init") {
    return [
      {
        kind: "init",
        sessionId: String(msg.session_id ?? ""),
        tools: Array.isArray(msg.tools) ? msg.tools.map(String) : [],
        model: String(msg.model ?? ""),
      },
    ];
  }

  if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
    const events = [];
    const tokens = contextTokens(msg.message.usage);
    for (const block of msg.message.content) {
      if (block?.type === "text" && block.text) {
        events.push({ kind: "text", text: String(block.text), contextTokens: tokens });
      } else if (block?.type === "tool_use") {
        events.push({ kind: "tool", name: String(block.name ?? ""), input: block.input ?? {} });
      }
    }
    return events;
  }

  // With --include-partial-messages (voice calls): the reply as it is written, piece by piece.
  if (msg.type === "stream_event" && !msg.parent_tool_use_id) {
    const ev = msg.event ?? {};
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
      return [{ kind: "delta", text: String(ev.delta.text) }];
    }
    if (ev.type === "content_block_stop") return [{ kind: "blockEnd" }];
    return [];
  }

  if (msg.type === "rate_limit_event") {
    const info = msg.rate_limit_info ?? {};
    const windows = info.unifiedWindows ?? {};
    return [
      {
        kind: "limits",
        fiveHour: windows.five_hour?.utilization ?? null,
        sevenDay: windows.seven_day?.utilization ?? null,
        resetsAt: info.resetsAt ?? null,
        status: info.status ?? null,
      },
    ];
  }

  if (msg.type === "result") {
    return [
      {
        kind: "result",
        text: String(msg.result ?? ""),
        isError: Boolean(msg.is_error) || msg.subtype !== "success",
        sessionId: msg.session_id ? String(msg.session_id) : null,
        numTurns: msg.num_turns ?? null,
        usage: msg.usage ?? null,
        denials: Array.isArray(msg.permission_denials) ? msg.permission_denials : [],
      },
    ];
  }

  return [];
}
