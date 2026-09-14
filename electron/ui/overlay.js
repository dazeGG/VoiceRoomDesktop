'use strict';

const root = document.documentElement;
const people = document.querySelector('#overlayPeople');
const panel = document.querySelector('#overlayPanel');
const panelRoom = document.querySelector('#overlayRoom');
const panelHint = document.querySelector('#overlayHint');
const tiles = document.querySelector('#overlayTiles');

const AVATAR_COLORS = {
  amber: 'oklch(63% 0.19 70)',
  blue: 'oklch(54% 0.22 260)',
  blurple: 'oklch(58% 0.26 278)',
  coral: 'oklch(61% 0.22 36)',
  cyan: 'oklch(55% 0.17 214)',
  green: 'oklch(52% 0.19 148)',
  indigo: 'oklch(51% 0.23 284)',
  magenta: 'oklch(56% 0.26 351)',
  olive: 'oklch(50% 0.16 112)',
  orchid: 'oklch(58% 0.24 326)',
  rose: 'oklch(58% 0.24 16)',
  rust: 'oklch(53% 0.20 42)',
  sky: 'oklch(57% 0.18 242)',
  slate: 'oklch(44% 0.06 260)',
  teal: 'oklch(53% 0.18 182)',
  violet: 'oklch(55% 0.25 304)'
};
const AVATAR_SIZES = ['small', 'medium', 'large'];
const DEFAULT_AVATAR_SIZE = 'medium';
const DEFAULT_IDLE_OPACITY = 0.5;
const SVG_NS = 'http://www.w3.org/2000/svg';
// lucide 1.24 MicOff and HeadphoneOff, inlined because the page CSP only loads its own files.
const ICON_PATHS = {
  micOff: [
    'M12 19v3',
    'M15 9.34V5a3 3 0 0 0-5.68-1.33',
    'M16.95 16.95A7 7 0 0 1 5 12v-2',
    'M18.89 13.23A7 7 0 0 0 19 12v-2',
    'm2 2 20 20',
    'M9 9v3a3 3 0 0 0 5.12 2.12'
  ],
  outputOff: [
    'M21 14h-1.343',
    'M9.128 3.47A9 9 0 0 1 21 12v3.343',
    'm2 2 20 20',
    'M20.414 20.414A2 2 0 0 1 19 21h-1a2 2 0 0 1-2-2v-3',
    'M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 2.636-6.364'
  ]
};

// Nodes are reused per participant so avatar images do not reload on every
// speaking change. Styles go through CSSOM: the page CSP blocks style attributes.
const hudNodes = new Map();
const tileNodes = new Map();
let mode = 'hud';

function element(tagName, className) {
  const node = document.createElement(tagName);
  node.className = className;
  return node;
}

function icon(name, className) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function participantLabel(participant) {
  return participant.name || (participant.self ? 'Вы' : 'Участник');
}

function avatarBackground(participant) {
  if (participant.avatarAccent) return participant.avatarAccent;
  return AVATAR_COLORS[participant.avatarColorKey] || AVATAR_COLORS.blurple;
}

function createAvatar(className) {
  const avatar = element('span', className);
  const image = document.createElement('img');
  image.alt = '';
  const initial = element('span', 'overlay-initial');
  avatar.append(image, initial);
  const node = { avatar, failedSrc: '', image, initial };
  // A broken avatar falls back to the initial, like the web app.
  image.addEventListener('error', () => {
    node.failedSrc = image.getAttribute('src') || '';
    image.hidden = true;
    initial.hidden = false;
  });
  return node;
}

function updateAvatar(node, participant) {
  const src = typeof participant.avatarUrl === 'string' && participant.avatarUrl.startsWith('https://')
    ? participant.avatarUrl
    : '';
  const showImage = Boolean(src) && node.failedSrc !== src;
  node.avatar.style.background = avatarBackground(participant);
  if (showImage) {
    if (node.image.getAttribute('src') !== src) node.image.src = src;
  } else {
    node.image.removeAttribute('src');
  }
  node.image.hidden = !showImage;
  node.initial.hidden = showImage;
  node.initial.textContent = participantLabel(participant).slice(0, 1).toUpperCase() || '?';
}

