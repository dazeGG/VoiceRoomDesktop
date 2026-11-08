#pragma once

#include <cstdint>

namespace voiceroom::capture {

class FramePacer {
 public:
  void Reset() { interval_ = 0; }

  bool ShouldEmit(int64_t now, int64_t interval) {
    if (interval <= 0) {
      Reset();
      return true;
    }
    if (interval != interval_) {
      interval_ = interval;
      nextFrame_ = now + interval;
      lastEmit_ = now;
      return true;
    }
    // Accept a frame up to 55% of an interval before the deadline. A window of
    // exactly half an interval rejects a frame that is 16.7 ms early at 30 FPS,
    // and the following on-time frame is then dropped too. The schedule below
    // still advances by one whole interval, so the average rate stays capped.
    if (now < nextFrame_ - interval * 11 / 20) return false;
    // A frame that was late by less than one interval advances the deadline by
    // only one interval, so the next frame can land inside the early window right
    // after it. Keep emitted frames at least 45% of an interval apart; a skipped
    // frame does not move the schedule.
    if (now - lastEmit_ < interval * 9 / 20) return false;

    // Keep the phase when an arrival is a little late: restarting the interval
    // at every accepted frame aliases a jittered 60 FPS source down to 20 FPS.
    // After a whole missed interval, discard the old schedule instead of
    // emitting a burst of catch-up frames (e.g. after a GPU/pipe stall).
    nextFrame_ = now - nextFrame_ >= interval ? now + interval : nextFrame_ + interval;
    lastEmit_ = now;
    return true;
  }

 private:
  int64_t interval_ = 0;
  int64_t nextFrame_ = 0;
  int64_t lastEmit_ = 0;
};

}  // namespace voiceroom::capture
