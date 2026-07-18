#include "../../native/capture/windows/CaptureGeometry.h"

#include <cstdint>
#include <iostream>

using voiceroom::capture::ComputeOutputSize;
using voiceroom::capture::FrameSize;

static bool Expect(uint32_t sourceWidth,
                   uint32_t sourceHeight,
                   uint32_t maxWidth,
                   uint32_t maxHeight,
                   uint32_t expectedWidth,
                   uint32_t expectedHeight) {
  const FrameSize actual = ComputeOutputSize(sourceWidth, sourceHeight, maxWidth, maxHeight);
  if (actual.width == expectedWidth && actual.height == expectedHeight) return true;
  std::cerr << sourceWidth << 'x' << sourceHeight << " inside "
            << maxWidth << 'x' << maxHeight << " produced "
            << actual.width << 'x' << actual.height << " instead of "
            << expectedWidth << 'x' << expectedHeight << '\n';
  return false;
}

int main() {
  bool ok = true;
  ok &= Expect(3440, 1440, 1920, 1080, 1920, 804);
  ok &= Expect(2560, 1080, 1920, 1080, 1920, 810);
  ok &= Expect(1920, 1200, 1920, 1080, 1728, 1080);
  ok &= Expect(1280, 720, 1920, 1080, 1280, 720);
  ok &= Expect(1537, 865, 1920, 1080, 1536, 864);
  ok &= Expect(1279, 719, 1280, 720, 1278, 718);
  ok &= Expect(1080, 1920, 1920, 1080, 608, 1080);
  return ok ? 0 : 1;
}
