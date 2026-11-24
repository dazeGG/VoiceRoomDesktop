mod audio;
mod parent;
mod protocol;
mod stats;

use audio::{Output, OUTPUT_NOT_RENDERING};
use livekit::prelude::*;
use protocol::{Frame, VERSION};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    io::{self, Write},
    time::Duration,
};
use tokio::{
    sync::mpsc,
    time::{interval, timeout, MissedTickBehavior},
};

type Reply = Result<Value, &'static str>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Join {
    url: String,
    token: String,
    #[serde(default)]
    tracks: HashSet<String>,
    #[serde(default)]
    output_device: Option<String>,
    #[serde(default = "initial_mute")]
    muted: bool,
}

fn initial_mute() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Subscriptions {
    tracks: HashSet<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Mute {
    muted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Device {
    output_device: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Update {
    #[serde(default, deserialize_with = "updated")]
    tracks: Option<HashSet<String>>,
    #[serde(default, deserialize_with = "updated")]
    muted: Option<bool>,
    #[serde(default, deserialize_with = "updated")]
    output_device: Option<Option<String>>,
}

fn updated<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

struct Session {
    room: Room,
    events: mpsc::UnboundedReceiver<RoomEvent>,
    output: Output,
    tracks: HashSet<String>,
    stats: stats::ReceiverStats,
}

impl Session {
    async fn connect(join: Join) -> Result<Self, &'static str> {
        validate_tracks(&join.tracks)?;
        if join.token.is_empty()
            || join.token.len() > 16384
            || join.url.len() > 4096
            || !(join.url.starts_with("ws://") || join.url.starts_with("wss://"))
        {
            return Err("bad-payload");
        }
        let output = Output::new(join.output_device)?;
        let mut options = RoomOptions::default();
        options.auto_subscribe = false;
        let (room, events) = timeout(
            Duration::from_secs(10),
            Room::connect(&join.url, &join.token, options),
        )
        .await
        .map_err(|_| "join-timeout")?
        .map_err(|_| "join-failed")?;
        let mut session = Self {
            room,
            events,
            output,
            tracks: join.tracks,
            stats: stats::ReceiverStats::default(),
        };
        session.reconcile();
        if !join.muted {
            session.output.unmute(session.should_render())?;
        }
        Ok(session)
    }

    fn reconcile(&self) {
        let identity = self.room.local_participant().identity();
        let canonical = identity
            .as_str()
            .split_once("#voice.")
            .map(|(peer, _)| peer);
        for participant in self.room.remote_participants().into_values() {
            let is_self = canonical == Some(participant.identity().as_str());
            for publication in participant.track_publications().into_values() {
                let desired = !is_self
                    && publication.kind() == TrackKind::Audio
                    && publication.source() == TrackSource::Microphone
                    && self.tracks.contains(publication.sid().as_str());
                if desired != publication.is_desired() {
                    publication.set_subscribed(desired);
                }
            }
        }
    }

    fn transport(&self) -> Value {
        let state = match self.room.connection_state() {
            ConnectionState::Connected => "connected",
            ConnectionState::Reconnecting => "reconnecting",
            ConnectionState::Disconnected => "disconnected",
        };
        json!({ "state": state })
    }

    fn should_render(&self) -> bool {
        self.room.connection_state() == ConnectionState::Connected
            && !self.tracks.is_empty()
            && self.room.remote_participants().into_values().any(|peer| {
                peer.track_publications().into_values().any(|publication| {
                    publication.is_desired()
                        && publication.track().is_some()
                        && self.tracks.contains(publication.sid().as_str())
                })
            })
    }

    async fn stats(&mut self) -> Reply {
        let stats = timeout(Duration::from_millis(750), self.room.get_stats())
            .await
            .map_err(|_| "stats-timeout")?
            .map_err(|_| "stats-failed")?;
        Ok(self
            .stats
            .sample([&stats.subscriber_stats, &stats.publisher_stats]))
    }

    fn update(&mut self, update: Update) -> Reply {
        if let Some(tracks) = &update.tracks {
            validate_tracks(tracks)?;
        }
        if update.muted == Some(true) {
            self.output.mute();
        }
        let device_changed = update.output_device.is_some();
        if let Some(device) = update.output_device {
            self.output.set_device(device)?;
        }
        if let Some(tracks) = update.tracks {
            self.tracks = tracks;
            self.reconcile();
        }
        if update.muted == Some(false) {
            self.output.unmute(self.should_render())?;
        } else if device_changed {
            self.output.verify_active_playout(self.should_render())?;
        }
        Ok(self.output.state())
    }

    async fn close(self) -> Reply {
        let mut output = self.output;
        output.mute();
        timeout(Duration::from_secs(2), self.room.close())
            .await
            .map_err(|_| "leave-timeout")?
            .map_err(|_| "leave-failed")?;
        Ok(json!({}))
    }
}

fn validate_tracks(tracks: &HashSet<String>) -> Result<(), &'static str> {
    if tracks.len() > 128
        || tracks
            .iter()
            .any(|sid| !sid.starts_with("TR_") || sid.len() > 128)
    {
        return Err("bad-payload");
    }
    Ok(())
}

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, &'static str> {
    serde_json::from_value(value).map_err(|_| "bad-payload")
}

