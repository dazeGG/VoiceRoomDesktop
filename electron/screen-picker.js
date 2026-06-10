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

const sourceButtons = new Map();

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
  elements.options.addEventListener('keydown', handleSourceGridKeydown);
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
  const sources = getVisibleSources();
  const nextIds = new Set(sources.map((source) => source.id));

  for (const [sourceId, button] of sourceButtons) {
    if (nextIds.has(sourceId)) continue;
    button.remove();
    sourceButtons.delete(sourceId);
  }

  for (const source of sources) {
    let button = sourceButtons.get(source.id);
    if (!button) {
      button = createSourceButton(source);
      sourceButtons.set(source.id, button);
      elements.options.append(button);
    } else {
      syncSourceButton(button, source);
    }
  }

  updateSourceSelection();
}

function getVisibleSources() {
  return state.sources.filter((source) => source.type === state.sourceType);
}

function getVisibleSourceButtons() {
  return getVisibleSources()
    .map((source) => sourceButtons.get(source.id))
    .filter(Boolean);
}

function selectSource(sourceId, { focus = false } = {}) {
  if (!sourceId || state.selectedSourceId === sourceId) {
    updateSourceSelection();
    return;
  }

  state.selectedSourceId = sourceId;
  updateSourceSelection();

  if (focus) {
    sourceButtons.get(sourceId)?.focus();
  }
}

function updateSourceSelection() {
  for (const [sourceId, button] of sourceButtons) {
    const selected = sourceId === state.selectedSourceId;
    button.setAttribute('aria-pressed', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }

  elements.startButton.disabled = !state.selectedSourceId;
}

function createSourceButton(source) {
  const button = document.createElement('button');
  button.className = 'screen-source-option';
  button.type = 'button';
  button.dataset.sourceId = source.id;
  button.setAttribute('aria-label', source.name);
  syncSourceButton(button, source);
  button.addEventListener('click', () => {
    selectSource(source.id, { focus: true });
  });
  return button;
}

function syncSourceButton(button, source) {
  button.dataset.sourceId = source.id;
  button.setAttribute('aria-label', source.name);

  let preview = button.querySelector('.screen-source-preview');
  if (!preview) {
    preview = document.createElement('span');
    button.prepend(preview);
  }

  preview.className = `screen-source-preview ${getFallbackPreviewClass(source)}`;
  preview.replaceChildren();

  if (source.thumbnail) {
    const image = document.createElement('img');
    image.alt = `Превью: ${source.name}`;
    image.src = source.thumbnail;
    preview.append(image);
  } else {
    preview.append(...createFallbackPreviewNodes(source));
  }

  let label = button.querySelector('.screen-source-label');
  if (!label) {
    label = document.createElement('span');
    label.className = 'screen-source-label';
    button.append(label);
  }
  label.textContent = source.name;
}

function getGridColumnCount() {
  const template = window.getComputedStyle(elements.options).gridTemplateColumns;
  if (!template || template === 'none') return 1;
  return template.split(' ').filter(Boolean).length;
}

function handleSourceGridKeydown(event) {
  const buttons = getVisibleSourceButtons();
  const currentIndex = buttons.indexOf(document.activeElement);
  if (currentIndex === -1) return;

  const columnCount = getGridColumnCount();
  let nextIndex = currentIndex;

  switch (event.key) {
    case 'ArrowRight':
      nextIndex = currentIndex + 1;
      break;
    case 'ArrowLeft':
      nextIndex = currentIndex - 1;
      break;
    case 'ArrowDown':
      nextIndex = currentIndex + columnCount;
      break;
    case 'ArrowUp':
      nextIndex = currentIndex - columnCount;
      break;
    case 'Home':
      nextIndex = 0;
      break;
    case 'End':
      nextIndex = buttons.length - 1;
      break;
    default:
      return;
  }

  const nextButton = buttons[nextIndex];
  if (!nextButton) return;

  event.preventDefault();
  selectSource(nextButton.dataset.sourceId, { focus: true });
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