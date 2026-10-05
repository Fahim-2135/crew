// Links in agent messages, for the Crew window and the phone app alike: web links (https) and
// files or folders on the user's PC (absolute Windows paths), so they can open what an agent made
// with one click instead of going to look for it. Pure: it only splits text into pieces.

/**
 * @typedef {{ kind: "text", text: string }
 *   | { kind: "code", text: string }
 *   | { kind: "bold", text: string }
 *   | { kind: "url", text: string, url: string }
 *   | { kind: "path", text: string, path: string }} Piece
 */

// [label](target) · `code` · **bold** · a bare https link · a bare absolute path like E:/a/b.md
const TOKEN =
  /\[([^\]\n]+)\]\(([^)\s]+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|(https?:\/\/[^\s<>"'`]+)|((?<![\w/\\])[A-Za-z]:[\\/][^\s<>"'`|*?]*)/g;

/** Punctuation that ends a sentence rather than the link: "see E:/a.md." */
const TRAILING = /[.,;:!?)\]}'"]+$/;

/** An absolute Windows path, as a whole string. */
const PATH = /^[A-Za-z]:[\\/][^<>"|*?\n]*$/;

/** @param {string} url */
function webLink(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/** @param {string} target @returns {Piece | null} */
function linkFor(target, text) {
  const url = webLink(target);
  if (url) return { kind: "url", text, url };
  if (PATH.test(target)) return { kind: "path", text, path: target };
  return null;
}

/**
 * Split a message into text, code, bold and link pieces. A code span that holds nothing but a
 * link or a path becomes that link (agents often write paths as `code`).
 * @param {string} input
 * @returns {Piece[]}
 */
export function splitLinks(input) {
  const text = String(input ?? "");
  /** @type {Piece[]} */
  const pieces = [];
  const plain = (s) => {
    if (!s) return;
    const prev = pieces.at(-1);
    if (prev?.kind === "text") prev.text += s;
    else pieces.push({ kind: "text", text: s });
  };
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    let whole = m[0];
    let piece;
    if (m[1] !== undefined) {
      piece = linkFor(m[2], m[1]);
    } else if (m[3] !== undefined) {
      piece = linkFor(m[3].trim(), m[3]) ?? { kind: "code", text: m[3] };
    } else if (m[4] !== undefined) {
      piece = { kind: "bold", text: m[4] };
    } else {
      const full = whole;
      whole = whole.replace(TRAILING, "");
      // Give back a closing bracket that belongs to the link: https://x.org/a_(b)
      const count = (s, c) => s.split(c).length - 1;
      while (full[whole.length] === ")" && count(whole, "(") > count(whole, ")")) {
        whole += ")";
      }
      piece = linkFor(whole, whole);
    }
    plain(text.slice(last, m.index));
    if (piece) pieces.push(piece);
    else plain(whole);
    last = m.index + whole.length;
  }
  plain(text.slice(last));
  return pieces;
}
