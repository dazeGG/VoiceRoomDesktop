param(
  [int]$ParentPid = 0,
  [int]$IntervalMs = 400
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding

# Fail loudly: without these bindings the loop below would run forever and report nothing.
try {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class VoiceRoomForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
} catch {
  [Console]::Error.WriteLine("foreground.ps1: native bindings failed to load: $($_.Exception.Message)")
  exit 3
}

$ErrorActionPreference = 'SilentlyContinue'

$PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
$SYNCHRONIZE = 0x00100000
$WAIT_OBJECT_0 = 0
$MAX_TRACKED_WINDOWS = 8

# The foreground process rarely changes, so remember the last lookup.
$script:lastPid = [uint32]0
$script:lastExe = ''

function Get-ProcessExecutablePath([uint32]$processId) {
  if ($processId -eq $script:lastPid -and $script:lastExe) { return $script:lastExe }
  $exe = ''
  $handle = [VoiceRoomForeground]::OpenProcess($PROCESS_QUERY_LIMITED_INFORMATION, $false, $processId)
  if ($handle -ne [IntPtr]::Zero) {
    try {
      $size = [uint32]1024
      $name = New-Object System.Text.StringBuilder 1024
      if ([VoiceRoomForeground]::QueryFullProcessImageName($handle, 0, $name, [ref]$size)) {
        $exe = $name.ToString()
      }
    } finally {
      [void][VoiceRoomForeground]::CloseHandle($handle)
    }
  }
  $script:lastPid = $processId
  $script:lastExe = $exe
  return $exe
}

function Get-WindowBounds([IntPtr]$hwnd) {
  $rect = New-Object VoiceRoomForeground+RECT
  [void][VoiceRoomForeground]::GetWindowRect($hwnd, [ref]$rect)
  return @{
    x = [int]$rect.Left
    y = [int]$rect.Top
    width = [int][Math]::Max(0, $rect.Right - $rect.Left)
    height = [int][Math]::Max(0, $rect.Bottom - $rect.Top)
  }
}

# Recently focused windows, newest first. The shell decides which one is the game and
# keeps its overlay while another window is in front, so it needs to know where they are.
$tracked = New-Object System.Collections.Generic.List[long]

function Get-Snapshot {
  $hwnd = [VoiceRoomForeground]::GetForegroundWindow()
  if ($hwnd -eq [IntPtr]::Zero) { return $null }
  $processId = [uint32]0
  [void][VoiceRoomForeground]::GetWindowThreadProcessId($hwnd, [ref]$processId)
  if ($processId -eq 0) { return $null }
  $exe = Get-ProcessExecutablePath $processId
  if (-not $exe) { return $null }

  $handle = $hwnd.ToInt64()
  [void]$tracked.Remove($handle)
  $tracked.Insert(0, $handle)
  while ($tracked.Count -gt $MAX_TRACKED_WINDOWS) { $tracked.RemoveAt($tracked.Count - 1) }

  $windows = @()
  foreach ($item in @($tracked)) {
    $window = [IntPtr]$item
    if (-not [VoiceRoomForeground]::IsWindow($window)) {
      [void]$tracked.Remove($item)
      continue
    }
    $windows += @{
      hwnd = $item
      bounds = (Get-WindowBounds $window)
      minimized = [bool][VoiceRoomForeground]::IsIconic($window)
    }
  }

  $title = New-Object System.Text.StringBuilder 512
  [void][VoiceRoomForeground]::GetWindowText($hwnd, $title, $title.Capacity)
  return @{
    pid = [int]$processId
    hwnd = $handle
    exe = $exe
    title = $title.ToString()
    minimized = [bool][VoiceRoomForeground]::IsIconic($hwnd)
    bounds = (Get-WindowBounds $hwnd)
    windows = $windows
  }
}

$parentHandle = [IntPtr]::Zero
if ($ParentPid -gt 0) {
  $parentHandle = [VoiceRoomForeground]::OpenProcess($SYNCHRONIZE, $false, [uint32]$ParentPid)
}

$lastJson = ''
$delay = [Math]::Max(200, [Math]::Min(2000, $IntervalMs))
while ($true) {
  $snapshot = Get-Snapshot
  if ($snapshot) {
    $json = $snapshot | ConvertTo-Json -Compress -Depth 6
    if ($json -ne $lastJson) {
      $lastJson = $json
      [Console]::Out.WriteLine($json)
      [Console]::Out.Flush()
    }
  }
  if ($parentHandle -ne [IntPtr]::Zero) {
    # Doubles as the poll delay: returns early only when Voice Room exits.
    if ([VoiceRoomForeground]::WaitForSingleObject($parentHandle, [uint32]$delay) -eq $WAIT_OBJECT_0) { break }
  } else {
    if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid)) { break }
    Start-Sleep -Milliseconds $delay
  }
}
