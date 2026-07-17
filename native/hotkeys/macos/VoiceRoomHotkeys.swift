import Carbon
import CoreGraphics
import Darwin
import Dispatch
import Foundation

private enum HotKeyAction: String {
  case microphoneMute = "mic-mute"
  case outputMute = "output-mute"
  case pushToTalk = "push-to-talk"
}

private struct Binding {
  let action: HotKeyAction
  let code: String
  let keyCode: UInt32
  let modifiers: UInt32

  var chord: Chord {
    Chord(keyCode: keyCode, modifiers: modifiers)
  }
}

private struct Chord: Hashable {
  let keyCode: UInt32
  let modifiers: UInt32
}

private struct Failure {
  let action: String
  let reason: String

  var json: [String: String] {
    ["action": action, "reason": reason]
  }
}

private struct ParsedBindings {
  let bindings: [Binding]
  let failures: [Failure]
}

private let keyCodes: [String: UInt32] = [
  // DOM KeyboardEvent.code values identify physical positions. Carbon's ANSI virtual
  // key constants do the same, so the mapping stays stable when the input layout changes.
  "KeyA": UInt32(kVK_ANSI_A),
  "KeyB": UInt32(kVK_ANSI_B),
  "KeyC": UInt32(kVK_ANSI_C),
  "KeyD": UInt32(kVK_ANSI_D),
  "KeyE": UInt32(kVK_ANSI_E),
  "KeyF": UInt32(kVK_ANSI_F),
  "KeyG": UInt32(kVK_ANSI_G),
  "KeyH": UInt32(kVK_ANSI_H),
  "KeyI": UInt32(kVK_ANSI_I),
  "KeyJ": UInt32(kVK_ANSI_J),
  "KeyK": UInt32(kVK_ANSI_K),
  "KeyL": UInt32(kVK_ANSI_L),
  "KeyM": UInt32(kVK_ANSI_M),
  "KeyN": UInt32(kVK_ANSI_N),
  "KeyO": UInt32(kVK_ANSI_O),
  "KeyP": UInt32(kVK_ANSI_P),
  "KeyQ": UInt32(kVK_ANSI_Q),
  "KeyR": UInt32(kVK_ANSI_R),
  "KeyS": UInt32(kVK_ANSI_S),
  "KeyT": UInt32(kVK_ANSI_T),
  "KeyU": UInt32(kVK_ANSI_U),
  "KeyV": UInt32(kVK_ANSI_V),
  "KeyW": UInt32(kVK_ANSI_W),
  "KeyX": UInt32(kVK_ANSI_X),
  "KeyY": UInt32(kVK_ANSI_Y),
  "KeyZ": UInt32(kVK_ANSI_Z),

  "Digit0": UInt32(kVK_ANSI_0),
  "Digit1": UInt32(kVK_ANSI_1),
  "Digit2": UInt32(kVK_ANSI_2),
  "Digit3": UInt32(kVK_ANSI_3),
  "Digit4": UInt32(kVK_ANSI_4),
  "Digit5": UInt32(kVK_ANSI_5),
  "Digit6": UInt32(kVK_ANSI_6),
  "Digit7": UInt32(kVK_ANSI_7),
  "Digit8": UInt32(kVK_ANSI_8),
  "Digit9": UInt32(kVK_ANSI_9),

  "Backquote": UInt32(kVK_ANSI_Grave),
  "Minus": UInt32(kVK_ANSI_Minus),
  "Equal": UInt32(kVK_ANSI_Equal),
  "BracketLeft": UInt32(kVK_ANSI_LeftBracket),
  "BracketRight": UInt32(kVK_ANSI_RightBracket),
  "Backslash": UInt32(kVK_ANSI_Backslash),
  "IntlBackslash": UInt32(kVK_ISO_Section),
  "IntlRo": UInt32(kVK_JIS_Underscore),
  "IntlYen": UInt32(kVK_JIS_Yen),
  "Semicolon": UInt32(kVK_ANSI_Semicolon),
  "Quote": UInt32(kVK_ANSI_Quote),
  "Comma": UInt32(kVK_ANSI_Comma),
  "Period": UInt32(kVK_ANSI_Period),
  "Slash": UInt32(kVK_ANSI_Slash),

  "F1": UInt32(kVK_F1),
  "F2": UInt32(kVK_F2),
  "F3": UInt32(kVK_F3),
  "F4": UInt32(kVK_F4),
  "F5": UInt32(kVK_F5),
  "F6": UInt32(kVK_F6),
  "F7": UInt32(kVK_F7),
  "F8": UInt32(kVK_F8),
  "F9": UInt32(kVK_F9),
  "F10": UInt32(kVK_F10),
  "F11": UInt32(kVK_F11),
  "F12": UInt32(kVK_F12),
  "F13": UInt32(kVK_F13),
  "F14": UInt32(kVK_F14),
  "F15": UInt32(kVK_F15),
  "F16": UInt32(kVK_F16),
  "F17": UInt32(kVK_F17),
  "F18": UInt32(kVK_F18),
  "F19": UInt32(kVK_F19),
  "F20": UInt32(kVK_F20),
  // Carbon exposes no macOS virtual key codes for F21-F24. Those DOM codes are
  // intentionally rejected instead of being aliased to unrelated physical keys.

  "ArrowLeft": UInt32(kVK_LeftArrow),
  "ArrowRight": UInt32(kVK_RightArrow),
  "ArrowUp": UInt32(kVK_UpArrow),
  "ArrowDown": UInt32(kVK_DownArrow),
  "Home": UInt32(kVK_Home),
  "End": UInt32(kVK_End),
  "PageUp": UInt32(kVK_PageUp),
  "PageDown": UInt32(kVK_PageDown),
  "Insert": UInt32(kVK_Help),
  "ContextMenu": UInt32(kVK_ContextualMenu),
  "Space": UInt32(kVK_Space),
  "Tab": UInt32(kVK_Tab),
  "Enter": UInt32(kVK_Return),
  "Backspace": UInt32(kVK_Delete),
  "Delete": UInt32(kVK_ForwardDelete),
  "Escape": UInt32(kVK_Escape),

  "Numpad0": UInt32(kVK_ANSI_Keypad0),
  "Numpad1": UInt32(kVK_ANSI_Keypad1),
  "Numpad2": UInt32(kVK_ANSI_Keypad2),
  "Numpad3": UInt32(kVK_ANSI_Keypad3),
  "Numpad4": UInt32(kVK_ANSI_Keypad4),
  "Numpad5": UInt32(kVK_ANSI_Keypad5),
  "Numpad6": UInt32(kVK_ANSI_Keypad6),
  "Numpad7": UInt32(kVK_ANSI_Keypad7),
  "Numpad8": UInt32(kVK_ANSI_Keypad8),
  "Numpad9": UInt32(kVK_ANSI_Keypad9),
  "NumpadDecimal": UInt32(kVK_ANSI_KeypadDecimal),
  "NumpadMultiply": UInt32(kVK_ANSI_KeypadMultiply),
  "NumpadAdd": UInt32(kVK_ANSI_KeypadPlus),
  "NumpadSubtract": UInt32(kVK_ANSI_KeypadMinus),
  "NumpadDivide": UInt32(kVK_ANSI_KeypadDivide),
  "NumpadEnter": UInt32(kVK_ANSI_KeypadEnter),
  "NumpadEqual": UInt32(kVK_ANSI_KeypadEquals),
  "NumpadComma": UInt32(kVK_JIS_KeypadComma),
  "NumLock": UInt32(kVK_ANSI_KeypadClear)
]

