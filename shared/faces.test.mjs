import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENTS,
  DEFAULT_ICONS,
  ICON_NAMES,
  MOODS,
  MOOD_COLORS,
  faceGrid,
  halfBlocks,
  iconFor,
} from "./faces.mjs";

test("the first eight each have their own icon, and there are 25 to choose from", () => {
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
});

test("every face, with every icon, in every state and frame, is a 16×16 grid of colours or null", () => {
  for (const icon of ICON_NAMES) {
    for (const mood of MOODS) {
      for (const frame of [1, 3, 4, 9]) {
        const grid = faceGrid("ceo", mood, frame, icon);
        assert.equal(grid.length, 16);
        for (const row of grid) {
          assert.equal(row.length, 16);
          for (const cell of row) assert.ok(cell === null || /^#[0-9A-F]{6}$/i.test(cell));
        }
      }
    }
  }
});

test("the body colour follows the state", () => {
  for (const mood of MOODS) {
    const grid = faceGrid("ceo", mood);
    assert.equal(grid[10][8], MOOD_COLORS[mood].B, mood); // a body cell between eyes and mouth
    assert.equal(grid[8][0], MOOD_COLORS[mood].O, mood); // the outline
  }
});

test("agents differ by icon; a picked icon replaces the agent's own", () => {
  const top = (g) => JSON.stringify(g.slice(0, 5));
  assert.notEqual(top(faceGrid("ceo", "done")), top(faceGrid("ops", "done")));
  assert.equal(top(faceGrid("ceo", "done", 1, "hardhat")), top(faceGrid("ops", "done")));
  assert.equal(top(faceGrid("ceo", "done", 1, "not-an-icon")), top(faceGrid("ceo", "done")));
});

test("working strains, then breathes out; idle and asking blink", () => {
  assert.deepEqual(faceGrid("ops", "working", 1), faceGrid("ops", "working", 2));
  assert.notDeepEqual(faceGrid("ops", "working", 1), faceGrid("ops", "working", 3));
  assert.deepEqual(faceGrid("ops", "working", 1), faceGrid("ops", "working", 5));
  assert.notDeepEqual(faceGrid("ops", "idle", 1), faceGrid("ops", "idle", 9));
  assert.notDeepEqual(faceGrid("ops", "asking", 1), faceGrid("ops", "asking", 9));
});

test("created agents get a spare icon from their name; the app icon's face wears none", () => {
  assert.equal(iconFor("reviews", null), iconFor("reviews", null));
  assert.ok(ICON_NAMES.slice(8).includes(iconFor("reviews")));
  assert.equal(iconFor("reviews", "wizard"), "wizard");
  assert.equal(iconFor("ceo"), "crown");
  assert.equal(iconFor("crew"), null);
  const picks = new Set(
    ["reviews", "finance", "health", "study", "travel", "music"].map((a) => iconFor(a)),
  );
  assert.ok(picks.size >= 3);
});

test("unknown states still draw", () => {
  assert.equal(faceGrid("nobody", "confused").length, 16);
});

test("half blocks fold 16 rows into 8 terminal rows", () => {
  const cells = halfBlocks(faceGrid("social", "asking"));
  assert.equal(cells.length, 8);
  assert.equal(cells[0].length, 16);
  assert.deepEqual(Object.keys(cells[4][8]), ["top", "bottom"]);
});
