// VoiceRoom foreground-window helper for the in-game overlay (Windows).
//
// Replaces the PowerShell poller (foreground.ps1) and prints the same JSON Lines:
//   {"pid":1,"hwnd":2,"exe":"C:\\...\\game.exe","title":"...","minimized":false,
//    "bounds":{"x":0,"y":0,"width":1920,"height":1080},
//    "windows":[{"hwnd":2,"bounds":{...},"minimized":false}]}
// A line is written only when the snapshot changes. The first line is
// {"event":"ready"}, which the shell ignores.
//
// Window events (foreground, move/resize, minimize, destroy) wake the helper; a
// one-second poll covers title changes and anything the events miss. The process is
// per-monitor DPI aware, so bounds are physical pixels on every monitor.
//
// CLI:
//   VoiceRoomForeground.exe [--parent-pid <pid>] [--once]
// --parent-pid exits the helper when VoiceRoom exits; --once prints the ready
// line and one snapshot, then exits (used by the build smoke test).

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dwmapi.h>
#include <fcntl.h>
#include <io.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <string>
#include <vector>

namespace {

constexpr std::size_t kMaxTrackedWindows = 8;
constexpr ULONGLONG kCoalesceMs = 50;
constexpr ULONGLONG kPollMs = 1000;
constexpr int kMaxTitleLength = 512;

std::vector<HWND> g_tracked;
bool g_dirty = true;
ULONGLONG g_dirtySince = 0;
DWORD g_cachedPid = 0;
std::wstring g_cachedExe;
std::string g_lastJson;

void EnableDpiAwareness() {
  using SetContextFn = BOOL(WINAPI*)(DPI_AWARENESS_CONTEXT);
  const HMODULE user32 = GetModuleHandleW(L"user32.dll");
  const auto setContext = user32
      ? reinterpret_cast<SetContextFn>(GetProcAddress(user32, "SetProcessDpiAwarenessContext"))
      : nullptr;
  if (setContext) setContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
}

std::string ToUtf8(const std::wstring& value) {
  if (value.empty()) return std::string();
  const int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()),
                                       nullptr, 0, nullptr, nullptr);
  if (size <= 0) return std::string();
  std::string result(static_cast<std::size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size,
                      nullptr, nullptr);
  return result;
}

void AppendJsonString(std::string& out, const std::wstring& value) {
  std::wstring escaped;
  escaped.reserve(value.size() + 2);
  for (const wchar_t ch : value) {
    if (ch == L'"' || ch == L'\\') {
      escaped.push_back(L'\\');
      escaped.push_back(ch);
    } else if (ch < 0x20) {
      wchar_t buffer[8] = {};
      std::swprintf(buffer, 8, L"\\u%04x", static_cast<unsigned>(ch));
      escaped.append(buffer);
    } else {
      escaped.push_back(ch);
    }
  }
  out.push_back('"');
  out.append(ToUtf8(escaped));
  out.push_back('"');
}

std::wstring ProcessPath(DWORD pid) {
  if (pid == g_cachedPid && !g_cachedExe.empty()) return g_cachedExe;
  std::wstring exe;
  const HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (process) {
    wchar_t buffer[1024] = {};
    DWORD size = static_cast<DWORD>(std::size(buffer));
    if (QueryFullProcessImageNameW(process, 0, buffer, &size)) exe.assign(buffer, size);
    CloseHandle(process);
  }
  g_cachedPid = pid;
  g_cachedExe = exe;
  return exe;
}

// The visible frame: GetWindowRect also counts the invisible resize borders.
RECT WindowBounds(HWND window) {
  RECT rect = {};
  if (FAILED(DwmGetWindowAttribute(window, DWMWA_EXTENDED_FRAME_BOUNDS, &rect, sizeof(rect)))
      || rect.right <= rect.left || rect.bottom <= rect.top) {
    GetWindowRect(window, &rect);
  }
  return rect;
}

void AppendBounds(std::string& out, HWND window) {
  const RECT rect = WindowBounds(window);
  char buffer[160] = {};
  std::snprintf(buffer, sizeof(buffer), "{\"x\":%ld,\"y\":%ld,\"width\":%ld,\"height\":%ld}",
                rect.left, rect.top, (std::max)(0L, rect.right - rect.left),
                (std::max)(0L, rect.bottom - rect.top));
  out.append(buffer);
}

unsigned long long HandleValue(HWND window) {
  return static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(window));
}

bool IsTracked(HWND window) {
  return std::find(g_tracked.begin(), g_tracked.end(), window) != g_tracked.end();
}

// Recently focused windows, newest first, so the shell can keep the overlay over
// a game that is no longer in front.
void Track(HWND window) {
  g_tracked.erase(std::remove(g_tracked.begin(), g_tracked.end(), window), g_tracked.end());
  g_tracked.insert(g_tracked.begin(), window);
  g_tracked.erase(std::remove_if(g_tracked.begin(), g_tracked.end(),
                                 [](HWND item) { return !IsWindow(item); }),
                  g_tracked.end());
  if (g_tracked.size() > kMaxTrackedWindows) g_tracked.resize(kMaxTrackedWindows);
}

