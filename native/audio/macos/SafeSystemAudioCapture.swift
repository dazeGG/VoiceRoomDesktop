import AVFoundation
import CoreAudio
import CoreMedia
import Darwin
import Foundation
import ScreenCaptureKit

private let stderrHandle = FileHandle.standardError
private let stdoutHandle = FileHandle.standardOutput
private let defaultSampleRate = 48_000
private let defaultChannelCount = 2

private func logEvent(_ payload: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(payload),
        let data = try? JSONSerialization.data(withJSONObject: payload),
        let line = String(data: data, encoding: .utf8) else {
    return
  }
  if let encoded = "\(line)\n".data(using: .utf8) {
    stderrHandle.write(encoded)
  }
}

private func writeFloat32Samples(_ samples: [Float]) {
  samples.withUnsafeBufferPointer { buffer in
    guard let baseAddress = buffer.baseAddress else { return }
    let data = Data(bytes: baseAddress, count: buffer.count * MemoryLayout<Float>.size)
    stdoutHandle.write(data)
  }
}

@available(macOS 13.0, *)
final class SafeSystemAudioCapture: NSObject, SCStreamDelegate, SCStreamOutput {
  private let queue = DispatchQueue(label: "ru.dazinho.voiceroom.safe-system-audio")
  private var stream: SCStream?
  private var announcedFormat = false
  private var running = false

  func start() async throws {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard let display = content.displays.first else {
      throw NSError(domain: "VoiceRoomSafeAudio", code: 1, userInfo: [NSLocalizedDescriptionKey: "No capturable display was found"])
    }

    let filter = SCContentFilter(display: display, excludingWindows: [])
    let configuration = SCStreamConfiguration()
    configuration.capturesAudio = true
    // TODO: excludesCurrentProcessAudio исключает аудио только самого процесса-хелпера,
    // а не основного приложения Voice Room (это разные процессы), поэтому в захват может
    // попасть воспроизведение голосов других участников → возможное эхо. На Windows это
    // решено исключением дерева процессов; per-app-исключения чужого процесса в SCK (13.0)
    // нет. Чистое решение — выполнять SCK-захват внутри процесса, проигрывающего звук
    // Voice Room. Отдельная задача, не блокер «нет звука».
    configuration.excludesCurrentProcessAudio = true
    configuration.sampleRate = defaultSampleRate
    configuration.channelCount = defaultChannelCount
    // ScreenCaptureKit не доставляет аудио-буферы для чисто аудио-захвата (forum thread/718279,
    // "stream output NOT found. Dropping frame"). Нужна валидная видеоконфигурация и screen-выход;
    // кадры видео отбрасываются в didOutputSampleBuffer (guard outputType == .audio).
    configuration.width = 16
    configuration.height = 16
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1) // ~1 fps
    configuration.queueDepth = 6
    configuration.showsCursor = false

    let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
    try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
    try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
    try await stream.startCapture()
    self.stream = stream
    self.running = true
    announceFormat(sampleRate: Double(defaultSampleRate), channels: defaultChannelCount)

