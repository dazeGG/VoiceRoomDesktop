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
// Protocol (mirrors SafeSystemAudioCapture):
//   stdout — binary frame stream: 24-byte header + top-down payload.
//            header: u32 magic 'VRF1', u32 width, u32 height, u32 flags
//            (bit0 = cursor drawn, bit1 = NV12 payload), i64 timestampMs.
//            NV12 is tightly packed Y plane + interleaved UV plane. Odd-sized
//            frames fall back to top-down BGRX with stride == width * 4.
//   stderr — one JSON event per line: format / log / error / closed / exit.
//   args   — --source screen:<index> | window:<hwnd>  [--fps 15|30|60]
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
#include <mutex>
#include <string>
#include <vector>

namespace wgc = winrt::Windows::Graphics::Capture;
namespace wgd = winrt::Windows::Graphics::DirectX;
namespace wgd3d = winrt::Windows::Graphics::DirectX::Direct3D11;

static std::atomic<bool> g_running{true};
static HANDLE g_stopEvent = nullptr;
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
  bool EnsureSize(uint32_t width, uint32_t height) {
    if (width == width_ && height == height_ && bitmap_) return true;
    Reset();

    BITMAPINFO info = {};
    info.bmiHeader.biSize = sizeof(info.bmiHeader);
    info.bmiHeader.biWidth = static_cast<LONG>(width);
    // Negative height makes the DIB top-down, matching both the WGC texture
    // layout and the BGRA byte order the renderer feeds into VideoFrame.
    info.bmiHeader.biHeight = -static_cast<LONG>(height);
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB;

    dc_ = CreateCompatibleDC(nullptr);
    if (!dc_) return false;
    bitmap_ = CreateDIBSection(dc_, &info, DIB_RGB_COLORS, &bits_, nullptr, 0);
    if (!bitmap_ || !bits_) {
      Reset();
      return false;
    }
    previousObject_ = SelectObject(dc_, bitmap_);
    width_ = width;
    height_ = height;
    return true;
  }

  // Copies the mapped GPU texture into the DIB, draws the cursor when the OS
  // reports it visible, and streams the result to stdout. Returns false when
  // stdout is gone (parent exited) so the capture loop can stop.
  bool WriteFrame(const uint8_t* source,
                  uint32_t sourceStride,
                  uint32_t width,
                  uint32_t height,
                  const POINT& contentOrigin) {
    if (!EnsureSize(width, height)) return true;

    const uint32_t rowBytes = width * 4;
    auto* destination = static_cast<uint8_t*>(bits_);
    for (uint32_t row = 0; row < height; ++row) {
      std::memcpy(destination + static_cast<size_t>(row) * rowBytes,
                  source + static_cast<size_t>(row) * sourceStride,
                  rowBytes);
    }

    const bool cursorDrawn = DrawCursor(contentOrigin);
    const bool useNv12 = (width % 2) == 0 && (height % 2) == 0;

    uint8_t header[24];
    const uint32_t magic = 0x31465256;  // 'VRF1'
    const uint32_t flags = (cursorDrawn ? kFrameFlagCursorDrawn : 0u)
        | (useNv12 ? kFrameFlagFormatNv12 : 0u);
    const int64_t timestampMs = static_cast<int64_t>(GetTickCount64());
    std::memcpy(header, &magic, 4);
    std::memcpy(header + 4, &width, 4);
    std::memcpy(header + 8, &height, 4);
    std::memcpy(header + 12, &flags, 4);
    std::memcpy(header + 16, &timestampMs, 8);

    if (std::fwrite(header, 1, sizeof(header), stdout) != sizeof(header)) return false;
    if (useNv12) {
      const size_t yPlaneBytes = static_cast<size_t>(width) * height;
      const size_t payload = yPlaneBytes + yPlaneBytes / 2;
      nv12_.resize(payload);
      ConvertBgraToNv12(destination, rowBytes, width, height, nv12_.data());
      if (std::fwrite(nv12_.data(), 1, payload, stdout) != payload) return false;
    } else {
      const size_t payload = static_cast<size_t>(rowBytes) * height;
      if (std::fwrite(bits_, 1, payload, stdout) != payload) return false;
    }
    std::fflush(stdout);
    return true;
  }

  ~FrameWriter() { Reset(); }

 private:
  static uint8_t ClampByte(int value) {
    if (value < 0) return 0;
    if (value > 255) return 255;
    return static_cast<uint8_t>(value);
  }

  static uint8_t LumaBt709(uint8_t r, uint8_t g, uint8_t b) {
    return ClampByte(16 + ((47 * r + 157 * g + 16 * b + 128) >> 8));
  }

  static int ChromaUBt709(uint8_t r, uint8_t g, uint8_t b) {
    return 128 + ((-26 * r - 87 * g + 112 * b + 128) >> 8);
  }

  static int ChromaVBt709(uint8_t r, uint8_t g, uint8_t b) {
    return 128 + ((112 * r - 102 * g - 10 * b + 128) >> 8);
  }

  static void ConvertBgraToNv12(const uint8_t* source,
                                uint32_t sourceStride,
                                uint32_t width,
                                uint32_t height,
                                uint8_t* destination) {
    uint8_t* yPlane = destination;
    uint8_t* uvPlane = destination + static_cast<size_t>(width) * height;

    for (uint32_t row = 0; row < height; ++row) {
      const uint8_t* sourceRow = source + static_cast<size_t>(row) * sourceStride;
      uint8_t* yRow = yPlane + static_cast<size_t>(row) * width;
      for (uint32_t col = 0; col < width; ++col) {
        const uint8_t* pixel = sourceRow + static_cast<size_t>(col) * 4;
        yRow[col] = LumaBt709(pixel[2], pixel[1], pixel[0]);
      }
    }

    for (uint32_t row = 0; row < height; row += 2) {
      uint8_t* uvRow = uvPlane + static_cast<size_t>(row / 2) * width;
      const uint8_t* row0 = source + static_cast<size_t>(row) * sourceStride;
      const uint8_t* row1 = source + static_cast<size_t>(row + 1) * sourceStride;
      for (uint32_t col = 0; col < width; col += 2) {
        const uint8_t* p00 = row0 + static_cast<size_t>(col) * 4;
        const uint8_t* p01 = p00 + 4;
        const uint8_t* p10 = row1 + static_cast<size_t>(col) * 4;
        const uint8_t* p11 = p10 + 4;
        const int u = ChromaUBt709(p00[2], p00[1], p00[0])
            + ChromaUBt709(p01[2], p01[1], p01[0])
            + ChromaUBt709(p10[2], p10[1], p10[0])
            + ChromaUBt709(p11[2], p11[1], p11[0]);
        const int v = ChromaVBt709(p00[2], p00[1], p00[0])
            + ChromaVBt709(p01[2], p01[1], p01[0])
            + ChromaVBt709(p10[2], p10[1], p10[0])
            + ChromaVBt709(p11[2], p11[1], p11[0]);
        uvRow[col] = ClampByte((u + 2) / 4);
        uvRow[col + 1] = ClampByte((v + 2) / 4);
      }
    }
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

    ICONINFO iconInfo = {};
    if (!GetIconInfo(info.hCursor, &iconInfo)) return false;
    const int x = static_cast<int>(info.ptScreenPos.x - contentOrigin.x - static_cast<LONG>(iconInfo.xHotspot));
    const int y = static_cast<int>(info.ptScreenPos.y - contentOrigin.y - static_cast<LONG>(iconInfo.yHotspot));
    if (iconInfo.hbmMask) DeleteObject(iconInfo.hbmMask);
    if (iconInfo.hbmColor) DeleteObject(iconInfo.hbmColor);

    // DrawIconEx on the DIB DC handles masked and XOR (inverting I-beam)
    // cursors. Animated cursors render their first frame, which is enough.
    const BOOL drawn = DrawIconEx(dc_, x, y, info.hCursor, 0, 0, 0, nullptr, DI_NORMAL);
    GdiFlush();
    return drawn != FALSE;
  }

  void Reset() {
    if (dc_ && previousObject_) SelectObject(dc_, previousObject_);
    if (bitmap_) DeleteObject(bitmap_);
    if (dc_) DeleteDC(dc_);
    dc_ = nullptr;
    bitmap_ = nullptr;
    previousObject_ = nullptr;
    bits_ = nullptr;
    width_ = 0;
    height_ = 0;
  }

  HDC dc_ = nullptr;
  HBITMAP bitmap_ = nullptr;
  HGDIOBJ previousObject_ = nullptr;
  void* bits_ = nullptr;
  std::vector<uint8_t> nv12_;
  uint32_t width_ = 0;
  uint32_t height_ = 0;
};

