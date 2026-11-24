//! Synthetic lab publisher. Cargo examples are excluded from the desktop package.
use livekit::{
    options::TrackPublishOptions,
    prelude::*,
    webrtc::{
        audio_frame::AudioFrame,
        audio_source::{native::NativeAudioSource, AudioSourceOptions, RtcAudioSource},
    },
};
use std::{
    borrow::Cow,
    io::{self, BufRead},
    time::Duration,
};
use tokio::time::{interval, MissedTickBehavior};

async fn send() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let url = args.next().ok_or("missing URL")?;
    let amplitude: i16 = args.next().map_or(Ok(1000), |value| value.parse())?;
    let mut input = io::BufReader::new(io::stdin());
    let mut token = String::new();
    input.read_line(&mut token)?;
    let (commands, mut command) = tokio::sync::mpsc::unbounded_channel();
    std::thread::spawn(move || {
        for line in input.lines().map_while(Result::ok) {
            if commands.send(line).is_err() {
                break;
            }
        }
    });
    let mut options = RoomOptions::default();
    options.auto_subscribe = false;
    let (room, _events) = Room::connect(&url, token.trim(), options).await?;
    let source = NativeAudioSource::new(AudioSourceOptions::default(), 48_000, 1, 0);
    let mut sid = publish(&room, &source).await?;

    let mut tick = interval(Duration::from_millis(10));
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    // 400 Hz and exactly four periods per frame, so frame boundaries are continuous.
    let samples: Vec<i16> = (0..480)
        .map(|i| (f32::from(amplitude) * (i as f32 * std::f32::consts::TAU / 120.0).sin()) as i16)
        .collect();
    loop {
        tokio::select! {
            message = command.recv() => {
                match message.as_deref() {
                    Some("republish") => {
                        room.local_participant().unpublish_track(&sid).await?;
                        sid = publish(&room, &source).await?;
                    }
                    _ => break,
                }
            }
            _ = tick.tick() => source.capture_frame(&AudioFrame {
                data: Cow::Borrowed(&samples), sample_rate: 48_000, num_channels: 1, samples_per_channel: 480,
            }).await?,
        }
    }
    room.close().await?;
    Ok(())
}

async fn publish(room: &Room, source: &NativeAudioSource) -> RoomResult<TrackSid> {
    let track = LocalAudioTrack::create_audio_track(
        "native-voice-smoke",
        RtcAudioSource::Native(source.clone()),
    );
    let publication = room
        .local_participant()
        .publish_track(
            LocalTrack::Audio(track),
            TrackPublishOptions {
                source: TrackSource::Microphone,
                dtx: false,
                ..Default::default()
            },
        )
        .await?;
    let sid = publication.sid();
    println!("{sid}");
    Ok(sid)
}

#[tokio::main]
async fn main() {
    std::panic::set_hook(Box::new(|_| eprintln!("smoke sender panic")));
    if send().await.is_err() {
        eprintln!("smoke sender failed");
        std::process::exit(1);
    }
}