    logEvent([
      "event": "started",
      "mode": "safe-system",
      "platform": "darwin",
      "excludesCurrentProcessAudio": true
    ])
  }

  func stop() async {
    guard let stream else { return }
    running = false
    do {
      try await stream.stopCapture()
    } catch {
      logEvent(["event": "warning", "message": "stopCapture failed", "detail": error.localizedDescription])
    }
    self.stream = nil
    logEvent(["event": "stopped"])
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    running = false
    logEvent(["event": "error", "message": error.localizedDescription])
    Foundation.exit(2)
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
    guard running, outputType == .audio, sampleBuffer.isValid else { return }
    emitPCM(sampleBuffer)
  }

  private func emitPCM(_ sampleBuffer: CMSampleBuffer) {
    guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
          let asbdPointer = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription) else {
      return
    }

    let asbd = asbdPointer.pointee
    guard asbd.mFormatID == kAudioFormatLinearPCM else {
      logEvent(["event": "warning", "message": "Unsupported audio format", "formatID": asbd.mFormatID])
      return
    }

    let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
    guard frameCount > 0 else { return }

    let channelCount = max(1, Int(asbd.mChannelsPerFrame))
    if !announcedFormat {
      announceFormat(sampleRate: asbd.mSampleRate, channels: channelCount)
    }

    // ScreenCaptureKit отдаёт PCM неинтерливленно — по одному AudioBuffer на канал, поэтому
    // AudioBufferList должен вмещать channelCount буферов. Статический `AudioBufferList()`
    // вмещает лишь один → CMSampleBufferGetAudioBufferList… возвращает -12737
    // (kCMSampleBufferError_ArrayTooSmall) и кадр теряется. Выделяем список нужного размера.
    let buffers = AudioBufferList.allocate(maximumBuffers: channelCount)
    defer { free(buffers.unsafeMutablePointer) }

    var blockBuffer: CMBlockBuffer?
    let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      sampleBuffer,
      bufferListSizeNeededOut: nil,
      bufferListOut: buffers.unsafeMutablePointer,
      bufferListSize: AudioBufferList.sizeInBytes(maximumBuffers: channelCount),
      blockBufferAllocator: kCFAllocatorDefault,
      blockBufferMemoryAllocator: kCFAllocatorDefault,
      flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
      blockBufferOut: &blockBuffer
    )
    guard status == noErr else {
      logEvent(["event": "warning", "message": "Unable to read audio buffer list", "status": status])
      return
    }

    let flags = asbd.mFormatFlags
    let isFloat = (flags & kAudioFormatFlagIsFloat) != 0
    let isNonInterleaved = (flags & kAudioFormatFlagIsNonInterleaved) != 0
    let bitsPerChannel = Int(asbd.mBitsPerChannel)

    // blockBuffer владеет памятью, на которую указывают buffers[*].mData — держим его живым,
    // пока пишем сэмплы.
    withExtendedLifetime(blockBuffer) {
      if isFloat && bitsPerChannel == 32 {
        emitFloat32(buffers: buffers, frameCount: frameCount, channelCount: channelCount, isNonInterleaved: isNonInterleaved)
      } else if !isFloat && bitsPerChannel == 16 {
        emitInt16AsFloat32(buffers: buffers, frameCount: frameCount, channelCount: channelCount, isNonInterleaved: isNonInterleaved)
      } else {
        logEvent([
          "event": "warning",
          "message": "Unsupported PCM layout",
          "bitsPerChannel": bitsPerChannel,
          "isFloat": isFloat,
          "isNonInterleaved": isNonInterleaved
        ])
      }
    }
  }

  private func emitFloat32(buffers: UnsafeMutableAudioBufferListPointer, frameCount: Int, channelCount: Int, isNonInterleaved: Bool) {
    if !isNonInterleaved, let data = buffers.first?.mData {
      stdoutHandle.write(Data(bytes: data, count: frameCount * channelCount * MemoryLayout<Float>.size))
      return
    }

    var samples = Array(repeating: Float(0), count: frameCount * channelCount)
    for channel in 0..<min(channelCount, buffers.count) {
      guard let data = buffers[channel].mData else { continue }
      let channelSamples = data.assumingMemoryBound(to: Float.self)
      for frame in 0..<frameCount {
        samples[(frame * channelCount) + channel] = channelSamples[frame]
      }
    }
    writeFloat32Samples(samples)
  }

  private func emitInt16AsFloat32(buffers: UnsafeMutableAudioBufferListPointer, frameCount: Int, channelCount: Int, isNonInterleaved: Bool) {
    var samples = Array(repeating: Float(0), count: frameCount * channelCount)

    if !isNonInterleaved, let data = buffers.first?.mData {
      let intSamples = data.assumingMemoryBound(to: Int16.self)
      for index in 0..<samples.count {
        samples[index] = Float(intSamples[index]) / Float(Int16.max)
      }
      writeFloat32Samples(samples)
      return
    }

    for channel in 0..<min(channelCount, buffers.count) {
      guard let data = buffers[channel].mData else { continue }
      let channelSamples = data.assumingMemoryBound(to: Int16.self)
      for frame in 0..<frameCount {
        samples[(frame * channelCount) + channel] = Float(channelSamples[frame]) / Float(Int16.max)
      }
    }
    writeFloat32Samples(samples)
  }

  private func announceFormat(sampleRate: Double, channels: Int) {
    guard !announcedFormat else { return }
    announcedFormat = true
    logEvent([
      "event": "format",
      "sampleRate": sampleRate,
      "channels": channels,
      "sampleFormat": "f32le",
      "interleaved": true
    ])
  }
}

