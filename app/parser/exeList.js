'use strict';

const remote = require('@electron/remote');
const path = require('path');
const fs = require('fs');

const file = path.join(remote.app.getPath('userData'), 'cfg/exeList.db');

async function getCurrentList() {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      await module.exports.save([]);
      return [];
    } else {
      throw err;
    }
  }
}

module.exports.get = async (appid) => {
  let defaultCfg = { appid: String(appid), exe: '', source: 'steam', args: '' };
  try {
    let currentList = await getCurrentList();
    let found = currentList.find((app) => String(app.appid) === String(appid));
    return found ? found : defaultCfg;
  } catch (err) {
    debug.log(err);
    return defaultCfg;
  }
};

module.exports.save = async (data) => {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    debug.log(err);
  }
};

module.exports.add = async (app) => {
  try {
    debug.log(`Adding ${app.appid} to exeList ...`);
    let currentList = await getCurrentList();
    let existingEntry = currentList.find((ap) => String(ap.appid) === String(app.appid));
    if (existingEntry) {
      existingEntry.appid = String(app.appid);
      existingEntry.exe = app.exe;
      existingEntry.args = app.args;
      existingEntry.source = app.source;
      debug.log(`${app.appid} already on the list, updating path and launch args ...`);
    } else {
      app.appid = String(app.appid);
      currentList.push(app);
    }
    await this.save(currentList);
    debug.log('Done.');
  } catch (err) {
    debug.log(err);
  }
};
