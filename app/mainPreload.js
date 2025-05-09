const { contextBridge, ipcRenderer } = require('electron');

const userDataPath = null;
async function getUserDataPath() {
  if (userDataPath) return userDataPath;
  userDataPath = await ipcRenderer.invoke('get-user-data-path');
  return userDataPath;
}
const os = require('os');
const fs = require('fs');
const args_split = require('argv-split');
const args = require('minimist');
const moment = require('moment');
const { execFile } = require('child_process');
const humanizeDuration = require('humanize-duration');
const settings = require(path.join(appPath, 'settings.js'));
const achievements = require(path.join(appPath, 'parser/achievements.js'));
const userdatapath = ipcRenderer.sendSync('get-user-data-path-sync');
achievements.initDebug({ isDev: ipcRenderer.sendSync('win-isDev') || false, userDataPath: userdatapath });
const blacklist = require(path.join(appPath, 'parser/blacklist.js'));
const userDir = require(path.join(appPath, 'parser/userDir.js'));
const exeList = require(path.join(appPath, 'parser/exeList.js'));
const PlaytimeTracking = require(path.join(appPath, 'parser/playtime.js'));
const l10n = require(path.join(appPath, 'locale/loader.js'));
const toastAudio = require(path.join(appPath, 'util/toastAudio.js'));
let debug = new (require('@xan105/log'))({
  console: ipcRenderer.sendSync('win-isDev') || false,
  file: path.join(userdatapath, `logs/${ipcRenderer.sendSync('get-app-name-sync')}.log`),
});
