'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { describe, it } = require('node:test');
const vm = require('node:vm');

class FakeElement {
  constructor({ id = '', tagName = 'div' } = {}) {
    this.attributes = new Map();
    this.children = [];
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.checked = false;
    this.className = '';
    this.id = id;
    this.listeners = new Map();
    this.parent = null;
    this.tagName = tagName.toUpperCase();
    this.tabIndex = 0;
    this.textContent = '';
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  append(...children) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }

  prepend(child) {
    child.parent = this;
    this.children.unshift(child);
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name);
  }

  click() {
    this.dispatch('click', { target: this });
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) {
      listener({ preventDefault() {}, target: this, ...event });
    }
  }

  focus() {}

  contains(target) {
    return target === this || this.children.some((child) => child.contains?.(target));
  }

  closest() {
    return null;
  }

  querySelector(selector) {
    return findFirst(this, selector);
  }

  querySelectorAll(selector) {
    return findAll(this, selector);
  }
}

function matches(element, selector) {
  if (selector === 'button') return element.tagName === 'BUTTON';
  if (selector.startsWith('.')) return String(element.className || '').split(/\s+/).includes(selector.slice(1));
  return false;
}

function findFirst(root, selector) {
  for (const child of root.children) {
    if (matches(child, selector)) return child;
    const nested = findFirst(child, selector);
    if (nested) return nested;
  }
  return null;
}

function findAll(root, selector, found = []) {
  for (const child of root.children) {
    if (matches(child, selector)) found.push(child);
    findAll(child, selector, found);
  }
  return found;
}

function makeElement(id, tagName = 'div') {
  return new FakeElement({ id, tagName });
}

function makeModeButton(id, selected) {
  const button = makeElement(id, 'button');
  const radio = new FakeElement();
  radio.className = 'screen-settings-radio';
  if (selected) {
    const dot = new FakeElement();
    dot.className = 'screen-settings-dot';
    radio.append(dot);
  }
  button.append(radio);
  return button;
}

function createPickerHarness() {
  const elements = {
    screenAudioToggle: makeElement('screenAudioToggle', 'input'),
    screenSourceClose: makeElement('screenSourceClose', 'button'),
    screenSettingsGear: makeElement('screenSettingsGear', 'button'),
    screenModeGames: makeModeButton('screenModeGames', true),
    screenModeText: makeModeButton('screenModeText', false),
    screenSourceOptions: makeElement('screenSourceOptions'),
    screenResToggle: makeElement('screenResToggle'),
    screenSourceScreensTab: makeElement('screenSourceScreensTab', 'button'),
    screenSettingsPopover: makeElement('screenSettingsPopover'),
    screenSourceStart: makeElement('screenSourceStart', 'button'),
    screenSummaryDetail: makeElement('screenSummaryDetail'),
    screenSummaryName: makeElement('screenSummaryName'),
    screenSourceTabpanel: makeElement('screenSourceTabpanel'),
    screenSourceWindowsTab: makeElement('screenSourceWindowsTab', 'button')
  };
  elements.screenAudioToggle.checked = true;
  elements.screenSettingsPopover.hidden = true;

  const sdButton = makeElement('', 'button');
  sdButton.dataset.qualityPreset = 'sd';
  const hdButton = makeElement('', 'button');
  hdButton.dataset.qualityPreset = 'hd';
  elements.screenResToggle.append(sdButton, hdButton);

  const tablist = new FakeElement();
  tablist.className = 'screen-source-tabs';

  const selected = [];
  const document = {
    activeElement: null,
    addEventListener() {},
    createElement: (tagName) => new FakeElement({ tagName }),
    querySelector(selector) {
      if (selector === '.screen-source-tabs') return tablist;
      if (selector.startsWith('#')) return elements[selector.slice(1)] || null;
      return null;
    }
  };
  const window = {
    addEventListener() {},
    getComputedStyle: () => ({ gridTemplateColumns: '1fr 1fr 1fr' }),
    voiceRoomScreenPicker: {
      getState: async () => ({
        defaultFpsId: '30',
        defaultQualityId: 'balanced',
        defaultStreamAudioEnabled: true,
        sources: [{ id: 'screen:1:0', name: 'Display 1', thumbnail: '', type: 'screen' }]
      }),
      select: async (selection) => { selected.push(selection); }
    }
  };

  vm.runInNewContext(fs.readFileSync('electron/ui/screen-picker.js', 'utf8'), {
    console,
    document,
    window
  });

  return { elements, hdButton, selected };
}

async function flushInit() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

describe('screen picker stream profile UI', () => {
  it('hides quality presets in text mode and submits source-5', async () => {
    const { elements, selected } = createPickerHarness();
    await flushInit();

    elements.screenModeText.click();
    elements.screenSourceStart.click();

    assert.equal(elements.screenResToggle.hidden, true);
    assert.equal(elements.screenResToggle.getAttribute('aria-hidden'), 'true');
    assert.equal(elements.screenSummaryDetail.textContent, 'Источник · 5 к/с · звук');
    assert.deepEqual(JSON.parse(JSON.stringify(selected.at(-1))), {
      fpsId: '5',
      qualityId: 'source',
      sourceId: 'screen:1:0',
      streamAudioEnabled: true
    });
  });

  it('keeps SD/HD quality presets for games mode and submits high-30', async () => {
    const { elements, hdButton, selected } = createPickerHarness();
    await flushInit();

    elements.screenResToggle.dispatch('click', { target: hdButton });
    elements.screenSourceStart.click();

    assert.equal(elements.screenResToggle.hidden, false);
    assert.equal(elements.screenSummaryDetail.textContent, 'HD · 1080p · 30 к/с · звук');
    assert.deepEqual(JSON.parse(JSON.stringify(selected.at(-1))), {
      fpsId: '30',
      qualityId: 'high',
      sourceId: 'screen:1:0',
      streamAudioEnabled: true
    });
  });
});
