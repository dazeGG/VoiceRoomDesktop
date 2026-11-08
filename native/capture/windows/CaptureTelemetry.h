#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <mutex>

namespace voiceroom::capture {

// Counters for the capture pipeline, kept free of WinRT/D3D types so they can be
// compiled and tested on their own. Times are QPC ticks supplied by the caller
// and stored as whole microseconds. Counters are cumulative since Begin();
// max* values cover the window since the previous Take().
class CaptureTelemetry {
 public:
  struct Snapshot {
    uint64_t seq = 0;
    bool dxgi = false;
    uint64_t acquired = 0;
    uint64_t pacingSkips = 0;
    uint64_t pausedSkips = 0;
    uint64_t written = 0;
    uint64_t accumulated = 0;
    uint64_t sumMapUs = 0;
    uint64_t sumWriteUs = 0;
    uint64_t maxGapUs = 0;
    uint64_t maxMapUs = 0;
    uint64_t maxWriteUs = 0;
  };

  void Begin(bool dxgi, int64_t frequency, int64_t now) {
    std::lock_guard<std::mutex> guard(mutex_);
    data_ = Snapshot();
    data_.dxgi = dxgi;
    frequency_ = frequency > 0 ? frequency : 1;
    lastAcquired_ = now;
  }

  // The gap is measured from the previous acquire, or from Begin() before the
  // first frame, so a source that never delivers is visible as a growing gap.
  void RecordAcquired(int64_t now, uint32_t accumulatedFrames) {
    std::lock_guard<std::mutex> guard(mutex_);
    data_.acquired += 1;
    data_.accumulated += accumulatedFrames;
    data_.maxGapUs = std::max(data_.maxGapUs, ToMicros(now - lastAcquired_));
    lastAcquired_ = now;
  }

  void RecordPacingSkip() {
    std::lock_guard<std::mutex> guard(mutex_);
    data_.pacingSkips += 1;
  }

  void RecordPausedSkip() {
    std::lock_guard<std::mutex> guard(mutex_);
    data_.pausedSkips += 1;
  }

  void RecordMap(int64_t ticks) {
    std::lock_guard<std::mutex> guard(mutex_);
    const uint64_t us = ToMicros(ticks);
    data_.sumMapUs += us;
    data_.maxMapUs = std::max(data_.maxMapUs, us);
  }

  // Counts one frame as written: call only after the payload was flushed.
  void RecordWrite(int64_t ticks) {
    std::lock_guard<std::mutex> guard(mutex_);
    const uint64_t us = ToMicros(ticks);
    data_.written += 1;
    data_.sumWriteUs += us;
    data_.maxWriteUs = std::max(data_.maxWriteUs, us);
  }

  // Includes the gap that is still running, then starts a new max window.
  Snapshot Take(int64_t now) {
    std::lock_guard<std::mutex> guard(mutex_);
    data_.seq += 1;
    Snapshot out = data_;
    out.maxGapUs = std::max(out.maxGapUs, ToMicros(now - lastAcquired_));
    data_.maxGapUs = 0;
    data_.maxMapUs = 0;
    data_.maxWriteUs = 0;
    return out;
  }

  // One JSON object, no identifiers. accumulated exists only for DXGI.
  static int Format(char* buffer, size_t size, const Snapshot& s) {
    char accumulated[48] = "";
    if (s.dxgi) {
      std::snprintf(accumulated, sizeof(accumulated), ",\"accumulated\":%llu",
                    static_cast<unsigned long long>(s.accumulated));
    }
    return std::snprintf(
        buffer, size,
        "{\"event\":\"pipeline\",\"seq\":%llu,\"backend\":\"%s\",\"acquired\":%llu,"
        "\"pacingSkips\":%llu,\"pausedSkips\":%llu,\"written\":%llu%s,"
        "\"sumMapUs\":%llu,\"sumWriteUs\":%llu,\"maxGapUs\":%llu,\"maxMapUs\":%llu,"
        "\"maxWriteUs\":%llu}",
        static_cast<unsigned long long>(s.seq), s.dxgi ? "dxgi" : "wgc",
        static_cast<unsigned long long>(s.acquired),
        static_cast<unsigned long long>(s.pacingSkips),
        static_cast<unsigned long long>(s.pausedSkips),
        static_cast<unsigned long long>(s.written), accumulated,
        static_cast<unsigned long long>(s.sumMapUs),
        static_cast<unsigned long long>(s.sumWriteUs),
        static_cast<unsigned long long>(s.maxGapUs),
        static_cast<unsigned long long>(s.maxMapUs),
        static_cast<unsigned long long>(s.maxWriteUs));
  }

 private:
  uint64_t ToMicros(int64_t ticks) const {
    if (ticks <= 0) return 0;
    const int64_t whole = ticks / frequency_;
    const int64_t rest = ticks % frequency_;
    return static_cast<uint64_t>(whole) * 1000000ull +
           static_cast<uint64_t>(rest) * 1000000ull / static_cast<uint64_t>(frequency_);
  }

  std::mutex mutex_;
  Snapshot data_;
  int64_t frequency_ = 1;
  int64_t lastAcquired_ = 0;
};

}  // namespace voiceroom::capture
