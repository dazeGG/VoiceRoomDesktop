'use strict';

const ICON_SIZES = Object.freeze({
  lg: 20,
  md: 18,
  sm: 15,
  xs: 12
});

const PICKER_ICONS = Object.freeze({
  AppWindow: window.lucide.icons.AppWindow,
  Check: window.lucide.icons.Check,
  Monitor: window.lucide.icons.Monitor,
  Play: window.lucide.icons.Play,
  Settings: window.lucide.icons.Settings,
  Type: window.lucide.icons.Type,
  X: window.lucide.icons.X
});

function renderPickerIcons(root = document) {
  window.lucide.createIcons({
    attrs: { 'stroke-width': 2 },
    icons: PICKER_ICONS,
    root
  });

  for (const icon of root.querySelectorAll('svg[data-icon-size]')) {
    const size = ICON_SIZES[icon.dataset.iconSize] || ICON_SIZES.md;
    icon.setAttribute('height', String(size));
    icon.setAttribute('width', String(size));
    if (icon.dataset.iconFill === 'true') icon.setAttribute('fill', 'currentColor');
  }
}

window.voiceRoomPickerIcons = Object.freeze({
  render: renderPickerIcons,
  sizes: ICON_SIZES,
  strokeWidth: 2
});

renderPickerIcons();
