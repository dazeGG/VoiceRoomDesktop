'use strict';

const elements = {
  audioToggle: document.querySelector('#screenAudioToggle'),
  closeButton: document.querySelector('#screenSourceClose'),
  gearButton: document.querySelector('#screenSettingsGear'),
  modeGames: document.querySelector('#screenModeGames'),
  modeText: document.querySelector('#screenModeText'),
  options: document.querySelector('#screenSourceOptions'),
  resToggle: document.querySelector('#screenResToggle'),
  screensTab: document.querySelector('#screenSourceScreensTab'),
  settingsPopover: document.querySelector('#screenSettingsPopover'),
  startButton: document.querySelector('#screenSourceStart'),
  summaryDetail: document.querySelector('#screenSummaryDetail'),
  summaryName: document.querySelector('#screenSummaryName'),
  tablist: document.querySelector('.screen-source-tabs'),
  tabpanel: document.querySelector('#screenSourceTabpanel'),
  windowsTab: document.querySelector('#screenSourceWindowsTab')
};

const sourceButtons = new Map();
let cachedGridColumnCount = 1;

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
  mode: 'games',       // 'games' (30fps) | 'text' (5fps)
  qualityId: 'balanced', // 'balanced' (SD/720p) | 'high' (HD/1080p)
  selectedSourceId: '',
  sourceType: 'screen',
  sources: []
};

init().catch((error) => {
  showInitError(error);
});

function assertPickerElements() {
  for (const [name, element] of Object.entries(elements)) {
    if (!element) {
      throw new Error(`Missing picker element: ${name}`);
    }
  }
}

function showInitError(error) {
  console.error(error);
  if (elements.options) {
    elements.options.textContent = 'Не удалось открыть выбор источника. Закройте окно и попробуйте снова.';
    elements.options.setAttribute('role', 'alert');
  }
  if (elements.startButton) elements.startButton.disabled = true;
}

async function init() {
  assertPickerElements();

  const pickerState = await getPickerState();
  state.sources = pickerState.sources || [];
  state.qualityId = pickerState.defaultQualityId === 'high' ? 'high' : 'balanced';
  state.mode = pickerState.defaultFpsId === '5' ? 'text' : 'games';
  elements.audioToggle.checked = pickerState.defaultStreamAudioEnabled !== false;

  const hasScreen = state.sources.some((source) => source.type === 'screen');
  state.sourceType = hasScreen ? 'screen' : 'window';
  state.selectedSourceId = state.sources.find((source) => source.type === state.sourceType)?.id || state.sources[0]?.id || '';

  elements.screensTab.addEventListener('click', () => setSourceType('screen'));
  elements.windowsTab.addEventListener('click', () => setSourceType('window'));
  elements.closeButton.addEventListener('click', cancelPicker);
  elements.startButton.addEventListener('click', submitSelection);
  elements.gearButton.addEventListener('click', togglePopover);
  elements.modeGames.addEventListener('click', () => setMode('games'));
  elements.modeText.addEventListener('click', () => setMode('text'));
  elements.audioToggle.addEventListener('change', updateSummary);

  elements.resToggle.addEventListener('click', (event) => {
    const preset = event.target?.dataset?.qualityPreset;
    if (!preset) return;
    state.qualityId = preset === 'hd' ? 'high' : 'balanced';
    refreshResToggle();
    updateSummary();
  });

  elements.options.addEventListener('keydown', handleSourceGridKeydown);
  elements.tablist.addEventListener('keydown', handleTablistKeydown);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!elements.settingsPopover.hidden) {
        closePopover();
      } else {
        cancelPicker();
      }
    }
    if (event.key === 'Enter' && state.selectedSourceId) submitSelection();
  });

  document.addEventListener('pointerdown', (event) => {
    if (elements.settingsPopover.hidden) return;
    const wrap = elements.settingsPopover.closest('.screen-source-gear-wrap');
    if (!wrap?.contains(event.target)) closePopover();
  });

  window.addEventListener('resize', updateGridColumnCount);

  refreshTabs();
  refreshResToggle();
  refreshModePresets();
  renderSources();
  updateGridColumnCount();
  updateSummary();
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
  updateSummary();
}

function setMode(mode) {
  state.mode = mode;
  refreshModePresets();
  updateSummary();
}

function togglePopover() {
  if (elements.settingsPopover.hidden) {
    openPopover();
  } else {
    closePopover();
  }
}

function openPopover() {
  elements.settingsPopover.hidden = false;
  elements.gearButton.setAttribute('aria-pressed', 'true');
}

function closePopover() {
  elements.settingsPopover.hidden = true;
  elements.gearButton.setAttribute('aria-pressed', 'false');
}

function refreshTabs() {
  const isScreen = state.sourceType === 'screen';
  elements.screensTab.setAttribute('aria-selected', String(isScreen));
  elements.windowsTab.setAttribute('aria-selected', String(!isScreen));
  elements.tabpanel.setAttribute('aria-labelledby', isScreen ? 'screenSourceScreensTab' : 'screenSourceWindowsTab');
  elements.screensTab.disabled = !state.sources.some((source) => source.type === 'screen');
  elements.windowsTab.disabled = !state.sources.some((source) => source.type === 'window');
}

