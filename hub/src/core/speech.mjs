// Turning a streamed reply into sentences the phone can speak while the rest is still being
// written. Pure.

import { Owner } from "./owner.mjs";

/** What a voice-call prompt starts with, so the agent answers in speakable sentences. */
export const voiceNote = () =>
  `[Phone call: ${Owner()} is talking to you by voice and will hear your reply read aloud. Answer in one to three short spoken sentences: plain words, no lists, no markdown, no code, no file paths unless they ask. If the work needs more than a quick answer, say in one sentence what you will do, then do it. Never say you can't call, commit or push, or that Crew does it: say what will happen, like 'I'll call you back' or 'it's ready for your OK'.]`;

/** Strip what reads badly aloud: markdown marks, code fences, links, bullets. */
export function speakable(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Collects streamed text and hands back whole sentences. A sentence ends at . ! or ? followed
 * by a space or a line break, or at a blank line; very short pieces wait for the next one so
 * the phone doesn't speak "Ok." on its own and then pause.
 */
export function createSplitter({ minChars = 12 } = {}) {
  let buffer = "";

  function take(final) {
    const out = [];
    // Sentence ends whose next character has arrived (so "3.5" or "e.g." mid-stream can wait).
    const ends = /[.!?]["')\]]?(?=\s)|\n\s*\n/g;
    let start = 0;
    let m;
    while ((m = ends.exec(buffer))) {
      const end = m.index + m[0].length;
      const clean = speakable(buffer.slice(start, end));
      if (clean.length >= minChars) {
        out.push(clean);
        start = end;
      }
    }
    buffer = buffer.slice(start);
    if (final) {
      const clean = speakable(buffer);
      buffer = "";
      if (clean) out.push(clean);
    }
    return out;
  }

  return {
    /** @param {string} text  the next streamed piece; returns sentences now complete */
    push(text) {
      buffer += text;
      return take(false);
    },
    /** End of a block: whatever is left is a sentence. */
    flush() {
      return take(true);
    },
  };
}
