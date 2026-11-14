'use strict';

const t = window.voiceRoomI18n.t;
let lastState = null;

const elements = {
  message: document.querySelector('#updateMessage'),
  progress: document.querySelector('#updateProgress'),
  progressBar: document.querySelector('#updateProgressBar'),
  progressLabel: document.querySelector('#updateProgressLabel'),
  proceed: document.querySelector('#updateProceed'),
  quit: document.querySelector('#updateQuit'),
  title: document.querySelector('#updateTitle')
};

const phaseTitles = {
  blocked: 'phaseBlocked',
  checking: 'phaseChecking',
  downloading: 'phaseDownloading',
  installing: 'phaseInstalling',
  'site-unavailable': 'phaseSiteUnavailable',
  'update-error': 'phaseUpdateError'
};

elements.proceed.addEventListener('click', () => {
  window.voiceRoomUpdateGate?.proceed?.().catch(() => {});
});

elements.quit.addEventListener('click', () => {
  window.voiceRoomUpdateGate?.quit?.().catch(() => {});
});

if (window.voiceRoomUpdateGate?.onState) {
  window.voiceRoomUpdateGate.onState(renderState);
}

function renderState(state) {
  lastState = state;
  const phase = state?.phase || 'checking';
  elements.title.textContent = t(phaseTitles[phase] || 'phaseChecking');
  const messages = { checking: 'checkingUpdate', downloading: 'downloadingUpdate', installing: 'installingUpdate', 'site-unavailable': 'siteUnavailable' };
  elements.message.textContent = phase === 'update-error'
    ? `${t('updateError')} ${t(state?.canProceed ? 'proceedWithoutUpdate' : 'checkingSite')}`
    : messages[phase] ? t(messages[phase]) : state?.message || t('checkingUpdate');
  elements.message.classList.toggle('is-error', Boolean(state?.blocked));

  const showProgress = phase === 'downloading' || phase === 'installing';
  elements.progress.hidden = !showProgress;
  elements.progressLabel.hidden = !showProgress;

  if (showProgress) {
    const progress = Number.isFinite(state?.progress) ? state.progress : 0;
    elements.progressBar.style.width = `${progress}%`;
    elements.progressLabel.textContent = `${progress}%`;
  }

  elements.proceed.hidden = !state?.canProceed;
  elements.quit.hidden = !state?.blocked;
}
window.voiceRoomI18n.subscribe(() => renderState(lastState));
