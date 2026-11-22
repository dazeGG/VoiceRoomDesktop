'use strict';

const t = window.voiceRoomI18n.t;

const elements = {
  appAudioRow: document.querySelector('#screenAppAudioRow'),
  appAudioToggle: document.querySelector('#screenAppAudioToggle'),
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
  appAudioSupported: true,
  defaultFpsId: '30',
  defaultQualityId: 'balanced',
  defaultStreamAudioEnabled: true,
  sources: [
    { id: 'screen:1:0', name: t('entireScreen'), thumbnail: '', type: 'screen' },
    { id: 'window:1:0', name: 'Cursor - VoiceRoom', thumbnail: '', type: 'window' },
    { id: 'window:2:0', name: 'voiceroom.ru', thumbnail: '', type: 'window' },
    { id: 'window:3:0', name: 'Telegram', thumbnail: '', type: 'window' }
  ]
};

const state = {
  appAudioSupported: false,
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
    elements.options.textContent = t('pickerError');
    elements.options.setAttribute('role', 'alert');
  }
  if (elements.startButton) elements.startButton.disabled = true;
}

async function init() {
  assertPickerElements();

  const pickerState = await getPickerState();
  state.sources = pickerState.sources || [];
  state.appAudioSupported = pickerState.appAudioSupported === true;
  state.qualityId = pickerState.defaultQualityId === 'high' ? 'high' : 'balanced';
  state.mode = pickerState.defaultFpsId === '5' ? 'text' : 'games';
  setChecked(elements.audioToggle, pickerState.defaultStreamAudioEnabled !== false);

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
  bindChecked(elements.audioToggle);
  bindChecked(elements.appAudioToggle);

  elements.resToggle.addEventListener('click', (event) => {
    const preset = event.target?.dataset?.qualityPreset;
    if (!preset) return;
    state.qualityId = preset === 'hd' ? 'high' : 'balanced';
    refreshResToggle();
    updateSummary();
  });

  elements.resToggle.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    state.qualityId = state.qualityId === 'high' ? 'balanced' : 'high';
    refreshResToggle();
    updateSummary();
    const preset = state.qualityId === 'high' ? 'hd' : 'sd';
    elements.resToggle.querySelector(`[data-quality-preset="${preset}"]`)?.focus();
  });

  elements.options.addEventListener('keydown', handleSourceGridKeydown);
  elements.tablist.addEventListener('keydown', handleTablistKeydown);
  elements.settingsPopover.addEventListener('keydown', handleModeKeydown);

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
    if (event.target?.classList?.contains('screen-picker-shell')) {
      cancelPicker();
      return;
    }
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
  refreshResToggle();
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
  elements.screensTab.tabIndex = isScreen ? 0 : -1;
  elements.windowsTab.tabIndex = isScreen ? -1 : 0;
  elements.tabpanel.setAttribute('aria-labelledby', isScreen ? 'screenSourceScreensTab' : 'screenSourceWindowsTab');
  elements.screensTab.disabled = !state.sources.some((source) => source.type === 'screen');
  elements.windowsTab.disabled = !state.sources.some((source) => source.type === 'window');
}

