'use strict';

const elements = {
  audioToggle: document.querySelector('#screenAudioToggle'),
  closeButton: document.querySelector('#screenSourceClose'),
  fpsOptions: document.querySelector('#screenFpsOptions'),
  options: document.querySelector('#screenSourceOptions'),
  qualityOptions: document.querySelector('#screenQualityOptions'),
  screensTab: document.querySelector('#screenSourceScreensTab'),
  startButton: document.querySelector('#screenSourceStart'),
  windowsTab: document.querySelector('#screenSourceWindowsTab')
};

const fallbackState = {
  defaultFpsId: '30',
  defaultQualityId: 'balanced',
  defaultStreamAudioEnabled: true,
  sources: [
    { id: 'screen:1:0', name: 'Весь экран', thumbnail: '', type: 'screen' },
    { id: 'window:1:0', name: 'Cursor - VoiceRoom', thumbnail: '', type: 'window' },
    { id: 'window:2:0', name: 'voiceroom.ru', thumbnail: '', type: 'window' },
    { id: 'window:3:0', name: 'Telegram', thumbnail: '', type: 'window' }
  ]
};

const state = {
  fpsId: '30',
  qualityId: 'balanced',
  selectedSourceId: '',
  sourceType: 'screen',
  sources: []
};

init().catch((error) => {
  console.error(error);
});

async function init() {
  const pickerState = await getPickerState();
  state.sources = pickerState.sources || [];
  state.qualityId = pickerState.defaultQualityId || 'balanced';
  state.fpsId = pickerState.defaultFpsId || '30';
  elements.audioToggle.checked = pickerState.defaultStreamAudioEnabled !== false;

  const hasScreen = state.sources.some((source) => source.type === 'screen');
  state.sourceType = hasScreen ? 'screen' : 'window';
  state.selectedSourceId = state.sources.find((source) => source.type === state.sourceType)?.id || state.sources[0]?.id || '';

  elements.screensTab.addEventListener('click', () => setSourceType('screen'));
  elements.windowsTab.addEventListener('click', () => setSourceType('window'));
  elements.closeButton.addEventListener('click', cancelPicker);
  elements.startButton.addEventListener('click', submitSelection);
  elements.qualityOptions.addEventListener('click', (event) => {
    const qualityId = event.target?.dataset?.qualityId;
    if (!qualityId) return;
    state.qualityId = qualityId;
    refreshSegments();
  });
  elements.fpsOptions.addEventListener('click', (event) => {
    const fpsId = event.target?.dataset?.fpsId;
    if (!fpsId) return;
    state.fpsId = fpsId;
    refreshSegments();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') cancelPicker();
    if (event.key === 'Enter' && state.selectedSourceId) submitSelection();
  });

  refreshTabs();
  refreshSegments();
  renderSources();
}

async function getPickerState() {
  if (!window.voiceRoomScreenPicker?.getState) return fallbackState;
  return window.voiceRoomScreenPicker.getState();
}

function setSourceType(type) {
  if (state.sourceType === type) return;
  state.sourceType = type;
  state.selectedSourceId = state.sources.find((source) => source.type === type)?.id || '';
  refreshTabs();
  renderSources();
}

function refreshTabs() {
  elements.screensTab.setAttribute('aria-pressed', String(state.sourceType === 'screen'));
  elements.windowsTab.setAttribute('aria-pressed', String(state.sourceType === 'window'));
  elements.screensTab.disabled = !state.sources.some((source) => source.type === 'screen');
  elements.windowsTab.disabled = !state.sources.some((source) => source.type === 'window');
}

function refreshSegments() {
  for (const button of elements.qualityOptions.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.qualityId === state.qualityId));
  }
  for (const button of elements.fpsOptions.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.fpsId === state.fpsId));
  }
}

function renderSources() {
  elements.options.textContent = '';
  const sources = state.sources.filter((source) => source.type === state.sourceType);

  for (const source of sources) {
    const button = createSourceButton(source);
    elements.options.append(button);
  }

  elements.startButton.disabled = !state.selectedSourceId;
}

function createSourceButton(source) {
  const button = document.createElement('button');
  button.className = 'screen-source-option';
  button.type = 'button';
  button.setAttribute('aria-label', source.name);
  button.setAttribute('aria-pressed', String(source.id === state.selectedSourceId));

  const preview = document.createElement('span');
  preview.className = `screen-source-preview ${getFallbackPreviewClass(source)}`;
  if (source.thumbnail) {
    const image = document.createElement('img');
    image.alt = '';
    image.src = source.thumbnail;
    preview.append(image);
  } else {
    preview.append(...createFallbackPreviewNodes(source));
  }

  const label = document.createElement('span');
  label.className = 'screen-source-label';
  label.textContent = source.name;

  button.append(preview, label);
  button.addEventListener('click', () => {
    state.selectedSourceId = source.id;
    renderSources();
  });
  return button;
}

function getFallbackPreviewClass(source) {
  if (source.thumbnail) return '';
  if (source.type === 'screen') return 'preview-desktop';
  if (/cursor|code|voice/i.test(source.name)) return 'preview-code';
  if (/room|browser|chrome|safari|edge|firefox/i.test(source.name)) return 'preview-browser';
  return 'preview-chat';
}

function createFallbackPreviewNodes(source) {
  if (source.type === 'screen') {
    return [
      createPreviewSpan('preview-topbar'),
      createPreviewSpan('preview-layout')
    ];
  }
  if (/cursor|code|voice/i.test(source.name)) {
    return [createPreviewSpan(), createPreviewSpan(), createPreviewSpan(), createPreviewSpan()];
  }
  if (/room|browser|chrome|safari|edge|firefox/i.test(source.name)) {
    return [
      createPreviewSpan('preview-address'),
      createPreviewSpan('preview-room')
    ];
  }
  return [createPreviewSpan(), createPreviewSpan(), createPreviewSpan()];
}

function createPreviewSpan(className = '') {
  const span = document.createElement('span');
  if (className) span.className = className;
  return span;
}

function submitSelection() {
  const selection = {
    fpsId: state.fpsId,
    qualityId: state.qualityId,
    sourceId: state.selectedSourceId,
    streamAudioEnabled: elements.audioToggle.checked
  };
  if (!window.voiceRoomScreenPicker?.select) return;
  window.voiceRoomScreenPicker.select(selection).catch((error) => console.error(error));
}

function cancelPicker() {
  if (!window.voiceRoomScreenPicker?.cancel) return;
  window.voiceRoomScreenPicker.cancel().catch((error) => console.error(error));
}