// MARK: - Core Audio process tap (macOS 14.4+)

// Captures the system audio mix while EXCLUDING the entire Voice Room process tree, so the
// stream does not re-capture other participants' voices played back by Voice Room (no echo).
// This is the macOS equivalent of the Windows EXCLUDE_TARGET_PROCESS_TREE loopback. Mirrors
// insidegui/AudioCap and Apple's "Capturing system audio with Core Audio taps".
@available(macOS 14.4, *)
final class ProcessTapCapture {
  private let excludePid: pid_t
  private let writeQueue = DispatchQueue(label: "ru.dazinho.voiceroom.tap-write")
  private var tapID = AudioObjectID(kAudioObjectUnknown)
  private var aggregateID = AudioObjectID(kAudioObjectUnknown)
  private var ioProcID: AudioDeviceIOProcID?
  private var format = AudioStreamBasicDescription()
  private var running = false

  init(excludePid: pid_t) {
    self.excludePid = excludePid
  }

  func start() throws {
    // 1. All PIDs of the Voice Room process tree (main Electron process + children, including
    //    the Chromium audio service process that actually plays participant audio).
    let treePids = collectProcessTree(root: excludePid)

    // 2. Audio process objects whose PID is in that tree → the exclusion list.
    var excludedObjects: [AudioObjectID] = []
    for object in readAudioProcessObjectList() {
      guard let pid = readAudioProcessPID(object) else { continue }
      if treePids.contains(pid) { excludedObjects.append(object) }
    }

    // 3. Global system-audio tap excluding those processes.
    let tapUUID = UUID()
    let description = CATapDescription(stereoGlobalTapButExcludeProcesses: excludedObjects)
    description.uuid = tapUUID
    description.name = "VoiceRoomStreamTap"
    description.isPrivate = true
    // muteBehavior left at its default (CATapUnmuted): the tapped audio keeps playing
    // normally while we capture it.

    var createdTap = AudioObjectID(kAudioObjectUnknown)
    var status = AudioHardwareCreateProcessTap(description, &createdTap)
    guard status == noErr, createdTap != AudioObjectID(kAudioObjectUnknown) else {
      throw tapError("AudioHardwareCreateProcessTap failed", status)
    }
    tapID = createdTap

    // 4. Real audio format produced by the tap.
    guard let tapFormat = readTapFormat(tapID) else {
      throw tapError("Unable to read tap format", noErr)
    }
    format = tapFormat

    // 5. Private aggregate device that auto-starts the tap and exposes it as an input stream.
    let aggregateDescription: [String: Any] = [
      kAudioAggregateDeviceNameKey: "VoiceRoomAggregate",
      kAudioAggregateDeviceUIDKey: "VoiceRoomAggregate-\(UUID().uuidString)",
      kAudioAggregateDeviceIsPrivateKey: true,
      kAudioAggregateDeviceIsStackedKey: false,
      kAudioAggregateDeviceTapAutoStartKey: true,
      kAudioAggregateDeviceSubDeviceListKey: [[String: Any]](),
      kAudioAggregateDeviceTapListKey: [
        [
          kAudioSubTapDriftCompensationKey: true,
          kAudioSubTapUIDKey: tapUUID.uuidString
        ]
      ]
    ]
    var createdAggregate = AudioObjectID(kAudioObjectUnknown)
    status = AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &createdAggregate)
    guard status == noErr, createdAggregate != AudioObjectID(kAudioObjectUnknown) else {
      throw tapError("AudioHardwareCreateAggregateDevice failed", status)
    }
    aggregateID = createdAggregate