function refreshResToggle() {
  const isTextMode = state.mode === 'text';
  elements.resToggle.hidden = isTextMode;
  elements.resToggle.setAttribute('aria-hidden', String(isTextMode));

  const isHd = state.qualityId === 'high';
  for (const button of elements.resToggle.querySelectorAll('button')) {
    const isHdBtn = button.dataset.qualityPreset === 'hd';
    const selected = isHd === isHdBtn;
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('aria-checked', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
}

function refreshModePresets() {
  const games = state.mode === 'games';
  elements.modeGames.setAttribute('aria-pressed', String(games));
  elements.modeText.setAttribute('aria-pressed', String(!games));
  elements.modeGames.setAttribute('aria-checked', String(games));
  elements.modeText.setAttribute('aria-checked', String(!games));
  elements.modeGames.tabIndex = games ? 0 : -1;
  elements.modeText.tabIndex = games ? -1 : 0;

  const gamesDot = elements.modeGames.querySelector('.screen-settings-dot');
  const textRadio = elements.modeText.querySelector('.screen-settings-radio');
  if (!textRadio) return;

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

function handleModeKeydown(event) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  if (event.target !== elements.modeGames && event.target !== elements.modeText) return;
  event.preventDefault();
  const next = state.mode === 'games' ? 'text' : 'games';
  setMode(next);
  (next === 'games' ? elements.modeGames : elements.modeText).focus();
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
    button.setAttribute('aria-checked', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }

  elements.startButton.disabled = !state.selectedSourceId;
}

// A window share can carry only that app's sound; a screen share always carries
// everything except VoiceRoom.
function isSwitch(control) {
  return control.getAttribute('role') === 'switch';
}

function isChecked(control) {
  if (isSwitch(control)) return control.getAttribute('aria-checked') === 'true';
  return control.checked === true;
}

function setChecked(control, value) {
  const checked = Boolean(value);
  if (isSwitch(control)) {
    control.setAttribute('aria-checked', String(checked));
    return;
  }
  control.checked = checked;
}

function bindChecked(control) {
  if (isSwitch(control)) {
    control.addEventListener('click', () => {
      setChecked(control, !isChecked(control));
      updateSummary();
    });
    return;
  }
  control.addEventListener('change', updateSummary);
}

function canChooseAppAudio() {
  return state.appAudioSupported && state.sourceType === 'window' && isChecked(elements.audioToggle);
}

function isAppAudioOnly() {
  return canChooseAppAudio() && isChecked(elements.appAudioToggle);
}

function updateSummary() {
  const source = state.sources.find((s) => s.id === state.selectedSourceId);
  const fpsLabel = t('fps', { count: state.mode === 'text' ? 5 : 30 });
  elements.appAudioRow.hidden = !canChooseAppAudio();
  const audioLabel = !isChecked(elements.audioToggle) ? '' : isAppAudioOnly() ? t('windowAudioDetail') : t('audioDetail');

  elements.summaryName.textContent = source?.name ?? t('notSelected');
  if (state.mode === 'text') {
    elements.summaryDetail.textContent = `${t('sourceDetail')} · ${fpsLabel}${audioLabel}`;
    return;
  }

  const qualityLabel = state.qualityId === 'high' ? '1080p' : '720p';
  const resLabel = state.qualityId === 'high' ? 'HD' : 'SD';
  elements.summaryDetail.textContent = `${resLabel} · ${qualityLabel} · ${fpsLabel}${audioLabel}`;
}

function createSourceButton(source) {
  const button = document.createElement('button');
  button.className = 'screen-source-option ui-choice ui-choice--card';
  button.type = 'button';
  button.setAttribute('role', 'radio');
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
    preview.className = 'screen-source-preview ui-choice__preview';
    preview.setAttribute('aria-hidden', 'true');
    button.prepend(preview);
  }

  preview.className = `screen-source-preview ui-choice__preview ${getFallbackPreviewClass(source)}`.trim();
  const thumbnailKey = source.thumbnail || '';
  if (preview.dataset.thumbnailKey === thumbnailKey) {
    syncSourceLabel(button, source);
    return;
  }

  preview.dataset.thumbnailKey = thumbnailKey;
  preview.replaceChildren();

  if (source.thumbnail) {
    const image = document.createElement('img');
    image.alt = t('preview', { name: source.name });
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
    label.className = 'screen-source-label ui-choice__row';
    button.append(label);
  }
  const icon = source.appIcon
    ? createSourceAppIcon(source)
    : createLucidePlaceholder(source.type === 'screen' ? 'monitor' : 'app-window', 'sm');
  const name = document.createElement('span');
  name.className = 'ellipsis';
  name.textContent = source.name;
  let radio = label.querySelector('.ui-radio');
  if (!radio) {
    radio = document.createElement('span');
    radio.className = 'ui-radio';
    radio.setAttribute('aria-hidden', 'true');
  }
  label.replaceChildren(icon, name, radio);
  renderPickerIcons(label);
}

function createSourceAppIcon(source) {
  const image = document.createElement('img');
  image.alt = '';
  image.src = source.appIcon;
  return image;
}

function createLucidePlaceholder(name, size) {
  const icon = document.createElement('i');
  icon.dataset.lucide = name;
  icon.dataset.iconSize = size;
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function renderPickerIcons(root) {
  window.voiceRoomPickerIcons?.render(root);
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
  const qualityId = state.mode === 'text' ? 'source' : state.qualityId;
  const selection = {
    appAudioOnly: isAppAudioOnly(),
    fpsId,
    qualityId,
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

window.voiceRoomI18n.subscribe(() => {
  if (!window.voiceRoomScreenPicker) fallbackState.sources[0].name = t('entireScreen');
  for (const source of state.sources) {
    const button = sourceButtons.get(source.id);
    if (button) {
      syncSourceButton(button, source);
      const image = button.querySelector('.screen-source-preview img');
      if (image) image.alt = t('preview', { name: source.name });
    }
  }
  if (state.sources.length) updateSummary();
});
