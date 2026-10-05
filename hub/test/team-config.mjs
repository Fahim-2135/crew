// The team the hub tests run with: eight departments, like a long-running Crew (a new one starts
// with the four in STARTER_TEAM). Not a test file itself.

import { DEFAULT_CONFIG, resolveConfig } from "../src/core/config.mjs";

export const TEST_TEAM = Object.freeze([
  { id: "ceo", title: "CEO" },
  { id: "product", title: "Product" },
  { id: "engineering", title: "Engineering" },
  { id: "growth", title: "Growth" },
  { id: "social", title: "Social" },
  { id: "ops", title: "Ops" },
  { id: "learning", title: "Learning" },
  { id: "coder", title: "Coder" },
]);

/** The default routines plus a mail check at noon and five, as a brain with a mailroom has. */
export const TEST_SCHEDULES = Object.freeze([
  ...DEFAULT_CONFIG.schedules,
  { id: "mail-midday", system: "mailroom", at: "12:00" },
  { id: "mail-evening", system: "mailroom", at: "17:00" },
]);

/** Defaults with the test team; pass overrides for anything else. */
export const testConfig = (overrides = {}) =>
  resolveConfig({
    team: TEST_TEAM,
    agentPrefix: "",
    schedules: TEST_SCHEDULES,
    budgetGuard: true,
    ...overrides,
  });