fn empty(value: &Value) -> Result<(), &'static str> {
    if value.as_object().is_some_and(serde_json::Map::is_empty) {
        Ok(())
    } else {
        Err("bad-payload")
    }
}

async fn handle(session: &mut Option<Session>, kind: &str, payload: Value) -> Reply {
    match kind {
        "ping" => {
            empty(&payload)?;
            Ok(json!({}))
        }
        "list-outputs" => {
            empty(&payload)?;
            audio::list_outputs()
        }
        "update" => session
            .as_mut()
            .ok_or("not-joined")?
            .update(decode(payload)?),
        "join" => {
            if session.is_some() {
                return Err("already-joined");
            }
            let joined = Session::connect(decode(payload)?).await?;
            let state = joined.output.state();
            *session = Some(joined);
            Ok(state)
        }
        "leave" | "shutdown" => {
            empty(&payload)?;
            match session.take() {
                Some(joined) => joined.close().await,
                None => Ok(json!({})),
            }
        }
        "subscriptions" => {
            let request: Subscriptions = decode(payload)?;
            validate_tracks(&request.tracks)?;
            let joined = session.as_mut().ok_or("not-joined")?;
            joined.tracks = request.tracks;
            joined.reconcile();
            Ok(json!({}))
        }
        "output-mute" => {
            let request: Mute = decode(payload)?;
            session.as_mut().ok_or("not-joined")?.update(Update {
                muted: Some(request.muted),
                tracks: None,
                output_device: None,
            })
        }
        "output-device" => {
            let request: Device = decode(payload)?;
            session.as_mut().ok_or("not-joined")?.update(Update {
                muted: None,
                tracks: None,
                output_device: Some(request.output_device),
            })
        }
        _ => Err("unknown-command"),
    }
}

fn emit(out: &mut impl Write, epoch: &str, id: u32, kind: &str, payload: Value) -> io::Result<()> {
    protocol::write(
        out,
        &Frame {
            v: VERSION,
            epoch: epoch.into(),
            id,
            kind: kind.into(),
            payload,
        },
    )
}

