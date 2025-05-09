'use strict';

const path = require('path');
const ffs = require('@xan105/fs');

const file = path.join(remote.app.getPath('userData'), 'cfg/exeList.db');

async function getCurrentList() {
  try {
    return JSON.parse(await ffs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      await this.save([]);
      return [];
    } else {
      throw err;
    }
  }
}

module.exports.get = async (appid) => {
  let defaultCfg = { appid, exe: '', args: '' };
  let currentList = await getCurrentList();
  let found = currentList.find((app) => app.appid === appid);
  return found ? found : defaultCfg;
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
    let currentList = await getCurrentList();
    let existingEntry = currentList.find((ap) => ap.appid === app.appid);
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