    // 6. IO proc on a private serial queue (keeps stdout writes off the real-time thread).
    var createdProc: AudioDeviceIOProcID?
    status = AudioDeviceCreateIOProcIDWithBlock(&createdProc, aggregateID, writeQueue) { [weak self] _, inInputData, _, _, _ in
      self?.emit(inInputData)
    }
    guard status == noErr, let proc = createdProc else {
      throw tapError("AudioDeviceCreateIOProcIDWithBlock failed", status)
    }
    ioProcID = proc

    status = AudioDeviceStart(aggregateID, proc)
    guard status == noErr else {
      throw tapError("AudioDeviceStart failed", status)
    }

    running = true
    announceFormat()
    logEvent([
      "event": "started",
      "mode": "safe-system",
      "platform": "darwin",
      "method": "core-audio-process-tap",
      "excludedProcesses": excludedObjects.count
    ])
  }

  func stop() {
    let wasRunning = running
    running = false
    if let proc = ioProcID {
      if wasRunning { AudioDeviceStop(aggregateID, proc) }
      AudioDeviceDestroyIOProcID(aggregateID, proc)
      ioProcID = nil
    }
    if aggregateID != AudioObjectID(kAudioObjectUnknown) {
      AudioHardwareDestroyAggregateDevice(aggregateID)
      aggregateID = AudioObjectID(kAudioObjectUnknown)
    }
    if tapID != AudioObjectID(kAudioObjectUnknown) {
      AudioHardwareDestroyProcessTap(tapID)
      tapID = AudioObjectID(kAudioObjectUnknown)
    }
    if wasRunning { logEvent(["event": "stopped"]) }
  }

  private func emit(_ bufferList: UnsafePointer<AudioBufferList>) {
    guard running else { return }
    let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: bufferList))
    let channelCount = max(1, Int(format.mChannelsPerFrame))
    let isNonInterleaved = (format.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0

    // Tap format is 32-bit float. Interleaved → write bytes as-is (already f32le).
    if !isNonInterleaved {
      guard let first = abl.first, let data = first.mData, first.mDataByteSize > 0 else { return }
      stdoutHandle.write(Data(bytes: data, count: Int(first.mDataByteSize)))
      return
    }

    // Planar float → interleave into f32le.
    let frameCount = Int(abl.first?.mDataByteSize ?? 0) / MemoryLayout<Float>.size
    guard frameCount > 0 else { return }
    var samples = Array(repeating: Float(0), count: frameCount * channelCount)
    for channel in 0..<min(channelCount, abl.count) {
      guard let data = abl[channel].mData else { continue }
      let channelSamples = data.assumingMemoryBound(to: Float.self)
      for frame in 0..<frameCount {
        samples[(frame * channelCount) + channel] = channelSamples[frame]
      }
    }
    writeFloat32Samples(samples)
  }

  private func announceFormat() {
    logEvent([
      "event": "format",
      "sampleRate": format.mSampleRate > 0 ? format.mSampleRate : Double(defaultSampleRate),
      "channels": max(1, Int(format.mChannelsPerFrame)),
      "sampleFormat": "f32le",
      "interleaved": true
    ])
  }

  private func tapError(_ message: String, _ status: OSStatus) -> NSError {
    return NSError(
      domain: "VoiceRoomProcessTap",
      code: Int(status),
      userInfo: [NSLocalizedDescriptionKey: "\(message) (status=\(status))"]
    )
  }
}

@available(macOS 14.4, *)
private func readAudioProcessObjectList() -> [AudioObjectID] {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyProcessObjectList,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var dataSize: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize) == noErr else {
    return []
  }
  let count = Int(dataSize) / MemoryLayout<AudioObjectID>.size
  guard count > 0 else { return [] }
  var ids = [AudioObjectID](repeating: AudioObjectID(kAudioObjectUnknown), count: count)
  let status = ids.withUnsafeMutableBytes { raw -> OSStatus in
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize, raw.baseAddress!)
  }
  return status == noErr ? ids : []
}

