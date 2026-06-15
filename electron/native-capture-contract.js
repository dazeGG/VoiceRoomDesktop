'use strict';

// Compatibility shim for packaged preload scripts that still require the
// pre-reorganization path (`./native-capture-contract`). Keep this file in the
// packaged app so desktop runtime markers are not lost if that path is used.
module.exports = require('./native/capture-contract');
