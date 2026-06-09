#define WIN32_LEAN_AND_MEAN
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <avrt.h>
#include <combaseapi.h>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <ksmedia.h>
#include <mmdeviceapi.h>
#include <propsys.h>
#include <string>
#include <windows.h>
#include <wrl/client.h>

using Microsoft::WRL::ComPtr;

static volatile std::sig_atomic_t g_running = 1;

static void HandleSignal(int) {
  g_running = 0;
}

static void LogEvent(const char* event, const std::string& message = "") {
  if (message.empty()) {
    std::fprintf(stderr, "{\"event\":\"%s\"}\n", event);
  } else {
    std::fprintf(stderr, "{\"event\":\"%s\",\"message\":\"%s\"}\n", event, message.c_str());
  }
  std::fflush(stderr);
}

static DWORD ReadDWORDArg(int argc, wchar_t** argv, const wchar_t* name, DWORD fallback) {
  for (int index = 1; index + 1 < argc; ++index) {
    if (wcscmp(argv[index], name) == 0) {
      return static_cast<DWORD>(wcstoul(argv[index + 1], nullptr, 10));
    }
  }
  return fallback;
}

static bool HasArg(int argc, wchar_t** argv, const wchar_t* name) {
  for (int index = 1; index < argc; ++index) {
    if (wcscmp(argv[index], name) == 0) return true;
  }
  return false;
}

static void Fail(HRESULT hr, const char* message) {
  char buffer[256];
  std::snprintf(buffer, sizeof(buffer), "%s HRESULT=0x%08lx", message, static_cast<unsigned long>(hr));
  LogEvent("error", buffer);
}

static HRESULT ActivateProcessLoopbackAudioClient(DWORD processId, PROCESS_LOOPBACK_MODE mode, IAudioClient** client) {
  AUDIOCLIENT_ACTIVATION_PARAMS activationParams = {};
  activationParams.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  activationParams.ProcessLoopbackParams.TargetProcessId = processId;
  activationParams.ProcessLoopbackParams.ProcessLoopbackMode = mode;

  PROPVARIANT activateParams = {};
  activateParams.vt = VT_BLOB;
  activateParams.blob.cbSize = sizeof(activationParams);
  activateParams.blob.pBlobData = reinterpret_cast<BYTE*>(&activationParams);

  ComPtr<IActivateAudioInterfaceAsyncOperation> asyncOperation;
  HANDLE completed = CreateEvent(nullptr, FALSE, FALSE, nullptr);
  if (!completed) return HRESULT_FROM_WIN32(GetLastError());

  class CompletionHandler final : public IActivateAudioInterfaceCompletionHandler {
   public:
    CompletionHandler(HANDLE completed, IAudioClient** client) : refCount_(1), completed_(completed), client_(client) {}

    ULONG STDMETHODCALLTYPE AddRef() override {
      return InterlockedIncrement(&refCount_);
    }

    ULONG STDMETHODCALLTYPE Release() override {
      const ULONG value = InterlockedDecrement(&refCount_);
      if (value == 0) delete this;
      return value;
    }

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** object) override {
      if (!object) return E_POINTER;
      if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
        *object = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
        AddRef();
        return S_OK;
      }
      *object = nullptr;
      return E_NOINTERFACE;
    }

    HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
      HRESULT activateResult = E_FAIL;
      IUnknown* activatedInterface = nullptr;
      HRESULT hr = operation->GetActivateResult(&activateResult, &activatedInterface);
      if (SUCCEEDED(hr)) hr = activateResult;
      if (SUCCEEDED(hr) && activatedInterface) {
        hr = activatedInterface->QueryInterface(__uuidof(IAudioClient), reinterpret_cast<void**>(client_));
      }
      if (activatedInterface) activatedInterface->Release();
      SetEvent(completed_);
      return hr;
    }

   private:
    ~CompletionHandler() = default;
    volatile LONG refCount_;
    HANDLE completed_;
    IAudioClient** client_;
  };

  CompletionHandler* completion = new CompletionHandler(completed, client);
  HRESULT hr = ActivateAudioInterfaceAsync(
      VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
      __uuidof(IAudioClient),
      &activateParams,
      completion,
      &asyncOperation);
  completion->Release();
  if (SUCCEEDED(hr)) {
    WaitForSingleObject(completed, INFINITE);
    if (!*client) hr = E_FAIL;
  }
  CloseHandle(completed);
  return hr;
}

