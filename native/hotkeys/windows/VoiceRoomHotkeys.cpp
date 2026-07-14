// Voice Room native global-hotkey helper for Windows.
//
// The helper deliberately uses WH_KEYBOARD_LL instead of RegisterHotKey:
// RegisterHotKey cannot report key-up, which is required for push-to-talk.
// This hook never consumes input; every event is forwarded with
// CallNextHookEx. Bindings are matched by scan code plus the extended-key bit,
// so DOM KeyboardEvent.code values keep their physical meaning on non-QWERTY
// layouts.
//
// CLI:
//   VoiceRoomHotkeys.exe
//     --binding "mic-mute|KeyM|C"
//     --binding "output-mute|F10|-"
//     --binding "push-to-talk|Space|CA"
//
// stdout is JSON Lines. Diagnostics go to stderr.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cwchar>
#include <string>
#include <vector>

namespace {

constexpr std::uint8_t kControl = 1u << 0;
constexpr std::uint8_t kAlt = 1u << 1;
constexpr std::uint8_t kShift = 1u << 2;
constexpr std::uint8_t kMeta = 1u << 3;
constexpr UINT kEmitHotkeyMessage = WM_APP + 0x481;
constexpr UINT kClearSharedKeyMessage = WM_APP + 0x482;
constexpr DWORD kParentPipePollMs = 25;
constexpr DWORD kParentWatcherJoinMs = 1000;

struct PhysicalKey {
  DWORD scanCode = 0;
  bool extended = false;
  DWORD expectedVirtualKey = 0;
};

struct CodeDefinition {
  const char* code;
  DWORD scanCode;
  bool extended;
  DWORD expectedVirtualKey = 0;
};

// IBM PC/AT scan-code set 1 values as surfaced by KBDLLHOOKSTRUCT. The
// extended flag distinguishes navigation keys from the numpad, and separates
// NumpadEnter, NumpadDivide, and PrintScreen from otherwise shared scan codes.
constexpr CodeDefinition kCodeDefinitions[] = {
    {"Escape", 0x01, false},
    {"Digit1", 0x02, false},
    {"Digit2", 0x03, false},
    {"Digit3", 0x04, false},
    {"Digit4", 0x05, false},
    {"Digit5", 0x06, false},
    {"Digit6", 0x07, false},
    {"Digit7", 0x08, false},
    {"Digit8", 0x09, false},
    {"Digit9", 0x0A, false},
    {"Digit0", 0x0B, false},
    {"Minus", 0x0C, false},
    {"Equal", 0x0D, false},
    {"Backspace", 0x0E, false},
    {"Tab", 0x0F, false},
    {"KeyQ", 0x10, false},
    {"KeyW", 0x11, false},
    {"KeyE", 0x12, false},
    {"KeyR", 0x13, false},
    {"KeyT", 0x14, false},
    {"KeyY", 0x15, false},
    {"KeyU", 0x16, false},
    {"KeyI", 0x17, false},
    {"KeyO", 0x18, false},
    {"KeyP", 0x19, false},
    {"BracketLeft", 0x1A, false},
    {"BracketRight", 0x1B, false},
    {"Enter", 0x1C, false},
    {"KeyA", 0x1E, false},
    {"KeyS", 0x1F, false},
    {"KeyD", 0x20, false},
    {"KeyF", 0x21, false},
    {"KeyG", 0x22, false},
    {"KeyH", 0x23, false},
    {"KeyJ", 0x24, false},
    {"KeyK", 0x25, false},
    {"KeyL", 0x26, false},
    {"Semicolon", 0x27, false},
    {"Quote", 0x28, false},
    {"Backquote", 0x29, false},
    {"Backslash", 0x2B, false},
    {"KeyZ", 0x2C, false},
    {"KeyX", 0x2D, false},
    {"KeyC", 0x2E, false},
    {"KeyV", 0x2F, false},
    {"KeyB", 0x30, false},
    {"KeyN", 0x31, false},
    {"KeyM", 0x32, false},
    {"Comma", 0x33, false},
    {"Period", 0x34, false},
    {"Slash", 0x35, false},
    {"NumpadMultiply", 0x37, false},
    {"Space", 0x39, false},
    {"CapsLock", 0x3A, false, VK_CAPITAL},
    {"F1", 0x3B, false},
    {"F2", 0x3C, false},
    {"F3", 0x3D, false},
    {"F4", 0x3E, false},
    {"F5", 0x3F, false},
    {"F6", 0x40, false},
    {"F7", 0x41, false},
    {"F8", 0x42, false},
    {"F9", 0x43, false},
    {"F10", 0x44, false},
    // NumLock and Pause share scan code 0x45 in the low-level hook. The VK
    // discriminator prevents Pause's unusual E1 sequence from matching.
    {"NumLock", 0x45, false, VK_NUMLOCK},
    {"ScrollLock", 0x46, false, VK_SCROLL},
    {"Numpad7", 0x47, false},
    {"Numpad8", 0x48, false},
    {"Numpad9", 0x49, false},
    {"NumpadSubtract", 0x4A, false},
    {"Numpad4", 0x4B, false},
    {"Numpad5", 0x4C, false},
    {"Numpad6", 0x4D, false},
    {"NumpadAdd", 0x4E, false},
    {"Numpad1", 0x4F, false},
    {"Numpad2", 0x50, false},
    {"Numpad3", 0x51, false},
    {"Numpad0", 0x52, false},
    {"NumpadDecimal", 0x53, false},
    {"IntlBackslash", 0x56, false},
    {"F11", 0x57, false},
    {"F12", 0x58, false},
    {"NumpadEqual", 0x59, false},
    {"F13", 0x64, false},
    {"F14", 0x65, false},
    {"F15", 0x66, false},
    {"F16", 0x67, false},
    {"F17", 0x68, false},
    {"F18", 0x69, false},
    {"F19", 0x6A, false},
    {"F20", 0x6B, false},
    {"F21", 0x6C, false},
    {"F22", 0x6D, false},
    {"F23", 0x6E, false},
    {"IntlRo", 0x73, false},
    {"F24", 0x76, false},
    {"IntlYen", 0x7D, false},

    {"NumpadEnter", 0x1C, true},
    {"NumpadDivide", 0x35, true},
    {"PrintScreen", 0x37, true},
    {"Home", 0x47, true},
    {"ArrowUp", 0x48, true},
    {"PageUp", 0x49, true},
    {"ArrowLeft", 0x4B, true},
    {"ArrowRight", 0x4D, true},
    {"End", 0x4F, true},
    {"ArrowDown", 0x50, true},
    {"PageDown", 0x51, true},
    {"Insert", 0x52, true},
    {"Delete", 0x53, true},
    {"ContextMenu", 0x5D, true},
};

struct Binding {
  std::string action;
  PhysicalKey key;
  std::uint8_t modifiers = 0;
  bool active = false;
  bool pressQueued = false;
  bool releaseQueued = false;
};

struct Failure {
  std::string action;
  const char* reason;
};

struct ModifierState {
  bool leftControl = false;
  bool rightControl = false;
  bool leftAlt = false;
  bool rightAlt = false;
  bool leftShift = false;
  bool rightShift = false;
  bool leftMeta = false;
  bool rightMeta = false;

