'use strict';

const path = require('path');
const fs = require('fs');

const cache = path.join(process.env['APPDATA'], 'Achievement Watcher');

module.exports.load = (appID, source = 'steam') => {
  try {
    let cacheRoot = path.join(cache, `${source}_cache`, 'data');
    return JSON.parse(fs.readFileSync(path.join(cacheRoot, `${appID}.db`), 'utf8'));
  } catch (err) {
    return [];
  }
};

module.exports.save = (appID, source = 'steam', achievements) => {
  let cacheRoot = path.join(cache, `${source}_cache`, 'data');
  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.writeFileSync(path.join(cacheRoot, `${appID}.db`), JSON.stringify(achievements), 'utf8');
};
