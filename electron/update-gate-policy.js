'use strict';

function shouldRunUpdateGateState({ isPackaged, previewEnabled = false } = {}) {
  return Boolean(isPackaged) && !previewEnabled;
}

module.exports = {
  shouldRunUpdateGateState
};