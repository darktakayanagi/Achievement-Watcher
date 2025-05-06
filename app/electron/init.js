'use strict';

const { app, BrowserWindow, dialog, session, shell, ipcMain, globalShortcut } = require('electron');
const remote = require('@electron/remote/main');
remote.initialize();
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const ipc = require(path.join(__dirname, 'ipc.js'));

const manifest = require('../package.json');

if (manifest.config['disable-gpu']) app.disableHardwareAcceleration();
if (manifest.config.appid) app.setAppUserModelId(manifest.config.appid);
let options = manifest.config.window;
options.show = false;
options.webPreferences = {
  devTools: manifest.config.debug || false,
  nodeIntegration: true,
  contextIsolation: false,
  webviewTag: false,
  v8CacheOptions: manifest.config.debug ? 'none' : 'code',
  enableRemoteModule: true,
};

let MainWin = null;
let overlayWindow = null;

function createMainWindow() {
  if (MainWin) {
    if (MainWin.isMinimized()) MainWin.restore();
    MainWin.focus();
    return;
  }

  //electron 9 crash if no icon exists to specified path
  try {
    fs.accessSync(options.icon, fs.constants.F_OK);
  } catch {
    delete options.icon;
  }

  MainWin = new BrowserWindow(options);

  //Frameless
  if (options.frame === false) MainWin.isFrameless = true;

  //Debug tool
  if (manifest.config.debug) {
    MainWin.webContents.openDevTools({ mode: 'undocked' });
    MainWin.isDev = true;
    console.info((({ node, electron, chrome }) => ({ node, electron, chrome }))(process.versions));
    try {
      const contextMenu = require('electron-context-menu')({
        append: (defaultActions, params, browserWindow) => [
          {
            label: 'Reload',
            visible: params,
            click: () => {
              MainWin.reload();
            },
          },
        ],
      });
    } catch (err) {
      dialog.showMessageBoxSync({
        type: 'warning',
        title: 'Context Menu',
        message: 'Failed to initialize context menu.',
        detail: `${err}`,
      });
    }
  }

  //User agent
  MainWin.webContents.userAgent = manifest.config['user-agent'];
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = manifest.config['user-agent'];
    callback({ cancel: false, requestHeaders: details.requestHeaders });
  });

  //External open links
  const openExternal = function (event, url) {
    if (!url.startsWith('file:///')) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  };
  MainWin.webContents.on('will-navigate', openExternal); //a href
  MainWin.webContents.on('new-window', openExternal); //a href target="_blank"

  //enable ipc
  ipc.window(MainWin);

  MainWin.loadFile(manifest.config.window.view);

  const isReady = [
    new Promise(function (resolve) {
      MainWin.once('ready-to-show', () => {
        return resolve();
      }); //Window is loaded and ready to be drawn
    }),
    new Promise(function (resolve) {
      ipcMain.handleOnce('components-loaded', () => {
        return resolve();
      }); //Wait for custom event
    }),
  ];

  Promise.all(isReady).then(() => {
    MainWin.show();
    MainWin.focus();

    setInterval(() => {
      const command = `powershell -NoProfile -Command "Get-Process | Where-Object { $_.Path -ne $null } | ForEach-Object { try { $desc = (Get-Item $_.Path).VersionInfo.FileDescription } catch { $desc = 'N/A' }; $memoryUsage = $_.WorkingSet / 1MB; Write-Output ('{0}|{1}|{2}|{3}' -f $_.Name, $_.Id, $desc, $memoryUsage) }"`;
      let found = false;
      exec(command, (error, stdout) => {
        if (!error) {
          const lines = stdout.trim().split('\r\n');
          for (const line of lines) {
            const [name, pid, description, memory] = line.trim().split('|');
            if (name.toLowerCase() === 'node' && description.toLowerCase().includes('achievement watcher')) {
              found = true;
            }
          }
        }
        MainWin.webContents.send('watchdog-status', found);
      });
    }, 5000);

    //overlay here to debug
    globalShortcut.register('Control+Shift+O', () => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.close();
        overlayWindow = null;
      } else {
        if (!selectedConfig) {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('notify', {
              message: '⚠️ Select first a config!',
              color: '#ff9800',
            });
          }
          return;
        }

        createOverlayWindow(selectedConfig);
      }
    });
  });

  MainWin.on('closed', () => {
    MainWin = null;
  });
}
function createOverlayWindow(selectedConfig) {
  const { width, height } = require('electron').screen.getPrimaryDisplay().workAreaSize;

  overlayWindow = new BrowserWindow({
    width: 450,
    height: 800,
    x: width - 470,
    y: 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, '../overlayPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: manifest.config.debug || false,
    },
  });

  if (manifest.config.debug) {
    overlayWindow.webContents.openDevTools({ mode: 'undocked' });
    overlayWindow.isDev = true;
    console.info((({ node, electron, chrome }) => ({ node, electron, chrome }))(process.versions));
    try {
      const contextMenu = require('electron-context-menu')({
        append: (defaultActions, params, browserWindow) => [
          {
            label: 'Reload',
            visible: params,
            click: () => {
              overlayWindow.reload();
            },
          },
        ],
      });
    } catch (err) {
      dialog.showMessageBoxSync({
        type: 'warning',
        title: 'Context Menu',
        message: 'Failed to initialize context menu.',
        detail: `${err}`,
      });
    }
  }

  //User agent
  overlayWindow.webContents.userAgent = manifest.config['user-agent'];
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = manifest.config['user-agent'];
    callback({ cancel: false, requestHeaders: details.requestHeaders });
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setFullScreenable(false);
  overlayWindow.setFocusable(false);
  overlayWindow.blur();

  overlayWindow.loadFile(path.join(__dirname, '..\\view\\overlay.html'));
  let selectedLanguage = 'english';
  overlayWindow.webContents.on('did-finish-load', () => {
    overlayWindow.webContents.send('load-overlay-data', selectedConfig);
    overlayWindow.webContents.send('set-language', selectedLanguage);
  });

  const isReady = [
    new Promise(function (resolve) {
      overlayWindow.once('ready-to-show', () => {
        return resolve();
      }); //Window is loaded and ready to be drawn
    }),
  ];
  Promise.all(isReady).then(() => {
    overlayWindow.show();
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}
function createNotificationWindow(message) {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  const preset = message.preset || 'default';
  const presetFolder = path.join(userPresetsFolder, preset);
  const presetHtml = path.join(presetFolder, 'index.html');
  const position = message.position || 'center-bottom';
  const scale = parseFloat(message.scale || 1);

  const { width: windowWidth, height: windowHeight } = getPresetDimensions(presetFolder);

  const scaledWidth = windowWidth;
  const scaledHeight = windowHeight;

  let x = 0,
    y = 0;

  switch (position) {
    case 'center-top':
      x = Math.floor((width - scaledWidth) / 2);
      y = 5;
      break;
    case 'top-right':
      x = width - scaledWidth - Math.round(20 * scale);
      y = 5;
      break;
    case 'bottom-right':
      x = width - scaledWidth - Math.round(20 * scale);
      y = height - Math.floor(scaledHeight * scale) - 40;
      break;
    case 'top-left':
      x = Math.round(20 * scale);
      y = 5;
      break;
    case 'bottom-left':
      x = Math.round(20 * scale);
      y = height - Math.floor(scaledHeight * scale) - 40;
      break;
    case 'center-bottom':
    default:
      x = Math.floor((width - scaledWidth) / 2);
      y = height - Math.floor(scaledHeight * scale) - 40;
      break;
  }

  const notificationWindow = new BrowserWindow({
    width: scaledWidth,
    height: scaledHeight,
    x,
    y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    type: 'notification',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  notificationWindow.setAlwaysOnTop(true, 'screen-saver');
  notificationWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  notificationWindow.setFullScreenable(false);
  notificationWindow.setFocusable(false);

  notificationWindow.loadFile(presetHtml);

  notificationWindow.webContents.on('did-finish-load', () => {
    notificationWindow.webContents.send('show-notification', {
      displayName: message.displayName,
      description: message.description,
      iconPath: `${message.config_path}\\${message.icon}`,
      scale,
    });
  });

  return notificationWindow;
}

try {
  if (app.requestSingleInstanceLock() !== true) app.quit();

  app
    .on('ready', function () {
      const args = require('minimist')(process.argv.slice(1));
      let overlayAppid = args['overlay-appid'];
      overlayAppid ? createOverlayWindow(overlayAppid) : createMainWindow();
    })
    .on('window-all-closed', function () {
      app.quit();
    })
    .on('web-contents-created', (event, contents) => {
      contents.on('new-window', (event, url) => {
        event.preventDefault();
      });
    })
    .on('second-instance', (event, argv, cwd) => {
      const args = require('minimist')(process.argv.slice(1));
      let overlayAppid = args['overlay-appid'];
      overlayAppid ? createOverlayWindow(overlayAppid) : createMainWindow();
    });
} catch (err) {
  dialog.showErrorBox('Critical Error', `Failed to initialize:\n${err}`);
  app.quit();
}
