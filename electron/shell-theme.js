'use strict';

const WINDOW_BACKGROUND = '#10110f';
const TITLEBAR_HEIGHT = 32;
const TITLEBAR_OVERLAY_SYMBOL_COLOR = '#b0aea8';
const TITLEBAR_MAC_TRAFFIC_LIGHTS_PADDING = '78px';
const TITLEBAR_WIN_CONTROLS_PADDING = '140px';

const TITLEBAR_OVERLAY = {
  color: WINDOW_BACKGROUND,
  symbolColor: TITLEBAR_OVERLAY_SYMBOL_COLOR,
  height: TITLEBAR_HEIGHT
};

function getMainWindowChromeOptions(platform = process.platform) {
  const options = {
    titleBarStyle: 'hidden'
  };

  if (platform === 'win32') {
    options.titleBarOverlay = { ...TITLEBAR_OVERLAY };
  }

  return options;
}

function buildDesktopLayoutCss(titlebarHeight = TITLEBAR_HEIGHT) {
  return `
    html.is-desktop {
      --voice-room-shell-topbar: ${titlebarHeight}px;
      --voice-room-app-height: calc(100vh - var(--voice-room-shell-topbar));
      --voice-room-app-dvh: calc(100dvh - var(--voice-room-shell-topbar));
      box-sizing: border-box !important;
      height: 100vh !important;
      padding-top: var(--voice-room-shell-topbar) !important;
      overflow: hidden !important;
    }
    html.is-desktop body {
      height: 100% !important;
      max-height: 100% !important;
      min-height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      overflow: hidden !important;
      box-sizing: border-box !important;
    }
    html.is-desktop #root,
    html.is-desktop #app,
    html.is-desktop #__next {
      height: 100% !important;
      max-height: 100% !important;
    }
    html.is-desktop .lobby-shell,
    html.is-desktop .app-shell {
      height: 100% !important;
      max-height: 100% !important;
      min-height: 0 !important;
    }
    html.is-desktop .auth-loader {
      min-height: calc(var(--voice-room-app-height) - 96px) !important;
    }
    html.is-desktop .auth-session-error {
      min-height: calc(var(--voice-room-app-height) - 76px) !important;
    }
    html.is-desktop.is-shell-fullscreen {
      padding-top: 0 !important;
    }
    html.is-desktop.is-shell-fullscreen body,
    html.is-desktop.is-shell-fullscreen #root,
    html.is-desktop.is-shell-fullscreen #app,
    html.is-desktop.is-shell-fullscreen #__next,
    html.is-desktop.is-shell-fullscreen .lobby-shell,
    html.is-desktop.is-shell-fullscreen .app-shell {
      height: 100% !important;
      max-height: 100% !important;
    }
  `;
}

function resolveTopbarBounds({
  width = 0,
  titlebarHeight = TITLEBAR_HEIGHT,
  visible = true,
  isFullscreen = false
} = {}) {
  if (!visible || isFullscreen) {
    return { x: 0, y: 0, width, height: 0 };
  }

  return { x: 0, y: 0, width, height: titlebarHeight };
}

module.exports = {
  WINDOW_BACKGROUND,
  TITLEBAR_HEIGHT,
  TITLEBAR_OVERLAY,
  TITLEBAR_MAC_TRAFFIC_LIGHTS_PADDING,
  TITLEBAR_WIN_CONTROLS_PADDING,
  buildDesktopLayoutCss,
  getMainWindowChromeOptions,
  resolveTopbarBounds
};