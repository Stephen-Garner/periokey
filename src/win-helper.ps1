# PerioKey Windows helper. Reads one command per line on stdin:
# On start it prints DESKTOP<TAB>name of this thread's desktop ("Default" is the one the user sees).
#   K<TAB>delayMs<TAB>matchB64<TAB>keys1...  types each SendKeys string, waits delayMs between.
#                                          matchB64 is base64 UTF-8 text the front window title, or a
#                                          visible child (MDI) window title, must contain.
#                                          Replies OK, LOST_FOCUS <sentCount> if the front window
#                                          changed mid-phrase, or ERR <message>
#   F<TAB>matchB64                         replies F<TAB>MATCH, F<TAB>EMPTY (no front window or no
#                                          title), or F<TAB>MISMATCH. Titles hold patient names, so
#                                          they never leave this helper.
#   H<TAB>virtualKeyCode                   watches that key everywhere; prints H when it goes down
#   P<TAB>status                           shows an always-on-top pill with that status
#                                          (Listening, Paused, Connecting, Repeat). Clicking the
#                                          pill prints HOTKEY. The pill never takes keyboard focus.
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PkWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint threadId);
  [DllImport("user32.dll")] public static extern bool GetUserObjectInformationW(IntPtr h, int index, byte[] info, int length, out int needed);
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  static bool Has(IntPtr h, string needle) { return Title(h).IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0; }
  // Eaglesoft's perio exam can be a visible MDI child inside the outer Chart window.
  public static bool WindowMatches(IntPtr h, string needle) {
    if (string.IsNullOrEmpty(needle) || Has(h, needle)) return true;
    bool found = false;
    EnumChildWindows(h, (c, l) => { if (IsWindowVisible(c) && Has(c, needle)) { found = true; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static string Focus(string needle) {
    var h = GetForegroundWindow();
    if (h == IntPtr.Zero || Title(h).Length == 0) return "EMPTY";
    return WindowMatches(h, needle) ? "MATCH" : "MISMATCH";
  }
  // UOI_NAME = 2. A sandboxed shell runs on its own desktop, where keys and the pill never show.
  public static string DesktopName() {
    var buf = new byte[512]; int needed;
    if (!GetUserObjectInformationW(GetThreadDesktop(GetCurrentThreadId()), 2, buf, buf.Length, out needed)) return "";
    return Encoding.Unicode.GetString(buf, 0, Math.Min(needed, buf.Length)).TrimEnd('\0');
  }
}
"@
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing @"
using System.Drawing;
using System.Windows.Forms;
public class PkPill : Form {
  public Label StatusLabel = new Label();
  public PkPill() {
    FormBorderStyle = FormBorderStyle.None;
    TopMost = true;
    ShowInTaskbar = false;
    StartPosition = FormStartPosition.Manual;
    Size = new Size(170, 44);
    var area = Screen.PrimaryScreen.WorkingArea;
    Location = new Point(area.Right - 190, area.Top + 20);
    StatusLabel.Dock = DockStyle.Fill;
    StatusLabel.TextAlign = ContentAlignment.MiddleCenter;
    StatusLabel.Font = new Font("Segoe UI", 12, FontStyle.Bold);
    StatusLabel.ForeColor = Color.White;
    StatusLabel.Cursor = Cursors.Hand;
    Controls.Add(StatusLabel);
  }
  protected override bool ShowWithoutActivation { get { return true; } }
  // WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST: clicks never take focus from the dental software.
  protected override CreateParams CreateParams {
    get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x80 | 0x8; return p; }
  }
}
"@

$pill = $null
$pillColors = @{ Listening = "#1f7a52"; Repeat = "#b5651d"; Connecting = "#2b6cb0" }
$hotkey = 0
$wasDown = $false
[Console]::Out.WriteLine("DESKTOP`t" + ([PkWin]::DesktopName() -replace "\s", " "))
[Console]::Out.Flush()
# [Console]::In.ReadLineAsync() blocks on Windows PowerShell 5.1, so read raw stdin instead.
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$task = $reader.ReadLineAsync()
while ($true) {
  if ($task.Wait(25)) {
    $line = $task.Result
    if ($null -eq $line) { break }
    if ($line.StartsWith("K`t")) {
      $parts = $line.Split("`t")
      $delay = [int]$parts[1]
      $match = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[2]))
      $window = [PkWin]::GetForegroundWindow()
      $sent = 0
      $reply = "OK"
      try {
        $first = 3
        if (-not [PkWin]::WindowMatches($window, $match)) { $first = $parts.Length; $reply = "LOST_FOCUS 0" }
        for ($i = $first; $i -lt $parts.Length; $i++) {
          if ([PkWin]::GetForegroundWindow() -ne $window) { $reply = "LOST_FOCUS $sent"; break }
          [System.Windows.Forms.SendKeys]::SendWait($parts[$i])
          $sent++
          Start-Sleep -Milliseconds $delay
        }
      } catch {
        $reply = "ERR " + ($_.Exception.Message -replace "\s+", " ")
      }
      [Console]::Out.WriteLine($reply)
    } elseif ($line -eq "F" -or $line.StartsWith("F`t")) {
      $match = ""
      if ($line.Length -gt 2) { $match = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring(2))) }
      [Console]::Out.WriteLine("F`t" + [PkWin]::Focus($match))
    } elseif ($line.StartsWith("H`t")) {
      $hotkey = [int]$line.Substring(2)
    } elseif ($line.StartsWith("P`t")) {
      $status = $line.Substring(2)
      if ($null -eq $pill) {
        $pill = New-Object PkPill
        $pill.StatusLabel.Add_Click({ [Console]::Out.WriteLine("HOTKEY"); [Console]::Out.Flush() })
        $pill.Show()
      }
      $color = $pillColors[$status]
      if (-not $color) { $color = "#6b7570" }
      $pill.BackColor = [System.Drawing.ColorTranslator]::FromHtml($color)
      $pill.StatusLabel.Text = $status
    }
    [Console]::Out.Flush()
    $task = $reader.ReadLineAsync()
  }
  [System.Windows.Forms.Application]::DoEvents()
  if ($hotkey -ne 0) {
    $down = ([PkWin]::GetAsyncKeyState($hotkey) -band 0x8000) -ne 0
    if ($down -and -not $wasDown) { [Console]::Out.WriteLine("H"); [Console]::Out.Flush() }
    $wasDown = $down
  }
}