private func writeJSONLine(_ payload: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(payload),
        let data = try? JSONSerialization.data(withJSONObject: payload),
        let line = String(data: data, encoding: .utf8) else {
    writeDiagnostic("unable to encode JSON output")
    return
  }

  _ = line.withCString { pointer in
    fputs(pointer, stdout)
  }
  fputc(0x0A, stdout)
  fflush(stdout)
}

private func writeDiagnostic(_ message: String) {
  fputs("VoiceRoomHotkeys: \(message)\n", stderr)
  fflush(stderr)
}

private func parseModifiers(_ value: String) -> UInt32? {
  if value == "-" {
    return 0
  }
  guard !value.isEmpty, !value.contains("-") else {
    return nil
  }

  var modifiers: UInt32 = 0
  for character in value {
    let modifier: UInt32
    switch character {
    case "C":
      modifier = UInt32(controlKey)
    case "A":
      modifier = UInt32(optionKey)
    case "S":
      modifier = UInt32(shiftKey)
    case "M":
      modifier = UInt32(cmdKey)
    default:
      return nil
    }
    guard modifiers & modifier == 0 else {
      return nil
    }
    modifiers |= modifier
  }
  return modifiers
}

private func parseBindings(arguments: [String]) -> ParsedBindings {
  var bindings: [Binding] = []
  var failures: [Failure] = []
  var seenChords = Set<Chord>()
  var index = 0

  while index < arguments.count {
    guard arguments[index] == "--binding" else {
      writeDiagnostic("ignoring unknown argument '\(arguments[index])'")
      index += 1
      continue
    }
    guard index + 1 < arguments.count else {
      writeDiagnostic("--binding requires action|code|mods")
      break
    }

    let rawBinding = arguments[index + 1]
    index += 2
    let fields = rawBinding.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
    let actionName = fields.first ?? ""

    guard fields.count == 3,
          let action = HotKeyAction(rawValue: fields[0]),
          let keyCode = keyCodes[fields[1]],
          let modifiers = parseModifiers(fields[2]) else {
      failures.append(Failure(action: actionName, reason: "unsupported-key"))
      writeDiagnostic("rejected binding '\(rawBinding)'")
      continue
    }

    let binding = Binding(action: action, code: fields[1], keyCode: keyCode, modifiers: modifiers)
    guard seenChords.insert(binding.chord).inserted else {
      failures.append(Failure(action: action.rawValue, reason: "duplicate-binding"))
      continue
    }
    bindings.append(binding)
  }

  return ParsedBindings(bindings: bindings, failures: failures)
}

