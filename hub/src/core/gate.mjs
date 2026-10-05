// Which tool calls need the user's quick OK before a Crew agent goes ahead ("coworker" mode).
// Agents work freely: read anywhere, run commands, edit, commit, use connectors. Only what
// cannot be undone or reaches other people waits for one tap: deleting, pushing to main or
// rewriting history, publishing, sending email, inviting people, sharing or trashing files.
// A run started by untrusted input (an email) asks before anything beyond reading. Pure.

import { inspectCommand } from "./safety.mjs";

/** Tools that only look: never gated, even in a tainted run. */
const READ_ONLY = new Set([
  "Read",
  "Glob",
  "Grep",
  "ToolSearch",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "ReadMcpResourceDirTool",
  "TaskStop",
  "CronList",
  "ListAgents",
]);

/** Shell lines that need an OK on top of inspectCommand's irreversible ones. */
const COMMANDS = [
  [/\bgit\s+push\b[^\n;&|]*\b(main|master)\b/i, "a push to main"],
  [/\bgit\s+push\b[^\n;&|]*(\s-f\b|--force)/i, "a force push"],
  [/\bRemove-Item\b[^\n;&|]*-(Recurse|Force)\b/i, "deletes files with no recovery"],
  [/\b(del|erase)\b[^\n;&|]*\s\/[sq]\b/i, "deletes files with no recovery"],
  [/\brmdir\b[^\n;&|]*\s\/s\b/i, "deletes a folder with no recovery"],
  [/\b(npm|pnpm|yarn)\s+publish\b/i, "publishes a package"],
  [/\beas\s+submit\b/i, "submits an app to a store"],
  [/\bgh\s+(release\s+create|repo\s+delete|pr\s+merge)\b/i, "acts on GitHub for everyone"],
  [/\b(vercel|netlify)\b[^\n;&|]*--prod\b/i, "deploys to production"],
  // HyperFrames renders locally; these send the project to HeyGen, the cloud, or a public page.
  [
    /\b(hyperframes|plugin-cli\.mjs)\b[^\n;&|]*\s(publish|feedback|cloud|cloudrun|lambda)\b|--file-issue\b/i,
    "sends the video project off this PC",
  ],
];

/** Connector actions that reach other people or can't be taken back. */
const CONNECTOR = [
  [/__(send_message|reply|forward)$/i, "sends an email"],
  [/Gmail__.*(trash|delete)/i, "deletes email"],
  [/Calendar__(delete_event|respond_to_event)$/i, "changes a calendar event for others"],
  [/Drive__(share_file|trash_file)$/i, "shares or trashes a Drive file"],
  [/Canva__(publish|share)/i, "publishes a design"],
  [/__(post|publish|schedule_post|create_post)/i, "posts publicly"],
  [/slack__.*(send|post|schedule)_?message/i, "sends a Slack message"],
  [
    /supabase__(apply_migration|deploy_edge_function|create_project|pause_project|restore_project|create_branch|delete_branch|merge_branch|reset_branch|rebase_branch|confirm_cost)$/i,
    "changes the live Supabase project",
  ],
];

/** SQL that changes data or schema (Supabase execute_sql); SELECTs go freely. */
const WRITE_SQL =
  /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|merge|upsert|vacuum|reindex|comment\s+on|call|do)\b/i;

/**
 * The agent browser (Playwright, signed in to the sites the user saved). Looking, scrolling and
 * typing go freely; the click that sends it out into the world waits for an OK. The tool gives
 * a description of the element it clicks ("Post button"), so the words on it decide.
 */
const BROWSER = /__browser_([a-z][a-z_]*)$/;
const OUTWARD =
  /\b(post|publish|send|submit|share|repost|comment|reply|like|react|follow|connect|invite|buy|pay|purchase|order|checkout|check out|subscribe|donate|delete|remove|discard|trash|confirm|approve|accept|agree|sign ?up|register|create account|log ?out|sign ?out|withdraw|transfer|roll ?out|release|promote|go live|deploy|place)\b/i;
/**
 * Buttons that only open a box to write in: "Start a post", "New message", "Open the comment
 * box", "Add a comment" (the agent describes what it clicks; crewNote asks it to say so).
 */
const OPENS_EDITOR =
  /^\s*((start|create|write|new|draft)\s+(a\s+|an\s+)?(post|message|article)\b|(open|show|add)\s+(the\s+|a\s+)?(comment|reply)(\s+(box|field|editor))?\b)/i;
/**
 * Page scripts (browser_evaluate) that do more than read: clicking, submitting, typing, sending
 * anything off the page, navigating, changing the page or its storage, or hiding a call behind
 * computed names. A script with none of these only reads (counts, numbers, text) and goes freely.
 */