async fn run(epoch: &str, output: &mut impl Write) -> io::Result<()> {
    let (tx, mut rx) = mpsc::channel(16);
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            match protocol::read(&mut input) {
                Ok(Some(frame)) => {
                    if tx.blocking_send(Ok(frame)).is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(code) => {
                    let _ = tx.blocking_send(Err(code));
                    break;
                }
            }
        }
    });
    emit(
        output,
        epoch,
        0,
        "hello",
        json!({
            "helperVersion": env!("CARGO_PKG_VERSION"),
            "capabilities": { "receive": true, "capture": false, "publish": false, "outputSelection": true },
        }),
    )?;
    emit(
        output,
        epoch,
        0,
        "ready",
        json!({ "captureInitialized": false }),
    )?;

    let mut session: Option<Session> = None;
    let mut tick = interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    tick.tick().await;
    loop {
        tokio::select! {
            request = rx.recv() => {
                let Some(request) = request else { break };
                let frame = match request {
                    Ok(frame) => frame,
                    Err(code) => {
                        emit(output, epoch, 0, "fault", json!({ "code": code }))?;
                        break;
                    }
                };
                let shutdown = frame.kind == "shutdown" && empty(&frame.payload).is_ok();
                let result = if frame.v != VERSION { Err("version-mismatch") }
                    else if frame.epoch != epoch { Err("stale-epoch") }
                    else if frame.id == 0 { Err("bad-id") }
                    else { handle(&mut session, &frame.kind, frame.payload).await };
                let successful = result.is_ok();
                let command = match frame.kind.as_str() {
                    "join" | "leave" | "shutdown" | "subscriptions" | "output-mute" | "output-device" | "ping"
                    | "list-outputs" | "update" => Some(frame.kind.as_str()),
                    _ => None,
                };
                let valid_request = frame.v == VERSION && frame.epoch == epoch && frame.id != 0;
                let output_failed = result == Err(OUTPUT_NOT_RENDERING);
                if output_failed {
                    if let Some(joined) = &session {
                        emit(output, epoch, 0, "device", joined.output.state())?;
                    }
                }
                match result {
                    Ok(data) => emit(output, epoch, frame.id, "response", json!({ "command": command, "data": data }))?,
                    Err(code) => emit(output, epoch, frame.id, "error", json!({ "command": command, "code": code }))?,
                }
                if valid_request && shutdown { break; }
                if successful && frame.kind == "leave" {
                    emit(output, epoch, 0, "transport", json!({ "state": "disconnected" }))?;
                }
                if let Some(joined) = &session {
                    match frame.kind.as_str() {
                        "join" if successful => {
                            emit(output, epoch, 0, "transport", joined.transport())?;
                            emit(output, epoch, 0, "media-ready", json!({ "captureInitialized": false }))?;
                            emit(output, epoch, 0, "device", joined.output.state())?;
                        }
                        "output-mute" | "output-device" | "update" if valid_request && !output_failed => {
                            emit(output, epoch, 0, "device", joined.output.state())?;
                        }
                        _ => {}
                    }
                }
            }
            event = async { session.as_mut().unwrap().events.recv().await }, if session.is_some() => {
                let joined = session.as_ref().unwrap();
                match event {
                    Some(RoomEvent::TrackPublished { .. } | RoomEvent::TrackSubscribed { .. } | RoomEvent::Reconnected) => joined.reconcile(),
                    Some(RoomEvent::ConnectionStateChanged(_)) => emit(output, epoch, 0, "transport", joined.transport())?,
                    Some(RoomEvent::Disconnected { .. }) | None => {
                        emit(output, epoch, 0, "transport", json!({ "state": "disconnected" }))?;
                        let _ = session.take().unwrap().close().await;
                    }
                    _ => {}
                }
            }
            _ = tick.tick(), if session.is_some() => {
                let joined = session.as_mut().unwrap();
                if let Err(code) = joined.output.verify_active_playout(joined.should_render()) {
                    emit(output, epoch, 0, "device", joined.output.state())?;
                    emit(output, epoch, 0, "fault", json!({ "code": code }))?;
                    break;
                }
                if let Ok(stats) = joined.stats().await {
                    emit(output, epoch, 0, "stats", stats)?;
                }
            }
        }
    }
    if let Some(joined) = session {
        let _ = joined.close().await;
    }
    Ok(())
}

#[tokio::main]
async fn main() {
    std::panic::set_hook(Box::new(|_| eprintln!("voice: panic")));
    let args: Vec<_> = std::env::args().skip(1).collect();
    let [epoch, parent_pid] = args.as_slice() else {
        eprintln!("voice: invalid startup arguments");
        std::process::exit(2);
    };
    if epoch.is_empty()
        || epoch.len() > 128
        || !epoch
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        eprintln!("voice: invalid epoch");
        std::process::exit(2);
    }
    let result = parent_pid
        .parse::<u32>()
        .ok()
        .filter(|pid| *pid != 0 && *pid != std::process::id())
        .ok_or("bad-parent")
        .and_then(parent::watch);
    if let Err(code) = result {
        eprintln!("voice: {code}");
        std::process::exit(2);
    }
    if run(epoch, &mut io::stdout().lock()).await.is_err() {
        eprintln!("voice: pipe-write-failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_distinguishes_default_output_from_an_omitted_output() {
        assert_eq!(decode::<Update>(json!({})).unwrap().output_device, None);
        assert_eq!(
            decode::<Update>(json!({ "outputDevice": null }))
                .unwrap()
                .output_device,
            Some(None)
        );
        assert_eq!(
            decode::<Update>(json!({ "outputDevice": "endpoint", "muted": false }))
                .unwrap()
                .output_device,
            Some(Some("endpoint".into()))
        );
        for invalid in [
            json!({ "muted": null }),
            json!({ "tracks": null }),
            json!({ "token": "not an update field" }),
        ] {
            assert!(matches!(decode::<Update>(invalid), Err("bad-payload")));
        }
    }
}
