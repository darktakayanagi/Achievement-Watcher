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

function notifyError(message) {
  console.error(message);
}

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

ipcMain.on('close-notification-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);

  if (win && !win.isDestroyed()) {
    win.close();
  }
});

module.exports.window = () => {
  ipcMain.handle('win-close', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win.close();
  });

  ipcMain.handle('win-minimize', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win.minimize();
  });

  ipcMain.handle('win-maximize', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win.isMaximized() ? win.unmaximize() : win.maximize();
  });

  ipcMain.handle('win-isMinimizable', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win.minimizable;
  });

  ipcMain.handle('win-isMaximizable', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win.maximizable;
  });

  ipcMain.handle('win-isFrameless', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win.isFrameless;
  });

  //Sync

  ipcMain.on('win-isDev', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    event.returnValue = win.isDev;
  });
};
