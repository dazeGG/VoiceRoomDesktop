// ScreenCursorCapture: Windows screen/window capture helper for Voice Room.
//
// Why this exists: every capture backend available to Chromium gets the cursor
// wrong when an application hides it. WGC lets the OS bake the cursor into the
// frame and Windows keeps drawing it even after a game calls ShowCursor(FALSE);
// the legacy DXGI/GDI path goes through WebRTC's MouseCursorMonitorWin, which
// turns the hidden-cursor state (GetCursorInfo flags == 0) into a default
// IDC_ARROW phantom. The only correct approach (used by OBS and by Discord's
// game capture) is to capture frames *without* the OS cursor and composite the
// cursor ourselves, honouring CURSOR_SHOWING.
//
// Backends: screens use DXGI Desktop Duplication, windows use WGC. WGC paints a
// yellow capture border that cannot be turned off on Windows 10 (the
// IsBorderRequired toggle is Windows 11 only), so monitors go through
// Duplication, which draws no border and hands back a cursor-free desktop image
// that feeds the same cursor-compositing FrameWriter. Windows have no
// border-free GPU backend, so they stay on WGC.
//
// Protocol (mirrors SafeSystemAudioCapture):
//   stdout — binary frame stream: 24-byte header + top-down payload.
//            header: u32 magic 'VRF1', u32 width, u32 height, u32 flags
//            (bit0 = cursor drawn, bit1 = NV12 payload), i64 timestampMs.
//            NV12 is tightly packed Y plane + interleaved UV plane. If GPU NV12
//            conversion is unavailable, frames fall back to top-down BGRX with
//            stride == width * 4.
//   stderr — one JSON event per line: format / log / warning / error / closed / exit.
//   stdin  — one JSON command per line (ignored when absent):
//            {"cmd":"reconfigure","fps":<1..60>,"maxHeight":<2..16384>}
//   args   — --source screen:<index> | window:<hwnd>  [--fps 5|15|30|60]
//            [--max-height 720|1080|1440]
//
// Exit codes: 0 clean stop, 2 capture unsupported on this Windows build,
// 1 any other failure (details on stderr).

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <d3d11.h>
#include <dwmapi.h>
#include <dxgi1_2.h>
#include <fcntl.h>
#include <io.h>

#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <csignal>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <avrt.h>

namespace wgc = winrt::Windows::Graphics::Capture;
namespace wgd = winrt::Windows::Graphics::DirectX;
namespace wgd3d = winrt::Windows::Graphics::DirectX::Direct3D11;

static std::atomic<bool> g_running{true};
static HANDLE g_stopEvent = nullptr;

class CaptureSession;

// Guards the active-session pointer against the detached stdin thread. Clearing
// the pointer under this lock guarantees no ApplyReconfigure is in-flight (and
// none can start) before wmain tears the session down, so the stdin thread can
// never touch a destroyed CaptureSession.
static CaptureSession* g_activeSession = nullptr;
static std::mutex g_activeSessionMutex;

static constexpr uint32_t kFrameFlagCursorDrawn = 1u;
static constexpr uint32_t kFrameFlagFormatNv12 = 1u << 1;

static void HandleSignal(int) {
  g_running = false;
  if (g_stopEvent) SetEvent(g_stopEvent);
}

static void LogEvent(const char* event, const std::string& message = "") {
  if (message.empty()) {
    std::fprintf(stderr, "{\"event\":\"%s\"}\n", event);
  } else {
    std::fprintf(stderr, "{\"event\":\"%s\",\"message\":\"%s\"}\n", event, message.c_str());
  }
  std::fflush(stderr);
}

static void LogFormat(uint32_t width, uint32_t height, uint32_t fps) {
  std::fprintf(stderr,
               "{\"event\":\"format\",\"width\":%u,\"height\":%u,\"fps\":%u,\"pixelFormat\":\"nv12\"}\n",
               width, height, fps);
  std::fflush(stderr);
}

static void RegisterMmcssCaptureThread() {
  static thread_local bool registered = false;
  if (registered) return;
  DWORD taskIndex = 0;
  if (AvSetMmThreadCharacteristicsW(L"Capture", &taskIndex)) {
    registered = true;
    return;
  }
  LogEvent("log", "AvSetMmThreadCharacteristicsW failed.");
}

static bool ParseJsonUintField(const std::string& line, const char* key, uint32_t* out) {
  const std::string needle = std::string("\"") + key + "\":";
  const size_t pos = line.find(needle);
  if (pos == std::string::npos) return false;
  size_t index = pos + needle.size();
  while (index < line.size() && (line[index] == ' ' || line[index] == '\t')) index++;
  char* end = nullptr;
  const unsigned long parsed = std::strtoul(line.c_str() + index, &end, 10);
  if (end == line.c_str() + index) return false;
  *out = static_cast<uint32_t>(parsed);
  return true;
}

struct FrameSize {
  uint32_t width = 0;
  uint32_t height = 0;
};

static uint32_t MakeEvenDimension(uint32_t value) {
  if (value < 2) return 0;
  return value & ~1u;
}

static FrameSize ComputeOutputSize(uint32_t width, uint32_t height, uint32_t maxHeight) {
  if (width == 0 || height == 0 || maxHeight < 2 || height <= maxHeight) {
    return {width, height};
  }

  const uint32_t outputHeight = MakeEvenDimension(std::min(height, maxHeight));
  if (outputHeight == 0) return {width, height};

  const uint64_t roundedWidth = (static_cast<uint64_t>(width) * outputHeight + height / 2) / height;
  const uint32_t outputWidth = MakeEvenDimension(static_cast<uint32_t>(std::max<uint64_t>(2, roundedWidth)));
  if (outputWidth == 0) return {width, height};
  return {outputWidth, outputHeight};
}

static void Fail(const char* message, HRESULT hr = S_OK) {
  char buffer[320];
  if (hr != S_OK) {
    std::snprintf(buffer, sizeof(buffer), "%s HRESULT=0x%08lx", message, static_cast<unsigned long>(hr));
    LogEvent("error", buffer);
  } else {
    LogEvent("error", message);
  }
}

struct CaptureTarget {
  bool isWindow = false;
  HWND window = nullptr;
  HMONITOR monitor = nullptr;
  RECT monitorRect = {};
};

static bool ParseSourceArg(const std::wstring& value, bool* isWindow, uint64_t* id) {
  const std::wstring screenPrefix = L"screen:";
  const std::wstring windowPrefix = L"window:";
  std::wstring rest;
  if (value.compare(0, screenPrefix.size(), screenPrefix) == 0) {
    *isWindow = false;
    rest = value.substr(screenPrefix.size());
  } else if (value.compare(0, windowPrefix.size(), windowPrefix) == 0) {
    *isWindow = true;
    rest = value.substr(windowPrefix.size());
  } else {
    return false;
  }

  // Electron/Chromium source ids look like "screen:0:0" / "window:198452:0";
  // the first numeric component is the WebRTC SourceId (display device index
  // for screens, HWND value for windows).
  wchar_t* end = nullptr;
  const uint64_t parsed = wcstoull(rest.c_str(), &end, 10);
  if (end == rest.c_str()) return false;
  *id = parsed;
  return true;
}

