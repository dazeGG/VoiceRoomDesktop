'use strict';

const people = document.querySelector('#overlayPeople');

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
const nodes = new Map();

function element(tagName, className) {
  const node = document.createElement(tagName);
  node.className = className;
  return node;
}

function icon(name, label) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'overlay-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
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

function createPerson() {
  const item = element('li', 'overlay-person');
  const avatar = element('span', 'overlay-avatar');
  const image = document.createElement('img');
  image.alt = '';
  const initial = element('span', 'overlay-initial');
  avatar.append(image, initial);
  const name = element('span', 'overlay-name');
  const micOff = icon('micOff', 'Микрофон выключен');
  const outputOff = icon('outputOff', 'Звук выключен');
  const stream = element('span', 'overlay-stream');
  stream.textContent = 'Стрим';
  item.append(avatar, name, micOff, outputOff, stream);

  const node = { avatar, failedSrc: '', image, initial, item, micOff, name, outputOff, stream };
  // A broken avatar falls back to the initial, like the web app.
  image.addEventListener('error', () => {
    node.failedSrc = image.getAttribute('src') || '';
    image.hidden = true;
    initial.hidden = false;
  });
  return node;
}

function updatePerson(node, participant, showNames) {
  const label = participantLabel(participant);
  const src = typeof participant.avatarUrl === 'string' && participant.avatarUrl.startsWith('https://')
    ? participant.avatarUrl
    : '';
  const showImage = Boolean(src) && node.failedSrc !== src;

  node.item.dataset.speaking = participant.speaking ? 'true' : 'false';
  node.avatar.style.background = avatarBackground(participant);
  if (showImage) {
    if (node.image.getAttribute('src') !== src) node.image.src = src;
  } else {
    node.image.removeAttribute('src');
  }
  node.image.hidden = !showImage;
  node.initial.hidden = showImage;
  node.initial.textContent = label.slice(0, 1).toUpperCase() || '?';
  node.name.textContent = label;
  node.name.hidden = !showNames;
  // SVG elements have no `hidden` property, so toggle the attribute directly.
  node.micOff.toggleAttribute('hidden', participant.micMuted !== true);
  node.outputOff.toggleAttribute('hidden', participant.outputMuted !== true);
  node.stream.hidden = participant.streaming !== true;
}

function render(state) {
  if (!people) return;
  const participants = Array.isArray(state?.participants) ? state.participants : [];
  const settings = state?.settings || {};
  const showNames = settings.showNames !== false;
  people.dataset.size = AVATAR_SIZES.includes(settings.avatarSize) ? settings.avatarSize : DEFAULT_AVATAR_SIZE;
  // Right corners mirror each row so the avatars stay glued to the edge of the game.
  people.dataset.side = String(settings.anchor || '').endsWith('-right') ? 'right' : 'left';

  const seen = new Set();
  const ordered = participants.map((participant) => {
    let node = nodes.get(participant.id);
    if (!node) {
      node = createPerson();
      nodes.set(participant.id, node);
    }
    seen.add(participant.id);
    updatePerson(node, participant, showNames);
    return node.item;
  });
  for (const id of nodes.keys()) {
    if (!seen.has(id)) nodes.delete(id);
  }

  const current = Array.from(people.children);
  const sameOrder = current.length === ordered.length && current.every((item, index) => item === ordered[index]);
  if (!sameOrder) people.replaceChildren(...ordered);
  people.hidden = ordered.length === 0;
}

function reportSize() {
  if (!people || people.hidden) return;
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

if (window.ResizeObserver && people) {
  new ResizeObserver(() => reportSize()).observe(people);
}

window.voiceRoomOverlay?.ready?.().catch(() => {});
