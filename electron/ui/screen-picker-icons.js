'use strict';

const ICON_SIZES = Object.freeze({
  lg: 20,
  md: 18,
  sm: 15,
  xs: 12
});

const PICKER_ICON_NAMES = Object.freeze(['AppWindow', 'Check', 'Monitor', 'Play', 'Settings', 'Type', 'X']);

function getPickerIcons(lucide) {
  if (!lucide || typeof lucide.createIcons !== 'function' || !lucide.icons) return null;

  const pickerIcons = {};
  for (const name of PICKER_ICON_NAMES) {
    const icon = lucide.icons[name];
    if (!icon) return null;
    pickerIcons[name] = icon;
  }
  return Object.freeze(pickerIcons);
}

function renderPickerIcons(root = document) {
  const lucide = window.lucide;
  const pickerIcons = getPickerIcons(lucide);
  if (!pickerIcons) return false;

  lucide.createIcons({
    attrs: { 'stroke-width': 2 },
    icons: pickerIcons,
    root
  });

  for (const icon of root.querySelectorAll('svg[data-icon-size]')) {
    const size = ICON_SIZES[icon.dataset.iconSize] || ICON_SIZES.md;
    icon.setAttribute('height', String(size));
    icon.setAttribute('width', String(size));
    if (icon.dataset.iconFill === 'true') icon.setAttribute('fill', 'currentColor');
  }

  return true;
}

window.voiceRoomPickerIcons = Object.freeze({
  render: renderPickerIcons,
  sizes: ICON_SIZES,
  strokeWidth: 2
});

renderPickerIcons();