struct MonitorSearch {
  std::wstring deviceName;
  HMONITOR found = nullptr;
  RECT rect = {};
};

static BOOL CALLBACK FindMonitorByDeviceName(HMONITOR monitor, HDC, LPRECT, LPARAM context) {
  auto* search = reinterpret_cast<MonitorSearch*>(context);
  MONITORINFOEXW info = {};
  info.cbSize = sizeof(info);
  if (GetMonitorInfoW(monitor, &info) && search->deviceName == info.szDevice) {
    search->found = monitor;
    search->rect = info.rcMonitor;
    return FALSE;
  }
  return TRUE;
}

// WebRTC screen SourceIds are indexes into the EnumDisplayDevices order
// (counting active outputs only is not needed: webrtc uses the raw device
// index and skips inactive entries, so an inactive index never reaches us).
static bool ResolveScreenTarget(uint64_t screenIndex, CaptureTarget* target) {
  DISPLAY_DEVICEW device = {};
  device.cb = sizeof(device);
  if (!EnumDisplayDevicesW(nullptr, static_cast<DWORD>(screenIndex), &device, 0)) {
    return false;
  }
  if (!(device.StateFlags & DISPLAY_DEVICE_ACTIVE)) {
    return false;
  }

  MonitorSearch search;
  search.deviceName = device.DeviceName;
  EnumDisplayMonitors(nullptr, nullptr, FindMonitorByDeviceName, reinterpret_cast<LPARAM>(&search));
  if (!search.found) return false;

  target->isWindow = false;
  target->monitor = search.found;
  target->monitorRect = search.rect;
  return true;
}

static bool ResolveWindowTarget(uint64_t hwndValue, CaptureTarget* target) {
  HWND hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(hwndValue));
  if (!IsWindow(hwnd)) return false;
  target->isWindow = true;
  target->window = hwnd;
  return true;
}

// The WGC window item shows the DWM extended frame bounds (window without the
// drop shadow), so cursor coordinates are translated against that rect.
static bool GetWindowContentOrigin(HWND hwnd, POINT* origin) {
  RECT bounds = {};
  if (SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &bounds, sizeof(bounds)))) {
    origin->x = bounds.left;
    origin->y = bounds.top;
    return true;
  }
  RECT rect = {};
  if (!GetWindowRect(hwnd, &rect)) return false;
  origin->x = rect.left;
  origin->y = rect.top;
  return true;
}

class FrameWriter {
 public:
  void Initialize(ID3D11Device* device, ID3D11DeviceContext* context) {
    d3dDevice_ = device;
    d3dContext_ = context;
    videoDevice_ = nullptr;
    videoContext_ = nullptr;
    if (d3dDevice_) {
      d3dDevice_->QueryInterface(__uuidof(ID3D11VideoDevice), videoDevice_.put_void());
    }
    if (d3dContext_) {
      d3dContext_->QueryInterface(__uuidof(ID3D11VideoContext), videoContext_.put_void());
    }
  }

  // Composites the cursor on a GPU BGRA texture, converts that texture to NV12
  // with the D3D11 video processor, and streams the mapped NV12 payload. Returns
  // false when stdout is gone (parent exited) so the capture loop can stop.
  bool WriteFrame(ID3D11Texture2D* source,
                  uint32_t width,
                  uint32_t height,
                  const POINT& contentOrigin,
                  uint32_t maxHeight) {
    if (!source || !d3dDevice_ || !d3dContext_ || width == 0 || height == 0) return true;
    if (!EnsureBgraResources(width, height)) return true;
    const FrameSize outputSize = ComputeOutputSize(width, height, maxHeight);

    D3D11_BOX sourceBox = {};
    sourceBox.right = width;
    sourceBox.bottom = height;
    sourceBox.back = 1;
    d3dContext_->CopySubresourceRegion(bgraTexture_.get(), 0, 0, 0, 0, source, 0, &sourceBox);

    const bool cursorDrawn = DrawCursor(contentOrigin);
    if ((outputSize.width % 2) == 0 && (outputSize.height % 2) == 0
        && EnsureVideoProcessor(width, height, outputSize.width, outputSize.height)) {
      if (inputMode_ == VideoProcessorInputMode::kCopied) {
        d3dContext_->CopyResource(processorInputTexture_.get(), bgraTexture_.get());
      }
      WriteStatus status = TryWriteGpuNv12(outputSize.width, outputSize.height, cursorDrawn);
      if (status == WriteStatus::kFailedBeforeWrite && inputMode_ == VideoProcessorInputMode::kDirect) {
        DisableDirectVideoProcessorInputForSize(width, height);
        if (EnsureVideoProcessor(width, height, outputSize.width, outputSize.height)) {
          d3dContext_->CopyResource(processorInputTexture_.get(), bgraTexture_.get());
          status = TryWriteGpuNv12(outputSize.width, outputSize.height, cursorDrawn);
        }
      }
      if (status == WriteStatus::kWrote) return true;
      if (status == WriteStatus::kPipeClosed) return false;
      DisableVideoProcessorForSize(width, height, outputSize.width, outputSize.height);
      if (!gpuFallbackLogged_) {
        LogEvent("warning", "GPU NV12 conversion failed; falling back to full-resolution BGRX frames.");
        gpuFallbackLogged_ = true;
      }
    }

    return WriteBgrxFrame(width, height, cursorDrawn);
  }

  ~FrameWriter() { Reset(); }

 private:
  enum class WriteStatus {
    kWrote,
    kFailedBeforeWrite,
    kPipeClosed
  };

  enum class VideoProcessorInputMode {
    kNone,
    kDirect,
    kCopied
  };

  static bool WriteFrameHeader(uint32_t width, uint32_t height, uint32_t flags) {
    uint8_t header[24];
    const uint32_t magic = 0x31465256;  // 'VRF1'
    const int64_t timestampMs = static_cast<int64_t>(GetTickCount64());
    std::memcpy(header, &magic, 4);
    std::memcpy(header + 4, &width, 4);
    std::memcpy(header + 8, &height, 4);
    std::memcpy(header + 12, &flags, 4);
    std::memcpy(header + 16, &timestampMs, 8);

    return std::fwrite(header, 1, sizeof(header), stdout) == sizeof(header);
  }

