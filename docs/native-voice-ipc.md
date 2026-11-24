# Windows native voice IPC v1.1

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
session by call ID, updates its tracks, output and mute, stops it, and emits
call-scoped media, transport, device, stats, fault and stopped events.

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
{"v":{"major":1,"minor":1},"epoch":"a-per-process-uuid","id":1,"kind":"ping","payload":{}}
```

The parent supplies the opaque epoch and parent PID as startup arguments.
Each spawn gets a fresh epoch. The first frames are `hello` (helper version
and receive, capture, publish and output-selection capabilities) and `ready`
(control channel ready, capture uninitialized). Helper events use ID 0.
Requests use positive u32 IDs, unique among in-flight requests. Replies
reuse the request ID and carry `{command,data}` in a `response` frame or
`{command,code}` in an `error` frame. An unknown command has a null command
field. The initial handshake requires version 1.1.

| Request | Payload | Success data |
| --- | --- | --- |
| `ping` | `{}` | `{}` |
| `list-outputs` | `{}` | `{outputs:[{id,name,isDefault}]}` |
| `join` | `{url,token,tracks?,outputDevice?,muted?}` | Device state |
| `update` | `{tracks?,outputDevice?,muted?}` | Device state |
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
endpoints without opening an audio stream. Muting routes decoded audio to
synthetic playout so inbound RTP and statistics continue. Unmute verifies
that the selected WASAPI endpoint is active and that it has a running
helper-owned render session when a remote microphone is subscribed. Failed
verification returns `output-not-rendering` and restores synthetic playout.
The periodic health check also emits a device state and a terminal fault if
an active output fails.

| Event | Payload |
| --- | --- |
| `media-ready` | The room is connected and the receive path is configured. This may precede the first media packet. |
| `transport` | `{state}` with `connected`, `reconnecting` or `disconnected` |
| `device` | `{outputDevice,effectiveOutputDevice,muted,captureEnabled,captureInitialized,outputs:[{id,name}]}` |
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
binds loopback ports 17980–17982 and starts a temporary `vrlab-desk-*`
LiveKit v1.13.11 container. Keep the Windows capture endpoint configuration
fixed during the test. The observer subscribes to session creation on every
active capture endpoint before spawning the helper and checks its PID
through teardown. The synthetic publisher feeds a tone for checking
rising receive counters with no active render while muted, output selection,
active WASAPI render with a nonzero session peak after unmute, and a
terminal fault after a forced helper exit.
Listen for the tone on the selected output to confirm physical audibility. The publisher and observer
are test-only Cargo examples. The smoke removes its container and releases
its lock. The normal Node test suite exercises
the real helper when it has been built and runs without Docker. The Windows
CI lifecycle step sets `VOICE_ROOM_REQUIRE_NATIVE_VOICE=1` to require it.
