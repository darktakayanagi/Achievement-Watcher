'use strict';

const remote = require('@electron/remote');
const path = require('path');
const ffs = require('@xan105/fs');

const file = path.join(remote.app.getPath('userData'), 'cfg/exeList.db');

module.exports.get = async (appid) => {
  let defaultCfg = { appid, exe: '', args: '' };
  try {
    let currentList = JSON.parse(await ffs.readFile(file, 'utf8'));
    let found = currentList.find((app) => app.appid === appid);
    return found ? found : defaultCfg;
  } catch (err) {
    if (err.code === 'ENOENT') {
      await this.save([]);
      return defaultCfg;
    } else {
      throw err;
    }
  }
};

module.exports.save = async (data) => {
  try {
    await ffs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    throw err;
  }
};

module.exports.add = async (app) => {
  try {
    debug.log(`Adding ${app.appid} to exeList ...`);

    let currentList = await this.get();
    let existingEntry = currentList.find((g) => g.appid === app.appid);
    if (existingEntry) {
      existingEntry.exe = app.exe;
      existingEntry.args = app.args;
      debug.log(`${app.appid} already on the list, updating path and launch args ...`);
    } else {
      currentList.push(app);
    }
    await this.save(currentList);
    debug.log('Done.');
  } catch (err) {
    throw err;
  }
};
