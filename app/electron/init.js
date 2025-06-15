'use strict';

const path = require('path');
const { app } = require('electron');
app.setName('Achievement Watcher');
app.setPath('userData', path.join(app.getPath('appData'), app.getName()));
const { BrowserWindow, dialog, session, shell, ipcMain, globalShortcut } = require('electron');
const { autoUpdater } = require('electron-updater');
const remote = require('@electron/remote/main');
remote.initialize();
const minimist = require('minimist');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const ipc = require(path.join(__dirname, 'ipc.js'));
const player = require('sound-play');
const { fetchIcon } = require(path.join(__dirname, '../parser/steam.js'));
const { pathToFileURL } = require('url');
const SteamUser = require('steam-user');
const client = new SteamUser();
client.logOn({ anonymous: true });
client.on('loggedOn', () => {
  console.log('logged on');
});

const manifest = require('../package.json');
const userData = app.getPath('userData');

if (manifest.config['disable-gpu']) app.disableHardwareAcceleration();
if (manifest.config.appid) app.setAppUserModelId(manifest.config.appid);

let MainWin = null;
let progressWindow = null;
let overlayWindow = null;
let playtimeWindow = null;
let notificationWindow = null;
let isplaytimeWindowShowing = false;
let isNotificationShowing = false;
let isProgressWindowShowing = false;
let isOverlayShowing = false;
const earnedNotificationQueue = [];
const playtimeQueue = [];
const progressQueue = [];

ipcMain.on('get-steam-data', async (event, arg) => {
  const appid = +arg.appid;
  if (arg.type === 'icon') {
    await client.getProductInfo([appid], [], false, async (err, data) => {
      const appInfo = data[appid].appinfo;
      event.returnValue = `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${appid}/${appInfo.common.icon}.jpg`;
    });
  }
  if (arg.type === 'portrait') {
    await client.getProductInfo([appid], [], false, async (err, data) => {
      const appInfo = data[appid].appinfo;
      event.returnValue = `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/${appInfo.common.library_assets_full.library_capsule.image.english}`;
    });
  }
  await delay(5000);
  event.returnValue = {};
});

ipcMain.on('notify-test', async (event, arg) => {
  await createNotificationWindow({ appid: 400, ach: 'PORTAL_TRANSMISSION_RECEIVED' });
});

ipcMain.on('playtime-test', async (event, arg) => {
  await createPlaytimeWindow({ appid: 400, description: 'Testing notification' });
});
ipcMain.on('progress-test', async (event, arg) => {
  await createProgressWindow({ appid: 400, ach: 'PORTAL_TRANSMISSION_RECEIVED', description: 'Testing progress', count: '50/100' });
});

ipcMain.handle('start-watchdog', async (event, arg) => {
  event.sender.send('reset-watchdog-status');
  console.log('starting watchdog');
  const wd = spawn(
    path.join(manifest.config.debug ? path.join(__dirname, '../../service/') : path.dirname(process.execPath), 'nw/nw.exe'),
    ['-config', 'watchdog.json'],
    {
      cwd: path.join(manifest.config.debug ? path.join(__dirname, '../../service/') : path.dirname(process.execPath), 'nw/'),
      detached: true,
      stdio: 'ignore',
      shell: false,
    }
  );
  wd.unref(); // Let it run independently
  console.log('Started watchdog.');
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMainWindow() {
  if (MainWin) {
    if (MainWin.isMinimized()) MainWin.restore();
    MainWin.focus();
    return;
  }
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
            if (name.toLowerCase() === 'node' && description.toLowerCase().includes('achievement watchdog')) {
              found = true;
            }
          }
        }
        if (MainWin) MainWin.webContents.send('watchdog-status', found);
      });
    }, 5000);
  });

  MainWin.on('closed', () => {
    MainWin = null;
  });
}

/**
 * @param {{appid: string, description:string}} selectedConfig
 */
function createOverlayWindow(selectedConfig) {
  if (!selectedConfig.description) selectedConfig.description = 'open';
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    if (String(selectedConfig.appid) === '0' || selectedConfig.description == 'close') {
      overlayWindow.close();
      return;
    }
    if (selectedConfig.description === 'refresh') {
      overlayWindow.webContents.send('refresh-achievements-table', String(selectedConfig.appid));
      return;
    }
  }
  if (String(selectedConfig.appid) === '0' || selectedConfig.description === 'refresh') return;
  const { width, height } = require('electron').screen.getPrimaryDisplay().workAreaSize;
  isOverlayShowing = true;

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
    focusable: true,
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
  overlayWindow.setFocusable(true);
  overlayWindow.blur();

  overlayWindow.loadFile(path.join(manifest.config.debug ? '' : userData, 'view\\overlay.html'));
  let selectedLanguage = 'english';
  overlayWindow.webContents.on('did-finish-load', () => {
    overlayWindow.webContents.send('load-overlay-data', selectedConfig.appid);
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
    overlayWindow.showInactive();
  });

  overlayWindow.on('closed', () => {
    isOverlayShowing = false;
    overlayWindow = null;
  });
}

