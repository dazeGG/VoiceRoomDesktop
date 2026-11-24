# Windows native voice IPC v1.2

The Windows x64 receive preview is enabled with `VOICE_ROOM_NATIVE_VOICE=1`.
Electron main owns the supervisor and can start one helper for a call. The flag
alone does not start a process. The helper is packaged under
`resources/app.asar.unpacked/native/bin/windows/VoiceRoomVoice.exe`. In
development the equivalent location is under the checkout root. Building
uses the exact Rust toolchain in `native/voice/rust-toolchain.toml` and MSVC
x64. Run `node scripts/build-native-voice.js` to prepare WebRTC and build.
The script checks SHA-256 before extracting a new or cached ZIP from the
pinned LiveKit release. Cargo uses that extracted directory.

## Renderer bridge

The sandboxed preload exposes `window.voiceRoomDesktopNativeVoice` in the
primary window's top-level document on the configured VoiceRoom origin.
Electron verifies the window, frame and origin on every request. The bridge
reports static capability, lists output endpoints, starts an admitted receive
session by call ID, updates its tracks, output, mute and gains, stops it, and emits
call-scoped media, transport, device, stats, fault and stopped events.

Both start and update accept `volumes?: Record<trackSid, number>` and
`masterVolume?: number`. Gains are linear in [0, 2]. The volume map
can contain up to 128 publication SIDs. Each absent SID and an omitted
initial master value use unity. A supplied map replaces the previous map.
An omitted field in an update keeps its value. A zero gain silences the
corresponding audio while network receive and statistics continue.

Bridge device events include the requested `outputDeviceId`, the
`effectiveOutputDeviceId`, the `defaultOutputDeviceId`, `muted`, and
`fallback`. The endpoint IDs are stable WASAPI MMDevice identifiers.
The fallback is `'selected-output-unavailable'` when the requested
explicit endpoint is missing and null otherwise. The effective ID is
null when no output can be routed. A renderer can use native receive
with these gain settings when `getCapability()` advertises 1.2.

Admission URLs must use WSS. The trusted site origin and the deployment's
known LiveKit and fallback origins are allowed. Set
`VOICE_ROOM_NATIVE_VOICE_ORIGINS` to a comma-separated list of exact WSS
origins for a custom or regional deployment. The gate's query credential is
forwarded in the URL. Neither it nor the companion token appears in IPC
errors or diagnostics.

A full top-level navigation (including reload), renderer exit, window close
or app quit retires the session. A new start shuts down any previous helper
before joining. In-document routing and subframe navigation retain the
current session.

## Wire format

Stdin and stdout carry a four-byte unsigned little-endian byte length followed
by that many bytes of UTF-8 JSON. Valid lengths are 1 through 65,536. Every
frame has this envelope:

```json
{"v":{"major":1,"minor":2},"epoch":"a-per-process-uuid","id":1,"kind":"ping","payload":{}}
```

The parent supplies the opaque epoch and parent PID as startup arguments.
Each spawn gets a fresh epoch. The first frames are `hello` (helper version
and receive, capture, publish and output-selection capabilities) and `ready`
(control channel ready, capture uninitialized). Helper events use ID 0.
Requests use positive u32 IDs, unique among in-flight requests. Replies
reuse the request ID and carry `{command,data}` in a `response` frame or
`{command,code}` in an `error` frame. An unknown command has a null command
field. The initial handshake requires version 1.2.

| Request | Payload | Success data |
| --- | --- | --- |
| `ping` | `{}` | `{}` |
| `list-outputs` | `{}` | `{outputs:[{id,name,isDefault}]}` |
| `join` | `{url,token,tracks?,outputDevice?,muted?,volumes?,masterVolume?}` | Device state |
| `update` | `{tracks?,outputDevice?,muted?,volumes?,masterVolume?}` | Device state |
| `subscriptions` | `{tracks}` | `{}` |
| `output-mute` | `{muted}` | Device state |
| `output-device` | `{outputDevice}` | Device state |
| `leave` | `{}` | `{}` after the room closes |
| `shutdown` | `{}` | `{}` after the room closes, then exit |

`tracks` replaces the microphone publication SID allowlist (maximum 128).
It defaults to empty on join. The helper excludes the canonical participant
associated with its companion identity. A null `outputDevice` selects the
default communications endpoint. Omission keeps the current output on update
and selects the default on join. The helper can list active WASAPI render
endpoints without opening an audio stream. While joined the helper checks
the endpoint catalog once per second. A default change emits a device event
even when an explicit endpoint remains selected. A missing explicit
endpoint uses the communications default and returns to the requested
endpoint when it becomes active again.

LiveKit's PlatformAudio ADM pulls audio at the WASAPI endpoint's cadence.
The WebRTC mixer pulls each source in silence until the helper has installed
its gain. Track and master gain are multiplied. The helper limits boost
per frame to the available PCM headroom before the stock mixer combines
streams. Gain zero keeps playout and receive counters running. Deafen
closes platform playout and the SDK's synthetic playout keeps receiving.