private final class EventTapRegistry {
  private let bindings: [Binding]
  private var activeBindingIndexes = Set<Int>()
  private var downKeyCodes = Set<UInt32>()
  private var eventTap: CFMachPort?
  private var runLoopSource: CFRunLoopSource?

  init(bindings: [Binding]) {
    self.bindings = bindings
    for keyCode in Set(bindings.map(\.keyCode)) {
      if CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(keyCode)) {
        downKeyCodes.insert(keyCode)
      }
    }
  }

  func install() -> Bool {
    let mask = (CGEventMask(1) << CGEventType.keyDown.rawValue)
      | (CGEventMask(1) << CGEventType.keyUp.rawValue)
    guard let tap = CGEvent.tapCreate(
      tap: .cgSessionEventTap,
      place: .headInsertEventTap,
      options: .listenOnly,
      eventsOfInterest: mask,
      callback: eventTapCallback,
      userInfo: Unmanaged.passUnretained(self).toOpaque()
    ) else {
      writeDiagnostic("CGEvent.tapCreate returned nil")
      return false
    }
    guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
      writeDiagnostic("CFMachPortCreateRunLoopSource returned nil")
      return false
    }

    eventTap = tap
    runLoopSource = source
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    return true
  }

  func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      if let eventTap { CGEvent.tapEnable(tap: eventTap, enable: true) }
      return Unmanaged.passUnretained(event)
    }
    guard type == .keyDown || type == .keyUp else {
      return Unmanaged.passUnretained(event)
    }

    let keyCode = UInt32(event.getIntegerValueField(.keyboardEventKeycode))
    guard bindings.contains(where: { $0.keyCode == keyCode }) else {
      return Unmanaged.passUnretained(event)
    }

    if type == .keyDown {
      // Seeded physical-key state plus this set suppresses autorepeat and also
      // prevents a held key from becoming a new shortcut after modifiers change.
      guard downKeyCodes.insert(keyCode).inserted else {
        return Unmanaged.passUnretained(event)
      }
      let modifiers = carbonModifiers(from: event.flags)
      if let index = bindings.firstIndex(where: {
        $0.keyCode == keyCode && $0.modifiers == modifiers
      }) {
        activeBindingIndexes.insert(index)
        emit(binding: bindings[index], phase: "pressed")
      }
      return Unmanaged.passUnretained(event)
    }

    downKeyCodes.remove(keyCode)
    for index in activeBindingIndexes.filter({ bindings[$0].keyCode == keyCode }) {
      activeBindingIndexes.remove(index)
      emit(binding: bindings[index], phase: "released")
    }
    return Unmanaged.passUnretained(event)
  }

  func releaseActiveBindings() {
    for index in activeBindingIndexes.sorted() {
      emit(binding: bindings[index], phase: "released")
    }
    activeBindingIndexes.removeAll()
    downKeyCodes.removeAll()
  }

  private func emit(binding: Binding, phase: String) {
    writeJSONLine([
      "event": "hotkey",
      "action": binding.action.rawValue,
      "phase": phase
    ])
  }

  deinit {
    releaseActiveBindings()
    if let runLoopSource {
      CFRunLoopRemoveSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
    }
    if let eventTap { CFMachPortInvalidate(eventTap) }
  }
}

