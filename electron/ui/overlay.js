'use strict';

const card = document.querySelector('#overlayCard');
const title = document.querySelector('#overlayTitle');
const people = document.querySelector('#overlayPeople');
const controls = document.querySelector('#overlayControls');
const micButton = document.querySelector('#overlayMic');
const outputButton = document.querySelector('#overlayOutput');
const leaveButton = document.querySelector('#overlayLeave');
const hint = document.querySelector('#overlayHint');

function escapeText(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function participantFlags(participant) {
  const flags = [];
  if (participant.micMuted) flags.push('мик');
  if (participant.outputMuted) flags.push('звук');
  return flags.join(' · ');
}

function renderParticipants(participants) {
  people.innerHTML = participants.map((participant) => {
    const label = participant.name || (participant.self ? 'Вы' : 'Участник');
    const flags = participantFlags(participant);
    return `<li class="overlay-person" data-speaking="${participant.speaking ? 'true' : 'false'}">
      <span class="overlay-dot" aria-hidden="true"></span>
      <span class="overlay-name">${escapeText(label)}${participant.self ? ' (вы)' : ''}</span>
      ${flags ? `<span class="overlay-flags">${escapeText(flags)}</span>` : ''}
    </li>`;
  }).join('');
}

function render(state) {
  if (!state || !card) return;

  const opacity = Number.isFinite(state.settings?.opacity) ? state.settings.opacity : 0.92;
  card.style.setProperty('--overlay-opacity', String(opacity));
  card.style.opacity = String(opacity);
  card.hidden = false;
  card.dataset.interactive = state.interactive ? 'true' : 'false';

  const roomName = state.call?.roomName || (state.previewing ? 'Предпросмотр' : 'В звонке');
  title.textContent = roomName;

  const showPeople = state.settings?.showParticipants !== false && Array.isArray(state.participants) && state.participants.length > 0;
  people.hidden = !showPeople;
  if (showPeople) renderParticipants(state.participants);

  const showControls = state.settings?.showControls !== false;
  controls.hidden = !showControls;
  if (showControls) {
    const micMuted = state.call?.micMuted === true;
    const outputMuted = state.call?.outputMuted === true;
    micButton.textContent = micMuted ? 'Мик. выкл' : 'Микрофон';
    micButton.setAttribute('aria-pressed', micMuted ? 'true' : 'false');
    micButton.setAttribute('aria-label', micMuted ? 'Включить микрофон' : 'Выключить микрофон');
    outputButton.textContent = outputMuted ? 'Звук выкл' : 'Звук';
    outputButton.setAttribute('aria-pressed', outputMuted ? 'true' : 'false');
    outputButton.setAttribute('aria-label', outputMuted ? 'Включить звук' : 'Выключить звук');
  }

  const showHint = Boolean(state.interactive && state.hint);
  hint.hidden = !showHint;
  hint.textContent = showHint ? `Клики в Voice Room · ${state.hint} — обратно в игру` : '';
}

function reportSize() {
  if (!card || card.hidden) return;
  const rect = card.getBoundingClientRect();
  window.voiceRoomOverlay?.reportSize?.({
    height: Math.ceil(rect.height),
    width: Math.ceil(rect.width)
  }).catch(() => {});
}

micButton?.addEventListener('click', () => {
  window.voiceRoomOverlay?.action?.('toggle-mic').catch(() => {});
});
outputButton?.addEventListener('click', () => {
  window.voiceRoomOverlay?.action?.('toggle-output').catch(() => {});
});
leaveButton?.addEventListener('click', () => {
  window.voiceRoomOverlay?.action?.('disconnect').catch(() => {});
});

window.voiceRoomOverlay?.onState?.((state) => {
  render(state);
  requestAnimationFrame(reportSize);
});

if (window.ResizeObserver && card) {
  new ResizeObserver(() => reportSize()).observe(card);
}

window.voiceRoomOverlay?.ready?.().catch(() => {});
