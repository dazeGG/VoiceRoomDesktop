use crate::audio;
use livekit::webrtc::stats::RtcStats;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Counters {
    jitter_buffer_delay: f64,
    jitter_buffer_emitted_count: u64,
    concealed_samples: u64,
    silent_concealed_samples: u64,
    concealment_events: u64,
    total_samples_received: u64,
    packets_lost: i64,
}

impl Counters {
    fn accumulate(&mut self, current: Self, mut previous: Self) {
        if current.jitter_buffer_emitted_count < previous.jitter_buffer_emitted_count
            || current.total_samples_received < previous.total_samples_received
        {
            previous = Self::default();
        }
        self.jitter_buffer_delay +=
            (current.jitter_buffer_delay - previous.jitter_buffer_delay).max(0.0);
        self.jitter_buffer_emitted_count +=
            current.jitter_buffer_emitted_count - previous.jitter_buffer_emitted_count;
        self.total_samples_received +=
            current.total_samples_received - previous.total_samples_received;
        self.concealed_samples += current
            .concealed_samples
            .saturating_sub(previous.concealed_samples);
        self.silent_concealed_samples += current
            .silent_concealed_samples
            .saturating_sub(previous.silent_concealed_samples);
        self.concealment_events += current
            .concealment_events
            .saturating_sub(previous.concealment_events);
        self.packets_lost += current.packets_lost - previous.packets_lost;
    }
}

#[derive(Default)]
pub struct ReceiverStats {
    totals: Counters,
    last: [HashMap<String, Counters>; 2],
}

impl ReceiverStats {
    pub fn sample(&mut self, reports: [&[RtcStats]; 2]) -> Value {
        let mut rtt: Option<f64> = None;
        for (last, report) in self.last.iter_mut().zip(reports) {
            let selected: HashSet<_> = report
                .iter()
                .filter_map(|row| match row {
                    RtcStats::Transport(row) => {
                        Some(row.transport.selected_candidate_pair_id.as_str())
                    }
                    _ => None,
                })
                .collect();
            for row in report {
                match row {
                    RtcStats::InboundRtp(row) if row.stream.kind == "audio" => {
                        let current = Counters {
                            jitter_buffer_delay: row.inbound.jitter_buffer_delay,
                            jitter_buffer_emitted_count: row.inbound.jitter_buffer_emitted_count,
                            concealed_samples: row.inbound.concealed_samples,
                            silent_concealed_samples: row.inbound.silent_concealed_samples,
                            concealment_events: row.inbound.concealment_events,
                            total_samples_received: row.inbound.total_samples_received,
                            packets_lost: row.received.packets_lost,
                        };
                        // Keep the last readings after unsubscribe. A returning SSRC can
                        // either resume its counters or start at zero on SDK reconnect.
                        let previous = last.insert(row.rtc.id.clone(), current).unwrap_or_default();
                        self.totals.accumulate(current, previous);
                    }
                    RtcStats::CandidatePair(row) if selected.contains(row.rtc.id.as_str()) => {
                        let seconds = row.candidate_pair.current_round_trip_time;
                        if seconds > 0.0 {
                            rtt = Some(rtt.map_or(seconds, |old| old.max(seconds)));
                        }
                    }
                    _ => {}
                }
            }
        }
        let mut result = json!(self.totals);
        result["rtt"] = json!(rtt);
        result["captureSessions"] = json!(audio::active_sessions(true));
        result["renderSessions"] = json!(audio::active_sessions(false));
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inbound(id: &str, kind: &str, samples: u64, lost: i64) -> RtcStats {
        serde_json::from_value(json!({
            "type": "inbound-rtp", "id": id, "kind": kind, "totalSamplesReceived": samples,
            "jitterBufferDelay": samples as f64 / 100.0, "jitterBufferEmittedCount": samples,
            "concealedSamples": samples / 10, "silentConcealedSamples": samples / 20,
            "concealmentEvents": samples / 20, "packetsLost": lost,
        }))
        .unwrap()
    }

    #[test]
    fn accumulates_audio_through_handoff_removal_and_reset() {
        let mut stats = ReceiverStats::default();
        stats.sample([&[inbound("old", "audio", 200, 5)], &[]]);
        let handoff = stats.sample([
            &[
                inbound("new", "audio", 100, 2),
                inbound("screen", "video", 30, 20),
            ],
            &[],
        ]);
        assert_eq!(handoff["totalSamplesReceived"], 300);
        let resumed = stats.sample([&[inbound("old", "audio", 240, 4)], &[]]);
        assert_eq!(resumed["totalSamplesReceived"], 340);
        let reset = stats.sample([&[inbound("old", "audio", 20, 1)], &[]]);
        assert_eq!(reset["totalSamplesReceived"], 360);
        assert_eq!(reset["jitterBufferEmittedCount"], 360);
        assert_eq!(reset["jitterBufferDelay"], 3.6);
        assert_eq!(reset["concealedSamples"], 36);
        assert_eq!(reset["silentConcealedSamples"], 18);
        assert_eq!(reset["concealmentEvents"], 18);
        assert_eq!(reset["packetsLost"], 7);
        assert_eq!(reset["rtt"], Value::Null);
    }
}