The helper qualifies a replacement endpoint while the current output
continues rendering. It retries a still-listed failed selection at most
every five seconds while a fallback is healthy. If no usable route remains,
it reports `effectiveOutputDevice: null` and uses synthetic playout for up
to 30 seconds from the first observed loss. The `muted` field continues to
reflect the requested deafen state. An endpoint that returns during this
window is restored automatically, including while deafened. After 30
continuous seconds without a usable route, the helper emits the terminal
`output-not-rendering` fault.

| Event | Payload |
| --- | --- |
| `media-ready` | The room is connected and the receive path is configured. This may precede the first media packet. |
| `transport` | `{state}` with `connected`, `reconnecting` or `disconnected` |
| `device` | `{outputDevice,effectiveOutputDevice,defaultOutputDevice,fallback,muted,captureEnabled,captureInitialized,outputs:[{id,name,isDefault}]}` |
| `stats` | Inbound audio jitter-buffer delay (seconds), emitted count, concealed and silent-concealed samples, concealment events, total received samples, packets lost, selected ICE RTT (seconds), and active capture/render process sessions |
| `fault` | `{code}`, followed by exit |

Stats are sampled at one-second intervals while joined. Counters accumulate
across inbound microphone streams for the helper session, including across
track removal and SDK resets. A helper restart starts a fresh counter series.
RTT is the maximum measured value across selected pairs or null when
unavailable. Session counts are null if WASAPI enumeration fails. The renderer
receives the same media counters with a shell timestamp and unit-suffixed
delay/RTT field names.

Bad frame lengths return `frame-size`. Truncation, malformed JSON or invalid
UTF-8 return `bad-frame`. Both close the pipe after a fault. A valid envelope
can return `version-mismatch`, `stale-epoch`, `bad-id`,
`unknown-command`, `bad-payload`, `already-joined`, `not-joined`,
`join-failed`, `join-timeout`, `leave-failed`, `leave-timeout`,
`device-unavailable`, `device-switch-failed` or `output-not-rendering`. SDK error details are
discarded. Credentials travel on stdin and should be scoped to subscribe-only
LiveKit access for the companion identity.

Electron times out the handshake and probes idle control with correlated
pings. On stop it sends shutdown, closes stdin and allows up to 500 ms
for the helper to exit before terminating it. The
shell confirms exit before resolving stop or delivering terminal fault and
stopped events. Duplicate stops share the same shutdown. If exit remains
unconfirmed at 800 ms, stop rejects. On application quit Electron exits
and the Windows watchdog terminates the helper on parent death.

A helper exit during a call is terminal. The shell emits a fault as soon as
the process closes and retires the call so the renderer can restore Chromium
playback. A new call can start a fresh process. Only helpers outside a call
are eligible for one supervisor restart, subject to a 30-second cooldown.

## Local integration smoke

In a Windows checkout with a LiveKit-compatible audio output and Docker
Desktop running:

```powershell
node scripts/build-native-voice.js
node scripts/build-native-voice.js --cargo build --release --locked --examples
$env:VOICE_ROOM_NATIVE_VOICE = '1'
npm run smoke:win-voice
```

The test reserves `trial.lock` in the sibling voice lab (or `VRLAB_LAB`),
binds loopback ports 17990–17992 and starts a temporary `vrlab-p3b-*`
LiveKit v1.13.11 container. Keep the Windows capture endpoint configuration
fixed during the test. The observer subscribes to session creation on every
active capture endpoint before spawning the helper and checks its PID
through teardown. The synthetic publisher feeds a tone for checking
rising receive counters with no active render while muted, endpoint selection
and fallback reporting, and graceful shutdown with an active render session.
It samples the helper's WASAPI session peak at 100%, 50%, 0% and 150% for
each gain control and checks the combined 4x gain. A nine-second watchdog
stops the helper during the audible portion. The publisher and observer are test-only Cargo examples.
The smoke removes its container and releases its lock. The normal Node test
suite exercises the built helper and runs without Docker. The Windows CI
lifecycle step sets `VOICE_ROOM_REQUIRE_NATIVE_VOICE=1` to require it.

The Windows CI receive integration runs the real helper with a pinned local
LiveKit server. Build it with
`node scripts/build-native-voice.js --cargo build --release --locked --features receive-test --bins --examples`,
set `VR_VOICE_TEST_LIVEKIT` to the LiveKit v1.13.11 Windows server executable
and run `node --test test/native-voice-receive.test.js`. This feature is
excluded from packaged builds. It supplies virtual endpoint snapshots and
captures mixer diagnostics to verify source admission, gain, route failures,
deafen recovery, the expiry fault and graceful shutdown without requiring
physical audio devices.
