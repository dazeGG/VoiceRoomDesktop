#include <Audiopolicy.h>
#include <Mmdeviceapi.h>
#include <PropIdl.h>
#include <initguid.h>
#include <Functiondiscoverykeys_devpkey.h>
#include <wrl/client.h>
#include <string>

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

std::string utf8(const wchar_t* value) {
    const int length = WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
    if (length <= 1) return {};
    std::string result(length, '\0');
    if (!WideCharToMultiByte(CP_UTF8, 0, value, -1, &result[0], length, nullptr, nullptr)) return {};
    result.pop_back();
    return result;
}

HRESULT device_session_count(IMMDevice* device, int& active) {
    ComPtr<IAudioSessionManager2> manager;
    HRESULT hr = device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL,
                                  nullptr, reinterpret_cast<void**>(manager.GetAddressOf()));
    if (FAILED(hr)) return hr;
    ComPtr<IAudioSessionEnumerator> sessions;
    if (FAILED(hr = manager->GetSessionEnumerator(&sessions))) return hr;
    int count = 0;
    if (FAILED(hr = sessions->GetCount(&count))) return hr;
    for (int i = 0; i < count; ++i) {
        ComPtr<IAudioSessionControl> control;
        if (FAILED(hr = sessions->GetSession(i, &control))) return hr;
        ComPtr<IAudioSessionControl2> details;
        if (FAILED(hr = control.As(&details))) return hr;
        DWORD pid = 0;
        if (FAILED(hr = details->GetProcessId(&pid))) return hr;
        if (pid != GetCurrentProcessId()) continue;
        AudioSessionState state;
        if (FAILED(hr = control->GetState(&state))) return hr;
        if (state == AudioSessionStateActive) ++active;
    }
    return S_OK;
}

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
        if (FAILED(hr = device_session_count(device.Get(), active))) return hr;
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

extern "C" int voice_render_endpoint_sessions(const wchar_t* id) {
    ComScope com;
    if (!com.usable()) return -1;
    ComPtr<IMMDeviceEnumerator> enumerator;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                IID_PPV_ARGS(&enumerator)))) return -1;
    ComPtr<IMMDevice> device;
    if (FAILED(enumerator->GetDevice(id, &device))) return -1;
    DWORD state = 0;
    if (FAILED(device->GetState(&state)) || state != DEVICE_STATE_ACTIVE) return -1;
    int active = 0;
    return SUCCEEDED(device_session_count(device.Get(), active)) ? active : -1;
}

using OutputCallback = void (*)(void*, const char*, const char*, bool);

extern "C" bool voice_list_outputs(void* context, OutputCallback append) {
    ComScope com;
    if (!com.usable()) return false;
    ComPtr<IMMDeviceEnumerator> enumerator;
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                IID_PPV_ARGS(&enumerator)))) return false;
    ComPtr<IMMDevice> default_device;
    std::wstring default_id;
    if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(eRender, eCommunications, &default_device))) {
        LPWSTR raw_id = nullptr;
        if (SUCCEEDED(default_device->GetId(&raw_id))) {
            default_id = raw_id;
            CoTaskMemFree(raw_id);
        }
    }

    ComPtr<IMMDeviceCollection> devices;
    if (FAILED(enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices))) return false;
    UINT count = 0;
    if (FAILED(devices->GetCount(&count))) return false;
    for (UINT index = 0; index < count; ++index) {
        ComPtr<IMMDevice> device;
        if (FAILED(devices->Item(index, &device))) return false;
        LPWSTR raw_id = nullptr;
        if (FAILED(device->GetId(&raw_id))) return false;
        const auto id = utf8(raw_id);
        const bool is_default = CompareStringOrdinal(raw_id, -1, default_id.c_str(), -1, TRUE) == CSTR_EQUAL;
        CoTaskMemFree(raw_id);
        ComPtr<IPropertyStore> properties;
        PROPVARIANT label{};
        std::string name;
        if (SUCCEEDED(device->OpenPropertyStore(STGM_READ, &properties)) &&
            SUCCEEDED(properties->GetValue(PKEY_Device_FriendlyName, &label)) &&
            label.vt == VT_LPWSTR && label.pwszVal) {
            name = utf8(label.pwszVal);
        }
        PropVariantClear(&label);
        if (!id.empty()) append(context, id.c_str(), name.empty() ? id.c_str() : name.c_str(), is_default);
    }
    return true;
}
