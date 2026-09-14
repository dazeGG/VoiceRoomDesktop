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
const DEFAULT_IDLE_OPACITY = 0.5;

// Nodes are reused per participant so avatar images do not reload on every
// speaking change. Styles go through CSSOM: the page CSP blocks style attributes.
const nodes = new Map();

function avatarBackground(participant) {
  if (participant.avatarAccent) return participant.avatarAccent;
  return AVATAR_COLORS[participant.avatarColorKey] || AVATAR_COLORS.blurple;
}

function element(tagName, className) {
  const node = document.createElement(tagName);
  node.className = className;
  return node;
}

function createPerson() {
  const item = element('li', 'overlay-person');
  const avatar = element('span', 'overlay-avatar');
  const image = document.createElement('img');
  image.alt = '';
  const initial = element('span', 'overlay-initial');
  const mute = element('span', 'overlay-mute');
  mute.setAttribute('aria-hidden', 'true');
  const name = element('span', 'overlay-name');
  avatar.append(image, initial, mute);
  item.append(avatar, name);
  return { avatar, image, initial, item, mute, name };
}

function updatePerson(node, participant, showNames) {
  const label = participant.name || (participant.self ? 'Вы' : 'Участник');
  const src = typeof participant.avatarUrl === 'string' && participant.avatarUrl.startsWith('https://')
    ? participant.avatarUrl
    : '';

  node.item.dataset.speaking = participant.speaking ? 'true' : 'false';
  node.avatar.style.background = avatarBackground(participant);
  if (src) {
    if (node.image.getAttribute('src') !== src) node.image.src = src;
  } else {
    node.image.removeAttribute('src');
  }
  node.image.hidden = !src;
  node.initial.hidden = Boolean(src);
  node.initial.textContent = label.slice(0, 1).toUpperCase() || '?';
  node.mute.hidden = participant.micMuted !== true;
  node.name.textContent = label;
  node.name.hidden = !showNames;
}

function render(state) {
  if (!people) return;
  const participants = Array.isArray(state?.participants) ? state.participants : [];
  const showNames = state?.settings?.showNames !== false;
  const idleOpacity = Number.isFinite(state?.settings?.opacity) ? state.settings.opacity : DEFAULT_IDLE_OPACITY;
  people.style.setProperty('--overlay-idle-opacity', String(idleOpacity));

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
