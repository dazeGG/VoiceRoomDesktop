#pragma once

#include <algorithm>
#include <cstdint>

namespace voiceroom::capture {

struct FrameSize {
  uint32_t width = 0;
  uint32_t height = 0;
};

inline uint32_t MakeEvenDimension(uint32_t value) {
  if (value < 2) return 0;
  return value & ~1u;
}

inline FrameSize ComputeOutputSize(uint32_t width,
                                   uint32_t height,
                                   uint32_t maxWidth,
                                   uint32_t maxHeight) {
  if (width == 0 || height == 0 || maxWidth < 2 || maxHeight < 2) {
    return {width, height};
  }

  if (width <= maxWidth && height <= maxHeight) {
    // D3D11 NV12 requires even dimensions. Trim at most one pixel per axis so
    // odd-sized windows remain on the GPU path without upscaling.
    const uint32_t outputWidth = MakeEvenDimension(width);
    const uint32_t outputHeight = MakeEvenDimension(height);
    if (outputWidth >= 2 && outputHeight >= 2) return {outputWidth, outputHeight};
    return {width, height};
  }

  uint32_t outputWidth = 0;
  uint32_t outputHeight = 0;
  if (static_cast<uint64_t>(width) * maxHeight >= static_cast<uint64_t>(height) * maxWidth) {
    outputWidth = MakeEvenDimension(std::min(width, maxWidth));
    const uint64_t roundedHeight =
        (static_cast<uint64_t>(height) * outputWidth + width / 2) / width;
    outputHeight = MakeEvenDimension(static_cast<uint32_t>(std::max<uint64_t>(2, roundedHeight)));
  } else {
    outputHeight = MakeEvenDimension(std::min(height, maxHeight));
    const uint64_t roundedWidth =
        (static_cast<uint64_t>(width) * outputHeight + height / 2) / height;
    outputWidth = MakeEvenDimension(static_cast<uint32_t>(std::max<uint64_t>(2, roundedWidth)));
  }

  if (outputWidth == 0 || outputHeight == 0 || outputWidth > maxWidth || outputHeight > maxHeight) {
    return {width, height};
  }
  return {outputWidth, outputHeight};
}

}  // namespace voiceroom::capture