  std::uint8_t Mask() const {
    std::uint8_t mask = 0;
    if (leftControl || rightControl) mask |= kControl;
    if (leftAlt || rightAlt) mask |= kAlt;
    if (leftShift || rightShift) mask |= kShift;
    if (leftMeta || rightMeta) mask |= kMeta;
    return mask;
  }
};

HHOOK g_hook = nullptr;
HANDLE g_shutdownEvent = nullptr;
std::atomic<DWORD> g_messageThreadId{0};
std::atomic<bool> g_failClosed{false};
ModifierState g_modifierState;
std::vector<Binding> g_bindings;
std::vector<std::uint64_t> g_downKeys;

constexpr std::uint64_t PhysicalKeyId(DWORD scanCode, bool extended) {
  return static_cast<std::uint64_t>(scanCode) | (extended ? (1ull << 32) : 0ull);
}

constexpr UINT SharedNavigationVirtualKey(DWORD scanCode) {
  switch (scanCode) {
    case 0x47: return VK_HOME;
    case 0x48: return VK_UP;
    case 0x49: return VK_PRIOR;
    case 0x4B: return VK_LEFT;
    case 0x4D: return VK_RIGHT;
    case 0x4F: return VK_END;
    case 0x50: return VK_DOWN;
    case 0x51: return VK_NEXT;
    case 0x52: return VK_INSERT;
    case 0x53: return VK_DELETE;
    default: return 0;
  }
}

constexpr UINT SharedNumpadVirtualKey(DWORD scanCode) {
  switch (scanCode) {
    case 0x47: return VK_NUMPAD7;
    case 0x48: return VK_NUMPAD8;
    case 0x49: return VK_NUMPAD9;
    case 0x4B: return VK_NUMPAD4;
    case 0x4D: return VK_NUMPAD6;
    case 0x4F: return VK_NUMPAD1;
    case 0x50: return VK_NUMPAD2;
    case 0x51: return VK_NUMPAD3;
    case 0x52: return VK_NUMPAD0;
    case 0x53: return VK_DECIMAL;
    default: return 0;
  }
}

constexpr bool HasSharedVirtualKeyState(DWORD scanCode) {
  switch (scanCode) {
    case 0x1C:  // Enter / NumpadEnter
    case 0x47:  // Numpad7 / Home
    case 0x48:  // Numpad8 / ArrowUp
    case 0x49:  // Numpad9 / PageUp
    case 0x4B:  // Numpad4 / ArrowLeft
    case 0x4D:  // Numpad6 / ArrowRight
    case 0x4F:  // Numpad1 / End
    case 0x50:  // Numpad2 / ArrowDown
    case 0x51:  // Numpad3 / PageDown
    case 0x52:  // Numpad0 / Insert
    case 0x53:  // NumpadDecimal / Delete
      return true;
    default:
      return false;
  }
}

static_assert(HasSharedVirtualKeyState(0x1C));
static_assert(HasSharedVirtualKeyState(0x47));
static_assert(HasSharedVirtualKeyState(0x53));
static_assert(!HasSharedVirtualKeyState(0x46));
static_assert(!HasSharedVirtualKeyState(0x4C));
static_assert(PhysicalKeyId(0x1C, false) != PhysicalKeyId(0x1C, true));
static_assert(SharedNavigationVirtualKey(0x47) == VK_HOME);
static_assert(SharedNumpadVirtualKey(0x47) == VK_NUMPAD7);
static_assert(SharedNavigationVirtualKey(0x4C) == 0);

bool IsKeyDown(int virtualKey);

bool IsSharedKeyGroupDown(DWORD scanCode) {
  if (scanCode == 0x1C) return IsKeyDown(VK_RETURN);
  const UINT navigationVirtualKey = SharedNavigationVirtualKey(scanCode);
  const UINT numpadVirtualKey = SharedNumpadVirtualKey(scanCode);
  return (navigationVirtualKey != 0
          && IsKeyDown(static_cast<int>(navigationVirtualKey)))
      || (numpadVirtualKey != 0
          && IsKeyDown(static_cast<int>(numpadVirtualKey)));
}

bool HasRememberedSharedKey(DWORD scanCode) {
  return std::find(g_downKeys.begin(), g_downKeys.end(),
                   PhysicalKeyId(scanCode, false)) != g_downKeys.end()
      || std::find(g_downKeys.begin(), g_downKeys.end(),
                   PhysicalKeyId(scanCode, true)) != g_downKeys.end();
}

void RememberDownKey(DWORD scanCode, bool extended) {
  const std::uint64_t keyId = PhysicalKeyId(scanCode, extended);
  if (std::find(g_downKeys.begin(), g_downKeys.end(), keyId) == g_downKeys.end()) {
    g_downKeys.push_back(keyId);
  }
}

void SeedDownKey(DWORD scanCode, bool extended) {
  RememberDownKey(scanCode, extended);
  if (!HasSharedVirtualKeyState(scanCode)) return;
  // GetAsyncKeyState cannot identify which member of these physical pairs is
  // held. Block both conservatively until either matching key-up is observed.
  RememberDownKey(scanCode, false);
  RememberDownKey(scanCode, true);
}

void ForgetDownKey(DWORD scanCode, bool extended) {
  const std::uint64_t primary = PhysicalKeyId(scanCode, extended);
  const std::uint64_t sibling = PhysicalKeyId(scanCode, !extended);
  g_downKeys.erase(
      std::remove_if(g_downKeys.begin(), g_downKeys.end(),
                     [&](std::uint64_t keyId) {
                       return keyId == primary
                           || (HasSharedVirtualKeyState(scanCode) && keyId == sibling);
                     }),
      g_downKeys.end());
}

bool IsSupportedAction(const std::string& action) {
  return action == "mic-mute" || action == "output-mute" || action == "push-to-talk";
}

bool WideAscii(const wchar_t* value, std::string* result) {
  result->clear();
  if (!value) return false;
  while (*value) {
    if (*value > 0x7F) return false;
    result->push_back(static_cast<char>(*value));
    ++value;
  }
  return true;
}

std::string JsonEscape(const std::string& value) {
  std::string escaped;
  escaped.reserve(value.size());
  for (const unsigned char character : value) {
    switch (character) {
      case '"': escaped += "\\\""; break;
      case '\\': escaped += "\\\\"; break;
      case '\b': escaped += "\\b"; break;
      case '\f': escaped += "\\f"; break;
      case '\n': escaped += "\\n"; break;
      case '\r': escaped += "\\r"; break;
      case '\t': escaped += "\\t"; break;
      default:
        if (character < 0x20) {
          char buffer[7] = {};
          std::snprintf(buffer, sizeof(buffer), "\\u%04x",
                        static_cast<unsigned int>(character));
          escaped += buffer;
        } else {
          escaped.push_back(static_cast<char>(character));
        }
    }
  }
  return escaped;
}

const CodeDefinition* FindCode(const std::string& code) {
  for (const auto& definition : kCodeDefinitions) {
    if (code == definition.code) return &definition;
  }
  return nullptr;
}

bool ParseModifiers(const std::string& value, std::uint8_t* result) {
  if (value == "-") {
    *result = 0;
    return true;
  }
  if (value.empty()) return false;

  std::uint8_t mask = 0;
  for (const char modifier : value) {
    std::uint8_t bit = 0;
    if (modifier == 'C') bit = kControl;
    if (modifier == 'A') bit = kAlt;
    if (modifier == 'S') bit = kShift;
    if (modifier == 'M') bit = kMeta;
    if (bit == 0 || (mask & bit) != 0) return false;
    mask |= bit;
  }
  *result = mask;
  return true;
}

bool SplitBinding(const std::string& value, std::string* action,
                  std::string* code, std::string* modifiers) {
  const std::size_t first = value.find('|');
  if (first == std::string::npos) return false;
  const std::size_t second = value.find('|', first + 1);
  if (second == std::string::npos || value.find('|', second + 1) != std::string::npos) return false;
  *action = value.substr(0, first);
  *code = value.substr(first + 1, second - first - 1);
  *modifiers = value.substr(second + 1);
  return true;
}

bool SameChord(const Binding& left, const Binding& right) {
  return left.key.scanCode == right.key.scanCode
      && left.key.extended == right.key.extended
      && left.key.expectedVirtualKey == right.key.expectedVirtualKey
      && left.modifiers == right.modifiers;
}

bool MatchesPhysicalKey(const Binding& binding, const KBDLLHOOKSTRUCT& event,
                        bool extended) {
  return binding.key.scanCode == event.scanCode
      && binding.key.extended == extended
      && (binding.key.expectedVirtualKey == 0
          || binding.key.expectedVirtualKey == event.vkCode);
}

void EmitReady(const std::vector<Binding>& registered,
               const std::vector<Failure>& failed) {
  std::fputs("{\"event\":\"ready\",\"registered\":[", stdout);
  for (std::size_t index = 0; index < registered.size(); ++index) {
    if (index != 0) std::fputc(',', stdout);
    const std::string action = JsonEscape(registered[index].action);
    std::fprintf(stdout, "\"%s\"", action.c_str());
  }
  std::fputs("],\"failed\":[", stdout);
  for (std::size_t index = 0; index < failed.size(); ++index) {
    if (index != 0) std::fputc(',', stdout);
    const std::string action = JsonEscape(failed[index].action);
    std::fprintf(stdout, "{\"action\":\"%s\",\"reason\":\"%s\"}",
                 action.c_str(), failed[index].reason);
  }
  std::fputs("]}\n", stdout);
  std::fflush(stdout);
}

void EmitHotkey(const Binding& binding, const char* phase) {
  // Actions are constrained to three ASCII constants during parsing.
  std::fprintf(stdout,
               "{\"event\":\"hotkey\",\"action\":\"%s\",\"phase\":\"%s\"}\n",
               binding.action.c_str(), phase);
  std::fflush(stdout);
}

bool QueueHotkey(std::size_t bindingIndex, bool pressed) {
  // Keep stdout I/O outside LowLevelKeyboardProc: Windows removes a low-level
  // hook if its callback stalls beyond LowLevelHooksTimeout. This thread's
  // queue is created before the hook is installed, and repeat suppression
  // bounds the number of pending messages to key transitions.
  const DWORD messageThreadId = g_messageThreadId.load();
  if (messageThreadId != 0
      && PostThreadMessageW(messageThreadId, kEmitHotkeyMessage,
                            static_cast<WPARAM>(bindingIndex), pressed ? 1 : 0) != 0) {
    return true;
  }

  // A lost key-up must never leave PTT logically pressed. The hook callback is
  // delivered on the message thread, so fail the helper closed and let normal
  // teardown emit a balanced release for every active binding.
  g_failClosed.store(true);
  if (g_shutdownEvent == nullptr || !SetEvent(g_shutdownEvent)) {
    PostQuitMessage(1);
  }
  return false;
}

bool QueueSharedKeyClear(DWORD scanCode) {
  const DWORD messageThreadId = g_messageThreadId.load();
  if (messageThreadId != 0
      && PostThreadMessageW(messageThreadId, kClearSharedKeyMessage,
                            static_cast<WPARAM>(scanCode), 0) != 0) {
    return true;
  }
  g_failClosed.store(true);
  if (g_shutdownEvent == nullptr || !SetEvent(g_shutdownEvent)) {
    PostQuitMessage(1);
  }
  return false;
}

void LogWindowsError(const char* message, DWORD error) {
  std::fprintf(stderr, "%s (Win32 error %lu)\n", message,
               static_cast<unsigned long>(error));
  std::fflush(stderr);
}

bool IsKeyDown(int virtualKey) {
  return (GetAsyncKeyState(virtualKey) & 0x8000) != 0;
}

HKL ForegroundKeyboardLayout() {
  const HWND foregroundWindow = GetForegroundWindow();
  const DWORD foregroundThreadId = foregroundWindow != nullptr
      ? GetWindowThreadProcessId(foregroundWindow, nullptr)
      : 0;
  return GetKeyboardLayout(foregroundThreadId);
}

UINT NumpadNavigationVirtualKey(const PhysicalKey& key) {
  if (key.extended) return 0;
  if (key.scanCode == 0x4C) return VK_CLEAR;
  return SharedNavigationVirtualKey(key.scanCode);
}

bool IsPhysicalKeyDown(const PhysicalKey& key, HKL keyboardLayout) {
  // Win32 exposes asynchronous keyboard state by virtual key only. Both Enter
  // keys share VK_RETURN, so conservatively seed either physical binding when
  // either Enter is held; this suppresses an unsafe first autorepeat.
  if (key.scanCode == 0x1C) return IsKeyDown(VK_RETURN);

  DWORD scanCode = key.scanCode;
  if (key.extended) scanCode |= 0xE000;
  const UINT virtualKey = key.expectedVirtualKey != 0
      ? key.expectedVirtualKey
      : MapVirtualKeyExW(scanCode, MAPVK_VSC_TO_VK_EX, keyboardLayout);
  if (virtualKey != 0 && IsKeyDown(static_cast<int>(virtualKey))) return true;

  // With NumLock off, numpad navigation keys report the navigation VK rather
  // than VK_NUMPAD*. Query that alias so a held numpad key is still seeded.
  const UINT navigationVirtualKey = NumpadNavigationVirtualKey(key);
  return navigationVirtualKey != 0
      && navigationVirtualKey != virtualKey
      && IsKeyDown(static_cast<int>(navigationVirtualKey));
}

void InitializeModifierState() {
  g_modifierState.leftControl = IsKeyDown(VK_LCONTROL);
  g_modifierState.rightControl = IsKeyDown(VK_RCONTROL);
  g_modifierState.leftAlt = IsKeyDown(VK_LMENU);
  g_modifierState.rightAlt = IsKeyDown(VK_RMENU);
  g_modifierState.leftShift = IsKeyDown(VK_LSHIFT);
  g_modifierState.rightShift = IsKeyDown(VK_RSHIFT);
  g_modifierState.leftMeta = IsKeyDown(VK_LWIN);
  g_modifierState.rightMeta = IsKeyDown(VK_RWIN);
}

void InitializeDownKeyState() {
  const HKL keyboardLayout = ForegroundKeyboardLayout();
  for (const auto& binding : g_bindings) {
    if (!IsPhysicalKeyDown(binding.key, keyboardLayout)) continue;
    SeedDownKey(binding.key.scanCode, binding.key.extended);
  }
}

bool UpdateModifierState(DWORD scanCode, bool extended, bool isDown) {
  if (scanCode == 0x1D) {
    (extended ? g_modifierState.rightControl : g_modifierState.leftControl) = isDown;
    return true;
  }
  if (scanCode == 0x38) {
    (extended ? g_modifierState.rightAlt : g_modifierState.leftAlt) = isDown;
    return true;
  }
  if (!extended && scanCode == 0x2A) {
    g_modifierState.leftShift = isDown;
    return true;
  }
  if (!extended && scanCode == 0x36) {
    g_modifierState.rightShift = isDown;
    return true;
  }
  if (extended && scanCode == 0x5B) {
    g_modifierState.leftMeta = isDown;
    return true;
  }
  if (extended && scanCode == 0x5C) {
    g_modifierState.rightMeta = isDown;
    return true;
  }
  return false;
}

void HandleKeyEvent(const KBDLLHOOKSTRUCT& event, bool isDown) {
  const bool extended = (event.flags & LLKHF_EXTENDED) != 0;
  if (UpdateModifierState(event.scanCode, extended, isDown)) return;

  if (!isDown) {
    if (HasSharedVirtualKeyState(event.scanCode)
        && HasRememberedSharedKey(event.scanCode)) {
      QueueSharedKeyClear(event.scanCode);
    } else {
      ForgetDownKey(event.scanCode, extended);
    }
  }

  bool hasBindingForKey = false;
  for (const auto& binding : g_bindings) {
    if (MatchesPhysicalKey(binding, event, extended)) {
      hasBindingForKey = true;
      break;
    }
  }
  if (!hasBindingForKey) return;

  const std::uint64_t keyId = PhysicalKeyId(event.scanCode, extended);
  if (isDown) {
    // LL hooks do not expose a repeat flag. Remembering the physical key is the
    // reliable way to emit exactly one pressed event until its matching key-up.
    if (std::find(g_downKeys.begin(), g_downKeys.end(), keyId) != g_downKeys.end()) return;
    RememberDownKey(event.scanCode, extended);

    const std::uint8_t currentModifiers = g_modifierState.Mask();
    for (std::size_t index = 0; index < g_bindings.size(); ++index) {
      auto& binding = g_bindings[index];
      if (!MatchesPhysicalKey(binding, event, extended)
          || binding.modifiers != currentModifiers) {
        continue;
      }
      if (!binding.active && !binding.pressQueued && QueueHotkey(index, true)) {
        binding.pressQueued = true;
      }
      break;  // Duplicate chords are rejected during argument parsing.
    }
    return;
  }

  for (std::size_t index = 0; index < g_bindings.size(); ++index) {
    auto& binding = g_bindings[index];
    if ((!binding.active && !binding.pressQueued)
        || binding.releaseQueued
        || !MatchesPhysicalKey(binding, event, extended)) {
      continue;
    }
    if (QueueHotkey(index, false)) binding.releaseQueued = true;
  }
}

LRESULT CALLBACK LowLevelKeyboardProc(int code, WPARAM message, LPARAM data) {
  if (code == HC_ACTION && data != 0) {
    const bool isDown = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
    const bool isUp = message == WM_KEYUP || message == WM_SYSKEYUP;
    if (isDown || isUp) {
      HandleKeyEvent(*reinterpret_cast<const KBDLLHOOKSTRUCT*>(data), isDown);
    }
  }

  // Voice Room observes global input but never reserves or swallows it.
  return CallNextHookEx(g_hook, code, message, data);
}

BOOL WINAPI ConsoleControlHandler(DWORD controlType) {
  switch (controlType) {
    case CTRL_C_EVENT:
    case CTRL_BREAK_EVENT:
    case CTRL_CLOSE_EVENT:
    case CTRL_LOGOFF_EVENT:
    case CTRL_SHUTDOWN_EVENT: {
      if (g_shutdownEvent == nullptr || !SetEvent(g_shutdownEvent)) {
        g_failClosed.store(true);
        TerminateProcess(GetCurrentProcess(), 1);
      }
      return TRUE;
    }
    default:
      return FALSE;
  }
}

DWORD WINAPI ParentPipeWatcher(LPVOID) {
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  if (input == nullptr || input == INVALID_HANDLE_VALUE) {
    g_failClosed.store(true);
    if (g_shutdownEvent == nullptr || !SetEvent(g_shutdownEvent)) {
      TerminateProcess(GetCurrentProcess(), 1);
    }
    return 0;
  }

  while (true) {
    const DWORD waitResult = WaitForSingleObject(g_shutdownEvent, kParentPipePollMs);
    if (waitResult == WAIT_OBJECT_0) return 0;
    if (waitResult != WAIT_TIMEOUT) {
      g_failClosed.store(true);
      TerminateProcess(GetCurrentProcess(), 1);
      return 0;
    }

    DWORD bytesAvailable = 0;
    if (!PeekNamedPipe(input, nullptr, 0, nullptr, &bytesAvailable, nullptr)) break;
    while (bytesAvailable != 0) {
      char buffer[64] = {};
      const DWORD requested = (std::min)(
          bytesAvailable, static_cast<DWORD>(sizeof(buffer)));
      DWORD bytesRead = 0;
      if (!ReadFile(input, buffer, requested, &bytesRead, nullptr)
          || bytesRead == 0) {
        bytesAvailable = 0;
        break;
      }
      bytesAvailable -= (std::min)(bytesAvailable, bytesRead);
    }
  }
  if (g_shutdownEvent == nullptr || !SetEvent(g_shutdownEvent)) {
    // EOF is the ownership boundary: if the graceful wake-up mechanism itself
    // is broken, terminate instead of leaving a global hook orphaned.
    g_failClosed.store(true);
    TerminateProcess(GetCurrentProcess(), 1);
  }
  return 0;
}

void CloseShutdownInfrastructure(HANDLE parentPipeThread) {
  SetConsoleCtrlHandler(ConsoleControlHandler, FALSE);
  if (g_shutdownEvent != nullptr) SetEvent(g_shutdownEvent);
  if (parentPipeThread != nullptr && parentPipeThread != INVALID_HANDLE_VALUE) {
    const DWORD waitResult = WaitForSingleObject(
        parentPipeThread, kParentWatcherJoinMs);
    if (waitResult != WAIT_OBJECT_0) {
      // Never hang shutdown or close an event still used by the watcher.
      g_failClosed.store(true);
      TerminateProcess(GetCurrentProcess(), 1);
      return;
    }
    CloseHandle(parentPipeThread);
  }
  if (g_shutdownEvent != nullptr) {
    CloseHandle(g_shutdownEvent);
    g_shutdownEvent = nullptr;
  }
  g_messageThreadId.store(0);
}

void ReleaseActiveBindings() {
  for (auto& binding : g_bindings) {
    if (!binding.active) continue;
    binding.active = false;
    binding.pressQueued = false;
    binding.releaseQueued = false;
    EmitHotkey(binding, "released");
  }
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  std::vector<Binding> accepted;
  std::vector<Failure> failed;

  for (int index = 1; index < argc; ++index) {
    if (std::wcscmp(argv[index], L"--binding") != 0) {
      std::string unknownArgument;
      if (WideAscii(argv[index], &unknownArgument)) {
        std::fprintf(stderr, "Ignoring unknown argument: %s\n",
                     unknownArgument.c_str());
      } else {
        std::fputs("Ignoring unknown non-ASCII argument\n", stderr);
      }
      std::fflush(stderr);
      continue;
    }

    if (index + 1 >= argc) {
      failed.push_back({"", "unsupported-key"});
      std::fputs("--binding requires action|code|mods\n", stderr);
      std::fflush(stderr);
      break;
    }

    std::string raw;
    std::string action;
    std::string code;
    std::string modifiers;
    const bool ascii = WideAscii(argv[++index], &raw);
    const bool split = ascii && SplitBinding(raw, &action, &code, &modifiers);
    if (!split) {
      const std::size_t separator = raw.find('|');
      if (separator != std::string::npos) action = raw.substr(0, separator);
      failed.push_back({action, "unsupported-key"});
      std::fputs("Invalid --binding value; expected action|code|mods\n", stderr);
      std::fflush(stderr);
      continue;
    }

    const CodeDefinition* definition = FindCode(code);
    std::uint8_t modifierMask = 0;
    if (!IsSupportedAction(action) || !definition
        || !ParseModifiers(modifiers, &modifierMask)) {
      failed.push_back({action, "unsupported-key"});
      std::fprintf(stderr, "Unsupported binding: %s|%s|%s\n",
                   action.c_str(), code.c_str(), modifiers.c_str());
      std::fflush(stderr);
      continue;
    }

    Binding candidate{action,
                      {definition->scanCode, definition->extended,
                       definition->expectedVirtualKey},
                      modifierMask};
    bool duplicate = false;
    for (const auto& existing : accepted) {
      if (SameChord(existing, candidate)) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) {
      failed.push_back({action, "duplicate-binding"});
      continue;
    }
    accepted.push_back(candidate);
  }

  if (accepted.empty()) {
    EmitReady(accepted, failed);
    return 0;
  }

  // Ensure this thread owns a message queue before the hook is installed.
  MSG message = {};
  PeekMessageW(&message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
  g_messageThreadId.store(GetCurrentThreadId());
  g_shutdownEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (g_shutdownEvent == nullptr) {
    const DWORD error = GetLastError();
    for (const auto& binding : accepted) {
      failed.push_back({binding.action, "registration-failed"});
    }
    EmitReady({}, failed);
    LogWindowsError("Failed to create shutdown event", error);
    g_messageThreadId.store(0);
    return 1;
  }
  SetConsoleCtrlHandler(ConsoleControlHandler, TRUE);
  const HANDLE parentPipeThread = CreateThread(
      nullptr, 0, ParentPipeWatcher, nullptr, 0, nullptr);
  if (parentPipeThread == nullptr) {
    const DWORD error = GetLastError();
    for (const auto& binding : accepted) {
      failed.push_back({binding.action, "registration-failed"});
    }
    EmitReady({}, failed);
    LogWindowsError("Failed to start parent-pipe watcher", error);
    CloseShutdownInfrastructure(nullptr);
    return 1;
  }

  g_bindings = accepted;
  // Conservative shared-VK seeding can track one physical sibling in addition
  // to each binding, so this keeps hook-time key tracking allocation-free.
  g_downKeys.reserve(g_bindings.size() * 2);
  g_hook = SetWindowsHookExW(WH_KEYBOARD_LL, LowLevelKeyboardProc,
                             GetModuleHandleW(nullptr), 0);
  if (!g_hook) {
    const DWORD error = GetLastError();
    for (const auto& binding : g_bindings) {
      failed.push_back({binding.action, "registration-failed"});
    }
    g_bindings.clear();
    EmitReady(g_bindings, failed);
    LogWindowsError("SetWindowsHookExW(WH_KEYBOARD_LL) failed", error);
    CloseShutdownInfrastructure(parentPipeThread);
    return 1;
  }

  InitializeModifierState();
  InitializeDownKeyState();
  EmitReady(g_bindings, failed);

  int exitCode = 0;
  bool running = true;
  while (running) {
    const DWORD waitResult = MsgWaitForMultipleObjectsEx(
        1, &g_shutdownEvent, INFINITE, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
    if (waitResult == WAIT_OBJECT_0) break;
    if (waitResult != WAIT_OBJECT_0 + 1) {
      LogWindowsError("Hotkey message wait failed", GetLastError());
      exitCode = 1;
      break;
    }

    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
      if (message.message == WM_QUIT) {
        running = false;
        break;
      }
      if (message.message == kClearSharedKeyMessage) {
        const DWORD scanCode = static_cast<DWORD>(message.wParam);
        if (HasSharedVirtualKeyState(scanCode)
            && !IsSharedKeyGroupDown(scanCode)) {
          ForgetDownKey(scanCode, false);
        }
        continue;
      }
      if (message.message == kEmitHotkeyMessage) {
        const std::size_t bindingIndex = static_cast<std::size_t>(message.wParam);
        if (bindingIndex < g_bindings.size()) {
          auto& binding = g_bindings[bindingIndex];
          if (message.lParam != 0) {
            binding.pressQueued = false;
            if (!binding.active) {
              binding.active = true;
              EmitHotkey(binding, "pressed");
            }
          } else {
            binding.releaseQueued = false;
            binding.pressQueued = false;
            if (binding.active) {
              binding.active = false;
              EmitHotkey(binding, "released");
            }
          }
        }
        continue;
      }
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
  }
  if (g_failClosed.load()) exitCode = 1;

  UnhookWindowsHookEx(g_hook);
  g_hook = nullptr;
  ReleaseActiveBindings();
  g_downKeys.clear();
  CloseShutdownInfrastructure(parentPipeThread);
  return exitCode;
}