  bool DrawCursor(const POINT& contentOrigin) {
    CURSORINFO info = {};
    info.cbSize = sizeof(info);
    if (!GetCursorInfo(&info)) return false;

    // This check is the whole point of the helper: CURSOR_SHOWING is cleared
    // when an app hides the cursor (games, fullscreen video players), and
    // CURSOR_SUPPRESSED is set for touch/pen input. Draw only a truly visible
    // cursor — unlike WGC's OS compositing and WebRTC's IDC_ARROW fallback.
    if (!(info.flags & CURSOR_SHOWING) || (info.flags & CURSOR_SUPPRESSED)) return false;
    if (!info.hCursor) return false;

    if (!EnsureCursorMetrics(info.hCursor)) return false;
    const int x = static_cast<int>(info.ptScreenPos.x - contentOrigin.x - cursorHotspotX_);
    const int y = static_cast<int>(info.ptScreenPos.y - contentOrigin.y - cursorHotspotY_);
    if (x >= static_cast<int>(width_) || y >= static_cast<int>(height_)
        || x + cursorWidth_ <= 0 || y + cursorHeight_ <= 0) {
      return false;
    }

    if (!cursorSurface_) return false;

    HDC dc = nullptr;
    d3dContext_->Flush();
    if (FAILED(cursorSurface_->GetDC(FALSE, &dc))) return false;

    // DrawIconEx on the GDI-compatible D3D surface handles masked and XOR
    // (inverting I-beam) cursors. Animated cursors render their first frame.
    const BOOL drawn = DrawIconEx(dc, x, y, info.hCursor, 0, 0, 0, nullptr, DI_NORMAL);
    GdiFlush();
    const HRESULT releaseHr = cursorSurface_->ReleaseDC(nullptr);
    return drawn != FALSE && SUCCEEDED(releaseHr);
  }

  bool EnsureCursorMetrics(HCURSOR cursor) {
    if (cursor == cachedCursor_ && cursorWidth_ > 0 && cursorHeight_ > 0) return true;

    ICONINFO iconInfo = {};
    if (!GetIconInfo(cursor, &iconInfo)) return false;

    BITMAP bitmap = {};
    HBITMAP sizeBitmap = iconInfo.hbmColor ? iconInfo.hbmColor : iconInfo.hbmMask;
    const bool hasBitmap = sizeBitmap
        && GetObject(sizeBitmap, sizeof(bitmap), &bitmap) == sizeof(bitmap)
        && bitmap.bmWidth > 0 && bitmap.bmHeight > 0;

    cachedCursor_ = nullptr;
    cursorHotspotX_ = 0;
    cursorHotspotY_ = 0;
    cursorWidth_ = 0;
    cursorHeight_ = 0;

    if (hasBitmap) {
      cachedCursor_ = cursor;
      cursorHotspotX_ = static_cast<int>(iconInfo.xHotspot);
      cursorHotspotY_ = static_cast<int>(iconInfo.yHotspot);
      cursorWidth_ = bitmap.bmWidth;
      cursorHeight_ = iconInfo.hbmColor ? bitmap.bmHeight : bitmap.bmHeight / 2;
    }

    if (iconInfo.hbmMask) DeleteObject(iconInfo.hbmMask);
    if (iconInfo.hbmColor) DeleteObject(iconInfo.hbmColor);
    return cachedCursor_ == cursor && cursorWidth_ > 0 && cursorHeight_ > 0;
  }

  bool EnsureBgraResources(uint32_t width, uint32_t height) {
    if (width == width_ && height == height_ && bgraTexture_ && bgraStagingTexture_) return true;
    Reset();
    videoProcessorUnavailable_ = false;
    unavailableVideoInputWidth_ = 0;
    unavailableVideoInputHeight_ = 0;
    unavailableVideoOutputWidth_ = 0;
    unavailableVideoOutputHeight_ = 0;

    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = width;
    desc.Height = height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_RENDER_TARGET;
    desc.MiscFlags = D3D11_RESOURCE_MISC_GDI_COMPATIBLE;
    HRESULT hr = d3dDevice_->CreateTexture2D(&desc, nullptr, bgraTexture_.put());
    if (FAILED(hr)) {
      Reset();
      return false;
    }
    hr = bgraTexture_->QueryInterface(__uuidof(IDXGISurface1), cursorSurface_.put_void());
    if (FAILED(hr)) {
      Reset();
      return false;
    }

    desc.Usage = D3D11_USAGE_STAGING;
    desc.BindFlags = 0;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    desc.MiscFlags = 0;
    hr = d3dDevice_->CreateTexture2D(&desc, nullptr, bgraStagingTexture_.put());
    if (FAILED(hr)) {
      Reset();
      return false;
    }

    width_ = width;
    height_ = height;
    return true;
  }

