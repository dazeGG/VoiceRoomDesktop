#include <Audiopolicy.h>
#include <Mmdeviceapi.h>
#include <wrl/client.h>

using Microsoft::WRL::ComPtr;

namespace {
class ComScope {
public:
    ComScope() : result(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) {}
    ~ComScope() { if (SUCCEEDED(result)) CoUninitialize(); }
    bool usable() const { return SUCCEEDED(result) || result == RPC_E_CHANGED_MODE; }
private:
    HRESULT result;
};

HRESULT session_count(EDataFlow flow, int& active) {
    ComPtr<IMMDeviceEnumerator> enumerator;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                  IID_PPV_ARGS(&enumerator));
    if (FAILED(hr)) return hr;
    ComPtr<IMMDeviceCollection> devices;
    hr = enumerator->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &devices);
    if (FAILED(hr)) return hr;
    UINT device_count = 0;
    if (FAILED(hr = devices->GetCount(&device_count))) return hr;
    for (UINT i = 0; i < device_count; ++i) {
        ComPtr<IMMDevice> device;
        if (FAILED(hr = devices->Item(i, &device))) return hr;
        ComPtr<IAudioSessionManager2> manager;
        hr = device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL,
                              nullptr, reinterpret_cast<void**>(manager.GetAddressOf()));
        if (FAILED(hr)) return hr;
        ComPtr<IAudioSessionEnumerator> sessions;
        if (FAILED(hr = manager->GetSessionEnumerator(&sessions))) return hr;
        int count = 0;
        if (FAILED(hr = sessions->GetCount(&count))) return hr;
        for (int j = 0; j < count; ++j) {
            ComPtr<IAudioSessionControl> control;
            if (FAILED(hr = sessions->GetSession(j, &control))) return hr;
            ComPtr<IAudioSessionControl2> details;
            if (FAILED(hr = control.As(&details))) return hr;
            DWORD pid = 0;
            if (FAILED(hr = details->GetProcessId(&pid))) return hr;
            if (pid != GetCurrentProcessId()) continue;
            AudioSessionState state;
            if (FAILED(hr = control->GetState(&state))) return hr;
            if (state == AudioSessionStateActive) ++active;
        }
    }
    return S_OK;
}
}

extern "C" int voice_active_audio_sessions(bool capture) {
    ComScope com;
    int active = 0;
    if (!com.usable() || FAILED(session_count(capture ? eCapture : eRender, active))) return -1;
    return active;
}

extern "C" bool voice_default_output(char* output, int capacity) {
    ComScope com;
    if (!com.usable()) return false;
    ComPtr<IMMDeviceEnumerator> enumerator;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                  IID_PPV_ARGS(&enumerator));
    if (FAILED(hr)) return false;
    ComPtr<IMMDevice> device;
    if (FAILED(enumerator->GetDefaultAudioEndpoint(eRender, eCommunications, &device))) return false;
    LPWSTR id = nullptr;
    if (FAILED(device->GetId(&id))) return false;
    int written = WideCharToMultiByte(CP_UTF8, 0, id, -1, output, capacity, nullptr, nullptr);
    CoTaskMemFree(id);
    return written > 0;
}
