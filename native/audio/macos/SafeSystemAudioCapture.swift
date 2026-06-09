import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

private let stderrHandle = FileHandle.standardError
private let stdoutHandle = FileHandle.standardOutput

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
    configuration.excludesCurrentProcessAudio = true

    let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
    try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
    try await stream.startCapture()
    self.stream = stream
    self.running = true

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

    var blockBuffer: CMBlockBuffer?
    var bufferList = AudioBufferList()
    let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      sampleBuffer,
      bufferListSizeNeededOut: nil,
      bufferListOut: &bufferList,
      bufferListSize: MemoryLayout<AudioBufferList>.size,
      blockBufferAllocator: kCFAllocatorDefault,
      blockBufferMemoryAllocator: kCFAllocatorDefault,
      flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
      blockBufferOut: &blockBuffer
    )
    guard status == noErr else {
      logEvent(["event": "warning", "message": "Unable to read audio buffer list", "status": status])
      return
    }

    let channelCount = max(1, Int(asbd.mChannelsPerFrame))
    if !announcedFormat {
      announcedFormat = true
      logEvent([
        "event": "format",
        "sampleRate": asbd.mSampleRate,
        "channels": channelCount,
        "sampleFormat": "f32le",
        "interleaved": true
      ])
    }

    let flags = asbd.mFormatFlags
    let isFloat = (flags & kAudioFormatFlagIsFloat) != 0
    let isNonInterleaved = (flags & kAudioFormatFlagIsNonInterleaved) != 0
    let bitsPerChannel = Int(asbd.mBitsPerChannel)

    if isFloat && bitsPerChannel == 32 {
      emitFloat32(bufferList: &bufferList, frameCount: frameCount, channelCount: channelCount, isNonInterleaved: isNonInterleaved)
      return
    }

    if !isFloat && bitsPerChannel == 16 {
      emitInt16AsFloat32(bufferList: &bufferList, frameCount: frameCount, channelCount: channelCount, isNonInterleaved: isNonInterleaved)
      return
    }

    logEvent([
      "event": "warning",
      "message": "Unsupported PCM layout",
      "bitsPerChannel": bitsPerChannel,
      "isFloat": isFloat,
      "isNonInterleaved": isNonInterleaved
    ])
  }

  private func emitFloat32(bufferList: inout AudioBufferList, frameCount: Int, channelCount: Int, isNonInterleaved: Bool) {
    let buffers = UnsafeMutableAudioBufferListPointer(&bufferList)
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

  private func emitInt16AsFloat32(bufferList: inout AudioBufferList, frameCount: Int, channelCount: Int, isNonInterleaved: Bool) {
    let buffers = UnsafeMutableAudioBufferListPointer(&bufferList)
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
}

@main
struct VoiceRoomSafeSystemAudioMain {
  static func main() async {
    guard ProcessInfo.processInfo.arguments.contains("--safe-system") else {
      logEvent(["event": "error", "message": "Expected --safe-system"])
      Foundation.exit(64)
    }

    guard #available(macOS 13.0, *) else {
      logEvent(["event": "error", "message": "Safe system audio requires macOS 13 or newer"])
      Foundation.exit(69)
    }

    let capture = SafeSystemAudioCapture()
    do {
      try await capture.start()
      await withCheckedContinuation { continuation in
        signal(SIGINT) { _ in Foundation.exit(0) }
        signal(SIGTERM) { _ in Foundation.exit(0) }
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