private func carbonModifiers(from flags: CGEventFlags) -> UInt32 {
  var modifiers: UInt32 = 0
  if flags.contains(.maskControl) { modifiers |= UInt32(controlKey) }
  if flags.contains(.maskAlternate) { modifiers |= UInt32(optionKey) }
  if flags.contains(.maskShift) { modifiers |= UInt32(shiftKey) }
  if flags.contains(.maskCommand) { modifiers |= UInt32(cmdKey) }
  return modifiers
}

private func eventTapCallback(
  _ proxy: CGEventTapProxy,
  _ type: CGEventType,
  _ event: CGEvent,
  _ userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
  guard let userInfo else { return Unmanaged.passUnretained(event) }
  let registry = Unmanaged<EventTapRegistry>.fromOpaque(userInfo).takeUnretainedValue()
  return registry.handle(type: type, event: event)
}

@main
private enum VoiceRoomHotkeysMain {
  static func main() {
    let parsed = parseBindings(arguments: Array(CommandLine.arguments.dropFirst()))
    guard !parsed.bindings.isEmpty else {
      writeJSONLine([
        "event": "ready",
        "registered": [],
        "failed": parsed.failures.map(\.json)
      ])
      return
    }

    if !CGPreflightListenEventAccess() {
      _ = CGRequestListenEventAccess()
    }
    guard CGPreflightListenEventAccess() else {
      let failures = parsed.failures + parsed.bindings.map {
        Failure(action: $0.action.rawValue, reason: "input-monitoring-required")
      }
      writeJSONLine([
        "event": "ready",
        "registered": [],
        "failed": failures.map(\.json)
      ])
      Foundation.exit(2)
    }

    let registry = EventTapRegistry(bindings: parsed.bindings)
    guard registry.install() else {
      let failures = parsed.failures + parsed.bindings.map {
        Failure(action: $0.action.rawValue, reason: "registration-failed")
      }
      writeJSONLine([
        "event": "ready",
        "registered": [],
        "failed": failures.map(\.json)
      ])
      Foundation.exit(1)
    }

    writeJSONLine([
      "event": "ready",
      "registered": parsed.bindings.map { $0.action.rawValue },
      "failed": parsed.failures.map(\.json)
    ])

    // Electron keeps the helper's stdin pipe open. EOF means the parent died;
    // terminating here prevents an orphan process from observing the keyboard.
    let parentPipe = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
    parentPipe.setEventHandler {
      var byte: UInt8 = 0
      let count = Darwin.read(STDIN_FILENO, &byte, 1)
      if count == 0 {
        registry.releaseActiveBindings()
        Foundation.exit(0)
      }
    }
    parentPipe.resume()

    withExtendedLifetime((registry, parentPipe)) {
      CFRunLoopRun()
    }
  }
}
