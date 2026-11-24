#pragma once

#include <atomic>

#include "api/audio/audio_mixer.h"
#include "api/media_stream_interface.h"
#include "api/scoped_refptr.h"

namespace livekit_ffi {

// The pinned receive channel calls this sink synchronously inside its source
// pull. Supply the gain for that pull without storing or copying any PCM.
class ReceiveGain : public webrtc::AudioTrackSinkInterface {
 public:
  explicit ReceiveGain(double gain) : gain_(gain) {}
  void Set(double gain) { gain_.store(gain, std::memory_order_relaxed); }
  void OnData(const void*, int, int, size_t, size_t) override;

 private:
  std::atomic<double> gain_;
};

webrtc::scoped_refptr<webrtc::AudioMixer> CreateReceiveGainMixer();

}  // namespace livekit_ffi
