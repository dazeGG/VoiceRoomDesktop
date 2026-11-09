#include "../../native/capture/windows/CaptureTelemetry.h"

#include <cstdint>
#include <cstring>
#include <iostream>
#include <limits>
#include <string>

using voiceroom::capture::CaptureTelemetry;

static bool Expect(bool condition, const char* message) {
  if (!condition) std::cerr << message << '\n';
  return condition;
}

int main() {
  bool ok = true;
  // 10 MHz clock: one tick is 100 ns, 10 ticks are one microsecond.
  const int64_t hz = 10000000;
  const int64_t ms = hz / 1000;

  CaptureTelemetry dxgi;
  dxgi.Begin(true, hz, 0);
  dxgi.RecordAcquireAttempt();
  dxgi.RecordAcquireEmpty();
  dxgi.RecordAcquireAttempt();
  dxgi.RecordLockWait(3 * ms);
  dxgi.RecordLockWait(-1);
  dxgi.RecordAcquired(33 * ms, 1);
  dxgi.RecordAcquired(66 * ms, 3);
  dxgi.RecordPacingSkip();
  dxgi.RecordPausedSkip();
  dxgi.RecordPausedSkip();
  dxgi.RecordMap(2 * ms);
  dxgi.RecordMap(5 * ms);
  dxgi.RecordWrite(4 * ms);
  dxgi.RecordWrite(1 * ms);
  auto first = dxgi.Take(70 * ms);
  ok &= Expect(first.acquireAttempts == 2 && first.acquireEmpty == 1 && first.maxLockWaitUs == 3000, "timeout and completed wait recorded");
  ok &= Expect(first.seq == 1, "first report has seq 1");
  ok &= Expect(first.acquired == 2 && first.accumulated == 4, "acquired and accumulated are summed");
  ok &= Expect(first.pacingSkips == 1 && first.pausedSkips == 2, "skips are counted separately");
  ok &= Expect(first.written == 2, "written counts flushed frames");
  ok &= Expect(first.sumMapUs == 7000 && first.maxMapUs == 5000, "map time is sum and max in microseconds");
  ok &= Expect(first.sumWriteUs == 5000 && first.maxWriteUs == 4000, "write time is sum and max in microseconds");
  ok &= Expect(first.maxGapUs == 33000, "max gap is the longest acquire interval, first measured from Begin");

  // Counters are cumulative, max values restart after Take.
  dxgi.RecordAcquired(100 * ms, 1);
  dxgi.RecordMap(1 * ms);
  auto second = dxgi.Take(101 * ms);
  ok &= Expect(second.acquireAttempts == 2 && second.acquireEmpty == 1 && second.maxLockWaitUs == 0, "counters persist and wait maximum resets");
  ok &= Expect(second.seq == 2, "seq increments per report");
  ok &= Expect(second.acquired == 3 && second.accumulated == 5, "counters stay cumulative");
  ok &= Expect(second.maxMapUs == 1000 && second.maxWriteUs == 0, "max values are per window");
  ok &= Expect(second.maxGapUs == 34000, "the gap spanning two windows is attributed to the acquire that ends it");

  // A stall is visible while it is still going on, without any new frame.
  auto stall1 = dxgi.Take(600 * ms);
  auto stall2 = dxgi.Take(1600 * ms);
  ok &= Expect(stall1.maxGapUs == 500000, "ongoing gap is reported before the next frame");
  ok &= Expect(stall2.maxGapUs == 1500000, "ongoing gap keeps growing across windows");
  ok &= Expect(stall2.acquired == second.acquired, "no frames were counted during the stall");

  // A source that never delivers is also visible, measured from Begin.
  CaptureTelemetry silent;
  silent.Begin(false, hz, 5 * hz);
  ok &= Expect(silent.Take(7 * hz).maxGapUs == 2000000, "gap before the first frame counts");

  char line[1024];
  const int n = CaptureTelemetry::Format(line, sizeof(line), first);
  const std::string text(line);
  ok &= Expect(n > 0 && static_cast<size_t>(n) == text.size(), "format fits the buffer");
  ok &= Expect(text.find("\"backend\":\"dxgi\"") != std::string::npos, "dxgi backend named");
  ok &= Expect(text.find("\"accumulated\":4") != std::string::npos, "dxgi reports accumulated");
  ok &= Expect(text.find("\"event\":\"pipeline\",\"seq\":1,") == 1, "event and seq lead the line");
  ok &= Expect(text.find('\n') == std::string::npos, "single line");

  ok &= Expect(text.find("callbackArrivals") == std::string::npos, "dxgi omits callback arrivals");
  char tiny[8] = "partial";
  ok &= Expect(CaptureTelemetry::Format(tiny, sizeof(tiny), first) < 0 && tiny[0] == 0, "undersized buffer has no partial JSON");

  CaptureTelemetry wgc;
  wgc.Begin(false, hz, 0);
  wgc.RecordCallbackArrival();
  auto callbackOnly = wgc.Take(1 * ms);
  ok &= Expect(callbackOnly.callbackArrivals == 1 && callbackOnly.acquireAttempts == 0, "callback independent of acquisition");
  wgc.RecordAcquireAttempt();
  wgc.RecordAcquireEmpty();
  wgc.RecordCallbackArrival();
  wgc.RecordAcquireAttempt();
  wgc.RecordLockWait(-10);
  wgc.RecordAcquired(10 * ms, 0);
  wgc.RecordWrite(1 * ms);
  auto wgcSnapshot = wgc.Take(20 * ms);
  ok &= Expect(wgcSnapshot.callbackArrivals == 2 && wgcSnapshot.acquireAttempts == 2 && wgcSnapshot.acquireEmpty == 1 && wgcSnapshot.maxLockWaitUs == 0, "WGC counters and negative wait");
  CaptureTelemetry::Format(line, sizeof(line), wgcSnapshot);
  const std::string wgcText(line);
  ok &= Expect(wgcText.find("\"backend\":\"wgc\"") != std::string::npos, "wgc backend named");
  ok &= Expect(wgcText.find("accumulated") == std::string::npos, "wgc omits accumulated instead of reporting 0");
  ok &= Expect(wgcText.find("\"written\":1,\"sumMapUs\":0,") != std::string::npos, "field order is stable");

  CaptureTelemetry::Snapshot worst;
  worst.dxgi = false;
  worst.seq = worst.acquired = worst.acquireAttempts = worst.acquireEmpty = worst.callbackArrivals =
      worst.maxLockWaitUs = worst.pacingSkips = worst.pausedSkips = worst.written = worst.accumulated =
      worst.sumMapUs = worst.sumWriteUs = worst.maxGapUs = worst.maxMapUs = worst.maxWriteUs =
      std::numeric_limits<uint64_t>::max();
  ok &= Expect(CaptureTelemetry::Format(line, sizeof(line), worst) > 0, "worst-case uint64 JSON fits");
  const std::string worstText(line);

  // Restart: Begin clears everything so the consumer sees a fresh session.
  dxgi.Begin(true, hz, 0);
  auto restarted = dxgi.Take(1 * ms);
  ok &= Expect(restarted.acquireAttempts == 0 && restarted.acquireEmpty == 0 && restarted.maxLockWaitUs == 0, "Begin resets new diagnostics");
  ok &= Expect(restarted.seq == 1 && restarted.acquired == 0, "Begin resets counters and seq");

  std::cout << text << '\n' << wgcText << '\n' << worstText << '\n';
  return ok ? 0 : 1;
}
