#include "../../native/capture/windows/CapturePacing.h"

#include <cstdint>
#include <iostream>

using voiceroom::capture::FramePacer;

static bool Expect(bool condition, const char* message) {
  if (!condition) std::cerr << message << '\n';
  return condition;
}

struct ReplayResult {
  int emitted;
  int64_t minGap;
};

static ReplayResult ReplayDetailed(int64_t interval, const int64_t* arrivals, int count) {
  FramePacer pacer;
  ReplayResult result{0, INT64_MAX};
  int64_t now = 1000000;
  int64_t lastEmit = 0;
  const int64_t end = now + 60000000;
  for (int i = 0; now < end; ++i) {
    now += arrivals[i % count];
    if (!pacer.ShouldEmit(now, interval)) continue;
    if (result.emitted > 0 && now - lastEmit < result.minGap) result.minGap = now - lastEmit;
    lastEmit = now;
    ++result.emitted;
  }
  return result;
}

static int Replay(int64_t interval, const int64_t* arrivals, int count) {
  return ReplayDetailed(interval, arrivals, count).emitted;
}

static double Fps(int frames) { return frames / 60.0; }

static bool NearFps(const char* label, int frames, double target, double tolerance) {
  const double fps = Fps(frames);
  std::cout << label << ": " << fps << " FPS\n";
  return Expect(fps >= target - tolerance && fps <= target + tolerance, label);
}

int main() {
  bool ok = true;
  const int64_t stutter[] = {33333, 33333, 16667, 50000};
  const int stutterFrames = Replay(33333, stutter, 4);
  std::cout << "30 FPS input with an early frame: " << Fps(stutterFrames) << " FPS\n";
  ok &= Expect(Fps(stutterFrames) >= 29.9, "an early frame must not cost the next on-time frame");
  const int64_t jitter[] = {16000, 17000, 17000};
  ok &= NearFps("60 FPS jittered 16/17/17", Replay(33333, jitter, 3), 30, 0.1);
  const int64_t regular[] = {16667};
  ok &= NearFps("60 FPS input", Replay(33333, regular, 1), 30, 0.1);
  const int64_t fast[] = {16639};
  ok &= NearFps("slightly faster than 60 FPS", Replay(33333, fast, 1), 30, 0.1);
  const int64_t fps144[] = {6944};
  ok &= NearFps("144 FPS input", Replay(33333, fps144, 1), 30, 0.1);
  const int64_t exact30[] = {33333};
  ok &= NearFps("30 FPS input", Replay(33333, exact30, 1), 30, 0.05);
  const int64_t khz[] = {1000};
  const ReplayResult dense = ReplayDetailed(33333, khz, 1);
  std::cout << "1 kHz input: " << Fps(dense.emitted) << " FPS, min emitted gap " << dense.minGap << " us\n";
  ok &= Expect(Fps(dense.emitted) <= 30.1, "dense input must stay capped near 30 FPS");
  ok &= Expect(dense.minGap >= 33333 * 9 / 20, "dense input must keep a minimum step between frames");
  // A frame late by under one interval, followed at once by a normal one, must
  // not produce a back-to-back pair.
  const int64_t latePair[] = {33333, 33333, 33333, 33333, 33333, 33333, 33333, 33333, 60000, 1000};
  const ReplayResult late = ReplayDetailed(33333, latePair, 10);
  std::cout << "late frame then 1 ms follower: " << Fps(late.emitted) << " FPS, min emitted gap " << late.minGap << " us\n";
  ok &= Expect(late.minGap >= 33333 * 9 / 20, "a late frame must not be followed by a back-to-back frame");
  const int64_t sparse[] = {1000000};
  ok &= Expect(Replay(33333, sparse, 1) == 60, "sparse input must not synthesize duplicate frames");
  const int lowFpsFrames = Replay(200000, jitter, 3);
  ok &= Expect(lowFpsFrames >= 299 && lowFpsFrames <= 301, "5 FPS profile must preserve its cap");

  FramePacer pacer;
  ok &= Expect(pacer.ShouldEmit(1000, 100), "first frame must be immediate");
  ok &= Expect(!pacer.ShouldEmit(1044, 100), "frames before the early window must be skipped");
  ok &= Expect(pacer.ShouldEmit(1045, 100), "early window edge must be inclusive");
  ok &= Expect(!pacer.ShouldEmit(1045, 100), "same-timestamp frame must not catch up");
  // While flow control is paused the helper does not call ShouldEmit. A short
  // pause must not reset the phase and let repeated ACKs bypass the FPS cap.
  ok &= Expect(!pacer.ShouldEmit(1100, 100), "short pause/resume must preserve the rate cap");
  ok &= Expect(pacer.ShouldEmit(10000, 100), "first frame after a stall must be immediate");
  ok &= Expect(!pacer.ShouldEmit(10001, 100), "stall must discard missed deadlines, not burst");
  ok &= Expect(pacer.ShouldEmit(10045, 100), "cadence must restart after a stall");
  pacer.Reset();
  ok &= Expect(pacer.ShouldEmit(10101, 100), "session reset must emit immediately");
  ok &= Expect(pacer.ShouldEmit(10102, 200), "changed FPS must not retain the previous deadline");
  ok &= Expect(!pacer.ShouldEmit(10191, 200), "changed FPS must use the new interval");
  ok &= Expect(pacer.ShouldEmit(10192, 200), "new interval early window edge must be inclusive");
  ok &= Expect(pacer.ShouldEmit(10303, 0), "disabled pacing must emit");
  ok &= Expect(pacer.ShouldEmit(10304, 100), "re-enabled pacing must start immediately");
  return ok ? 0 : 1;
}
