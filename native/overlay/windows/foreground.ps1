param(
  [int]$ParentPid = 0,
  [int]$IntervalMs = 400
)

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class VoiceRoomForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

function Get-ForegroundPayload {
  $hwnd = [VoiceRoomForeground]::GetForegroundWindow()
  if ($hwnd -eq [IntPtr]::Zero) { return $null }
  $processId = [uint32]0
  [void][VoiceRoomForeground]::GetWindowThreadProcessId($hwnd, [ref]$processId)
  if ($processId -eq 0) { return $null }
  $process = Get-Process -Id $processId
  if (-not $process) { return $null }
  $exe = [string]$process.Path
  if (-not $exe) { return $null }
  $rect = New-Object VoiceRoomForeground+RECT
  [void][VoiceRoomForeground]::GetWindowRect($hwnd, [ref]$rect)
  $title = New-Object System.Text.StringBuilder 512
  [void][VoiceRoomForeground]::GetWindowText($hwnd, $title, $title.Capacity)
  $width = [Math]::Max(0, $rect.Right - $rect.Left)
  $height = [Math]::Max(0, $rect.Bottom - $rect.Top)
  return @{
    pid = [int]$processId
    exe = $exe
    title = $title.ToString()
    bounds = @{
      x = [int]$rect.Left
      y = [int]$rect.Top
      width = [int]$width
      height = [int]$height
    }
  }
}

$lastKey = ''
$delay = [Math]::Max(200, [Math]::Min(2000, $IntervalMs))
while ($true) {
  if ($ParentPid -gt 0) {
    $parent = Get-Process -Id $ParentPid
    if (-not $parent) { break }
  }
  $payload = Get-ForegroundPayload
  if ($payload) {
    $key = '{0}|{1}|{2}|{3}|{4}|{5}' -f $payload.pid, $payload.exe, $payload.bounds.x, $payload.bounds.y, $payload.bounds.width, $payload.bounds.height
    if ($key -ne $lastKey) {
      $lastKey = $key
      [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress))
      [Console]::Out.Flush()
    }
  }
  Start-Sleep -Milliseconds $delay
}
