# Crew's hands on the Windows desktop, for mcp-desktop.mjs: screenshots, the list of windows,
# focusing one, mouse and keyboard input, how long the PC has been idle, and the banner that
# says an agent is using the PC. One request per line on stdin ({"id","op",...} as JSON), one
# JSON reply per line on stdout. Windows PowerShell 5.1, so the C# below is C# 5.

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public static class Desk {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }

  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);

  public static void Init() {
    // Physical pixels everywhere: screenshots, window rectangles and clicks agree.
    SetProcessDpiAwarenessContext(new IntPtr(-4));
  }

  public static uint IdleMs() {
    LASTINPUTINFO info = new LASTINPUTINFO();
    info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    GetLastInputInfo(ref info);
    return (uint)Environment.TickCount - info.dwTime;
  }

  public static int[] Cursor() { POINT p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }

  public static int[] ScreenBounds() {
    Rectangle b = Screen.PrimaryScreen.Bounds;
    return new int[] { b.Left, b.Top, b.Width, b.Height };
  }

  public static string Title(IntPtr hwnd) {
    int n = GetWindowTextLength(hwnd);
    if (n <= 0) return "";
    StringBuilder sb = new StringBuilder(n + 1);
    GetWindowText(hwnd, sb, sb.Capacity);
    return sb.ToString();
  }

  /** Visible top-level windows with a title, front to back: hwnd|process|left|top|width|height|minimized|title */
  public static string[] Windows() {
    List<string> rows = new List<string>();
    EnumWindows(delegate (IntPtr hwnd, IntPtr l) {
      if (!IsWindowVisible(hwnd) || GetWindowTextLength(hwnd) == 0) return true;
      if (GetWindow(hwnd, 4) != IntPtr.Zero) return true; // owned popups
      int cloaked;
      if (DwmGetWindowAttribute(hwnd, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      RECT r; GetWindowRect(hwnd, out r);
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      string name = "";
      try { name = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { }
      rows.Add(hwnd.ToInt64() + "|" + name + "|" + r.Left + "|" + r.Top + "|" + (r.Right - r.Left) + "|" + (r.Bottom - r.Top) + "|" + (IsIconic(hwnd) ? 1 : 0) + "|" + Title(hwnd));
      return true;
    }, IntPtr.Zero);
    return rows.ToArray();
  }

  public static bool Focus(long handle) {
    IntPtr hwnd = new IntPtr(handle);
    if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
    // Windows only lets the app with the last input take the foreground: a tap of Alt counts.
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(hwnd);
    Thread.Sleep(150);
    return GetForegroundWindow() == hwnd;
  }

  public static int[] WindowRect(long handle) {
    RECT r; GetWindowRect(new IntPtr(handle), out r);
    return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
  }

  /** Capture a screen rectangle, shrink it to maxWidth, save a JPEG. Returns the scale. */
  public static double Capture(int left, int top, int width, int height, int maxWidth, string path) {
    using (Bitmap full = new Bitmap(width, height, PixelFormat.Format24bppRgb)) {
      using (Graphics g = Graphics.FromImage(full)) g.CopyFromScreen(left, top, 0, 0, new Size(width, height));
      double scale = width > maxWidth ? (double)maxWidth / width : 1.0;
      int w = (int)Math.Round(width * scale), h = (int)Math.Round(height * scale);
      using (Bitmap small = new Bitmap(w, h, PixelFormat.Format24bppRgb)) {
        using (Graphics g = Graphics.FromImage(small)) {
          g.InterpolationMode = InterpolationMode.HighQualityBicubic;
          g.DrawImage(full, 0, 0, w, h);
        }
        ImageCodecInfo jpeg = null;
        foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpeg = c;
        EncoderParameters p = new EncoderParameters(1);
        p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 80L);
        small.Save(path, jpeg, p);
      }
      return scale;
    }
  }

  static INPUT Mouse(uint flags, uint data) {
    INPUT i = new INPUT(); i.type = 0; i.U.mi.dwFlags = flags; i.U.mi.mouseData = data; return i;
  }
  static INPUT Key(ushort vk, ushort scan, uint flags) {
    INPUT i = new INPUT(); i.type = 1; i.U.ki.wVk = vk; i.U.ki.wScan = scan; i.U.ki.dwFlags = flags; return i;
  }
  static void Send(List<INPUT> inputs) {
    SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
  }

  public static void MoveTo(int x, int y) { SetCursorPos(x, y); }

  public static void Click(int x, int y, string button, int count) {
    SetCursorPos(x, y);
    Thread.Sleep(40);
    uint down = 0x2, up = 0x4;
    if (button == "right") { down = 0x8; up = 0x10; }
    if (button == "middle") { down = 0x20; up = 0x40; }
    for (int n = 0; n < count; n++) {
      List<INPUT> list = new List<INPUT>();
      list.Add(Mouse(down, 0)); list.Add(Mouse(up, 0));
      Send(list);
      Thread.Sleep(60);
    }
  }

  public static void Drag(int x1, int y1, int x2, int y2) {
    SetCursorPos(x1, y1); Thread.Sleep(40);
    List<INPUT> a = new List<INPUT>(); a.Add(Mouse(0x2, 0)); Send(a);
    for (int s = 1; s <= 12; s++) { SetCursorPos(x1 + (x2 - x1) * s / 12, y1 + (y2 - y1) * s / 12); Thread.Sleep(15); }
    List<INPUT> b = new List<INPUT>(); b.Add(Mouse(0x4, 0)); Send(b);
  }

  public static void Scroll(int x, int y, int notches) {
    SetCursorPos(x, y); Thread.Sleep(30);
    List<INPUT> list = new List<INPUT>();
    list.Add(Mouse(0x800, (uint)(notches * 120)));
    Send(list);
  }

  /** Type text as Unicode keystrokes; newlines and tabs as the Enter and Tab keys. */
  public static void Type(string text) {
    foreach (char c in text) {
      List<INPUT> list = new List<INPUT>();
      if (c == '\r') continue;
      if (c == '\n' || c == '\t') {
        ushort vk = (ushort)(c == '\n' ? 0x0D : 0x09);
        list.Add(Key(vk, 0, 0)); list.Add(Key(vk, 0, 2));
      } else {
        list.Add(Key(0, c, 4)); list.Add(Key(0, c, 4 | 2));
      }
      Send(list);
      Thread.Sleep(8);
    }
  }

  /** Press a chord: every key down in order, then up in reverse. ext[i] marks extended keys. */
  public static void Chord(int[] vks, bool[] ext) {
    List<INPUT> list = new List<INPUT>();
    for (int i = 0; i < vks.Length; i++) list.Add(Key((ushort)vks[i], 0, ext[i] ? 1u : 0u));
    for (int i = vks.Length - 1; i >= 0; i--) list.Add(Key((ushort)vks[i], 0, (ext[i] ? 1u : 0u) | 2u));
    Send(list);
  }
}

/** A banner at the top of the screen while an agent uses the PC. Never takes focus, lets clicks
 *  through, and is left out of screenshots and recordings. */
public class BannerForm : Form {
  [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
  public Label Text1;
  public BannerForm() {
    FormBorderStyle = FormBorderStyle.None;
    ShowInTaskbar = false;
    TopMost = true;
    StartPosition = FormStartPosition.Manual;
    BackColor = Color.FromArgb(24, 24, 32);
    Opacity = 0.93;
    AutoSize = true;
    AutoSizeMode = AutoSizeMode.GrowAndShrink;
    Text1 = new Label();
    Text1.AutoSize = true;
    Text1.ForeColor = Color.FromArgb(255, 170, 51);
    Text1.Font = new Font("Segoe UI Semibold", 11f);
    Text1.Padding = new Padding(16, 9, 16, 9);
    Controls.Add(Text1);
  }
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get {
      CreateParams cp = base.CreateParams;
      cp.ExStyle |= 0x08000000 | 0x80 | 0x20 | 0x8; // no-activate, tool window, click-through, topmost
      return cp;
    }
  }
  protected override void OnHandleCreated(EventArgs e) {
    base.OnHandleCreated(e);
    SetWindowDisplayAffinity(Handle, 0x11); // WDA_EXCLUDEFROMCAPTURE
  }
  public void Place() {
    Rectangle a = Screen.PrimaryScreen.WorkingArea;
    Location = new Point(a.Left + (a.Width - Width) / 2, a.Top + 10);
  }
}

public static class Banner {
  static BannerForm form;
  static ManualResetEvent ready = new ManualResetEvent(false);
  public static void Show(string text) {
    if (form == null) {
      Thread t = new Thread(delegate () {
        form = new BannerForm();
        form.Text1.Text = text;
        form.Shown += delegate { form.Place(); ready.Set(); };
        Application.Run(form);
      });
      t.SetApartmentState(ApartmentState.STA);
      t.IsBackground = true;
      t.Start();
      ready.WaitOne(5000);
      return;
    }
    form.Invoke((MethodInvoker)delegate { form.Text1.Text = text; form.Place(); if (!form.Visible) form.Show(); form.Place(); });
  }
  public static void Hide() {
    if (form != null) form.Invoke((MethodInvoker)delegate { form.Hide(); });
  }
}
'@

Add-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms, System.Drawing
[Desk]::Init()
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $id = $null
  try {
    $c = $line | ConvertFrom-Json
    $id = $c.id
    $result = switch ($c.op) {
      'idle'    { @{ idleMs = [Desk]::IdleMs(); cursor = [Desk]::Cursor() } }
      'cursor'  { @{ cursor = [Desk]::Cursor() } }
      'screen'  { @{ bounds = [Desk]::ScreenBounds() } }
      'windows' { @{ rows = [Desk]::Windows() } }
      'focus'   { @{ focused = [Desk]::Focus([long]$c.hwnd) } }
      'rect'    { @{ rect = [Desk]::WindowRect([long]$c.hwnd) } }
      'capture' { @{ scale = [Desk]::Capture([int]$c.left, [int]$c.top, [int]$c.width, [int]$c.height, [int]$c.maxWidth, [string]$c.path) } }
      'move'    { [Desk]::MoveTo([int]$c.x, [int]$c.y); @{} }
      'click'   { [Desk]::Click([int]$c.x, [int]$c.y, [string]$c.button, [int]$c.count); @{} }
      'drag'    { [Desk]::Drag([int]$c.x, [int]$c.y, [int]$c.x2, [int]$c.y2); @{} }
      'scroll'  { [Desk]::Scroll([int]$c.x, [int]$c.y, [int]$c.notches); @{} }
      'type'    { [Desk]::Type([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($c.text64))); @{} }
      'chord'   { [Desk]::Chord([int[]]$c.vks, [bool[]]$c.ext); @{} }
      'banner'  { if ($c.text) { [Banner]::Show([string]$c.text) } else { [Banner]::Hide() }; @{} }
      default   { throw "unknown op $($c.op)" }
    }
    $reply = @{ id = $id; ok = $true; result = $result }
  } catch {
    $reply = @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}