  bool EnsureVideoProcessor(uint32_t inputWidth,
                            uint32_t inputHeight,
                            uint32_t outputWidth,
                            uint32_t outputHeight) {
    if (!videoDevice_ || !videoContext_) return false;
    if (videoProcessorUnavailable_
        && unavailableVideoInputWidth_ == inputWidth
        && unavailableVideoInputHeight_ == inputHeight
        && unavailableVideoOutputWidth_ == outputWidth
        && unavailableVideoOutputHeight_ == outputHeight) {
      return false;
    }
    if (HasVideoProcessorResources(inputWidth, inputHeight, outputWidth, outputHeight)) {
      return true;
    }
    ResetVideoResources();

    D3D11_VIDEO_PROCESSOR_CONTENT_DESC content = {};
    content.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
    content.InputFrameRate.Numerator = 30;
    content.InputFrameRate.Denominator = 1;
    content.InputWidth = inputWidth;
    content.InputHeight = inputHeight;
    content.OutputFrameRate.Numerator = 30;
    content.OutputFrameRate.Denominator = 1;
    content.OutputWidth = outputWidth;
    content.OutputHeight = outputHeight;
    content.Usage = D3D11_VIDEO_USAGE_PLAYBACK_NORMAL;

    HRESULT hr = videoDevice_->CreateVideoProcessorEnumerator(&content, enumerator_.put());
    if (FAILED(hr)) return DisableVideoProcessorForSize(inputWidth, inputHeight, outputWidth, outputHeight);

    UINT bgraSupport = 0;
    UINT nv12Support = 0;
    hr = enumerator_->CheckVideoProcessorFormat(DXGI_FORMAT_B8G8R8A8_UNORM, &bgraSupport);
    if (FAILED(hr) || !(bgraSupport & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT)) {
      return DisableVideoProcessorForSize(inputWidth, inputHeight, outputWidth, outputHeight);
    }
    hr = enumerator_->CheckVideoProcessorFormat(DXGI_FORMAT_NV12, &nv12Support);
    if (FAILED(hr) || !(nv12Support & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT)) {
      return DisableVideoProcessorForSize(inputWidth, inputHeight, outputWidth, outputHeight);
    }

    hr = videoDevice_->CreateVideoProcessor(enumerator_.get(), 0, videoProcessor_.put());
    if (FAILED(hr)) return DisableVideoProcessorForSize(inputWidth, inputHeight, outputWidth, outputHeight);

    if (!EnsureVideoProcessorInput(inputWidth, inputHeight)) {
      return DisableVideoProcessorForSize(inputWidth, inputHeight, outputWidth, outputHeight);
    }

    D3D11_TEXTURE2D_DESC nv12Desc = {};
    nv12Desc.Width = outputWidth;
    nv12Desc.Height = outputHeight;
    nv12Desc.MipLevels = 1;
    nv12Desc.ArraySize = 1;
    nv12Desc.Format = DXGI_FORMAT_NV12;
    nv12Desc.SampleDesc.Count = 1;
    nv12Desc.Usage = D3D11_USAGE_DEFAULT;
    nv12Desc.BindFlags = D3D11_BIND_RENDER_TARGET;
    hr = d3dDevice_->CreateTexture2D(&nv12Desc, nullptr, nv12Texture_.put());
    if (FAILED(hr)) return DisableVideoProcessorForSize(inputWidth, inputHeight, outputWidth, outputHeight);

    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC outputViewDesc = {};
    outputViewDesc.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;
    hr = videoDevice_->CreateVideoProcessorOutputView(
        nv12Texture_.get(), enumerator_.get(), &outputViewDesc, outputView_.put());
    if (FAILED(hr)) return DisableVideoProcessorForSize(inputWidth, inputHeight, outputWidth, outputHeight);

    nv12Desc.Usage = D3D11_USAGE_STAGING;
    nv12Desc.BindFlags = 0;
    nv12Desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    hr = d3dDevice_->CreateTexture2D(&nv12Desc, nullptr, nv12StagingTexture_.put());
    if (FAILED(hr)) return DisableVideoProcessorForSize(inputWidth, inputHeight, outputWidth, outputHeight);

    RECT sourceRect = {};
    sourceRect.right = static_cast<LONG>(inputWidth);
    sourceRect.bottom = static_cast<LONG>(inputHeight);
    RECT outputRect = {};
    outputRect.right = static_cast<LONG>(outputWidth);
    outputRect.bottom = static_cast<LONG>(outputHeight);
    videoContext_->VideoProcessorSetStreamFrameFormat(videoProcessor_.get(), 0,
                                                       D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
    videoContext_->VideoProcessorSetStreamAutoProcessingMode(videoProcessor_.get(), 0, FALSE);
    videoContext_->VideoProcessorSetStreamSourceRect(videoProcessor_.get(), 0, TRUE, &sourceRect);
    videoContext_->VideoProcessorSetStreamDestRect(videoProcessor_.get(), 0, TRUE, &outputRect);
    videoContext_->VideoProcessorSetOutputTargetRect(videoProcessor_.get(), TRUE, &outputRect);

    // Without an explicit color space the driver is free to pick its own
    // default (commonly BT.601) for the RGB->NV12 conversion, while the
    // renderer always tags the resulting VideoFrame as BT.709 limited range
    // (see native-capture.js). Force both ends to agree so colors don't shift.
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE inputColorSpace = {};
    inputColorSpace.Usage = 0;              // 0 = playback
    inputColorSpace.RGB_Range = 0;          // bgraTexture_ is full-range 0-255 RGB
    inputColorSpace.YCbCr_Matrix = 1;       // 1 = BT.709 (no effect on RGB input)
    inputColorSpace.YCbCr_xvYCC = 0;
    inputColorSpace.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_0_255;
    videoContext_->VideoProcessorSetStreamColorSpace(videoProcessor_.get(), 0, &inputColorSpace);

    D3D11_VIDEO_PROCESSOR_COLOR_SPACE outputColorSpace = {};
    outputColorSpace.Usage = 0;
    outputColorSpace.RGB_Range = 1;         // studio range output
    outputColorSpace.YCbCr_Matrix = 1;      // BT.709, matches the JS-side tag
    outputColorSpace.YCbCr_xvYCC = 0;
    outputColorSpace.Nominal_Range = D3D11_VIDEO_PROCESSOR_NOMINAL_RANGE_16_235;
    videoContext_->VideoProcessorSetOutputColorSpace(videoProcessor_.get(), &outputColorSpace);

    videoInputWidth_ = inputWidth;
    videoInputHeight_ = inputHeight;
    videoOutputWidth_ = outputWidth;
    videoOutputHeight_ = outputHeight;
    return true;
  }

  bool HasVideoProcessorResources(uint32_t inputWidth,
                                  uint32_t inputHeight,
                                  uint32_t outputWidth,
                                  uint32_t outputHeight) const {
    if (videoInputWidth_ != inputWidth || videoInputHeight_ != inputHeight) return false;
    if (videoOutputWidth_ != outputWidth || videoOutputHeight_ != outputHeight) return false;
    if (!videoProcessor_ || !inputView_ || !outputView_ || !nv12Texture_ || !nv12StagingTexture_) return false;
    if (inputMode_ == VideoProcessorInputMode::kDirect) return true;
    return inputMode_ == VideoProcessorInputMode::kCopied && processorInputTexture_;
  }

  bool EnsureVideoProcessorInput(uint32_t width, uint32_t height) {
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC inputViewDesc = {};
    inputViewDesc.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;

    if (!(directInputUnavailable_ && directInputUnavailableWidth_ == width && directInputUnavailableHeight_ == height)) {
      HRESULT hr = videoDevice_->CreateVideoProcessorInputView(
          bgraTexture_.get(), enumerator_.get(), &inputViewDesc, inputView_.put());
      if (SUCCEEDED(hr)) {
        inputMode_ = VideoProcessorInputMode::kDirect;
        return true;
      }
      MarkDirectVideoProcessorInputUnavailable(width, height);
    }

    D3D11_TEXTURE2D_DESC inputDesc = {};
    inputDesc.Width = width;
    inputDesc.Height = height;
    inputDesc.MipLevels = 1;
    inputDesc.ArraySize = 1;
    inputDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    inputDesc.SampleDesc.Count = 1;
    inputDesc.Usage = D3D11_USAGE_DEFAULT;
    inputDesc.BindFlags = D3D11_BIND_RENDER_TARGET;
    HRESULT hr = d3dDevice_->CreateTexture2D(&inputDesc, nullptr, processorInputTexture_.put());
    if (FAILED(hr)) return false;

    hr = videoDevice_->CreateVideoProcessorInputView(
        processorInputTexture_.get(), enumerator_.get(), &inputViewDesc, inputView_.put());
    if (FAILED(hr)) return false;

    inputMode_ = VideoProcessorInputMode::kCopied;
    return true;
  }

  void MarkDirectVideoProcessorInputUnavailable(uint32_t width, uint32_t height) {
    directInputUnavailable_ = true;
    directInputUnavailableWidth_ = width;
    directInputUnavailableHeight_ = height;
    if (!directInputFallbackLogged_) {
      LogEvent("log", "Direct GPU NV12 input failed; falling back to copied input.");
      directInputFallbackLogged_ = true;
    }
  }

  void DisableDirectVideoProcessorInputForSize(uint32_t width, uint32_t height) {
    ResetVideoResources();
    MarkDirectVideoProcessorInputUnavailable(width, height);
  }

  bool DisableVideoProcessorForSize(uint32_t inputWidth,
                                    uint32_t inputHeight,
                                    uint32_t outputWidth,
                                    uint32_t outputHeight) {
    ResetVideoResources();
    videoProcessorUnavailable_ = true;
    unavailableVideoInputWidth_ = inputWidth;
    unavailableVideoInputHeight_ = inputHeight;
    unavailableVideoOutputWidth_ = outputWidth;
    unavailableVideoOutputHeight_ = outputHeight;
    return false;
  }

  WriteStatus TryWriteGpuNv12(uint32_t width, uint32_t height, bool cursorDrawn) {
    D3D11_VIDEO_PROCESSOR_STREAM stream = {};
    stream.Enable = TRUE;
    stream.pInputSurface = inputView_.get();
    HRESULT hr = videoContext_->VideoProcessorBlt(videoProcessor_.get(), outputView_.get(), 0, 1, &stream);
    if (FAILED(hr)) return WriteStatus::kFailedBeforeWrite;

    d3dContext_->CopyResource(nv12StagingTexture_.get(), nv12Texture_.get());
    D3D11_MAPPED_SUBRESOURCE mapped = {};
    hr = d3dContext_->Map(nv12StagingTexture_.get(), 0, D3D11_MAP_READ, 0, &mapped);
    if (FAILED(hr)) return WriteStatus::kFailedBeforeWrite;

    const uint32_t flags = (cursorDrawn ? kFrameFlagCursorDrawn : 0u) | kFrameFlagFormatNv12;
    bool ok = WriteFrameHeader(width, height, flags);
    const size_t yPlaneBytes = static_cast<size_t>(width) * height;
    const size_t payload = yPlaneBytes + yPlaneBytes / 2;
    if (ok && mapped.RowPitch == width) {
      ok = std::fwrite(mapped.pData, 1, payload, stdout) == payload;
    } else if (ok) {
      PackNv12(mapped, width, height);
      ok = std::fwrite(nv12_.data(), 1, nv12_.size(), stdout) == nv12_.size();
    }
    d3dContext_->Unmap(nv12StagingTexture_.get(), 0);
    if (!ok) return WriteStatus::kPipeClosed;
    std::fflush(stdout);
    return WriteStatus::kWrote;
  }

  void PackNv12(const D3D11_MAPPED_SUBRESOURCE& mapped, uint32_t width, uint32_t height) {
    const size_t yPlaneBytes = static_cast<size_t>(width) * height;
    nv12_.resize(yPlaneBytes + yPlaneBytes / 2);

    const auto* source = static_cast<const uint8_t*>(mapped.pData);
    for (uint32_t row = 0; row < height; ++row) {
      std::memcpy(nv12_.data() + static_cast<size_t>(row) * width,
                  source + static_cast<size_t>(row) * mapped.RowPitch,
                  width);
    }

    const uint8_t* sourceUv = source + static_cast<size_t>(mapped.RowPitch) * height;
    uint8_t* destinationUv = nv12_.data() + yPlaneBytes;
    for (uint32_t row = 0; row < height / 2; ++row) {
      std::memcpy(destinationUv + static_cast<size_t>(row) * width,
                  sourceUv + static_cast<size_t>(row) * mapped.RowPitch,
                  width);
    }
  }

  bool WriteBgrxFrame(uint32_t width, uint32_t height, bool cursorDrawn) {
    d3dContext_->CopyResource(bgraStagingTexture_.get(), bgraTexture_.get());
    D3D11_MAPPED_SUBRESOURCE mapped = {};
    if (FAILED(d3dContext_->Map(bgraStagingTexture_.get(), 0, D3D11_MAP_READ, 0, &mapped))) {
      return true;
    }

    const uint32_t flags = cursorDrawn ? kFrameFlagCursorDrawn : 0u;
    bool ok = WriteFrameHeader(width, height, flags);
    const size_t rowBytes = static_cast<size_t>(width) * 4;
    if (ok) {
      if (mapped.RowPitch == rowBytes) {
        const size_t payload = rowBytes * height;
        ok = std::fwrite(mapped.pData, 1, payload, stdout) == payload;
      } else {
        const auto* source = static_cast<const uint8_t*>(mapped.pData);
        for (uint32_t row = 0; ok && row < height; ++row) {
          ok = std::fwrite(source + static_cast<size_t>(row) * mapped.RowPitch, 1, rowBytes, stdout) == rowBytes;
        }
      }
    }
    d3dContext_->Unmap(bgraStagingTexture_.get(), 0);
    if (ok) std::fflush(stdout);
    return ok;
  }

  void ResetVideoResources() {
    inputView_ = nullptr;
    outputView_ = nullptr;
    videoProcessor_ = nullptr;
    enumerator_ = nullptr;
    processorInputTexture_ = nullptr;
    nv12Texture_ = nullptr;
    nv12StagingTexture_ = nullptr;
    inputMode_ = VideoProcessorInputMode::kNone;
    videoInputWidth_ = 0;
    videoInputHeight_ = 0;
    videoOutputWidth_ = 0;
    videoOutputHeight_ = 0;
  }

  void Reset() {
    ResetVideoResources();
    cursorSurface_ = nullptr;
    bgraTexture_ = nullptr;
    bgraStagingTexture_ = nullptr;
    directInputUnavailable_ = false;
    directInputUnavailableWidth_ = 0;
    directInputUnavailableHeight_ = 0;
    width_ = 0;
    height_ = 0;
  }

  ID3D11Device* d3dDevice_ = nullptr;
  ID3D11DeviceContext* d3dContext_ = nullptr;
  winrt::com_ptr<ID3D11VideoDevice> videoDevice_;
  winrt::com_ptr<ID3D11VideoContext> videoContext_;
  winrt::com_ptr<IDXGISurface1> cursorSurface_;
  winrt::com_ptr<ID3D11Texture2D> bgraTexture_;
  winrt::com_ptr<ID3D11Texture2D> bgraStagingTexture_;
  winrt::com_ptr<ID3D11Texture2D> processorInputTexture_;
  winrt::com_ptr<ID3D11Texture2D> nv12Texture_;
  winrt::com_ptr<ID3D11Texture2D> nv12StagingTexture_;
  winrt::com_ptr<ID3D11VideoProcessorEnumerator> enumerator_;
  winrt::com_ptr<ID3D11VideoProcessor> videoProcessor_;
  winrt::com_ptr<ID3D11VideoProcessorInputView> inputView_;
  winrt::com_ptr<ID3D11VideoProcessorOutputView> outputView_;
  std::vector<uint8_t> nv12_;
  HCURSOR cachedCursor_ = nullptr;
  int cursorHotspotX_ = 0;
  int cursorHotspotY_ = 0;
  int cursorWidth_ = 0;
  int cursorHeight_ = 0;
  uint32_t width_ = 0;
  uint32_t height_ = 0;
  uint32_t videoInputWidth_ = 0;
  uint32_t videoInputHeight_ = 0;
  uint32_t videoOutputWidth_ = 0;
  uint32_t videoOutputHeight_ = 0;
  VideoProcessorInputMode inputMode_ = VideoProcessorInputMode::kNone;
  bool gpuFallbackLogged_ = false;
  bool directInputFallbackLogged_ = false;
  bool videoProcessorUnavailable_ = false;
  uint32_t unavailableVideoInputWidth_ = 0;
  uint32_t unavailableVideoInputHeight_ = 0;
  uint32_t unavailableVideoOutputWidth_ = 0;
  uint32_t unavailableVideoOutputHeight_ = 0;
  bool directInputUnavailable_ = false;
  uint32_t directInputUnavailableWidth_ = 0;
  uint32_t directInputUnavailableHeight_ = 0;
};

class CaptureSession {
 public:
  bool Start(const CaptureTarget& target, uint32_t fps, uint32_t maxHeight) {
    target_ = target;
    fps_.store(fps == 0 ? 30 : fps);
    maxHeight_.store(maxHeight);
    minFrameIntervalQpc_.store(0);
    lastSourceWidth_.store(0);
    lastSourceHeight_.store(0);

    LARGE_INTEGER frequency = {};
    if (QueryPerformanceFrequency(&frequency)) {
      minFrameIntervalQpc_.store(frequency.QuadPart / fps_.load());
    }

    // Screens use DXGI Desktop Duplication, windows use WGC. Duplication is the
    // only backend that does not paint the OS capture border (WGC draws a yellow
    // frame that cannot be removed on Windows 10, where IsBorderRequired does
    // not exist). It also hands us the desktop image *without* the cursor, so
    // FrameWriter::DrawCursor keeps compositing a cursor that honours
    // CURSOR_SHOWING — same correct hiding behaviour as the WGC path.
    return target_.isWindow ? StartWindowCapture() : StartScreenCapture();
  }