function refreshResToggle() {
  const isHd = state.qualityId === 'high';
  for (const button of elements.resToggle.querySelectorAll('button')) {
    const isHdBtn = button.dataset.qualityPreset === 'hd';
    button.setAttribute('aria-pressed', String(isHd === isHdBtn));
  }
}

function refreshModePresets() {
  elements.modeGames.setAttribute('aria-pressed', String(state.mode === 'games'));
  elements.modeText.setAttribute('aria-pressed', String(state.mode === 'text'));

  const gamesDot = elements.modeGames.querySelector('.screen-settings-dot');
  const textRadio = elements.modeText.querySelector('.screen-settings-radio');

  if (state.mode === 'games') {
    if (!gamesDot) {
      const dot = document.createElement('span');
      dot.className = 'screen-settings-dot';
      elements.modeGames.querySelector('.screen-settings-radio').append(dot);
    }
    textRadio.replaceChildren();
  } else {
    if (gamesDot) gamesDot.remove();
    if (!textRadio.querySelector('.screen-settings-dot')) {
      const dot = document.createElement('span');
      dot.className = 'screen-settings-dot';
      textRadio.append(dot);
    }
  }
}

function handleTablistKeydown(event) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

  const nextType = state.sourceType === 'screen' ? 'window' : 'screen';
  const nextTab = nextType === 'screen' ? elements.screensTab : elements.windowsTab;
  if (nextTab.disabled) return;

  event.preventDefault();
  setSourceType(nextType);
  nextTab.focus();
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
  updateGridColumnCount();
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
  updateSummary();

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

function updateSummary() {
  const source = state.sources.find((s) => s.id === state.selectedSourceId);
  const qualityLabel = state.qualityId === 'high' ? '1080p' : '720p';
  const fpsLabel = state.mode === 'text' ? '5 к/с' : '30 к/с';
  const audioLabel = elements.audioToggle.checked ? ' · звук' : '';
  const resLabel = state.qualityId === 'high' ? 'HD' : 'SD';

  elements.summaryName.textContent = source?.name ?? 'Не выбрано';
  elements.summaryDetail.textContent = `${resLabel} · ${qualityLabel} · ${fpsLabel}${audioLabel}`;
}

function createSourceButton(source) {
  const button = document.createElement('button');
  button.className = 'screen-source-option';
  button.type = 'button';
  button.dataset.sourceId = source.id;
  syncSourceButton(button, source);
  button.addEventListener('click', () => selectSource(source.id, { focus: true }));
  return button;
}

function syncSourceButton(button, source) {
  button.dataset.sourceId = source.id;
  button.setAttribute('aria-label', source.name);

  let preview = button.querySelector('.screen-source-preview');
  if (!preview) {
    preview = document.createElement('span');
    preview.className = 'screen-source-preview';
    preview.setAttribute('aria-hidden', 'true');
    button.prepend(preview);
  }

  preview.className = `screen-source-preview ${getFallbackPreviewClass(source)}`;
  const thumbnailKey = source.thumbnail || '';
  if (preview.dataset.thumbnailKey === thumbnailKey) {
    syncSourceLabel(button, source);
    return;
  }

  preview.dataset.thumbnailKey = thumbnailKey;
  preview.replaceChildren();

  if (source.thumbnail) {
    const image = document.createElement('img');
    image.alt = `Превью: ${source.name}`;
    image.src = source.thumbnail;
    preview.append(image);
  } else {
    preview.append(...createFallbackPreviewNodes(source));
  }

  syncSourceLabel(button, source);
}

function syncSourceLabel(button, source) {
  let label = button.querySelector('.screen-source-label');
  if (!label) {
    label = document.createElement('span');
    label.className = 'screen-source-label';
    button.append(label);
  }
  label.textContent = source.name;
}

function updateGridColumnCount() {
  const template = window.getComputedStyle(elements.options).gridTemplateColumns;
  if (!template || template === 'none') {
    cachedGridColumnCount = 1;
    return;
  }

  cachedGridColumnCount = Math.max(1, template.split(' ').filter(Boolean).length);
}

function getGridColumnCount() {
  return cachedGridColumnCount;
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
  span.setAttribute('aria-hidden', 'true');
  if (className) span.className = className;
  return span;
}

function submitSelection() {
  const fpsId = state.mode === 'text' ? '5' : '30';
  const selection = {
    fpsId,
    qualityId: state.qualityId,
    sourceId: state.selectedSourceId,
    streamAudioEnabled: elements.audioToggle.checked
  };
  if (!window.voiceRoomScreenPicker?.select) return;
  window.voiceRoomScreenPicker.select(selection).catch((error) => {
    console.error('Picker submit failed:', error);
    elements.startButton.disabled = true;
  });
}

function cancelPicker() {
  if (!window.voiceRoomScreenPicker?.cancel) return;
  window.voiceRoomScreenPicker.cancel().catch((error) => {
    console.error('Picker cancel failed:', error);
  });
}
