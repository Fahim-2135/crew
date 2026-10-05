// What differs between Windows and a Mac: starting Crew at sign-in, the desktop shortcut, and
// opening the Crew window as an app window.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";

/** A hidden launcher that runs `crew <args>` (Windows: a .vbs, so no console window flashes). */
function vbsLauncher(file, crewCli, args) {
  const cmd = `"""${process.execPath}"" ""${crewCli}"" ${args}"`;
  writeFileSync(
    file,
    `' Runs: crew ${args}\r\nCreateObject("WScript.Shell").Run ${cmd}, 0, False\r\n`,
  );
}

const startupVbs = () =>
  join(
    process.env.APPDATA ?? "",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    "crew-hub.vbs",
  );
const launchAgent = () => join(homedir(), "Library", "LaunchAgents", "com.crew.hub.plist");

/** Start the hub (hidden, with its supervisor) whenever the user signs in. */
export function setAutostart(on, crewCli) {
  if (isWin) {
    if (on) vbsLauncher(startupVbs(), crewCli, "run");
    else rmSync(startupVbs(), { force: true });
    return startupVbs();
  }
  if (isMac) {
    const plist = launchAgent();
    if (on) {
      mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
      writeFileSync(
        plist,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.crew.hub</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${crewCli}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
`,
      );
      spawnSync("launchctl", ["load", "-w", plist], { stdio: "ignore" });
    } else {
      spawnSync("launchctl", ["unload", "-w", plist], { stdio: "ignore" });
      rmSync(plist, { force: true });
    }
    return plist;
  }
  throw new Error("autostart is set up on Windows and macOS only");
}

export function autostartIsOn() {
  return isWin ? existsSync(startupVbs()) : isMac ? existsSync(launchAgent()) : false;
}

/** A "Crew" icon on the desktop that opens the window. */
export function makeShortcut({ crewCli, home, icon }) {
  if (isWin) {
    const vbs = join(home, "open-crew.vbs");
    vbsLauncher(vbs, crewCli, "open");
    const script = `$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'Crew.lnk')); $s.TargetPath=Join-Path $env:WINDIR 'System32\\wscript.exe'; $s.Arguments='"${vbs}"'; $s.IconLocation='${icon},0'; $s.Description='Open Crew'; $s.Save()`;
    const out = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      encoding: "utf8",
    });
    if (out.status !== 0) throw new Error(`couldn't make the desktop shortcut: ${out.stderr}`);
    return join(homedir(), "Desktop", "Crew.lnk");
  }
  if (isMac) {
    const file = join(homedir(), "Desktop", "Crew.command");
    writeFileSync(file, `#!/bin/sh\n"${process.execPath}" "${crewCli}" open >/dev/null 2>&1 &\n`, {
      mode: 0o755,
    });
    return file;
  }
  return null;
}

/** The app id Crew's Windows notifications come from (its Start menu shortcut carries it). */
export const APP_ID = "Crew.Agents";

const startMenuLink = () =>
  join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Crew.lnk");

/** Whether the Start menu shortcut (and so Crew's notification identity) is in place. */
export function hasAppId() {
  return isWin && existsSync(startMenuLink());
}

/**
 * A Start menu entry for Crew that opens the window, stamped with Crew's app id. Recent
 * Windows only shows toasts from an app it knows, and this is how it gets to know Crew.
 */
export function registerAppId({ crewCli, home, icon }) {
  if (!isWin) return null;
  const vbs = join(home, "open-crew.vbs");
  vbsLauncher(vbs, crewCli, "open");
  const link = startMenuLink();
  const cs = `
using System; using System.Runtime.InteropServices;
[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellLinkW { void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder f, int c, IntPtr d, uint fl); void GetIDList(out IntPtr p); void SetIDList(IntPtr p);
  void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder n, int c); void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string n);
  void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder d, int c); void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string d);
  void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder a, int c); void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string a);
  void GetHotkey(out short h); void SetHotkey(short h); void GetShowCmd(out int s); void SetShowCmd(int s);
  void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder p, int c, out int i); void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string p, int i);
  void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string p, uint r); void Resolve(IntPtr h, uint f); void SetPath([MarshalAs(UnmanagedType.LPWStr)] string f); }
[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore { void GetCount(out uint c); void GetAt(uint i, out PropertyKey k); void GetValue(ref PropertyKey k, out PropVariant v); void SetValue(ref PropertyKey k, ref PropVariant v); void Commit(); }
[StructLayout(LayoutKind.Sequential, Pack = 4)] public struct PropertyKey { public Guid fmtid; public uint pid; }
[StructLayout(LayoutKind.Explicit)] public struct PropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }
[ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink {}
public static class CrewLink {
  public static void Make(string link, string target, string args, string icon, string appId) {
    var sl = (IShellLinkW)new CShellLink();
    sl.SetPath(target); sl.SetArguments(args); sl.SetIconLocation(icon, 0); sl.SetDescription("Crew: your team of AI agents");
    var store = (IPropertyStore)sl;
    var key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
    var v = new PropVariant { vt = 31, p = Marshal.StringToCoTaskMemUni(appId) };
    store.SetValue(ref key, ref v); store.Commit();
    ((System.Runtime.InteropServices.ComTypes.IPersistFile)sl).Save(link, true);
    Marshal.FreeCoTaskMem(v.p);
  }
}`;
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const script = `Add-Type -TypeDefinition @"\n${cs}\n"@\n[CrewLink]::Make(${q(link)}, (Join-Path $env:WINDIR 'System32\\wscript.exe'), ${q(`"${vbs}"`)}, ${q(icon)}, ${q(APP_ID)})`;
  const out = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { windowsHide: true, encoding: "utf8" },
  );
  if (out.status !== 0) throw new Error(`couldn't add Crew to the Start menu: ${out.stderr}`);
  return link;
}

/** Open a URL as an app window: Edge on Windows; Chrome on a Mac if it's there, else the browser. */
export function openAppWindow(url) {
  if (isWin) {
    spawnSync(
      "cmd",
      [
        "/c",
        "start",
        "",
        "msedge",
        `--app=${url}`,
        "--window-size=1000,600",
        "--window-position=80,40",
      ],
      {
        windowsHide: true,
      },
    );
    return;
  }
  if (isMac) {
    const chrome = "/Applications/Google Chrome.app";
    const args = existsSync(chrome)
      ? ["-na", chrome, "--args", `--app=${url}`, "--window-size=1000,640"]
      : [url];
    spawn("open", args, { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}