  bool IsUnsupported() const { return unsupported_; }

  void ApplyReconfigure(uint32_t fps, uint32_t maxHeight) {
    if (fps >= 1 && fps <= 60) {
      fps_.store(fps);
      LARGE_INTEGER frequency = {};
      if (QueryPerformanceFrequency(&frequency)) {
        minFrameIntervalQpc_.store(frequency.QuadPart / fps);
      }
    }
    if (maxHeight >= 1 && maxHeight <= 16384) {
      maxHeight_.store(maxHeight);
    }

    const uint32_t sourceWidth = lastSourceWidth_.load();
    const uint32_t sourceHeight = lastSourceHeight_.load();
    if (sourceWidth > 0 && sourceHeight > 0) {
      const FrameSize outputSize = ComputeOutputSize(sourceWidth, sourceHeight, maxHeight_.load());
      LogFormat(outputSize.width, outputSize.height, fps_.load());
    }
  }

  void Stop() {
    // Desktop Duplication path: signal already set via g_running; join the loop.
    if (duplicationThread_.joinable()) duplicationThread_.join();
    duplication_ = nullptr;

    // WGC path.
    frameArrivedRevoker_.revoke();
    closedRevoker_.revoke();
    if (session_) session_.Close();
    if (framePool_) framePool_.Close();
    session_ = nullptr;
    framePool_ = nullptr;
    item_ = nullptr;
  }

