'use strict';

const { app, ipcMain, BrowserWindow } = require('electron');
const path = require('path');
const { fetchIcon } = require('../parser/steam');
const { pathToFileURL } = require('url');
const achievementsJS = require(path.join(__dirname, '../parser/achievements.js'));
achievementsJS.initDebug({ isDev: app.isDev || false, userDataPath: app.getPath('userData') });
const settingsJS = require(path.join(__dirname, '../settings.js'));
settingsJS.setUserDataPath(app.getPath('userData'));
const { getSteamUsersList } = require(path.join(__dirname, '../parser/steam.js'));

// Handler for renderer process
ipcMain.handle('get-app-name', () => {
  return app.getName();
});
ipcMain.handle('get-user-data-path', () => {
  return app.getPath('userData');
});

ipcMain.on('get-app-name-sync', (event) => {
  event.returnValue = app.getName();
});

ipcMain.on('get-user-data-path-sync', (event) => {
  const t = app.getPath('userData');
  event.returnValue = t;
});

ipcMain.on('get-steam-user-list', async (event) => {
  await getSteamUsersList()
    .then((p) => (event.returnValue = p))
    .catch((err) => (event.returnValue = null));
});

ipcMain.on('fetch-icon', async (event, url, appid) => {
  await fetchIcon(url, appid).then((p) => (event.returnValue = pathToFileURL(p).href));
});