class CaptureSession {
 public:
  bool Start(const CaptureTarget& target, uint32_t fps) {
    target_ = target;
    fps_ = fps == 0 ? 30 : fps;
    minFrameIntervalQpc_ = 0;

    LARGE_INTEGER frequency = {};
    if (QueryPerformanceFrequency(&frequency)) {
      minFrameIntervalQpc_ = frequency.QuadPart / fps_;
    }

    HRESULT hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                                   D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                                   D3D11_SDK_VERSION, d3dDevice_.put(), nullptr, nullptr);
    if (FAILED(hr)) {
      hr = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr,
                             D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                             D3D11_SDK_VERSION, d3dDevice_.put(), nullptr, nullptr);
    }
    if (FAILED(hr)) {
      Fail("D3D11CreateDevice failed.", hr);
      return false;
    }
    d3dDevice_->GetImmediateContext(d3dContext_.put());

    winrt::com_ptr<IDXGIDevice> dxgiDevice = d3dDevice_.as<IDXGIDevice>();
    winrt::com_ptr<IInspectable> inspectable;
    hr = CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.get(), inspectable.put());
    if (FAILED(hr)) {
      Fail("CreateDirect3D11DeviceFromDXGIDevice failed.", hr);
      return false;
    }
    device_ = inspectable.as<wgd3d::IDirect3DDevice>();

    auto interopFactory = winrt::get_activation_factory<wgc::GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
    if (target_.isWindow) {
      hr = interopFactory->CreateForWindow(target_.window, winrt::guid_of<wgc::GraphicsCaptureItem>(),
                                           winrt::put_abi(item_));
    } else {
      hr = interopFactory->CreateForMonitor(target_.monitor, winrt::guid_of<wgc::GraphicsCaptureItem>(),
                                            winrt::put_abi(item_));
    }
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

    LogFormat(static_cast<uint32_t>(contentSize_.Width), static_cast<uint32_t>(contentSize_.Height), fps_);
    session_.StartCapture();
    return true;
  }

  bool IsUnsupported() const { return unsupported_; }

  void Stop() {
    frameArrivedRevoker_.revoke();
    closedRevoker_.revoke();
    if (session_) session_.Close();
    if (framePool_) framePool_.Close();
    session_ = nullptr;
    framePool_ = nullptr;
    item_ = nullptr;
  }

 private:
  void TryDisableBorder() {
    // Best-effort: the capture border toggle only exists on newer builds and
    // may require capture access. A visible border is cosmetic, never fatal.
    try {
      if (winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
              L"Windows.Graphics.Capture.GraphicsCaptureSession", L"IsBorderRequired")) {
        wgc::GraphicsCaptureAccess::RequestAccessAsync(wgc::GraphicsCaptureAccessKind::Borderless).get();
        session_.IsBorderRequired(false);
      }
    } catch (...) {
      LogEvent("log", "Capture border could not be disabled.");
    }
  }

  void OnFrameArrived(wgc::Direct3D11CaptureFramePool const& pool) {
    std::lock_guard<std::mutex> guard(frameMutex_);
    if (!g_running) return;

    auto frame = pool.TryGetNextFrame();
    if (!frame) return;

    if (minFrameIntervalQpc_ > 0) {
      LARGE_INTEGER now = {};
      QueryPerformanceCounter(&now);
      if (lastFrameQpc_ != 0 && now.QuadPart - lastFrameQpc_ < minFrameIntervalQpc_) {
        return;
      }
      lastFrameQpc_ = now.QuadPart;
    }

    const auto frameSize = frame.ContentSize();
    if (frameSize.Width <= 0 || frameSize.Height <= 0) return;
    if (frameSize.Width != contentSize_.Width || frameSize.Height != contentSize_.Height) {
      contentSize_ = frameSize;
      pool.Recreate(device_, wgd::DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, contentSize_);
      LogFormat(static_cast<uint32_t>(contentSize_.Width), static_cast<uint32_t>(contentSize_.Height), fps_);
      return;
    }

    winrt::com_ptr<ID3D11Texture2D> texture;
    {
      auto access = frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
      if (FAILED(access->GetInterface(winrt::guid_of<ID3D11Texture2D>(), texture.put_void()))) return;
    }

    D3D11_TEXTURE2D_DESC desc = {};
    texture->GetDesc(&desc);
    if (!EnsureStagingTexture(desc.Width, desc.Height, desc.Format)) return;

    d3dContext_->CopyResource(stagingTexture_.get(), texture.get());
    D3D11_MAPPED_SUBRESOURCE mapped = {};
    if (FAILED(d3dContext_->Map(stagingTexture_.get(), 0, D3D11_MAP_READ, 0, &mapped))) return;

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
    const bool ok = originKnown
        ? writer_.WriteFrame(static_cast<const uint8_t*>(mapped.pData), mapped.RowPitch, width, height, contentOrigin)
        : true;
    d3dContext_->Unmap(stagingTexture_.get(), 0);

    if (!ok) {
      // stdout pipe is gone — the parent process exited.
      g_running = false;
      if (g_stopEvent) SetEvent(g_stopEvent);
    }
  }

  bool EnsureStagingTexture(uint32_t width, uint32_t height, DXGI_FORMAT format) {
    if (stagingTexture_) {
      D3D11_TEXTURE2D_DESC desc = {};
      stagingTexture_->GetDesc(&desc);
      if (desc.Width == width && desc.Height == height && desc.Format == format) return true;
      stagingTexture_ = nullptr;
    }

    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = width;
    desc.Height = height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = format;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_STAGING;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    return SUCCEEDED(d3dDevice_->CreateTexture2D(&desc, nullptr, stagingTexture_.put()));
  }

  CaptureTarget target_;
  uint32_t fps_ = 30;
  int64_t minFrameIntervalQpc_ = 0;
  int64_t lastFrameQpc_ = 0;
  bool unsupported_ = false;

  winrt::com_ptr<ID3D11Device> d3dDevice_;
  winrt::com_ptr<ID3D11DeviceContext> d3dContext_;
  winrt::com_ptr<ID3D11Texture2D> stagingTexture_;
  wgd3d::IDirect3DDevice device_{nullptr};
  wgc::GraphicsCaptureItem item_{nullptr};
  wgc::Direct3D11CaptureFramePool framePool_{nullptr};
  wgc::GraphicsCaptureSession session_{nullptr};
  winrt::Windows::Graphics::SizeInt32 contentSize_ = {};

  wgc::GraphicsCaptureItem::Closed_revoker closedRevoker_;
  wgc::Direct3D11CaptureFramePool::FrameArrived_revoker frameArrivedRevoker_;

  std::mutex frameMutex_;
  FrameWriter writer_;
};

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
  _setmode(_fileno(stdout), _O_BINARY);
  winrt::init_apartment(winrt::apartment_type::multi_threaded);

  const std::wstring sourceArg = ReadStringArg(argc, argv, L"--source");
  const uint32_t fps = ReadUIntArg(argc, argv, L"--fps", 30);

  bool isWindow = false;
  uint64_t sourceValue = 0;
  if (sourceArg.empty() || !ParseSourceArg(sourceArg, &isWindow, &sourceValue)) {
    Fail("Usage: --source screen:<index>|window:<hwnd> [--fps 30]");
    return 1;
  }

  if (!wgc::GraphicsCaptureSession::IsSupported()) {
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
      started = session.Start(target, fps);
    } catch (const winrt::hresult_error& error) {
      Fail("Capture session failed to start.", error.code());
    }

    if (!started) {
      exitCode = session.IsUnsupported() ? 2 : 1;
    } else {
      while (g_running) {
        WaitForSingleObject(g_stopEvent, 250);
      }
      session.Stop();
    }
  }

  LogEvent("exit");
  CloseHandle(g_stopEvent);
  g_stopEvent = nullptr;
  return exitCode;
}
