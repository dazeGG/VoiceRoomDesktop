# Windows native voice IPC v1

The Windows x64 helper is enabled for internal callers with
`VOICE_ROOM_NATIVE_VOICE=1`. Electron main owns the supervisor and can start
one helper for a call. The flag alone does not start a process. Existing call
media remains on Chromium. The helper is packaged under
`resources/app.asar.unpacked/native/bin/windows/VoiceRoomVoice.exe`. In
development the equivalent location is under the checkout root. Building
uses the exact Rust toolchain in `native/voice/rust-toolchain.toml` and MSVC
x64. Run `node scripts/build-native-voice.js` to prepare WebRTC and build.
The script checks SHA-256 before extracting a new or cached ZIP from the
pinned LiveKit release. Cargo uses that extracted directory.

## Wire format

Stdin and stdout carry a four-byte unsigned little-endian byte length followed
by that many bytes of UTF-8 JSON. Valid lengths are 1 through 65,536. Every
frame has this envelope:

```json
{"v":{"major":1,"minor":0},"epoch":"a-per-process-uuid","id":1,"kind":"ping","payload":{}}
```

The parent supplies the opaque epoch and parent PID as startup arguments.
Each spawn gets a fresh epoch. The first frames are `hello` (helper version
and receive, capture, publish and output-selection capabilities) and `ready`
(control channel ready, capture uninitialized). Helper events use ID 0.
Requests use positive u32 IDs, unique among in-flight requests. Replies
reuse the request ID and carry `{command,data}` in a `response` frame or
`{command,code}` in an `error` frame. An unknown command has a null command
field. The initial handshake requires version 1.0.

| Request | Payload | Success data |
| --- | --- | --- |
| `ping` | `{}` | `{}` |
| `join` | `{url,token,tracks?,outputDevice?,muted?}` | Device state |
| `subscriptions` | `{tracks}` | `{}` |
| `output-mute` | `{muted}` | Device state |
| `output-device` | `{outputDevice}` | Device state |
| `leave` | `{}` | `{}` after the room closes |
| `shutdown` | `{}` | `{}` after the room closes, then exit |

`tracks` replaces the audio publication SID allowlist (maximum 128). It
defaults to empty on join. A null or omitted `outputDevice` selects the
default communications endpoint. Other selections use the IDs in the
`outputs` array. The helper joins muted by default. Muting routes decoded
audio to synthetic playout so inbound RTP and receiver statistics continue.
A device switch that fails after it starts mutes output.

| Event | Payload |
| --- | --- |
| `media-ready` | The room is connected and the receive path is configured. This may precede the first media packet. |
| `transport` | `{state}` with `connected`, `reconnecting` or `disconnected` |
| `device` | `{outputDevice,effectiveOutputDevice,muted,captureEnabled,captureInitialized,outputs:[{id,name}]}` |
| `stats` | Inbound audio jitter-buffer delay (seconds), emitted count, concealed samples, concealment events, packets lost, selected ICE RTT (seconds), and active capture/render process sessions |
| `fault` | `{code}`, followed by exit |

Stats are sampled at one-second intervals while joined. Counters sum across
current inbound audio streams and can reset when streams change. RTT is the
maximum across selected pairs or null when unavailable. Session counts are
null if WASAPI enumeration fails.

Bad frame lengths return `frame-size`. Truncation, malformed JSON or invalid
UTF-8 return `bad-frame`. Both close the pipe after a fault. A valid envelope
can return `version-mismatch`, `stale-epoch`, `bad-id`,
`unknown-command`, `bad-payload`, `already-joined`, `not-joined`,
`join-failed`, `join-timeout`, `leave-failed`, `leave-timeout`,
`device-unavailable` or `device-switch-failed`. SDK error details are
discarded. Credentials travel on stdin and should be scoped to subscribe-only
LiveKit access for the companion identity.

Electron times out the handshake and probes idle control with correlated
pings. It waits for a shutdown response and exit, then attempts termination.
If exit is still unconfirmed at the three-second deadline, Electron exits
and the Windows watchdog handles the helper. The helper also closes on stdin EOF. A Windows watchdog waits on an open
handle to Electron and terminates the helper on parent death even if the pipe
remains open. The supervisor permits one restart per call and a 30-second
cooldown across calls, then emits a terminal event. A replacement uses a
fresh epoch and replays the last acknowledged join with muted output. The
owner must explicitly unmute the replacement. A disconnected room
clears the cached admission so the supervisor cannot replay it.

## Local integration smoke

In a Windows checkout with a LiveKit-compatible audio output and Docker
Desktop running:

```powershell
node scripts/build-native-voice.js
node scripts/build-native-voice.js --cargo build --release --locked --example smoke_sender
$env:VOICE_ROOM_NATIVE_VOICE = '1'
npm run smoke:win-voice
```

The test binds loopback ports 17980–17982 and uses a temporary
`vrlab-desk-*` container with LiveKit v1.13.11 and a synthetic publisher.
It checks explicit subscription, stats, mute, physical output routing,
output selection, and zero active capture sessions. The test may play a
short tone. Its publisher is a Cargo example excluded from application builds.
The smoke removes its own container. The normal Node test suite exercises
the real helper when it has been built and runs without Docker. The Windows
CI lifecycle step sets `VOICE_ROOM_REQUIRE_NATIVE_VOICE=1` to require it.
