// Whose team this is: the name agents use for the person they work for ("Maya", or whatever
// `crew setup` was told). The hub sets it from config.owner; the helper processes it starts
// (the gate hook, the crew and desktop MCP servers) read it from CREW_OWNER.

let name = null;

/** @param {string | null | undefined} value */
export function setOwner(value) {
  const clean = String(value ?? "")
    .trim()
    .slice(0, 40);
  name = clean || null;
}

/** The owner's name, or "the user" when none was given. */
export function owner() {
  return name ?? (process.env.CREW_OWNER?.trim() || "the user");
}

/** The name at the start of a sentence. */
export function Owner() {
  const n = owner();
  return n[0].toUpperCase() + n.slice(1);
}

/** "Maya's" / "the user's". */
export function owners() {
  return `${owner()}'s`;
}
