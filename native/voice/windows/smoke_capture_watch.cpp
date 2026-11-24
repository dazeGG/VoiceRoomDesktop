#include <Audiopolicy.h>
#include <Endpointvolume.h>
#include <Mmdeviceapi.h>
#include <wrl/implements.h>
#include <cstdio>
#include <cstdlib>
#include <vector>

using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Make;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;
using Microsoft::WRL::ClassicCom;

namespace {
class CaptureObserver final
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>, IAudioSessionNotification> {
public:
    HRESULT STDMETHODCALLTYPE OnSessionCreated(IAudioSessionControl* session) override {
        ComPtr<IAudioSessionControl2> details;
        DWORD pid = 0;
        if (FAILED(session->QueryInterface(IID_PPV_ARGS(&details))) ||
            FAILED(details->GetProcessId(&pid))) {
            std::puts("error");
        } else {
            std::printf("capture %lu\n", pid);
        }
        std::fflush(stdout);
        return S_OK;
    }
};

struct Watch {
    ComPtr<IAudioSessionManager2> manager;
    ComPtr<IAudioSessionNotification> observer;

    ~Watch() {
        if (observer) manager->UnregisterSessionNotification(observer.Get());
    }

    bool start(IMMDeviceCollection* endpoints, UINT index, IAudioSessionNotification* callback) {
        ComPtr<IMMDevice> device;
        if (FAILED(endpoints->Item(index, &device)) ||
            FAILED(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr,
                                    reinterpret_cast<void**>(manager.GetAddressOf()))) ||
            FAILED(manager->RegisterSessionNotification(callback))) return false;
        observer = callback;
        // GetCount enables delivery of new-session notifications.
        ComPtr<IAudioSessionEnumerator> sessions;
        int count = 0;
        return SUCCEEDED(manager->GetSessionEnumerator(&sessions)) &&
               SUCCEEDED(sessions->GetCount(&count));
    }
};

float render_peak(IMMDeviceEnumerator* enumerator, DWORD target_pid) {
    ComPtr<IMMDeviceCollection> endpoints;
    UINT device_count = 0;
    if (FAILED(enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &endpoints)) ||
        FAILED(endpoints->GetCount(&device_count))) return -1.0f;

    float peak = 0.0f;
    for (UINT i = 0; i < device_count; ++i) {
        ComPtr<IMMDevice> device;
        ComPtr<IAudioSessionManager2> manager;
        ComPtr<IAudioSessionEnumerator> sessions;
        int session_count = 0;
        if (FAILED(endpoints->Item(i, &device)) ||
            FAILED(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr,
                                    reinterpret_cast<void**>(manager.GetAddressOf()))) ||
            FAILED(manager->GetSessionEnumerator(&sessions)) ||
            FAILED(sessions->GetCount(&session_count))) return -1.0f;
        for (int j = 0; j < session_count; ++j) {
            ComPtr<IAudioSessionControl> session;
            ComPtr<IAudioSessionControl2> details;
            DWORD pid = 0;
            if (FAILED(sessions->GetSession(j, &session)) || FAILED(session.As(&details)) ||
                FAILED(details->GetProcessId(&pid)) || pid != target_pid) continue;
            AudioSessionState state;
            if (FAILED(session->GetState(&state))) return -1.0f;
            if (state != AudioSessionStateActive) continue;
            ComPtr<IAudioMeterInformation> meter;
            float sample = 0.0f;
            if (FAILED(session.As(&meter)) || FAILED(meter->GetPeakValue(&sample))) return -1.0f;
            if (sample > peak) peak = sample;
        }
    }
    return peak;
}

bool watch_capture() {
    ComPtr<IMMDeviceEnumerator> enumerator;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                IID_PPV_ARGS(&enumerator)))) return false;
    ComPtr<IMMDeviceCollection> endpoints;
    UINT count = 0;
    if (FAILED(enumerator->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &endpoints)) ||
        FAILED(endpoints->GetCount(&count)) || count == 0) return false;
    auto observer = Make<CaptureObserver>();
    if (!observer) return false;
    std::vector<Watch> watches(count);
    for (UINT i = 0; i < count; ++i) {
        if (!watches[i].start(endpoints.Get(), i, observer.Get())) return false;
    }
    std::printf("ready %u\n", count);
    std::fflush(stdout);
    // The smoke keeps the pipe open until after every receive process exits.
    char request[32];
    while (std::fgets(request, sizeof(request), stdin)) {
        DWORD pid = std::strtoul(request, nullptr, 10);
        if (pid == 0) return false;
        std::printf("peak %lu %.8f\n", pid, render_peak(enumerator.Get(), pid));
        std::fflush(stdout);
    }
    return !std::ferror(stdin);
}
}

extern "C" bool voice_smoke_watch_capture() {
    if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return false;
    bool result = watch_capture();
    CoUninitialize();
    return result;
}
