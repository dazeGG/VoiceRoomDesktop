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
    io::{self, BufRead, Read},
    time::Duration,
};
use tokio::time::{interval, MissedTickBehavior};

async fn send() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::args().nth(1).ok_or("missing URL")?;
    let mut input = io::BufReader::new(io::stdin());
    let mut token = String::new();
    input.read_line(&mut token)?;
    let (stop, mut stopped) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let _ = input.read(&mut [0; 1]);
        let _ = stop.send(());
    });
    let mut options = RoomOptions::default();
    options.auto_subscribe = false;
    let (room, _events) = Room::connect(&url, token.trim(), options).await?;
    let source = NativeAudioSource::new(AudioSourceOptions::default(), 48_000, 1, 0);
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
    println!("{}", publication.sid());

    let mut tick = interval(Duration::from_millis(10));
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    // 400 Hz and exactly four periods per frame, so frame boundaries are continuous.
    let samples: Vec<i16> = (0..480)
        .map(|i| (1000.0 * (i as f32 * std::f32::consts::TAU / 120.0).sin()) as i16)
        .collect();
    loop {
        tokio::select! {
            _ = &mut stopped => break,
            _ = tick.tick() => source.capture_frame(&AudioFrame {
                data: Cow::Borrowed(&samples), sample_rate: 48_000, num_channels: 1, samples_per_channel: 480,
            }).await?,
        }
    }
    room.close().await?;
    Ok(())
}

#[tokio::main]
async fn main() {
    std::panic::set_hook(Box::new(|_| eprintln!("smoke sender panic")));
    if send().await.is_err() {
        eprintln!("smoke sender failed");
        std::process::exit(1);
    }
}
