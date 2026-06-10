'use strict';

const { app } = require('electron');
const log = require('electron-log');

log.transports.file.level = 'info';
log.transports.console.level = app.isPackaged ? 'warn' : 'debug';
log.transports.file.maxSize = 5 * 1024 * 1024;

module.exports = log;