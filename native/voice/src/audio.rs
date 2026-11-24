use livekit::{
    rtc_engine::lk_runtime::LkRuntime,
    webrtc::peer_connection_factory::native::PeerConnectionFactoryExt, PlatformAudio,
};
use serde::Serialize;
use serde_json::{json, Value};
#[cfg(windows)]
use std::ffi::{c_char, c_void, CStr};
use std::time::{Duration, Instant};

#[cfg(windows)]
extern "C" {
    fn voice_active_audio_sessions(capture: bool) -> i32;
    fn voice_render_endpoint_sessions(id: *const u16) -> i32;
    fn voice_list_outputs(
        context: *mut c_void,
        append: extern "C" fn(*mut c_void, *const c_char, *const c_char, bool),
    ) -> bool;
}

const OUTPUT_NOT_RENDERING: &str = "output-not-rendering";
const SELECTED_OUTPUT_UNAVAILABLE: &str = "selected-output-unavailable";

#[derive(Serialize)]
#[cfg_attr(feature = "receive-test", derive(serde::Deserialize))]
#[serde(rename_all = "camelCase")]
struct Endpoint {
    id: String,
    name: String,
    is_default: bool,
}

fn endpoints() -> Result<Vec<Endpoint>, &'static str> {
    #[cfg(feature = "receive-test")]
    if let Some(path) = std::env::var_os("VR_VOICE_TEST_ENDPOINTS") {
        let snapshot = std::fs::read(path).map_err(|_| "device-unavailable")?;
        return serde_json::from_slice(&snapshot).map_err(|_| "device-unavailable");
    }
    #[cfg(windows)]
    {
        extern "C" fn append(
            context: *mut c_void,
            id: *const c_char,
            name: *const c_char,
            is_default: bool,
        ) {
            // The enumerator calls synchronously and owns both strings until this returns.
            let outputs = unsafe { &mut *context.cast::<Vec<Endpoint>>() };
            let read = |value| {
                unsafe { CStr::from_ptr(value) }
                    .to_string_lossy()
                    .into_owned()
            };
            outputs.push(Endpoint {
                id: read(id),
                name: read(name),
                is_default,
            });
        }

        let mut outputs = Vec::<Endpoint>::new();
        if unsafe { voice_list_outputs((&raw mut outputs).cast(), append) } {
            return Ok(outputs);
        }
    }
    Err("device-unavailable")
}

pub fn list_outputs() -> Result<Value, &'static str> {
    Ok(json!({ "outputs": endpoints()? }))
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

// Leave a working fallback undisturbed between retries of a listed but unusable endpoint.
const RESTORE_RETRY: Duration = Duration::from_secs(5);
const OUTPUT_RECOVERY: Duration = Duration::from_secs(30);

#[derive(Default, PartialEq, Eq)]
struct Route {
    default: Option<String>,
    effective: Option<String>,
    fallback: Option<&'static str>,
}

impl Route {
    fn activate(
        selected: Option<&str>,
        outputs: &[Endpoint],
        skip_explicit: bool,
        mut open: impl FnMut(&str) -> bool,
    ) -> Self {
        let default = outputs.iter().find(|endpoint| endpoint.is_default);
        let explicit = selected.and_then(|id| {
            outputs
                .iter()
                .find(|endpoint| endpoint.id.eq_ignore_ascii_case(id))
        });
        let available = explicit.filter(|_| !skip_explicit);
        let effective = available.filter(|endpoint| open(&endpoint.id)).or_else(|| {
            default.filter(|endpoint| {
                explicit.is_none_or(|requested| requested.id != endpoint.id) && open(&endpoint.id)
            })
        });
        let fallback = selected.is_some()
            && effective.is_none_or(|endpoint| {
                !selected
                    .unwrap_or_default()
                    .eq_ignore_ascii_case(&endpoint.id)
            });
        Self {
            effective: effective.map(|endpoint| endpoint.id.clone()),
            default: default.map(|endpoint| endpoint.id.clone()),
            fallback: fallback.then_some(SELECTED_OUTPUT_UNAVAILABLE),
        }
    }
}