async function createNotificationWindow(info) {
  if (isNotificationShowing) {
    earnedNotificationQueue.push(info);
    return;
  }
  isNotificationShowing = true;
  const settingsJS = require(path.join(__dirname, '../settings.js'));
  settingsJS.setUserDataPath(userData);
  let configJS = await settingsJS.load();
  configJS.achievement_source.greenLuma = false;
  configJS.achievement_source.importCache = false;
  configJS.achievement_source.rpcs3 = false;
  const achievementsJS = require(path.join(__dirname, '../parser/achievements.js'));
  achievementsJS.initDebug({ isDev: app.isDev || false, userDataPath: userData });
  let ach = await achievementsJS.getAchievementsForAppid(configJS, info.appid);
  let a = ach.achievement.list.find((ac) => ac.name === String(info.ach));

  const message = {
    displayName: a.displayName || '',
    description: a.description || '',
    icon: pathToFileURL(await fetchIcon(a.icon, info.appid)).href,
    icon_gray: pathToFileURL(await fetchIcon(a.icongray, info.appid)).href,
    preset: configJS.overlay.preset,
    position: configJS.overlay.position,
    scale: parseFloat(configJS.overlay.scale),
  };

  const display = require('electron').screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  const preset = message.preset || 'default';
  const presetFolder = path.join(manifest.config.debug ? path.join(__dirname, '../') : userData, 'presets', preset);
  const presetHtml = path.join(presetFolder, 'index.html');
  const position = message.position || 'center-bot';
  const scale = parseFloat(message.scale * 0.01 || 1);

  const { width: windowWidth, height: windowHeight } = getPresetDimensions(presetFolder);

  const scaledWidth = windowWidth * scale;
  const scaledHeight = windowHeight * scale;

  let x = 0,
    y = 0;

  if (position.includes('left')) {
    x = 20;
  } else if (position.includes('right')) {
    x = width - scaledWidth - 20;
  } else if (position.includes('center')) {
    x = Math.floor(width / 2 - scaledWidth / 2);
  }

  if (position.includes('top')) {
    y = 10;
  } else if (position.includes('bot')) {
    y = height - Math.round(scaledHeight) - 20;
  } else if (position.includes('mid')) {
    y = height / 2 - Math.round(scaledHeight / 2);
  }

  notificationWindow = new BrowserWindow({
    width: scaledWidth,
    height: scaledHeight,
    x,
    y,
    transparent: true,
    frame: false,
    show: false,
    alwaysOnTop: true,
    focusable: true,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '../overlayPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (manifest.config.debug) {
    notificationWindow.webContents.openDevTools({ mode: 'undocked' });
    notificationWindow.isDev = true;
    console.info((({ node, electron, chrome }) => ({ node, electron, chrome }))(process.versions));
    try {
      const contextMenu = require('electron-context-menu')({
        append: (defaultActions, params, browserWindow) => [
          {
            label: 'Reload',
            visible: params,
            click: () => {
              notificationWindow.reload();
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

  notificationWindow.setAlwaysOnTop(true, 'screen-saver');
  notificationWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  notificationWindow.setFullScreenable(false);
  notificationWindow.setFocusable(true);
  notificationWindow.setIgnoreMouseEvents(true, { forward: true });

  if (configJS.notification_toast.customToastAudio === '2' || configJS.notification_toast.customToastAudio === '1') {
    let toastAudio = require(path.join(__dirname, '../util/toastAudio.js'));
    let soundFile = configJS.notification_toast.customToastAudio === '1' ? toastAudio.getDefault() : toastAudio.getCustom();
    player.play(soundFile);
  }
  notificationWindow.webContents.on('did-finish-load', () => {
    notificationWindow.showInactive();
    notificationWindow.webContents.send('set-window-scale', scale);
    notificationWindow.webContents.send('set-animation-scale', (configJS.overlay?.duration ?? 1) * 0.01);
    notificationWindow.webContents.send('show-notification', {
      displayName: message.displayName,
      description: message.description,
      iconPath: message.icon,
      scale,
    });
    createOverlayWindow({ appid: info.appid, description: 'refresh' });
  });

  notificationWindow.on('closed', async () => {
    isNotificationShowing = false;
    notificationWindow = null;
    if (earnedNotificationQueue.length > 0) createNotificationWindow(earnedNotificationQueue.shift());
  });

  notificationWindow.loadFile(presetHtml);
}

async function createPlaytimeWindow(info) {
  if (isplaytimeWindowShowing) {
    playtimeQueue.push(info);
    return;
  }
  isplaytimeWindowShowing = true;

  const { width: screenWidth } = require('electron').screen.getPrimaryDisplay().workAreaSize;
  const winWidth = 460;
  const winHeight = 340;
  const x = Math.floor((screenWidth - winWidth) / 2);
  const y = 40;

  playtimeWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x,
    y,
    frame: false,
    type: 'notification',
    alwaysOnTop: true,
    transparent: true,
    resizable: false,
    show: false,
    skipTaskbar: true,
    focusable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, '../overlayPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  playtimeWindow.setIgnoreMouseEvents(true, { forward: true });
  playtimeWindow.setAlwaysOnTop(true, 'screen-saver');
  playtimeWindow.setVisibleOnAllWorkspaces(true);
  playtimeWindow.setFullScreenable(false);
  playtimeWindow.setFocusable(false);

  info.headerUrl = pathToFileURL(
    await fetchIcon(`https://cdn.cloudflare.steamstatic.com/steam/apps/${String(info.appid)}/header.jpg`, info.appid)
  ).href;
  playtimeWindow.once('ready-to-show', () => {
    if (playtimeWindow && !playtimeWindow.isDestroyed()) {
      playtimeWindow.show();

      //const prefs = fs.existsSync(preferencesPath) ? JSON.parse(fs.readFileSync(preferencesPath, 'utf8')) : {};
      const scale = 1; //prefs.notificationScale || 1;

      playtimeWindow.webContents.send('show-playtime', {
        ...info,
        scale,
      });
    }
  });
  ipcMain.once('close-playtime-window', () => {
    if (playtimeWindow && !playtimeWindow.isDestroyed()) {
      playtimeWindow.close();
    }
  });

  playtimeWindow.on('closed', () => {
    isplaytimeWindowShowing = false;
    playtimeWindow = null;
    if (playtimeQueue.length > 0) {
      createPlaytimeWindow(playtimeQueue.shift());
    }
  });

  playtimeWindow.loadFile(path.join(manifest.config.debug ? path.join(__dirname, '..') : userData, '\\view\\playtime.html'));
}

async function createProgressWindow(info) {
  if (isProgressWindowShowing) {
    if (progressWindow.appid !== info.appid) {
      progressQueue.push(info);
      return;
    }
    progressWindow.close();
  }
  isProgressWindowShowing = true;
  const { width, height } = require('electron').screen.getPrimaryDisplay().workAreaSize;

  progressWindow = new BrowserWindow({
    width: 350,
    height: 150,
    x: 20,
    y: height - 140,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: true,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../overlayPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  progressWindow.setAlwaysOnTop(true, 'screen-saver');
  progressWindow.setVisibleOnAllWorkspaces(true);
  progressWindow.setFullScreenable(false);
  progressWindow.setFocusable(true);
  progressWindow.setIgnoreMouseEvents(true, { forward: true });

  const settingsJS = require(path.join(__dirname, '../settings.js'));
  settingsJS.setUserDataPath(userData);
  let configJS = await settingsJS.load();
  const achievementsJS = require(path.join(__dirname, '../parser/achievements.js'));
  achievementsJS.initDebug({ isDev: app.isDev || false, userDataPath: userData });
  let ach = await achievementsJS.getAchievementsForAppid(configJS, info.appid);
  let a = ach.achievement.list.find((ac) => ac.name === info.ach);
  let [count, max_count] = info.count.split('/').map(Number);
  let data = {
    progress: count,
    max_progress: max_count,
    displayName: a.displayName,
    icon: pathToFileURL(await fetchIcon(a.icon, info.appid)).href,
  };
  progressWindow.once('ready-to-show', () => {
    progressWindow.showInactive();
    progressWindow.webContents.send('show-progress', data);
    createOverlayWindow({ appid: info.appid, description: 'refresh' });
  });

  progressWindow.on('closed', () => {
    isProgressWindowShowing = false;
    progressWindow = null;
    if (progressQueue.length > 0) {
      createProgressWindow(progressQueue.shift());
    }
  });

  setTimeout(() => {
    if (progressWindow && !progressWindow.isDestroyed()) progressWindow.close();
  }, 5000);

  progressWindow.loadFile(path.join(manifest.config.debug ? path.join(__dirname, '..') : userData, 'view/progress.html'));
  progressWindow.appid = info.appid;
}

function getPresetDimensions(presetFolder) {
  const presetIndexPath = path.join(presetFolder, 'index.html');
  try {
    const content = fs.readFileSync(presetIndexPath, 'utf-8');
    const metaRegex = /<meta\s+width\s*=\s*"(\d+)"\s+height\s*=\s*"(\d+)"\s*\/?>/i;
    const match = content.match(metaRegex);
    if (match) {
      return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
    }
  } catch (error) {
    notifyError('Error reading preset: ' + error.message);
  }
  // Default values if not defined
  return { width: 400, height: 200 };
}

function parseArgs(args) {
  let windowType = args['wintype'] || 'main'; // overlay, playtime, progress, achievement
  let appid = args['appid']; // appid
  let ach = args['ach']; // achievement name
  let description = args['description']; // text
  let count = args['count'] || '0/100'; // count / max_count
  console.log('opening ' + windowType + ' window');
  switch (windowType) {
    case 'playtime':
      createPlaytimeWindow({ appid, description });
      break;
    case 'overlay':
      createOverlayWindow({ appid, description });
      break;
    case 'progress':
      createProgressWindow({ appid, ach, count });
      break;
    case 'achievement':
      createNotificationWindow({ appid, ach });
      break;
    case 'main':
    default:
      createMainWindow();
      break;
  }
}

function checkResources() {
  function copyFolderRecursive(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const e of entries) {
      const srcPath = path.join(src, e.name);
      const dstPath = path.join(dst, e.name);
      if (e.isDirectory()) {
        copyFolderRecursive();
      } else {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  }

  const resourcesPath = path.join(manifest.config.debug ? path.join(__dirname, '..') : path.join(process.resourcesPath, 'userdata'));
  if (!fs.existsSync(path.join(userData, 'Presets'))) {
    const presets = path.join(resourcesPath, 'presets');
    copyFolderRecursive(presets, path.join(userData, 'Presets'));
  }

  if (!fs.existsSync(path.join(userData, 'Media'))) {
    const media = path.join(resourcesPath, 'Media');
    copyFolderRecursive(media, path.join(userData, 'Media'));
  }
  if (!fs.existsSync(path.join(userData, 'view'))) {
    const view = path.join(resourcesPath, 'view');
    copyFolderRecursive(view, path.join(userData, 'view'));
  }

  if (!fs.existsSync(path.join(app.getPath('appData'), 'obs-studio', 'basic', 'profiles', 'AW'))) {
    const profile = path.join(resourcesPath, 'obs', 'AW');
    copyFolderRecursive(profile, path.join(app.getPath('appData'), 'obs-studio', 'basic', 'profiles', 'AW'));
    fs.copyFileSync(path.join(resourcesPath, 'obs', 'AW.json'), path.join(app.getPath('appData'), 'obs-studio', 'basic', 'scenes', 'AW.json'));
  }
}

try {
  if (app.requestSingleInstanceLock() !== true) app.quit();
  checkResources();
  app
    .on('ready', async function () {
      autoUpdater.checkForUpdatesAndNotify();
      ipc.window();
      const args = minimist(process.argv.slice(1));
      parseArgs(args);
      await delay(5000);
      if (!overlayWindow && !progressWindow && !notificationWindow && !playtimeWindow && !MainWin) app.quit();
    })
    .on('window-all-closed', function () {
      if (
        earnedNotificationQueue.length === 0 &&
        !isNotificationShowing &&
        playtimeQueue.length === 0 &&
        !isplaytimeWindowShowing &&
        !isProgressWindowShowing &&
        progressQueue.length === 0 &&
        !isOverlayShowing
      )
        app.quit();
    })
    .on('web-contents-created', (event, contents) => {
      contents.on('new-window', (event, url) => {
        event.preventDefault();
      });
    })
    .on('second-instance', async (event, argv, cwd) => {
      const args = minimist(argv.slice(1));
      parseArgs(args);
      await delay(5000);
      if (!overlayWindow && !progressWindow && !notificationWindow && !playtimeWindow && !MainWin) app.quit();
    });
  autoUpdater.on('update-downloaded', () => {
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Update Ready',
        message: 'A new version has been downloaded. Restart now to install it?',
        buttons: ['Yes', 'Later'],
      })
      .then((result) => {
        if (result.response === 0) autoUpdater.quitAndInstall();
      });
  });
} catch (err) {
  dialog.showErrorBox('Critical Error', `Failed to initialize:\n${err}`);
  app.quit();
}
