'use strict';
const os = require('os');
const path = require('path');
const debug = new (require('@xan105/log'))({
  console: true,
  file: path.join(process.env['APPDATA'] || path.join(os.homedir(), 'Library', 'Application Support'), 'Achievement Watcher/logs/notification.log'),
});

module.exports = debug;
