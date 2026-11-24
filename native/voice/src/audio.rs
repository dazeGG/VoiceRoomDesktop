use livekit::{
    rtc_engine::lk_runtime::LkRuntime,
    webrtc::peer_connection_factory::native::PeerConnectionFactoryExt, PlatformAudio,
};
use serde_json::{json, Value};
#[cfg(windows)]
use std::ffi::{c_char, c_void, CStr};

#[cfg(windows)]
extern "C" {
    fn voice_active_audio_sessions(capture: bool) -> i32;
    fn voice_render_endpoint_sessions(id: *const u16) -> i32;
    fn voice_default_output(output: *mut u8, capacity: i32) -> bool;
    fn voice_list_outputs(
        context: *mut c_void,
        append: extern "C" fn(*mut c_void, *const c_char, *const c_char),
    ) -> bool;
}

pub const OUTPUT_NOT_RENDERING: &str = "output-not-rendering";

pub fn list_outputs() -> Result<Value, &'static str> {
    #[cfg(windows)]
    {
        extern "C" fn append(context: *mut c_void, id: *const c_char, name: *const c_char) {
            // The enumerator calls synchronously and owns both strings until this returns.
            let outputs = unsafe { &mut *context.cast::<Vec<(String, String)>>() };
            let id = unsafe { CStr::from_ptr(id) }.to_string_lossy().into_owned();
            let name = unsafe { CStr::from_ptr(name) }
                .to_string_lossy()
                .into_owned();
            outputs.push((id, name));
        }

        let mut outputs = Vec::<(String, String)>::new();
        if !unsafe { voice_list_outputs((&raw mut outputs).cast(), append) } {
            return Err("device-unavailable");
        }
        let default = default_output();
        let outputs: Vec<_> = outputs
            .into_iter()
            .map(|(id, name)| {
                let is_default = default
                    .as_ref()
                    .is_some_and(|default| id.eq_ignore_ascii_case(default));
                json!({ "id": id, "name": name, "isDefault": is_default })
            })
            .collect();
        Ok(json!({ "outputs": outputs }))
    }
    #[cfg(not(windows))]
    Err("device-unavailable")
}

pub fn active_sessions(capture: bool) -> Option<i32> {
    #[cfg(windows)]
    {
        let count = unsafe { voice_active_audio_sessions(capture) };
        (count >= 0).then_some(count)
    }
    #[cfg(not(windows))]
    {
        let _ = capture;
        None
    }
}

fn default_output() -> Option<String> {
    #[cfg(windows)]
    {
        let mut buffer = [0; 512];
        if unsafe { voice_default_output(buffer.as_mut_ptr(), buffer.len() as i32) } {
            return std::ffi::CStr::from_bytes_until_nul(&buffer)
                .ok()
                .and_then(|id| id.to_str().ok())
                .map(str::to_owned);
        }
    }
    None
}

fn render_endpoint_sessions(id: &str) -> i32 {
    #[cfg(windows)]
    {
        let wide: Vec<_> = id.encode_utf16().chain([0]).collect();
        // MMDevice reads the null-terminated endpoint ID synchronously.
        unsafe { voice_render_endpoint_sessions(wide.as_ptr()) }
    }
    #[cfg(not(windows))]
    {
        let _ = id;
        -1
    }
}

fn set_playout(enabled: bool) {
    // Synthetic playout keeps RTP and stats running while muted.
    LkRuntime::instance()
        .pc_factory()
        .set_adm_playout_enabled(enabled);
}

fn verify_playout(
    sessions: i32,
    expect_render: bool,
    muted: &mut bool,
    set_enabled: impl FnOnce(bool),
) -> Result<(), &'static str> {
    if sessions < 0 || (expect_render && sessions == 0) {
        set_enabled(false);
        *muted = true;
        return Err(OUTPUT_NOT_RENDERING);
    }
    *muted = false;
    Ok(())
}

pub struct Output {
    platform: PlatformAudio,
    selected: Option<String>,
    effective: Option<String>,
    muted: bool,
}

impl Output {
    pub fn new(device: Option<String>) -> Result<Self, &'static str> {
        let platform = PlatformAudio::new().map_err(|_| "device-unavailable")?;
        // PlatformAudio enables recording on acquisition. Turn it off before
        // creating a room/peer connection, which can then only pull silence.
        LkRuntime::instance()
            .pc_factory()
            .set_adm_recording_enabled(false);
        set_playout(false);
        let mut output = Self {
            platform,
            selected: None,
            effective: None,
            muted: true,
        };
        output.set_device(device)?;
        Ok(output)
    }

    pub fn set_device(&mut self, id: Option<String>) -> Result<(), &'static str> {
        let requested = id
            .clone()
            .or_else(default_output)
            .ok_or("device-unavailable")?;
        let device = self
            .platform
            .playout_devices()
            .find(|device| device.id.as_str().eq_ignore_ascii_case(&requested))
            .ok_or("device-unavailable")?;
        if self.platform.switch_playout_device(&device.id).is_err() {
            self.mute();
            return Err("device-switch-failed");
        }
        self.effective = Some(device.id.as_str().to_owned());
        self.selected = id;
        Ok(())
    }

    pub fn mute(&mut self) {
        set_playout(false);
        self.muted = true;
    }

    pub fn unmute(&mut self, expect_render: bool) -> Result<(), &'static str> {
        set_playout(true);
        self.check_playout(expect_render)
    }

    pub fn verify_active_playout(&mut self, expect_render: bool) -> Result<(), &'static str> {
        if self.muted {
            return Ok(());
        }
        self.check_playout(expect_render)
    }

    fn check_playout(&mut self, expect_render: bool) -> Result<(), &'static str> {
        // The SDK's setter discards the result of WASAPI InitPlayout/StartPlayout.
        let sessions = self
            .effective
            .as_deref()
            .map_or(-1, render_endpoint_sessions);
        verify_playout(sessions, expect_render, &mut self.muted, set_playout)
    }

    pub fn state(&self) -> Value {
        json!({
            "outputDevice": self.selected,
            "effectiveOutputDevice": self.effective,
            "muted": self.muted,
            "captureEnabled": LkRuntime::instance().pc_factory().adm_recording_enabled(),
            "captureInitialized": self.platform.is_recording_initialized(),
            "outputs": self.platform.playout_devices().map(|device| json!({
                "id": device.id.as_str(), "name": device.name
            })).collect::<Vec<_>>()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_failure_after_the_muted_probe_reverts_to_synthetic_playout() {
        for sessions in [-1, 0] {
            let mut muted = true;
            let mut enabled = true;
            assert_eq!(
                verify_playout(sessions, true, &mut muted, |value| enabled = value),
                Err(OUTPUT_NOT_RENDERING)
            );
            assert!(muted);
            assert!(!enabled);
        }
    }

    #[test]
    fn a_running_endpoint_or_an_idle_room_allows_unmute() {
        for (sessions, expect_render) in [(1, true), (0, false)] {
            let mut muted = true;
            verify_playout(sessions, expect_render, &mut muted, |_| {
                panic!("healthy endpoint was disabled")
            })
            .unwrap();
            assert!(!muted);
        }
    }
}
