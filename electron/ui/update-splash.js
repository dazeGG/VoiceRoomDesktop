'use strict';

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
  blocked: 'Нет доступа',
  checking: 'Запуск',
  downloading: 'Обновление',
  installing: 'Установка',
  'site-unavailable': 'Сайт недоступен',
  'update-error': 'Ошибка обновления'
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
  const phase = state?.phase || 'checking';
  elements.title.textContent = phaseTitles[phase] || 'Запуск';
  elements.message.textContent = state?.message || 'Проверка обновлений...';
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