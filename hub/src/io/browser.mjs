// The agent browser's logins. Agents browse with Playwright (the "browser" MCP server, set up by
// `crew browser setup`); each run gets a fresh browser loaded with the logins saved here, so
// two agents can browse at once. `crew browser` opens a plain Chrome window on the agents' own
// profile for the user to sign in (no automation attached, so Google and LinkedIn accept it); when
// they close it, the profile is opened once more, out of sight, and its logins saved.
//
// The saved logins (state.json) live in %LOCALAPPDATA%\crew\browser, never in the repo or the
// brain; Crew's file links refuse that folder.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findClaude } from "./claude.mjs";

/** Pinned: the browser tool's actions are what core/gate.mjs reads. */
export const PLAYWRIGHT_MCP = "@playwright/mcp@0.0.83";

/** Where the user signs in by default. */
export const SIGN_IN_SITES = [
  "https://www.linkedin.com/login",
  "https://play.google.com/console",
  "https://admob.google.com/",
];

export function browserPaths(home) {
  const dir = join(home, "browser");
  return {
    dir,
    profile: join(dir, "profile"),
    state: join(dir, "state.json"),
    out: join(dir, "out"),
    cli: join(dir, "node_modules", "@playwright", "mcp", "cli.js"),
  };
}

export function findChrome() {
  const roots = [
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
    process.env.LOCALAPPDATA,
  ];
  for (const root of roots) {
    const exe = root && join(root, "Google", "Chrome", "Application", "chrome.exe");
    if (exe && existsSync(exe)) return exe;
  }
  return null;
}

/**
 * The MCP server entry for Claude Code (user scope, so the terminal and Crew runs see the same
 * tools): an isolated, headless Chrome per run, loaded with the saved logins.
 */
export function mcpEntry(paths, chromeMajor) {
  return {
    type: "stdio",
    command: "node",
    args: [
      paths.cli,
      "--browser",
      "chrome",
      "--isolated",
      "--storage-state",
      paths.state,
      "--headless",
      "--output-dir",
      paths.out,
      // Headless Chrome names itself in its user agent; sites treat that as a bot.
      "--user-agent",
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`,
    ],
  };
}

/** Install the pinned browser tool and register it with Claude Code. */
export function setupBrowser(home, log = console.log) {
  const paths = browserPaths(home);
  mkdirSync(paths.out, { recursive: true });
  if (!existsSync(join(paths.dir, "package.json"))) {
    writeFileSync(join(paths.dir, "package.json"), '{ "name": "crew-browser", "private": true }\n');
  }
  if (!existsSync(paths.state)) writeFileSync(paths.state, '{"cookies":[],"origins":[]}\n');
  const npm = spawnSync(`npm install --no-audit --no-fund ${PLAYWRIGHT_MCP}`, {
    cwd: paths.dir,
    stdio: "inherit",
    shell: true,
  });
  if (npm.status !== 0) throw new Error("npm install failed");
  const chrome = findChrome();
  if (!chrome) throw new Error("Google Chrome isn't installed");
  const version = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `(Get-Item '${chrome}').VersionInfo.ProductVersion`],
    { encoding: "utf8", windowsHide: true },
  ).stdout.trim();
  const entry = JSON.stringify(mcpEntry(paths, version.split(".")[0] || "140"));
  const claude = findClaude();
  spawnSync(claude, ["mcp", "remove", "--scope", "user", "browser"], { stdio: "ignore" });
  const add = spawnSync(claude, ["mcp", "add-json", "--scope", "user", "browser", entry], {
    stdio: "inherit",
  });
  if (add.status !== 0) throw new Error("couldn't register the browser with Claude Code");
  log(`The agent browser is set up (Chrome ${version}). Next: \`crew browser\` to sign in.`);
}

/**
 * Open Chrome on the agents' profile for the user to sign in; once they close it, save the logins.
 * @returns {Promise<{ cookies: number, sites: string[] }>}
 */
export async function signIn(home, sites = SIGN_IN_SITES, log = console.log) {
  const paths = browserPaths(home);
  if (!existsSync(paths.cli)) throw new Error("run `crew browser setup` first");
  const chrome = findChrome();
  if (!chrome) throw new Error("Google Chrome isn't installed");
  mkdirSync(paths.profile, { recursive: true });

  log("Sign in to the sites the agents should use, then close the Chrome window.");
  const window = spawn(
    chrome,
    [
      `--user-data-dir=${paths.profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      ...sites,
    ],
    { stdio: "ignore", windowsHide: false },
  );
  await new Promise((resolve) => window.on("exit", resolve));
  // Chrome may hand the window to a process that outlives the first; wait until the profile
  // is free before reading it.
  await new Promise((r) => setTimeout(r, 1500));

  log("Saving the logins…");
  return saveLogins(home);
}

/**
 * Open the agents' profile once, out of sight, and save its logins for the agents' runs.
 * @returns {Promise<{ cookies: number, sites: string[] }>}
 */
export async function saveLogins(home) {
  const paths = browserPaths(home);
  mkdirSync(paths.profile, { recursive: true });
  const { chromium } = await import(
    pathToFileURL(join(paths.dir, "node_modules", "playwright", "index.mjs")).href
  );
  let context;
  for (let attempt = 0; ; attempt++) {
    try {
      context = await chromium.launchPersistentContext(paths.profile, {
        channel: "chrome",
        headless: true,
      });
      break;
    } catch (err) {
      if (attempt >= 20)
        throw new Error(`Chrome is still open on the agents' profile (${err.message})`, {
          cause: err,
        });
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  try {
    const tmp = `${paths.state}.tmp`;
    const state = await context.storageState({ path: tmp });
    renameSync(tmp, paths.state);
    const domains = [...new Set(state.cookies.map((c) => c.domain.replace(/^\./, "")))];
    const known = domains.filter((d) =>
      /(linkedin|facebook|google|github|notion|slack|supabase|sentry|vercel|expo)\./.test(d),
    );
    return { cookies: state.cookies.length, sites: known.sort() };
  } finally {
    await context.close();
  }
}