 private:
  bool CreateDevice(IDXGIAdapter* adapter) {
    // A specific adapter (Desktop Duplication needs the device on the output's
    // adapter) must use DRIVER_TYPE_UNKNOWN; the default-adapter path keeps the
    // hardware-then-WARP fallback the WGC backend relied on.
    const D3D_DRIVER_TYPE driverType = adapter ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE;
    HRESULT hr = D3D11CreateDevice(adapter, driverType, nullptr,
                                   D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                                   D3D11_SDK_VERSION, d3dDevice_.put(), nullptr, nullptr);
    if (FAILED(hr) && !adapter) {
      hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr,
                             D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                             D3D11_SDK_VERSION, d3dDevice_.put(), nullptr, nullptr);
    }
    if (FAILED(hr)) {
      Fail("D3D11CreateDevice failed.", hr);
      return false;
    }
    d3dDevice_->GetImmediateContext(d3dContext_.put());
    writer_.Initialize(d3dDevice_.get(), d3dContext_.get());
    return true;
  }

  bool StartScreenCapture() {
    winrt::com_ptr<IDXGIFactory1> factory;
    HRESULT hr = CreateDXGIFactory1(__uuidof(IDXGIFactory1), factory.put_void());
    if (FAILED(hr)) {
      Fail("CreateDXGIFactory1 failed.", hr);
      return false;
    }

    winrt::com_ptr<IDXGIAdapter1> adapter;
    winrt::com_ptr<IDXGIOutput> output;
    if (!FindMonitorOutput(factory.get(), adapter, output)) {
      Fail("Capture monitor output was not found.");
      return false;
    }

    if (!CreateDevice(adapter.get())) return false;

    auto output1 = output.try_as<IDXGIOutput1>();
    if (!output1) {
      Fail("IDXGIOutput1 is not available on this Windows build.");
      return false;
    }

    hr = output1->DuplicateOutput(d3dDevice_.get(), duplication_.put());
    if (FAILED(hr)) {
      Fail("DuplicateOutput failed.", hr);
      return false;
    }

    DXGI_OUTDUPL_DESC desc = {};
    duplication_->GetDesc(&desc);
    lastSourceWidth_.store(desc.ModeDesc.Width);
    lastSourceHeight_.store(desc.ModeDesc.Height);
    const FrameSize outputSize = ComputeOutputSize(desc.ModeDesc.Width, desc.ModeDesc.Height, maxHeight_.load());
    LogFormat(outputSize.width, outputSize.height, fps_.load());

    duplicationThread_ = std::thread([this]() { DuplicationLoop(); });
    return true;
  }

  bool StartWindowCapture() {
    if (!CreateDevice(nullptr)) return false;

    winrt::com_ptr<IDXGIDevice> dxgiDevice = d3dDevice_.as<IDXGIDevice>();
    winrt::com_ptr<IInspectable> inspectable;
    HRESULT hr = CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.get(), inspectable.put());
    if (FAILED(hr)) {
      Fail("CreateDirect3D11DeviceFromDXGIDevice failed.", hr);
      return false;
    }
    device_ = inspectable.as<wgd3d::IDirect3DDevice>();

    auto interopFactory = winrt::get_activation_factory<wgc::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
    hr = interopFactory->CreateForWindow(target_.window, winrt::guid_of<wgc::GraphicsCaptureItem>(),
                                         winrt::put_abi(item_));
    if (FAILED(hr) || !item_) {
      Fail("GraphicsCaptureItem creation failed.", hr);
      return false;
    }

    contentSize_ = item_.Size();
    framePool_ = wgc::Direct3D11CaptureFramePool::CreateFreeThreaded(
        device_, wgd::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, contentSize_);
    session_ = framePool_.CreateCaptureSession(item_);

    // No OS cursor in the frames — we composite it ourselves. If this Windows
    // build predates the property (pre-2004), report unsupported so the app
    // falls back to the regular Chromium capture path.
    if (!winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
            L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsCursorCaptureEnabled")) {
      LogEvent("error", "IsCursorCaptureEnabled is not available on this Windows build.");
      unsupported_ = true;
      return false;
    }
    session_.IsCursorCaptureEnabled(false);