@available(macOS 14.4, *)
private func readAudioProcessPID(_ object: AudioObjectID) -> pid_t? {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioProcessPropertyPID,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var pid: pid_t = -1
  var size = UInt32(MemoryLayout<pid_t>.size)
  guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &pid) == noErr else { return nil }
  return pid
}

@available(macOS 14.4, *)
private func readTapFormat(_ tapID: AudioObjectID) -> AudioStreamBasicDescription? {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioTapPropertyFormat,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var asbd = AudioStreamBasicDescription()
  var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
  guard AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &asbd) == noErr else { return nil }
  return asbd
}

// All running processes as (pid, ppid) pairs via sysctl(KERN_PROC_ALL).
private func allProcessParents() -> [(pid: pid_t, ppid: pid_t)] {
  var name: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
  var length = 0
  guard sysctl(&name, 4, nil, &length, nil, 0) == 0, length > 0 else { return [] }
  let stride = MemoryLayout<kinfo_proc>.stride
  var procs = [kinfo_proc](repeating: kinfo_proc(), count: length / stride)
  var resultLength = length
  let status = procs.withUnsafeMutableBytes { raw -> Int32 in
    sysctl(&name, 4, raw.baseAddress, &resultLength, nil, 0)
  }
  guard status == 0 else { return [] }
  return procs.prefix(resultLength / stride).map { ($0.kp_proc.p_pid, $0.kp_eproc.e_ppid) }
}

// Set of PIDs rooted at `root` (inclusive), walking the parent→child relationships.
private func collectProcessTree(root: pid_t) -> Set<pid_t> {
  guard root > 0 else { return [] }
  var childrenByParent: [pid_t: [pid_t]] = [:]
  for entry in allProcessParents() {
    childrenByParent[entry.ppid, default: []].append(entry.pid)
  }
  var result: Set<pid_t> = [root]
  var stack: [pid_t] = [root]
  while let current = stack.popLast() {
    for child in childrenByParent[current] ?? [] where !result.contains(child) {
      result.insert(child)
      stack.append(child)
    }
  }
  return result
}

private func parseExcludePid(_ arguments: [String]) -> pid_t? {
  guard let index = arguments.firstIndex(of: "--exclude-pid"), index + 1 < arguments.count else { return nil }
  return pid_t(arguments[index + 1])
}

private func installSignalHandlers() {
  signal(SIGINT) { _ in Foundation.exit(0) }
  signal(SIGTERM) { _ in Foundation.exit(0) }
}

@main
struct VoiceRoomSafeSystemAudioMain {
  static func main() async {
    let arguments = ProcessInfo.processInfo.arguments
    guard arguments.contains("--safe-system") else {
      logEvent(["event": "error", "message": "Expected --safe-system"])
      Foundation.exit(64)
    }

    // macOS 14.4+: Core Audio process tap that excludes the Voice Room process tree (no echo).
    if #available(macOS 14.4, *) {
      let tap = ProcessTapCapture(excludePid: parseExcludePid(arguments) ?? getppid())
      do {
        try tap.start()
        installSignalHandlers()
        RunLoop.current.run()
        tap.stop()
        return
      } catch {
        tap.stop()
        logEvent([
          "event": "warning",
          "message": "Core Audio process tap unavailable, falling back to ScreenCaptureKit",
          "detail": error.localizedDescription
        ])
        // fall through to the ScreenCaptureKit path (system audio works, echo possible)
      }
    }

    guard #available(macOS 13.0, *) else {
      logEvent(["event": "error", "message": "Safe system audio requires macOS 13 or newer"])
      Foundation.exit(69)
    }

    let capture = SafeSystemAudioCapture()
    do {
      try await capture.start()
      await withCheckedContinuation { continuation in
        installSignalHandlers()
        RunLoop.current.run()
        continuation.resume()
      }
      await capture.stop()
    } catch {
      logEvent(["event": "error", "message": error.localizedDescription])
      Foundation.exit(1)
    }
  }
}