int wmain(int argc, wchar_t** argv) {
  std::signal(SIGINT, HandleSignal);
  std::signal(SIGTERM, HandleSignal);

  const DWORD targetPid = ReadDWORDArg(argc, argv, L"--target-pid", GetCurrentProcessId());
  const bool includeTarget = HasArg(argc, argv, L"--include-target");
  const bool debug = HasArg(argc, argv, L"--debug");
  const PROCESS_LOOPBACK_MODE mode = includeTarget
      ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
      : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) {
    Fail(hr, "CoInitializeEx failed");
    return 1;
  }

  ComPtr<IAudioClient> audioClient;
  hr = ActivateProcessLoopbackAudioClient(targetPid, mode, &audioClient);
  if (FAILED(hr)) {
    Fail(hr, "Process loopback activation failed");
    CoUninitialize();
    return 1;
  }

  WAVEFORMATEX* mixFormat = nullptr;
  hr = audioClient->GetMixFormat(&mixFormat);
  if (FAILED(hr)) {
    Fail(hr, "GetMixFormat failed");
    CoUninitialize();
    return 1;
  }

  if (debug) {
    std::fprintf(stderr,
        "{\"event\":\"debug\",\"stage\":\"mix-format\",\"sampleRate\":%lu,\"channels\":%u,\"bits\":%u,\"formatTag\":%u}\n",
        mixFormat->nSamplesPerSec, mixFormat->nChannels, mixFormat->wBitsPerSample, mixFormat->wFormatTag);
    std::fflush(stderr);
  }

  WAVEFORMATEXTENSIBLE desiredFormat = {};
  desiredFormat.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
  desiredFormat.Format.nChannels = mixFormat->nChannels;
  desiredFormat.Format.nSamplesPerSec = mixFormat->nSamplesPerSec;
  desiredFormat.Format.wBitsPerSample = 32;
  desiredFormat.Format.nBlockAlign = desiredFormat.Format.nChannels * sizeof(float);
  desiredFormat.Format.nAvgBytesPerSec = desiredFormat.Format.nSamplesPerSec * desiredFormat.Format.nBlockAlign;
  desiredFormat.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
  desiredFormat.Samples.wValidBitsPerSample = 32;
  desiredFormat.dwChannelMask = mixFormat->nChannels == 1 ? SPEAKER_FRONT_CENTER : (SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT);
  desiredFormat.SubFormat = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
  CoTaskMemFree(mixFormat);

  // Process loopback (microsoft/Windows-classic-samples ApplicationLoopback): Initialize
  // вызывается с LOOPBACK | EVENTCALLBACK | AUTOCONVERTPCM и hnsBufferDuration/hnsPeriodicity = 0.
  // Без AUTOCONVERTPCM запрос 32-bit float ведёт к отказу Initialize либо GetNextPacketSize
  // всегда возвращает 0 (тишина); для process loopback hns-параметры ДОЛЖНЫ быть нулевыми.
  hr = audioClient->Initialize(
      AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
          | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
      0,   // hnsBufferDuration ДОЛЖЕН быть 0 для process loopback
      0,   // hnsPeriodicity ДОЛЖЕН быть 0
      reinterpret_cast<WAVEFORMATEX*>(&desiredFormat),
      nullptr);
  if (FAILED(hr)) {
    Fail(hr, "IAudioClient Initialize failed");
    CoUninitialize();
    return 1;
  }

  HANDLE sampleReady = CreateEvent(nullptr, FALSE, FALSE, nullptr);
  if (!sampleReady) {
    LogEvent("error", "CreateEvent failed");
    CoUninitialize();
    return 1;
  }
  hr = audioClient->SetEventHandle(sampleReady);
  if (FAILED(hr)) {
    Fail(hr, "SetEventHandle failed");
    CloseHandle(sampleReady);
    CoUninitialize();
    return 1;
  }

  ComPtr<IAudioCaptureClient> captureClient;
  hr = audioClient->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(captureClient.GetAddressOf()));
  if (FAILED(hr)) {
    Fail(hr, "GetService IAudioCaptureClient failed");
    CloseHandle(sampleReady);
    CoUninitialize();
    return 1;
  }

  DWORD taskIndex = 0;
  HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);

  std::fprintf(stderr, "{\"event\":\"format\",\"sampleRate\":%lu,\"channels\":%u,\"sampleFormat\":\"f32le\",\"interleaved\":true}\n",
      desiredFormat.Format.nSamplesPerSec,
      desiredFormat.Format.nChannels);
  std::fprintf(stderr, "{\"event\":\"started\",\"mode\":\"%s\",\"targetPid\":%lu,\"platform\":\"win32\"}\n",
      includeTarget ? "application" : "safe-system",
      targetPid);
  std::fflush(stderr);

  hr = audioClient->Start();
  if (FAILED(hr)) {
    Fail(hr, "IAudioClient Start failed");
    if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
    CloseHandle(sampleReady);
    CoUninitialize();
    return 1;
  }

  unsigned long long waitCalls = 0, signalCount = 0, timeoutCount = 0;
  unsigned long long packetCount = 0, totalFrames = 0, nonSilentFrames = 0;
  DWORD lastFlags = 0;
  bool loggedFirstAudio = false;
  ULONGLONG lastStatsTick = GetTickCount64();

  while (g_running) {
    const DWORD wait = WaitForSingleObject(sampleReady, 500);
    ++waitCalls;
    if (wait == WAIT_OBJECT_0) {
      ++signalCount;
      for (;;) {
        UINT32 packetFrames = 0;
        hr = captureClient->GetNextPacketSize(&packetFrames);
        if (FAILED(hr) || packetFrames == 0) break;

        BYTE* data = nullptr;
        UINT32 framesAvailable = 0;
        DWORD flags = 0;
        hr = captureClient->GetBuffer(&data, &framesAvailable, &flags, nullptr, nullptr);
        if (FAILED(hr)) break;

        ++packetCount;
        totalFrames += framesAvailable;
        lastFlags = flags;

        const size_t byteCount = static_cast<size_t>(framesAvailable) * desiredFormat.Format.nBlockAlign;
        if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) {
          std::string silence(byteCount, '\0');
          std::fwrite(silence.data(), 1, silence.size(), stdout);
        } else {
          nonSilentFrames += framesAvailable;
          if (debug && !loggedFirstAudio) {
            std::fprintf(stderr, "{\"event\":\"debug\",\"stage\":\"first-audio\",\"frames\":%u}\n", framesAvailable);
            std::fflush(stderr);
            loggedFirstAudio = true;
          }
          std::fwrite(data, 1, byteCount, stdout);
        }
        std::fflush(stdout);
        captureClient->ReleaseBuffer(framesAvailable);
      }
    } else {
      ++timeoutCount;
    }

    // Periodic capture stats (stderr only, --debug). Reveals where the pipeline stalls:
    //   signals=0          -> the sample-ready event never fires (process loopback not delivering)
    //   signals>0,packets=0-> GetNextPacketSize keeps returning 0 (known loopback symptom)
    //   packets>0,nonSilent=0 -> only silence captured (nothing playing outside the excluded tree)
    //   nonSilentFrames>0  -> native capture works; investigate the IPC/web side instead
    if (debug) {
      const ULONGLONG now = GetTickCount64();
      if (now - lastStatsTick >= 1000) {
        std::fprintf(stderr,
            "{\"event\":\"debug\",\"stage\":\"stats\",\"waits\":%llu,\"signals\":%llu,\"timeouts\":%llu,"
            "\"packets\":%llu,\"frames\":%llu,\"nonSilentFrames\":%llu,\"lastFlags\":%lu}\n",
            waitCalls, signalCount, timeoutCount, packetCount, totalFrames, nonSilentFrames,
            static_cast<unsigned long>(lastFlags));
        std::fflush(stderr);
        lastStatsTick = now;
      }
    }
  }

  audioClient->Stop();
  if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
  CloseHandle(sampleReady);
  LogEvent("stopped");
  CoUninitialize();
  return 0;
}
