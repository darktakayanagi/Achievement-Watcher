'use strict';

const path = require('path');
const { app } = require('electron');
app.setName('Achievement Watcher');
app.setPath('userData', path.join(app.getPath('appData'), app.getName()));
const puppeteer = require('puppeteer');
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
const fetch = require('node-fetch');
const BASE_URL = 'https://www.steamgriddb.com/api/v2';
const API_KEY = '2a9d32ddd0bfe4e1191b4f6ff56fef60'; // TODO: remove this and load from config file
const sharp = require('sharp');
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
  //TODO: get all necessary data from steamdb pages
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
  if (arg.type === 'data') {
    let info = { appid };
    openSteamDB(info);
    while (!info.achievements) {
      await delay(500);
    }
    event.returnValue = info;
    return;
  }
  await delay(5000);
  event.returnValue = {};
});

ipcMain.on('get-steam-appid-from-title', async (event, arg) => {
  function normalizeTitle(str) {
    return str
      .toLowerCase()
      .normalize('NFKD') // normalize accents
      .replace(/[\u2018\u2019\u201A\u201B\u2039\u203A']/g, '') // single quotes
      .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB"]/g, '') // double quotes
      .replace(/[™®©]/g, '') // trademark symbols
      .replace(/[:.,!?()\\[\\]{}\-]/g, '') // punctuation + hyphens
      .replace(/\s+/g, ' ') // collapse spaces
      .trim();
  }

  let info = { name: arg.title };
  searchForSteamAppId(info);
  while (true) {
    if (info.games) {
      for (let game of info.games) {
        if (normalizeTitle(game.title) === normalizeTitle(arg.title)) {
          event.returnValue = game.appid;
          return;
        }
      }
      break;
    }
    await delay(500);
  }
  event.returnValue = undefined;
});

ipcMain.on('get-title-from-epic-id', async (event, arg) => {
  let info = { appid: arg.appid };
  await searchForGameName(info);
  while (true) {
    if (info.title) {
      event.returnValue = info.title;
      return;
    }
    await delay(500);
  }
});

ipcMain.on('get-images-for-game', async (event, arg) => {
  const gameName = arg.name;
  try {
    const searchRes = await fetch(`${BASE_URL}/search/autocomplete/${encodeURIComponent(gameName)}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    const searchData = await searchRes.json();
    const game = searchData.data[0];
    if (!game) {
      console.log('Game not found');
      return;
    }

    const gameId = game.id;

    const [iconsRes, gridsRes, heroesRes] = await Promise.all([
      fetch(`${BASE_URL}/icons/game/${gameId}`, { headers: { Authorization: `Bearer ${API_KEY}` } }),
      fetch(`${BASE_URL}/grids/game/${gameId}`, { headers: { Authorization: `Bearer ${API_KEY}` } }),
      fetch(`${BASE_URL}/heroes/game/${gameId}`, { headers: { Authorization: `Bearer ${API_KEY}` } }),
    ]);

    const [icons, grids, heroes] = await Promise.all([iconsRes.json(), gridsRes.json(), heroesRes.json()]);

    const portrait = grids.data.find((g) => g.width === 600 && g.height === 900);
    const landscape = grids.data.find((g) => g.width === 920 && g.height === 430);
    const links = { icon: icons.data?.[0]?.url, background: heroes.data?.[0]?.url, portrait: portrait?.url, landscape: landscape?.url };
    event.returnValue = links;
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
});

ipcMain.on('stylize-background-for-appid', async (event, arg) => {
  const imageUrl = arg.background;
  const t = path.parse(imageUrl).base;
  const outputPath = path.join(app.getPath('userData'), 'steam_cache', 'icon', arg.appid, t);

  try {
    const res = await fetch(imageUrl);
    if (!res.ok) throw new Error(`Failed to fetch image: ${res.statusText}`);
    const buffer = await res.buffer();

    const metadata = await sharp(buffer).metadata();
    const { width, height } = metadata;

    const processedBuffer = await sharp(buffer)
      .blur(5)
      .modulate({ saturarion: 0.5 })
      .composite([
        {
          input: Buffer.from(
            `<svg width="${width}" height="${height}">
              <rect width="100%" height="100%" fill="#3b65a7" fill-opacity="0.8"/>
              <rect width="100%" height="100%" fill="#000000" fill-opacity="0.4"/>
             </svg>`
          ),
          blend: 'over',
        },
      ])
      .toBuffer();

    fs.writeFileSync(outputPath, processedBuffer);
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
});

ipcMain.on('fetch-source-img', async (event, arg) => {
  switch (arg) {
    case 'epic':
      event.returnValue = path.join(process.env['APPDATA'], 'Achievement Watcher', 'Source', 'epic.svg');
      break;
    case 'gog':
      event.returnValue = path.join(process.env['APPDATA'], 'Achievement Watcher', 'Source', 'gog.svg');
      break;
    case 'playstation':
      event.returnValue = path.join(process.env['APPDATA'], 'Achievement Watcher', 'Source', 'playstation.svg');
      break;
    case 'steam':
    default:
      event.returnValue = path.join(process.env['APPDATA'], 'Achievement Watcher', 'Source', 'steam.svg');
      break;
  }
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

/**
 * @param {{appid: string}} info
 */
function openSteamDB(info = { appid: 269770 }) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36');
  // Inject JS *before* the page starts executing its own scripts
  win.webContents.on('dom-ready', async () => {
    await win.webContents.executeJavaScript(`
      // Override navigator.userAgent
      Object.defineProperty(navigator, 'userAgent', {
        get: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
      });

      // Override platform
      Object.defineProperty(navigator, 'platform', {
        get: () => 'Win32'
      });

      // Override vendor
      Object.defineProperty(navigator, 'vendor', {
        get: () => 'Google Inc.'
      });

      // Fake Chrome object
      window.chrome = { runtime: {} };
    `);
  });
  win.loadURL(`https://steamdb.info/app/${info.appid}/stats/`);
  win.webContents.on('did-finish-load', async () => {
    let achievements = undefined;
    let name = undefined;
    try {
      while (!achievements || achievements.length === 0) {
        name = await win.webContents.executeJavaScript(`
          (() => {
            const el = document.querySelector('.achievements_game_name');
            return el?.innerText.trim() || null;
          })()
        `);
        achievements = await win.webContents.executeJavaScript(`
          (() => {
            const items = document.querySelectorAll('.achievements_list .achievement');
            const data = [];
            const appid = document.querySelector('.row.app-row table tbody tr')?.children?.[1]?.innerText.trim() || '';
            items.forEach(item => {
              const idRaw = item.getAttribute('id') || '';
              const id = idRaw.replace(/^achievement-/, '');
              const name = item.querySelector('.achievement_name')?.innerText.trim() || '';
              
              const descContainer = item.querySelector('.achievement_desc');
              const spoiler = descContainer?.querySelector('.achievement_spoiler');
              const hidden = !!spoiler;
              const description = hidden
                ? spoiler?.innerText.trim()
                : descContainer?.innerText.trim() || '';
              const icon = 'https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/'+appid+'/' + item.querySelector('.achievement_image')?.getAttribute('data-name') || '';
              const icongray = 'https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/'+appid+'/' + item.querySelector('.achievement_image_small')?.getAttribute('data-name') || '';
              data.push({ name: id, default_value:0, displayName: name, hidden: hidden ? 1 : 0, description,  icon, icongray});
            });

            return data;
          })()
        `);
        await delay(500);
      }
      info.name = name;
      info.achievements = achievements;
      console.log('Extracted achievements:', achievements.length);
    } catch (error) {
      console.error('Failed to extract achievements:', error);
    }
  });
}

async function searchForGameName(info = { appid: '' }) {
  if (info.appid.length === 0) {
    info.title = undefined;
    return;
  }

  let locale = 'en-US'; // use AW's languague in the future? does it even make a difference in this context?
  let startIndex = 0;
  let matchResult;

  async function scrapePage(startIndex) {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    const url = `https://store.epicgames.com/pt/browse?sortBy=releaseDate&sortDir=DESC&tag=Windows&priceTier=tier3&category=Game&count=40&start=${startIndex}`;

    try {
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
      });
      await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
      );
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

      await page.waitForFunction(() => !!window.__REACT_QUERY_INITIAL_QUERIES__, { timeout: 15000 });
      const queries = await page.evaluate(() => window.__REACT_QUERY_INITIAL_QUERIES__);
      if (queries.queries) {
        const catalogQuery = queries.queries.find((q) => q?.state?.data?.Catalog?.searchStore?.elements);
        if (catalogQuery) {
          const elements = catalogQuery.state.data.Catalog.searchStore.elements;
          const found = elements.find((el) => el.namespace === info.appid);
          if (found) {
            matchResult = found.title;
          }
        }
      }
    } catch (err) {
      console.error(`❌ Error on page ${startIndex}:`, err.message);
    } finally {
      await page.close();
      await browser.close();
    }
    return matchResult;
  }

  async function run() {
    const tasks = [];
    for (let i = 0; i < 5; i++) {
      const startIndex = i;
      tasks.push(scrapePage(startIndex));
    }

    await Promise.all(tasks);
  }
  await run();
  info.title = matchResult;
  return;
}

function searchForSteamAppId(info = { name: '' }) {
  if (info.name.length === 0) {
    info.appid = undefined;
    return;
  }
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36');
  // Inject JS *before* the page starts executing its own scripts
  win.webContents.on('dom-ready', async () => {
    await win.webContents.executeJavaScript(`
      // Override navigator.userAgent
      Object.defineProperty(navigator, 'userAgent', {
        get: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
      });

      // Override platform
      Object.defineProperty(navigator, 'platform', {
        get: () => 'Win32'
      });

      // Override vendor
      Object.defineProperty(navigator, 'vendor', {
        get: () => 'Google Inc.'
      });

      // Fake Chrome object
      window.chrome = { runtime: {} };
    `);
  });
  //win.loadURL(`https://steamdb.info/search/?a=app&q=${info.name}&type=1&category=0`);
  win.loadURL(`https://store.steampowered.com/search/?term=${info.name}&category1=998&ndl=1`);
  win.webContents.on('did-finish-load', async () => {
    let games = undefined;
    try {
      while (!games) {
        games = await win.webContents.executeJavaScript(`
          (() => {
            const rows = document.querySelectorAll('#search_resultsRows a[data-ds-appid]');
            const list = [];

            for (const row of rows) {
              if (list.length >= 10) break;

              const appid = row.getAttribute('data-ds-appid');
              const title = row.querySelector('.title')?.innerText.trim() || '';

              if (appid && title) {
                list.push({ appid, title });
              }
            }

            return list;
          })();
        `);

        /* // this is for steamdb
        games = await win.webContents.executeJavaScript(`
          (() => {
            const rows = document.querySelectorAll('#table-sortable tbody tr.app');
            const matches = [];
            console.log(rows);
            rows.forEach(row => {
              const appid = row.getAttribute('data-appid');
              const nameLink = row.querySelector('td:nth-child(3) a');
              const name = nameLink?.innerText.trim();

              if (appid && name) {
                matches.push({ appid, name });
              }
            });

            return matches;
          })();
        `);
        */
        await delay(500);
      }
      info.games = games;
    } catch (error) {
      console.error('Failed to find appid:', error);
    }
  });
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
