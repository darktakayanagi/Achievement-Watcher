'use strict';

const path = require('path');
const glob = require('fast-glob');
const ffs = require('@xan105/fs');

let cache;

module.exports.setUserDataPath = (p) => {
  cache = path.join(p, 'steam_cache/data');
};

module.exports.scan = async () => {
  try {
    let data = [];

    for (let file of await glob('([0-9])+.db', { cwd: cache, onlyFiles: true, absolute: false })) {
      data.push({
        appid: file.replace('.db', ''),
        source: 'Achievement Watcher : Watchdog',
        data: {
          type: 'cached',
        },
      });
    }

    return data;
  } catch (err) {
    throw err;
  }
};

module.exports.getAchievements = async (appID) => {
  return JSON.parse(await ffs.readFile(path.join(cache, `${appID}.db`), 'utf8'));
};
