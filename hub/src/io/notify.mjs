// A desktop notification: a Windows toast or a macOS banner. For people without the phone app,
// this is how a quick OK or a sign-in request reaches them while the Crew window is hidden.

import { spawn } from "node:child_process";
import { APP_ID, hasAppId } from "./platform.mjs";

// Windows only shows toasts from an app it knows: Crew's own id once setup has put Crew in the
// Start menu (platform.mjs), else PowerShell's, which works on some Windows versions.
const POWERSHELL_APP_ID =
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

const xml = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * @param {{ title: string, body: string }} message
 * @param {{ spawnFn?: typeof spawn, platform?: string }} [options]
 */
export function notifyDesktop(message, options = {}) {
  const title = String(message.title ?? "Crew").slice(0, 80);
  const body = String(message.body ?? "").slice(0, 240);
  const run = options.spawnFn ?? spawn;
  const platform = options.platform ?? process.platform;
  try {
    if (platform === "win32") {
      const toast = `<toast><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual><audio src="ms-winsoundevent:Notification.Reminder"/></toast>`;
      const script = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml('${toast.replace(/'/g, "''")}')
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${options.appId ?? (hasAppId() ? APP_ID : POWERSHELL_APP_ID)}')
$notifier.Show([Windows.UI.Notifications.ToastNotification]::new($doc))
Start-Sleep -Milliseconds 300`;
      // Keep the notifier in a variable: called on the temporary in one chained line, Windows
      // PowerShell drops the toast without an error (found in the end-to-end test).
      const child = run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        // Not detached: PowerShell started without a console drops the toast (end-to-end test).
        { windowsHide: true, stdio: "ignore" },
      );
      child.on?.("error", () => {});
      child.unref?.();
      return true;
    }
    if (platform === "darwin") {
      const as = (s) => JSON.stringify(s); // AppleScript string literals use the same escapes
      const child = run(
        "osascript",
        ["-e", `display notification ${as(body)} with title ${as(title)} sound name "Glass"`],
        { stdio: "ignore", detached: true },
      );
      child.on?.("error", () => {});
      child.unref?.();
      return true;
    }
  } catch {
    /* no notification system: the window and claude-face still show it */
  }
  return false;
}