    TryDisableBorder();

    closedRevoker_ = item_.Closed(winrt::auto_revoke, [](auto&&, auto&&) {
      LogEvent("closed");
      g_running = false;
      if (g_stopEvent) SetEvent(g_stopEvent);
    });
    frameArrivedRevoker_ = framePool_.FrameArrived(
        winrt::auto_revoke,
        [this](wgc::Direct3D11CaptureFramePool const& pool, winrt::Windows::Foundation::IInspectable const&) {
          OnFrameArrived(pool);
        });

    lastSourceWidth_.store(static_cast<uint32_t>(contentSize_.Width));
    lastSourceHeight_.store(static_cast<uint32_t>(contentSize_.Height));
    const FrameSize outputSize = ComputeOutputSize(
        static_cast<uint32_t>(contentSize_.Width),
        static_cast<uint32_t>(contentSize_.Height),
        maxHeight_.load());
    LogFormat(outputSize.width, outputSize.height, fps_.load());
    session_.StartCapture();
    return true;
  }

  bool FindMonitorOutput(IDXGIFactory1* factory,
                         winrt::com_ptr<IDXGIAdapter1>& outAdapter,
                         winrt::com_ptr<IDXGIOutput>& outOutput) {
    for (UINT adapterIndex = 0;; ++adapterIndex) {
      winrt::com_ptr<IDXGIAdapter1> adapter;
      if (factory->EnumAdapters1(adapterIndex, adapter.put()) == DXGI_ERROR_NOT_FOUND) break;
      for (UINT outputIndex = 0;; ++outputIndex) {
        winrt::com_ptr<IDXGIOutput> output;
        if (adapter->EnumOutputs(outputIndex, output.put()) == DXGI_ERROR_NOT_FOUND) break;
        DXGI_OUTPUT_DESC outputDesc = {};
        if (SUCCEEDED(output->GetDesc(&outputDesc)) && outputDesc.Monitor == target_.monitor) {
          outAdapter = adapter;
          outOutput = output;
          return true;
        }
      }
    }
    return false;
  }

  bool RecreateDuplication() {
    duplication_ = nullptr;
    winrt::com_ptr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), factory.put_void()))) return false;
    winrt::com_ptr<IDXGIAdapter1> adapter;
    winrt::com_ptr<IDXGIOutput> output;
    if (!FindMonitorOutput(factory.get(), adapter, output)) return false;
    auto output1 = output.try_as<IDXGIOutput1>();
    if (!output1) return false;
    return SUCCEEDED(output1->DuplicateOutput(d3dDevice_.get(), duplication_.put()));
  }

  void DuplicationLoop() {
    RegisterMmcssCaptureThread();
    // Cursor coordinates are translated against the monitor origin, matching the
    // screen branch of the old WGC OnFrameArrived path.
    const POINT origin = {target_.monitorRect.left, target_.monitorRect.top};
    while (g_running) {
      DXGI_OUTDUPL_FRAME_INFO info = {};
      winrt::com_ptr<IDXGIResource> resource;
      HRESULT hr = duplication_->AcquireNextFrame(250, &info, resource.put());
      if (hr == DXGI_ERROR_WAIT_TIMEOUT) continue;
      if (hr == DXGI_ERROR_ACCESS_LOST) {
        // Resolution/mode change, UAC desktop switch, etc. Rebuild and retry.
        if (RecreateDuplication()) continue;
        break;
      }
      if (FAILED(hr)) {
        Fail("AcquireNextFrame failed.", hr);
        break;
      }

      const int64_t frameIntervalQpc = minFrameIntervalQpc_.load();
      bool emit = true;
      if (frameIntervalQpc > 0) {
        LARGE_INTEGER now = {};
        QueryPerformanceCounter(&now);
        if (lastFrameQpc_ != 0 && now.QuadPart - lastFrameQpc_ < frameIntervalQpc) {
          emit = false;
        } else {
          lastFrameQpc_ = now.QuadPart;
        }
      }

      bool pipeAlive = true;
      if (emit) {
        auto texture = resource.try_as<ID3D11Texture2D>();
        if (texture) {
          D3D11_TEXTURE2D_DESC desc = {};
          texture->GetDesc(&desc);
          lastSourceWidth_.store(desc.Width);
          lastSourceHeight_.store(desc.Height);
          pipeAlive = writer_.WriteFrame(texture.get(), desc.Width, desc.Height, origin, maxHeight_.load());
        }
      }

      duplication_->ReleaseFrame();

      if (!pipeAlive) {
        // stdout pipe is gone — the parent process exited.
        g_running = false;
        if (g_stopEvent) SetEvent(g_stopEvent);
        break;
      }
    }
  }

  void TryDisableBorder() {
    // Best-effort: the capture border toggle only exists on newer builds and
    // may require capture access. A visible border is cosmetic, never fatal.
    if (!winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
            L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsBorderRequired")) {
      return;
    }

    // Requesting borderless access throws/denies on unpackaged Win32 apps
    // (Electron has no MSIX identity). Keep it in its own try so a failure here
    // never skips the IsBorderRequired call below, which still removes the
    // border on Windows 11 builds prior to 24H2 without any granted access.
    try {
      wgc::GraphicsCaptureAccess::RequestAccessAsync(wgc::GraphicsCaptureAccessKind::Borderless).get();
    } catch (...) {
      LogEvent("log", "Borderless capture access request failed.");
    }

    try {
      session_.IsBorderRequired(false);
    } catch (...) {
      LogEvent("log", "Capture border could not be disabled.");
    }
  }

  void OnFrameArrived(wgc::Direct3D11CaptureFramePool const& pool) {
    RegisterMmcssCaptureThread();
    std::lock_guard<std::mutex> guard(frameMutex_);
    if (!g_running) return;

    auto frame = pool.TryGetNextFrame();
    if (!frame) return;

    const int64_t frameIntervalQpc = minFrameIntervalQpc_.load();
    if (frameIntervalQpc > 0) {
      LARGE_INTEGER now = {};
      QueryPerformanceCounter(&now);
      if (lastFrameQpc_ != 0 && now.QuadPart - lastFrameQpc_ < frameIntervalQpc) {
        return;
      }
      lastFrameQpc_ = now.QuadPart;
    }

    const auto frameSize = frame.ContentSize();
    if (frameSize.Width <= 0 || frameSize.Height <= 0) return;
    if (frameSize.Width != contentSize_.Width || frameSize.Height != contentSize_.Height) {
      contentSize_ = frameSize;
      pool.Recreate(device_, wgd::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, contentSize_);
      lastSourceWidth_.store(static_cast<uint32_t>(contentSize_.Width));
      lastSourceHeight_.store(static_cast<uint32_t>(contentSize_.Height));
      const FrameSize outputSize = ComputeOutputSize(
          static_cast<uint32_t>(contentSize_.Width),
          static_cast<uint32_t>(contentSize_.Height),
          maxHeight_.load());
      LogFormat(outputSize.width, outputSize.height, fps_.load());
      return;
    }

    winrt::com_ptr<ID3D11Texture2D> texture;
    {
      auto access = frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
      if (FAILED(access->GetInterface(winrt::guid_of<ID3D11Texture2D>(), texture.put_void()))) return;
    }

    D3D11_TEXTURE2D_DESC desc = {};
    texture->GetDesc(&desc);

    POINT contentOrigin = {};
    bool originKnown = true;
    if (target_.isWindow) {
      originKnown = GetWindowContentOrigin(target_.window, &contentOrigin);
    } else {
      contentOrigin.x = target_.monitorRect.left;
      contentOrigin.y = target_.monitorRect.top;
    }

    const uint32_t width = std::min<uint32_t>(desc.Width, static_cast<uint32_t>(contentSize_.Width));
    const uint32_t height = std::min<uint32_t>(desc.Height, static_cast<uint32_t>(contentSize_.Height));
    lastSourceWidth_.store(width);
    lastSourceHeight_.store(height);
    const bool ok = originKnown ? writer_.WriteFrame(texture.get(), width, height, contentOrigin, maxHeight_.load()) : true;

    if (!ok) {
      // stdout pipe is gone — the parent process exited.
      g_running = false;
      if (g_stopEvent) SetEvent(g_stopEvent);
    }
  }

  CaptureTarget target_;
  std::atomic<uint32_t> fps_{30};
  std::atomic<uint32_t> maxHeight_{1080};
  std::atomic<uint32_t> lastSourceWidth_{0};
  std::atomic<uint32_t> lastSourceHeight_{0};
  std::atomic<int64_t> minFrameIntervalQpc_{0};
  int64_t lastFrameQpc_ = 0;
  bool unsupported_ = false;

  winrt::com_ptr<ID3D11Device> d3dDevice_;
  winrt::com_ptr<ID3D11DeviceContext> d3dContext_;
  wgd3d::IDirect3DDevice device_{nullptr};
  wgc::GraphicsCaptureItem item_{nullptr};
  wgc::Direct3D11CaptureFramePool framePool_{nullptr};
  wgc::GraphicsCaptureSession session_{nullptr};
  winrt::Windows::Graphics::SizeInt32 contentSize_ = {};

  wgc::GraphicsCaptureItem::Closed_revoker closedRevoker_;
  wgc::Direct3D11CaptureFramePool::FrameArrived_revoker frameArrivedRevoker_;

  winrt::com_ptr<IDXGIOutputDuplication> duplication_;
  std::thread duplicationThread_;

  std::mutex frameMutex_;
  FrameWriter writer_;
};