function createPerson() {
  const item = element('li', 'overlay-person');
  const avatar = createAvatar('overlay-avatar');
  const mute = element('span', 'overlay-mute');
  mute.setAttribute('aria-hidden', 'true');
  avatar.avatar.append(mute);
  const name = element('span', 'overlay-name');
  item.append(avatar.avatar, name);
  return { ...avatar, item, mute, name };
}

function updatePerson(node, participant, showNames) {
  node.item.dataset.speaking = participant.speaking ? 'true' : 'false';
  updateAvatar(node, participant);
  node.mute.hidden = participant.micMuted !== true;
  node.name.textContent = participantLabel(participant);
  node.name.hidden = !showNames;
}

function createTile() {
  const item = element('li', 'overlay-tile');
  const avatar = createAvatar('overlay-tile-avatar');
  const name = element('span', 'overlay-tile-name');
  const status = element('span', 'overlay-tile-status');
  const micOff = icon('micOff', 'overlay-tile-icon');
  const outputOff = icon('outputOff', 'overlay-tile-icon');
  status.append(micOff, outputOff);
  item.append(status, avatar.avatar, name);
  return { ...avatar, item, micOff, name, outputOff, status };
}

function updateTile(node, participant) {
  const label = participantLabel(participant);
  node.item.dataset.speaking = participant.speaking ? 'true' : 'false';
  updateAvatar(node, participant);
  node.name.textContent = participant.self && participant.name ? `${label} (вы)` : label;
  node.micOff.toggleAttribute('hidden', participant.micMuted !== true);
  node.outputOff.toggleAttribute('hidden', participant.outputMuted !== true);
  node.status.hidden = participant.micMuted !== true && participant.outputMuted !== true;
}

function syncList(container, nodes, participants, create, update) {
  const seen = new Set();
  const ordered = participants.map((participant) => {
    let node = nodes.get(participant.id);
    if (!node) {
      node = create();
      nodes.set(participant.id, node);
    }
    seen.add(participant.id);
    update(node, participant);
    return node.item;
  });
  for (const id of nodes.keys()) {
    if (!seen.has(id)) nodes.delete(id);
  }

  const current = Array.from(container.children);
  const sameOrder = current.length === ordered.length && current.every((item, index) => item === ordered[index]);
  if (!sameOrder) container.replaceChildren(...ordered);
  return ordered.length;
}

function render(state) {
  if (!people || !panel || !tiles) return;
  const participants = Array.isArray(state?.participants) ? state.participants : [];
  const settings = state?.settings || {};
  const showNames = settings.showNames !== false;
  const idleOpacity = Number.isFinite(settings.opacity) ? settings.opacity : DEFAULT_IDLE_OPACITY;
  const avatarSize = AVATAR_SIZES.includes(settings.avatarSize) ? settings.avatarSize : DEFAULT_AVATAR_SIZE;

  mode = state?.interactive ? 'panel' : 'hud';
  root.dataset.mode = mode;
  people.dataset.size = avatarSize;
  people.style.setProperty('--overlay-idle-opacity', String(idleOpacity));

  const hudCount = syncList(people, hudNodes, participants, createPerson, (node, participant) => {
    updatePerson(node, participant, showNames);
  });
  people.hidden = mode !== 'hud' || hudCount === 0;

  panel.hidden = mode !== 'panel';
  if (mode !== 'panel') return;
  panelRoom.textContent = state?.call?.roomName || (state?.previewing ? 'Предпросмотр' : 'В звонке');
  panelHint.textContent = state?.hint ? `${state.hint} или Esc — вернуться в игру` : 'Esc — вернуться в игру';
  syncList(tiles, tileNodes, participants, createTile, updateTile);
}

function closePanel() {
  window.voiceRoomOverlay?.closePanel?.().catch(() => {});
}

function reportSize() {
  if (!people || mode !== 'hud' || people.hidden) return;
  const rect = people.getBoundingClientRect();
  window.voiceRoomOverlay?.reportSize?.({
    height: Math.ceil(rect.height),
    width: Math.ceil(rect.width)
  }).catch(() => {});
}

window.voiceRoomOverlay?.onState?.((state) => {
  render(state);
  requestAnimationFrame(reportSize);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && mode === 'panel') closePanel();
});

panel?.addEventListener('click', (event) => {
  if (event.target === panel) closePanel();
});

if (window.ResizeObserver && people) {
  new ResizeObserver(() => reportSize()).observe(people);
}

window.voiceRoomOverlay?.ready?.().catch(() => {});
