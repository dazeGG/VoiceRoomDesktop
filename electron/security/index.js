'use strict';

const origin = require('./origin');
const mac = require('./mac');

module.exports = {
  ...origin,
  ...mac
};