static void StdinCommandLoop() {
  std::string line;
  while (g_running && std::getline(std::cin, line)) {
    if (line.find("reconfigure") == std::string::npos) continue;
    uint32_t fps = 0;
    uint32_t maxHeight = 0;
    const bool hasFps = ParseJsonUintField(line, "fps", &fps);
    const bool hasHeight = ParseJsonUintField(line, "maxHeight", &maxHeight);
    if (!hasFps && !hasHeight) continue;
    // Hold the lock across the call so wmain cannot clear the pointer and
    // destroy the session while ApplyReconfigure is running on it.
    std::lock_guard<std::mutex> guard(g_activeSessionMutex);
    CaptureSession* session = g_activeSession;
    if (!session) continue;
    session->ApplyReconfigure(hasFps ? fps : 0, hasHeight ? maxHeight : 0);
  }
}

static std::wstring ReadStringArg(int argc, wchar_t** argv, const wchar_t* name) {
  for (int index = 1; index + 1 < argc; ++index) {
    if (wcscmp(argv[index], name) == 0) return argv[index + 1];
  }
  return L"";
}

static uint32_t ReadUIntArg(int argc, wchar_t** argv, const wchar_t* name, uint32_t fallback) {
  const std::wstring value = ReadStringArg(argc, argv, name);
  if (value.empty()) return fallback;
  const unsigned long parsed = wcstoul(value.c_str(), nullptr, 10);
  return parsed > 0 ? static_cast<uint32_t>(parsed) : fallback;
}

int wmain(int argc, wchar_t** argv) {
  std::signal(SIGINT, HandleSignal);
  std::signal(SIGTERM, HandleSignal);
  std::signal(SIGBREAK, HandleSignal);

  // Physical pixels everywhere: WGC sizes, GetCursorInfo coordinates and
  // monitor rects must agree, otherwise the cursor lands at scaled positions.
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  SetPriorityClass(GetCurrentProcess(), ABOVE_NORMAL_PRIORITY_CLASS);
  _setmode(_fileno(stdout), _O_BINARY);
  winrt::init_apartment(winrt::apartment_type::multi_threaded);

  const std::wstring sourceArg = ReadStringArg(argc, argv, L"--source");
  const uint32_t fps = ReadUIntArg(argc, argv, L"--fps", 30);
  const uint32_t maxHeight = ReadUIntArg(argc, argv, L"--max-height", 1080);

  bool isWindow = false;
  uint64_t sourceValue = 0;
  if (sourceArg.empty() || !ParseSourceArg(sourceArg, &isWindow, &sourceValue)) {
    Fail("Usage: --source screen:<index>|window:<hwnd> [--fps 30] [--max-height 1080]");
    return 1;
  }

  // Window capture relies on WGC; screen capture uses DXGI Desktop Duplication
  // (supported since Windows 8) and does not need WGC at all.
  if (isWindow && !wgc::GraphicsCaptureSession::IsSupported()) {
    LogEvent("error", "Windows.Graphics.Capture is not supported on this Windows build.");
    return 2;
  }

  CaptureTarget target;
  const bool resolved = isWindow ? ResolveWindowTarget(sourceValue, &target)
                                 : ResolveScreenTarget(sourceValue, &target);
  if (!resolved) {
    Fail("Capture source was not found.");
    return 1;
  }

  g_stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!g_stopEvent) {
    Fail("CreateEvent failed.");
    return 1;
  }

  int exitCode = 0;
  {
    CaptureSession session;
    bool started = false;
    try {
      started = session.Start(target, fps, maxHeight);
    } catch (const winrt::hresult_error& error) {
      Fail("Capture session failed to start.", error.code());
    }

    if (!started) {
      exitCode = session.IsUnsupported() ? 2 : 1;
    } else {
      {
        std::lock_guard<std::mutex> guard(g_activeSessionMutex);
        g_activeSession = &session;
      }
      std::thread(StdinCommandLoop).detach();
      while (g_running) {
        WaitForSingleObject(g_stopEvent, 250);
      }
      {
        std::lock_guard<std::mutex> guard(g_activeSessionMutex);
        g_activeSession = nullptr;
      }
      session.Stop();
    }
  }

  LogEvent("exit");
  CloseHandle(g_stopEvent);
  g_stopEvent = nullptr;
  return exitCode;
}
