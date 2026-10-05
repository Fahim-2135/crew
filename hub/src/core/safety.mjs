// Copied from Praxis (github.com/the user-2135/praxis, src/safety.mjs, MIT): the recognizer for
// irreversible shell commands, used here to flag a `command` approval before the user decides.

// Pure safety classifier for the PreToolUse gate (PRAXIS.md §7, §12).
//
// This is SEPARATE from normalize.mjs on purpose. The normalizer collapses argument noise to
// count *habits* — `git push --force-with-lease` becomes `git_push`, `rm -rf x` becomes
// `unmatched`. That is exactly the wrong granularity for safety: the danger lives in the flags
// the normalizer throws away. So the safety gate recognizes the irreversible COMMAND directly,
// on its raw text, before anything runs — and classification feeds an "ask" confirmation, never
// a silent execution.
//
// Coverage is conservative and high-precision (the same philosophy as normalization, PRAXIS.md
// §5): it targets the spec's three irreversible categories — history-rewriting pushes,
// destructive deletions, and external sends — plus a few disk destroyers. Unknown commands are
// NOT flagged (the gate defaults to allow); the list grows as real dangerous commands are
// observed. A gate that over-blocks is one users learn to ignore, which is worse than one they
// trust. Because the decision is "ask" (one confirmation), erring slightly toward flagging is
// cheap — a false positive costs a keystroke, a false negative costs an irreversible action.

/**
 * Shell segment separators — the same set the normalizer splits on. Splitting first means each
 * rule matches within a single command, so a buried link like `npm test && rm -rf dist` is
 * caught segment-by-segment without the patterns needing to reason about chaining.
 */
const SEGMENT_SEPARATORS = /\s*(?:&&|\|\||;|\||\r?\n)\s*/;

/**
 * Irreversible-command rules, checked against each shell segment in order; first match wins.
 * Each pairs a high-precision pattern with a reversibility category and a human reason shown in
 * the confirmation prompt.
 * @type {ReadonlyArray<{ pattern: RegExp, category: string, reason: string }>}
 */
const DESTRUCTIVE_RULES = [
  {
    pattern: /\bgit\s+push\b.*(?:--force\b|-f\b|--force-with-lease\b)/,
    category: "history rewrite",
    reason: "a force-push rewrites published history and can overwrite others' commits",
  },
  {
    pattern: /\bgit\s+reset\b.*--hard\b/,
    category: "irreversible reset",
    reason: "git reset --hard discards uncommitted changes unrecoverably",
  },
  {
    pattern: /\bgit\s+clean\b.*(?:-[a-zA-Z]*f|--force\b)/,
    category: "deletion",
    reason: "git clean -f permanently deletes untracked files",
  },
  {
    pattern: /\brm\b.*\s(?:-[a-zA-Z]*[rRf][a-zA-Z]*|--recursive\b|--force\b)/,
    category: "deletion",
    reason: "rm with -r/-f deletes files with no recovery",
  },
  {
    pattern: /\bdd\b.*\bof=\/dev\//,
    category: "disk overwrite",
    reason: "dd writing to a device node overwrites the disk irreversibly",
  },
  {
    pattern: /\b(?:mkfs(?:\.\w+)?|shred)\b/,
    category: "disk overwrite",
    reason: "this command formats or shreds storage, destroying its contents",
  },
  {
    pattern: />\s*\/dev\/(?:sd|nvme|hd|disk|mapper)/,
    category: "disk overwrite",
    reason: "redirecting into a raw device node overwrites the disk",
  },
  {
    pattern: /\b(?:scp|rsync|sftp)\b.*\s[\w.-]+@[\w.-]+:/,
    category: "external send",
    reason: "this transfers data to or from a remote host — an action that leaves your machine",
  },
  {
    pattern:
      /\bcurl\b.*(?:-T\b|--upload-file\b|-d\b|--data(?:-\w+)?\b|-F\b|--form\b|-X\s*(?:POST|PUT|PATCH|DELETE)\b)/,
    category: "external send",
    reason: "this curl sends data to a remote endpoint — outbound data cannot be unsent",
  },
  {
    pattern: /\bwget\b.*--(?:post-data|post-file|method=(?:POST|PUT))\b/,
    category: "external send",
    reason: "this wget posts data to a remote endpoint — outbound data cannot be unsent",
  },
];

/**
 * @typedef {object} SafetyHit
 * @property {string} category   The reversibility category (for the prompt).
 * @property {string} reason     Human explanation of why confirmation is required.
 * @property {string} segment    The offending command segment.
 */

/**
 * Inspect a raw shell command for an irreversible operation. Returns the first matching rule's
 * details, or `null` if nothing dangerous is recognized (the gate then allows the call).
 * Deterministic and side-effect-free — no model, no I/O — so it is safe on the pre-tool hot path.
 * @param {string} command
 * @returns {SafetyHit | null}
 */
export function inspectCommand(command) {
  const text = String(command ?? "");
  if (!text.trim()) return null;

  const segments = text
    .split(SEGMENT_SEPARATORS)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const segment of segments) {
    for (const rule of DESTRUCTIVE_RULES) {
      if (rule.pattern.test(segment)) {
        return { category: rule.category, reason: rule.reason, segment };
      }
    }
  }
  return null;
}
