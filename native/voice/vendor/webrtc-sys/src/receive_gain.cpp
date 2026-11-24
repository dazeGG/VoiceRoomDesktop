#include "livekit/receive_gain.h"

#include <algorithm>
#include <cmath>
#include <memory>
#include <unordered_map>

#if defined(VOICEROOM_RECEIVE_TEST)
#include <cstdio>
#include <cstdlib>
#endif

#include "api/make_ref_counted.h"
#include "modules/audio_mixer/audio_mixer_impl.h"
#include "rtc_base/synchronization/mutex.h"

namespace livekit_ffi {
namespace {

thread_local double pulled_gain = 0.0;
constexpr double kBoostPeak = 32112.0;  // 98% of full scale.

int Peak(const webrtc::AudioFrame& frame) {
  int peak = 0;
  for (const auto sample : frame.data_view()) {
    peak = std::max(peak, std::abs(static_cast<int>(sample)));
  }
  return peak;
}

#if defined(VOICEROOM_RECEIVE_TEST)
bool TraceEnabled() {
  static const bool enabled = std::getenv("VR_VOICE_TEST_ENDPOINTS") != nullptr;
  return enabled;
}
#endif

class GainSource : public webrtc::AudioMixer::Source {
 public:
  explicit GainSource(Source* input) : input_(input) {}

  AudioFrameInfo GetAudioFrameWithInfo(int rate,
                                      webrtc::AudioFrame* frame) override {
    pulled_gain = 0.0;
    const auto result = input_->GetAudioFrameWithInfo(rate, frame);
    if (result != AudioFrameInfo::kNormal) return result;
    double gain = pulled_gain;
#if defined(VOICEROOM_RECEIVE_TEST)
    const int input_peak = TraceEnabled() ? Peak(*frame) : 0;
    auto trace = [&](int output_peak) {
      if (input_peak > 0) {
        std::fprintf(stderr, "voice-test source %u %d %d\n",
                     static_cast<unsigned>(Ssrc()), input_peak, output_peak);
      }
    };
#endif
    if (gain == 0.0) {
#if defined(VOICEROOM_RECEIVE_TEST)
      trace(0);
#endif
      frame->Mute();
      return AudioFrameInfo::kMuted;
    }
    if (gain > 1.0) {
      const int peak = Peak(*frame);
      // Full-scale input cannot be boosted, but need not be attenuated.
      if (peak > 0) gain = std::max(1.0, std::min(gain, kBoostPeak / peak));
    }
    if (gain != 1.0) {
      for (auto& sample : frame->mutable_data(frame->samples_per_channel(),
                                              frame->num_channels())) {
        sample = static_cast<int16_t>(sample * gain);
      }
    }
#if defined(VOICEROOM_RECEIVE_TEST)
    if (input_peak > 0) trace(Peak(*frame));
#endif
    return result;
  }

  int Ssrc() const override { return input_->Ssrc(); }
  int PreferredSampleRate() const override { return input_->PreferredSampleRate(); }

 private:
  Source* const input_;
};

class ReceiveGainMixer : public webrtc::AudioMixer {
 public:
  bool AddSource(Source* source) override {
    webrtc::MutexLock lock(&sources_lock_);
    if (sources_.contains(source)) return false;
    auto entry = std::make_unique<GainSource>(source);
    if (!mix_->AddSource(entry.get())) return false;
    sources_.emplace(source, std::move(entry));
    return true;
  }

  void RemoveSource(Source* source) override {
    webrtc::MutexLock lock(&sources_lock_);
    auto entry = sources_.find(source);
    mix_->RemoveSource(entry->second.get());
    sources_.erase(entry);
  }

  void Mix(size_t channels, webrtc::AudioFrame* frame) override {
    mix_->Mix(channels, frame);
#if defined(VOICEROOM_RECEIVE_TEST)
    if (TraceEnabled()) std::fprintf(stderr, "voice-test mix %d\n", Peak(*frame));
#endif
  }

 private:
  const webrtc::scoped_refptr<webrtc::AudioMixer> mix_ =
      webrtc::AudioMixerImpl::Create();
  webrtc::Mutex sources_lock_;
  std::unordered_map<Source*, std::unique_ptr<GainSource>> sources_;
};

}  // namespace

void ReceiveGain::OnData(const void*, int, int, size_t, size_t) {
  pulled_gain = gain_.load(std::memory_order_relaxed);
}

webrtc::scoped_refptr<webrtc::AudioMixer> CreateReceiveGainMixer() {
  return webrtc::make_ref_counted<ReceiveGainMixer>();
}

}  // namespace livekit_ffi