const ACTING_SCRIPT = [
  /\.\s*(click|submit|requestSubmit|dispatchEvent|focus|blur|select|setRangeText|showPicker)\s*\(/,
  /\bnew\s+\w*(Event|Request)\b/,
  /\b(fetch|sendBeacon|postMessage|importScripts|open)\s*\(/,
  /\bnew\s+(XMLHttpRequest|WebSocket|EventSource|Image|Worker|SharedWorker)\b/,
  /\b(execCommand|eval|Function|Reflect|Proxy|import)\s*\(/,
  /\b(setTimeout|setInterval)\s*\(\s*[^\s\w(]/, // a wait is fine; code in a string is not
  /\.\s*(value|checked|selected|innerHTML|outerHTML|innerText|textContent|src|href|action|cookie|location|hash|search)\s*(=(?!=)|\+=)/,
  /\b(location|document\.cookie)\s*=(?!=)/,
  /\b(location|history|localStorage|sessionStorage|indexedDB|caches|navigator\.clipboard)\s*\.\s*(assign|replace|reload|push|back|forward|go|set|remove|clear|open|delete|write)/,
  // Adding to the page can load from elsewhere; taking things away (removeAttribute) can't.
  /\.\s*(append|prepend|appendChild|insertBefore|replaceWith|replaceChildren|insertAdjacent\w*|before|after)\s*\(/,
  // Marking an element to find it again is fine; an attribute that loads or runs is not.
  /\.\s*setAttribute\s*\((?!\s*['"`](data-[\w-]+|aria-[\w-]+|class|id|title)['"`]\s*,)/,
  /\]\s*\(/, // obj["cl" + "ick"]()
  /\bwith\s*\(|\batob\s*\(|\\u[0-9a-f]{4}|\\x[0-9a-f]{2}/i,
];
const readsOnly = (script) => {
  const s = String(script ?? "");
  return s.length > 0 && s.length <= 4000 && !ACTING_SCRIPT.some((p) => p.test(s));
};

/** Browser actions whose effect can't be read from their input: they always ask. */
const BROWSER_OPAQUE = new Set([
  "run_code_unsafe",
  "webmcp_call",
  "mouse_click_xy",
  "mouse_down",
  "mouse_up",
  "route",
  "cookie_set",
  "set_storage_state",
  "localstorage_set",
  "sessionstorage_set",
]);

/** @returns {{ ask: boolean, reason?: string, summary?: string } | null} */
function browserGate(action, input) {
  const what = oneLine(input.element ?? input.selector ?? input.ref ?? "");
  if (action === "evaluate") {
    if (readsOnly(input.function ?? input.expression)) return null;
    return ask("a page script that may act", "Browser: run a script on the page");
  }
  if (BROWSER_OPAQUE.has(action)) {
    return ask("a browser action Crew can't read", `Browser ${action.replace(/_/g, " ")}`);
  }
  if (["click", "check", "uncheck", "hover", "drag", "drop"].includes(action)) {
    if (action !== "hover" && OUTWARD.test(what) && !OPENS_EDITOR.test(what))
      return ask("clicks a button that acts", `Click "${what}"`);
    return null;
  }
  if (action === "type" || action === "press_sequentially" || action === "fill_form") {
    if (input.submit) return ask("submits a form", `Type and submit in "${what}"`);
    return null;
  }
  if (action === "press_key" || action === "keydown") {
    if (/enter/i.test(String(input.key ?? ""))) {
      return ask("Enter may send or submit", `Press ${oneLine(input.key)}`);
    }
    return null;
  }
  if (action === "handle_dialog" && input.accept) {
    return ask(
      "confirms a dialog",
      `Accept the dialog${input.promptText ? `: ${oneLine(input.promptText)}` : ""}`,
    );
  }
  return null;
}

/**
 * @param {{ tool: string, input: Record<string, any>, tainted?: boolean }} call
 * @returns {{ ask: boolean, reason?: string, summary?: string }}
 */
export function gateFor({ tool, input = {}, tainted = false }) {
  if (READ_ONLY.has(tool)) return { ask: false };

  const browser = BROWSER.exec(tool);
  if (browser) {
    const verdict = browserGate(browser[1], input);
    if (verdict) return verdict;
  }

  if (tool === "Bash" || tool === "PowerShell") {
    const command = String(input.command ?? "");
    const hit = inspectCommand(command);
    if (hit) return ask(hit.reason, `Run: ${oneLine(command)}`);
    for (const [pattern, reason] of COMMANDS) {
      if (pattern.test(command)) return ask(reason, `Run: ${oneLine(command)}`);
    }
  }

  if (/__execute_sql$/i.test(tool) && WRITE_SQL.test(String(input.query ?? input.sql ?? ""))) {
    return ask("changes the live database", `SQL: ${oneLine(input.query ?? input.sql)}`);
  }

  // Calendar invites go out to the attendees.
  if (/Calendar__(create_event|update_event)$/i.test(tool) && hasPeople(input)) {
    return ask("invites people", `${short(tool)}: ${oneLine(input.summary ?? input.title ?? "")}`);
  }
  for (const [pattern, reason] of CONNECTOR) {
    if (pattern.test(tool)) {
      const to = input.to ?? input.recipient ?? input.email ?? "";
      return ask(reason, `${short(tool)}${to ? ` to ${oneLine(to)}` : ""}${subject(input)}`);
    }
  }

  // Started by an email or other untrusted text: anything beyond looking waits for the user.
  if (tainted) {
    return ask(
      "this run started from an email",
      `${short(tool)} ${oneLine(JSON.stringify(input))}`,
    );
  }
  return { ask: false };
}

const ask = (reason, summary) => ({ ask: true, reason, summary: summary.slice(0, 200) });
const oneLine = (s) => String(s).replace(/\s+/g, " ").trim().slice(0, 160);
const short = (tool) =>
  tool
    .replace(/^mcp__/, "")
    .replace(/__/g, " · ")
    .replace(/_/g, " ");
const subject = (input) => (input.subject ? ` ("${oneLine(input.subject)}")` : "");
const hasPeople = (input) => {
  const people = input.attendees ?? input.guests ?? input.invitees;
  return Array.isArray(people) ? people.length > 0 : Boolean(people);
};
