use livekit::{
    rtc_engine::lk_runtime::LkRuntime,
    webrtc::peer_connection_factory::native::PeerConnectionFactoryExt, PlatformAudio,
};
use serde_json::{json, Value};

#[cfg(windows)]
extern "C" {
    fn voice_active_audio_sessions(capture: bool) -> i32;
    fn voice_default_output(output: *mut u8, capacity: i32) -> bool;
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

pub struct Output {
    platform: PlatformAudio,
    selected: Option<String>,
    effective: Option<String>,
    muted: bool,
}

impl Output {
    pub fn new(device: Option<String>, muted: bool) -> Result<Self, &'static str> {
        let platform = PlatformAudio::new().map_err(|_| "device-unavailable")?;
        // PlatformAudio enables recording on acquisition. Turn it off before
        // creating a room/peer connection, which can then only pull silence.
        LkRuntime::instance()
            .pc_factory()
            .set_adm_recording_enabled(false);
        let mut output = Self {
            platform,
            selected: None,
            effective: None,
            muted,
        };
        output.set_device(device)?;
        output.set_muted(muted);
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
            self.set_muted(true);
            return Err("device-switch-failed");
        }
        self.effective = Some(device.id.as_str().to_owned());
        self.selected = id;
        Ok(())
    }

    pub fn set_muted(&mut self, muted: bool) {
        // The ADM switches to synthetic playout while muted. RTP/statistics
        // continue, and this leaves the endpoint's system-wide volume alone.
        LkRuntime::instance()
            .pc_factory()
            .set_adm_playout_enabled(!muted);
        self.muted = muted;
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