fn render_sessions(id: &str) -> i32 {
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

fn healthy(id: &str, expect_render: bool) -> bool {
    #[cfg(feature = "receive-test")]
    if id.starts_with("test-output:") && std::env::var_os("VR_VOICE_TEST_ENDPOINTS").is_some() {
        return true;
    }
    let sessions = render_sessions(id);
    sessions >= i32::from(expect_render)
}

pub struct Output {
    platform: PlatformAudio,
    selected: Option<String>,
    route: Route,
    outputs: Vec<Endpoint>,
    muted: bool,
    retry_explicit_after: Option<Instant>,
    missing_since: Option<Instant>,
    platform_id: Option<String>,
}

impl Output {
    pub fn new(device: Option<String>) -> Result<Self, &'static str> {
        let platform = PlatformAudio::new().map_err(|_| "device-unavailable")?;
        // PlatformAudio enables recording on acquisition. Turn it off before
        // creating a room or peer connection.
        LkRuntime::instance()
            .pc_factory()
            .set_adm_recording_enabled(false);
        set_playout(false);
        let mut output = Self {
            platform,
            selected: device,
            route: Route::default(),
            outputs: Vec::new(),
            muted: true,
            retry_explicit_after: None,
            missing_since: None,
            platform_id: None,
        };
        output.refresh(false);
        Ok(output)
    }

    pub fn set_device(&mut self, selected: Option<String>, expect_render: bool) {
        self.selected = selected;
        self.retry_explicit_after = None;
        self.refresh(expect_render);
    }

    pub fn poll_device(&mut self, expect_render: bool) -> Result<bool, &'static str> {
        let changed = self.refresh(expect_render);
        if self
            .missing_since
            .is_some_and(|since| since.elapsed() >= OUTPUT_RECOVERY)
        {
            return Err(OUTPUT_NOT_RENDERING);
        }
        Ok(changed)
    }

    fn refresh(&mut self, expect_render: bool) -> bool {
        let now = Instant::now();
        let outputs = endpoints().unwrap_or_default();
        let listed = |id: &str| {
            outputs
                .iter()
                .any(|endpoint| endpoint.id.eq_ignore_ascii_case(id))
        };
        let current = self
            .platform_id
            .as_deref()
            .filter(|id| listed(id) && healthy(id, expect_render));
        let skip_explicit = (self.muted || current.is_some())
            && self.retry_explicit_after.is_some_and(|retry| now < retry);
        let selected = self.selected.as_deref();
        let mut route = Route::activate(selected, &outputs, skip_explicit, |id| {
            self.muted
                || current == Some(id)
                || LkRuntime::instance().pc_factory().switch_receive_output(id)
        });
        // A communications-default change may be reported before the new device
        // is usable. Keep the currently working endpoint during that transition.
        if let (None, Some(current)) = (&route.effective, current) {
            route.effective = Some(current.to_owned());
            route.fallback = selected
                .filter(|id| !id.eq_ignore_ascii_case(current))
                .map(|_| SELECTED_OUTPUT_UNAVAILABLE);
        }
        self.retry_explicit_after = if route.fallback.is_some() && selected.is_some_and(listed) {
            if skip_explicit {
                self.retry_explicit_after
            } else {
                Some(now + RESTORE_RETRY)
            }
        } else {
            None
        };

        self.platform_id = if self.muted {
            None
        } else {
            route.effective.clone()
        };
        if route.effective.is_none() {
            set_playout(false);
            self.missing_since.get_or_insert(now);
        } else {
            self.missing_since = None;
        }
        let changed = self.route != route;
        self.route = route;
        self.outputs = outputs;
        changed
    }

    pub fn mute(&mut self) {
        set_playout(false);
        self.muted = true;
        self.platform_id = None;
    }

    pub fn unmute(&mut self, expect_render: bool) {
        self.muted = false;
        self.retry_explicit_after = None;
        self.refresh(expect_render);
    }

    pub fn state(&self) -> Value {
        json!({
            "outputDevice": self.selected,
            "effectiveOutputDevice": self.route.effective,
            "defaultOutputDevice": self.route.default,
            "fallback": self.route.fallback,
            "muted": self.muted,
            "captureEnabled": LkRuntime::instance().pc_factory().adm_recording_enabled(),
            "captureInitialized": self.platform.is_recording_initialized(),
            "outputs": self.outputs
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint(id: &str, is_default: bool) -> Endpoint {
        Endpoint {
            id: id.into(),
            name: id.into(),
            is_default,
        }
    }

    #[test]
    fn default_changes_leave_an_available_explicit_route_in_place() {
        let first = [endpoint("A", true), endpoint("B", false)];
        let changed = [endpoint("A", false), endpoint("B", true)];
        assert_eq!(
            Route::activate(None, &first, false, |_| true)
                .effective
                .as_deref(),
            Some("A")
        );
        assert_eq!(
            Route::activate(None, &changed, false, |_| true)
                .effective
                .as_deref(),
            Some("B")
        );
        let explicit = Route::activate(Some("a"), &changed, false, |_| true);
        assert_eq!(explicit.effective.as_deref(), Some("A"));
        assert_eq!(explicit.default.as_deref(), Some("B"));
        assert_eq!(explicit.fallback, None);
    }

    #[test]
    fn a_failed_open_uses_default_even_with_a_stale_catalog() {
        let both = [endpoint("A", false), endpoint("B", true)];
        let mut attempts = Vec::new();
        let fallback = Route::activate(Some("A"), &both, false, |id| {
            attempts.push(id.to_owned());
            id == "B"
        });
        assert_eq!(attempts, ["A", "B"]);
        assert_eq!(fallback.effective.as_deref(), Some("B"));
        assert_eq!(fallback.fallback, Some(SELECTED_OUTPUT_UNAVAILABLE));
        let held = Route::activate(Some("A"), &both, true, |id| {
            assert_eq!(id, "B");
            true
        });
        assert!(held == fallback);
    }

    #[test]
    fn an_unplugged_endpoint_falls_back_until_restored() {
        let alternative = [endpoint("B", true)];
        assert_eq!(
            Route::activate(Some("A"), &alternative, false, |_| true)
                .effective
                .as_deref(),
            Some("B"),
        );
        let unavailable = Route::activate(Some("A"), &alternative, false, |_| false);
        assert_eq!(unavailable.effective, None);
        assert_eq!(unavailable.default.as_deref(), Some("B"));
        let both = [endpoint("A", false), endpoint("B", true)];
        let restored = Route::activate(Some("A"), &both, false, |_| true);
        assert_eq!(restored.effective.as_deref(), Some("A"));
        assert_eq!(restored.fallback, None);
    }
}