bool BuildSnapshot(std::string* json) {
  const HWND window = GetForegroundWindow();
  if (!window) return false;
  DWORD pid = 0;
  GetWindowThreadProcessId(window, &pid);
  if (pid == 0) return false;
  const std::wstring exe = ProcessPath(pid);
  if (exe.empty()) return false;

  Track(window);

  wchar_t title[kMaxTitleLength] = {};
  const int titleLength = GetWindowTextW(window, title, kMaxTitleLength);

  std::string out;
  out.reserve(1024);
  char buffer[96] = {};
  std::snprintf(buffer, sizeof(buffer), "{\"pid\":%lu,\"hwnd\":%llu,\"exe\":",
                static_cast<unsigned long>(pid), HandleValue(window));
  out.append(buffer);
  AppendJsonString(out, exe);
  out.append(",\"title\":");
  AppendJsonString(out, std::wstring(title, titleLength > 0 ? titleLength : 0));
  out.append(",\"minimized\":");
  out.append(IsIconic(window) ? "true" : "false");
  out.append(",\"bounds\":");
  AppendBounds(out, window);
  out.append(",\"windows\":[");
  bool first = true;
  for (const HWND item : g_tracked) {
    if (!first) out.push_back(',');
    first = false;
    std::snprintf(buffer, sizeof(buffer), "{\"hwnd\":%llu,\"bounds\":", HandleValue(item));
    out.append(buffer);
    AppendBounds(out, item);
    out.append(",\"minimized\":");
    out.append(IsIconic(item) ? "true}" : "false}");
  }
  out.append("]}");
  *json = std::move(out);
  return true;
}

bool WriteLine(const std::string& line) {
  if (std::fwrite(line.data(), 1, line.size(), stdout) != line.size()) return false;
  if (std::fputc('\n', stdout) == EOF) return false;
  return std::fflush(stdout) == 0;
}

// Returns false once stdout is gone: VoiceRoom stopped listening.
bool EmitIfChanged() {
  std::string json;
  if (!BuildSnapshot(&json) || json == g_lastJson) return true;
  g_lastJson = json;
  return WriteLine(json);
}

void MarkDirty() {
  if (g_dirty) return;
  g_dirty = true;
  g_dirtySince = GetTickCount64();
}

void CALLBACK OnWinEvent(HWINEVENTHOOK, DWORD event, HWND window, LONG idObject, LONG idChild,
                         DWORD, DWORD) {
  if (event == EVENT_SYSTEM_FOREGROUND) {
    MarkDirty();
    return;
  }
  // Only top-level window changes matter; LOCATIONCHANGE also fires for the cursor.
  if (!window || idObject != OBJID_WINDOW || idChild != CHILDID_SELF) return;
  if (window == GetForegroundWindow() || IsTracked(window)) MarkDirty();
}

bool HasArg(int argc, wchar_t** argv, const wchar_t* name) {
  for (int index = 1; index < argc; ++index) {
    if (std::wcscmp(argv[index], name) == 0) return true;
  }
  return false;
}

DWORD ReadDwordArg(int argc, wchar_t** argv, const wchar_t* name) {
  for (int index = 1; index + 1 < argc; ++index) {
    if (std::wcscmp(argv[index], name) == 0) return std::wcstoul(argv[index + 1], nullptr, 10);
  }
  return 0;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  _setmode(_fileno(stdout), _O_BINARY);
  EnableDpiAwareness();

  if (!WriteLine("{\"event\":\"ready\"}")) return 0;
  if (HasArg(argc, argv, L"--once")) {
    EmitIfChanged();
    return 0;
  }

  HANDLE parent = nullptr;
  const DWORD parentPid = ReadDwordArg(argc, argv, L"--parent-pid");
  if (parentPid != 0) {
    parent = OpenProcess(SYNCHRONIZE, FALSE, parentPid);
    if (!parent) {
      std::fputs("{\"event\":\"error\",\"message\":\"Parent process is not running.\"}\n", stderr);
      return 1;
    }
  }

  // Ensure this thread has a message queue: out-of-context hooks deliver there.
  MSG message = {};
  PeekMessageW(&message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
  constexpr DWORD kFlags = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS;
  const HWINEVENTHOOK hooks[] = {
      SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, nullptr, OnWinEvent, 0, 0, kFlags),
      SetWinEventHook(EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND, nullptr, OnWinEvent, 0, 0, kFlags),
      SetWinEventHook(EVENT_OBJECT_DESTROY, EVENT_OBJECT_DESTROY, nullptr, OnWinEvent, 0, 0, kFlags),
      // Title changes are left to the poll: some games print their FPS there.
      SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, nullptr, OnWinEvent, 0, 0, kFlags),
  };
  if (!hooks[0]) {
    std::fputs("{\"event\":\"warning\",\"message\":\"Window events are unavailable; polling only.\"}\n", stderr);
  }
  std::fflush(stderr);

  int exitCode = 0;
  ULONGLONG nextPoll = 0;
  for (;;) {
    const ULONGLONG now = GetTickCount64();
    const bool due = (g_dirty && now - g_dirtySince >= kCoalesceMs) || now >= nextPoll;
    if (due) {
      g_dirty = false;
      nextPoll = now + kPollMs;
      if (!EmitIfChanged()) break;
    }

    const ULONGLONG deadline = g_dirty ? (std::min)(g_dirtySince + kCoalesceMs, nextPoll) : nextPoll;
    const ULONGLONG current = GetTickCount64();
    const DWORD timeout = deadline > current ? static_cast<DWORD>(deadline - current) : 0;
    const DWORD waitResult = MsgWaitForMultipleObjectsEx(parent ? 1 : 0, parent ? &parent : nullptr,
                                                         timeout, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
    if (parent && waitResult == WAIT_OBJECT_0) break;
    if (waitResult == WAIT_FAILED) {
      exitCode = 1;
      break;
    }

    bool quit = false;
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
      if (message.message == WM_QUIT) {
        quit = true;
        break;
      }
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
    if (quit) break;
  }

  for (const HWINEVENTHOOK hook : hooks) {
    if (hook) UnhookWinEvent(hook);
  }
  if (parent) CloseHandle(parent);
  return exitCode;
}
