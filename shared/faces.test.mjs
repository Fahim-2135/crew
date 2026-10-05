import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENTS,
  APP_ICON,
  CRITTERS,
  DEFAULT_ICONS,
  ICON_NAMES,
  STATES,
  appIconSVG,
  critterMarkup,
  faceSVG,
  iconFor,
} from "./faces.mjs";

test("the first eight each have their own Critter, and there are 25 to choose from", () => {
  assert.deepEqual(AGENTS, [
    "ceo",
    "product",
    "engineering",
    "growth",
    "social",
    "ops",
    "learning",
    "coder",
  ]);
  assert.equal(ICON_NAMES.length, 25);
  assert.deepEqual(ICON_NAMES.slice(0, 8), Object.values(DEFAULT_ICONS));
  for (const c of Object.values(CRITTERS)) assert.match(c.color, /^#[0-9A-F]{6}$/i);
});

test("every Critter draws in every state, with and without motion, as balanced markup", () => {
  const tags = (s) => {
    const open = (s.match(/<(g|svg|defs|filter|radialGradient)(\s[^>]*)?(?<!\/)>/g) ?? []).length;
    const close = (s.match(/<\/(g|svg|defs|filter|radialGradient)>/g) ?? []).length;
    return [open, close];
  };
  for (const icon of ICON_NAMES) {
    for (const state of [...STATES, "smile"]) {
      for (const motion of [true, false]) {
        const svg = faceSVG(icon, state, { motion });
        assert.match(svg, /^<svg class="critter" viewBox="0 0 100 100"/);
        assert.ok(!svg.includes("undefined") && !svg.includes("NaN"), `${icon} ${state}`);
        const [open, close] = tags(svg);
        assert.equal(open, close, `${icon} ${state} motion=${motion}`);
      }
    }
  }
});

test("each state has its own face; motion adds the moving parts only where they move", () => {
  const m = (state, motion = true) => critterMarkup("crown", state, { motion });
  assert.match(m("idle"), /class="zz"/, "idle dozes");
  assert.match(m("working"), /class="ph-jump"[\s\S]*class="ph-whoosh"/, "jacks, then whoosh");
  assert.match(
    m("working"),
    /<g class="jackL"><circle [^>]*fill="none"\/>/,
    "pivots at the shoulder",
  );
  assert.doesNotMatch(
    faceSVG("crown", "done"),
    /style=/,
    "no inline styles: the window forbids them",
  );
  assert.doesNotMatch(m("working", false), /ph-whoosh|style=/, "a still pose for the phone");
  assert.match(m("asking"), /class="tear"/, "eyes brimming");
  assert.match(m("done"), /class="spark/, "sparkles on the hop");
  assert.doesNotMatch(m("done", false), /spark/);
  assert.match(m("done"), /class="waveR"/);
  assert.match(m("limit"), /class="tear late"/, "crying");
  assert.doesNotMatch(m("smile"), /zz|tear|spark/);
});

test("created agents get a spare Critter from their name; a picked one wins", () => {
  assert.equal(iconFor("reviews", null), iconFor("reviews", null));
  assert.ok(ICON_NAMES.slice(8).includes(iconFor("reviews")));
  assert.equal(iconFor("reviews", "wizard"), "wizard");
  assert.equal(iconFor("ceo"), "crown");
  assert.equal(iconFor("ceo", "not-an-icon"), "crown");
  const picks = new Set(
    ["reviews", "finance", "health", "study", "travel", "music"].map((a) => iconFor(a)),
  );
  assert.ok(picks.size >= 3);
});

test("unknown icons and states still draw", () => {
  assert.match(faceSVG("nobody", "confused"), /^<svg/);
});

test("the app icon: Fahim's five on the round badge, or as a silhouette", () => {
  assert.deepEqual(APP_ICON.pick, ["crown", "headset", "bandana", "tophat", "antenna"]);
  const icon = appIconSVG();
  assert.equal((icon.match(/<svg x=/g) ?? []).length, 5);
  assert.match(icon, /<circle cx="100" cy="100" r="100" fill="#F1ECE1"\/>/);
  assert.doesNotMatch(appIconSVG({ background: null }), /r="100"/, "transparent foreground");
  assert.match(appIconSVG({ silhouette: "#ffffff", background: null }), /crew-flat/);
});
