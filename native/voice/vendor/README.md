# LiveKit remote playout gain patches

The helper uses local Cargo patches of crates.io `libwebrtc` 0.4.2 and
`webrtc-sys` 0.3.55. Both packages came from
[LiveKit Rust SDK commit 2811b4b](https://github.com/livekit/rust-sdks/tree/2811b4be194b091868ed83cca0603842179fed36).
The copies contain the source, manifests and notices needed by the Windows
helper. They omit upstream tests, standalone WebRTC build tooling and
Linux-only hardware acceleration sources. See the [Apache license](LICENSE)
and [upstream notices](webrtc-sys/NOTICE.md).

The `audio_track` bridge exposes `RtcAudioTrack::set_remote_volume` for
remote sources. The shim validates [0, 4] and adds a gain marker sink on
the owning runtime's signaling thread. The pinned receive channel invokes
the marker synchronously inside the mixer pull on the same thread. The
mixer adapter starts each pull at zero and permits only the gain supplied
by the source pulled in that frame. The sink stores no PCM. For boost,
the adapter limits each frame's gain using its peak before the signed
16-bit conversion. It delegates combining and multi-source limiting to
the stock mixer.
[Receive channel](https://github.com/webrtc-sdk/webrtc/blob/a545de4/audio/channel_receive.cc)
[Frame combiner](https://github.com/webrtc-sdk/webrtc/blob/a545de4/modules/audio_mixer/frame_combiner.cc)

The receive-only switch in `AdmProxy` prepares a new PlatformAudio device
with a silent transport. An active switch waits for the new device clock
before stopping the old one and forwarding the real transport. There is
one WebRTC transport reader at any time. The old route remains active if
the candidate fails. Recording stays disabled on this path.

The original WebRTC prebuilt owns the device pull, mixing and WASAPI
submission. The build wrapper verifies the unchanged `webrtc-a545de4`
Windows archive against SHA-256
`862403fcb248c7d8803487e4c22b8821c6130e89100cb9c69be95ef45ff46146`.
The receive-test feature adds diagnostic peaks and virtual endpoints
solely for the Windows integration test.
