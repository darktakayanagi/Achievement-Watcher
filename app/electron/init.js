'use strict';

const path = require('path');
const { app } = require('electron');
app.setName('Achievement Watcher');
app.setPath('userData', path.join(app.getPath('appData'), app.getName()));
const puppeteerCore = require('puppeteer');
const ChromeLauncher = require('chrome-launcher');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
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

function clientLogOn() {
  if (client.steamID) return Promise.resolve();
  return new Promise((resolve) => {
    client.logOn({ anonymous: true });
    client.on('loggedOn', () => {
      resolve();
    });
  });
}

const manifest = require('../package.json');
const userData = app.getPath('userData');
let lastScrape = Date.now();
let settingsJS = null;
let configJS = null;
let achievementsJS = null;

if (manifest.config['disable-gpu']) app.disableHardwareAcceleration();
if (manifest.config.appid) app.setAppUserModelId(manifest.config.appid);

let puppeteerWindow = {};
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
let debug = new (require('@xan105/log'))({
  console: manifest.config.debug || false,
  file: path.join(userData, `logs/renderer.log`),
});

async function getUserAchievements(appid) {
  let steamid = 76561198152618007;

  const url = `https://steamcommunity.com/profiles/${steamid}`;
  const res = await fetch(url, { redirect: 'manual', headers: { userAgent: 'node-fecth' } });
  const l = res.headers.get('location');
  const data = await res.json();

  if (!data.playerstats || !data.playerstats.achievements) {
    throw new Error('No achievements found or stats are private');
  }

  return data.playerstats.achievements.map((a) => ({
    apiName: a.apiname,
    unlocked: a.achieved === 1,
    name: a.name,
    description: a.description,
    unlockTime: a.unlocktime,
  }));
}

async function getSteamData(appid, type) {
  try {
    if (type === 'data') {
      let info = { appid };
      await scrapeWithPuppeteer(info);
      while (!info.achievements) {
        await delay(500);
      }
      return info;
    }
    if (type === 'steamhunters') {
      let info = { appid };
      await scrapeWithPuppeteer(info, { steamhunters: true });
      return info;
    }
    await clientLogOn();
    const { apps, packages, unknownApps, unknownPackages } = await client.getProductInfo([appid], [], false);
    const appInfo = apps[appid]?.appinfo || apps[0]?.appinfo;
    switch (type) {
      case 'name':
        return appInfo?.common?.name;
      case 'common':
        return {
          name: appInfo.common.name,
          isGame: appInfo.common.type.toLowerCase() === 'game',
          icon: appInfo.common.icon,
          header: appInfo.common.header_image?.english || appInfo.common.library_assets_full?.library_header?.image?.english,
          portrait: appInfo.common.library_assets_full?.library_capsule?.image?.english,
        };
      case 'header':
        return appInfo.common.header_image.english || appInfo.common.library_assets_full?.library_header?.image?.english;
      case 'icon':
        return appInfo.common.icon;
      case 'portrait':
        return appInfo.common.library_assets_full?.library_capsule?.image?.english;
      case 'full':
        return apps;
    }

    await delay(10000);
  } catch (err) {
    console.log(err);
  }
  return {};
}

async function closePuppeteer() {
  if (!puppeteerWindow) puppeteerWindow = {};
  if (puppeteerWindow.page) await puppeteerWindow.page.close();
  if (puppeteerWindow.context) await puppeteerWindow.context.close();
  if (puppeteerWindow.browser) await puppeteerWindow.browser.close();
  puppeteerWindow.browser = undefined;
  puppeteerWindow.page = undefined;
  puppeteerWindow.context = undefined;
}

async function startEngines() {
  if (!settingsJS) {
    settingsJS = require(path.join(__dirname, '../settings.js'));
    settingsJS.setUserDataPath(userData);
  }
  if (!configJS) configJS = await settingsJS.load();
  if (!achievementsJS) {
    achievementsJS = require(path.join(__dirname, '../parser/achievements.js'));
    achievementsJS.initDebug({ isDev: app.isDev || false, userDataPath: userData });
  }
}

async function getCachedData(info) {
  if (!info.source) info.source = 'steam';
  let g = await achievementsJS.getGameFromCache(info.appid, info.source, configJS);
  switch (info.source.toLowerCase()) {
    case 'epic':
    case 'gog':
    case 'luma':
    case 'steam':
    default:
      if (g) {
        info.a = g.achievement.list.find((ac) => ac.name === String(info.ach));
        info.game = g;
        info.description = info.a?.displayName;
        return;
      }
      let data = await getSteamData(info.appid, 'steamhunters');
      info.game = data;
      await achievementsJS.saveGameToCache(info, configJS.achievement.lang);
      info.a = info.game.achievements.find((ac) => ac.name === String(info.ach));
      info.description = info.a?.displayName;
  }
}

ipcMain.on('capture-screen', async (event, { image, filename }) => {
  if (!configJS.souvenir_screenshot.screenshot) return;
  const buffer = Buffer.from(image, 'base64');
  const savePath = path.join(
    configJS.souvenir_screenshot.custom_dir || app.getPath('pictures'),
    notificationWindow.info.game.name,
    notificationWindow.info.description + '.png'
  );
  fs.mkdirSync(path.dirname(savePath), { recursive: true });
  if (!configJS.souvenir_screenshot.overwrite_image && fs.existsSync(savePath)) return;
  fs.writeFileSync(savePath, buffer);
});

ipcMain.on('close-puppeteer', async (event, arg) => {
  await closePuppeteer();
  event.returnValue = true;
});

ipcMain.on('get-steam-data', async (event, arg) => {
  const appid = +arg.appid;
  event.returnValue = await getSteamData(appid, arg.type);
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
  let possibleMatch;
  while (true) {
    if (info.games) {
      for (let game of info.games) {
        if (normalizeTitle(game.title) === normalizeTitle(arg.title)) {
          event.returnValue = game.appid;
          return;
        }
        if (!possibleMatch && normalizeTitle(game.title).includes(normalizeTitle(arg.title))) {
          possibleMatch = game.appid;
        }
      }
      break;
    }
    await delay(500);
  }
  event.returnValue = possibleMatch;
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
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
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

ipcMain.on('achievement-data-ready', () => {
  progressWindow.showInactive();
});

ipcMain.handle('get-achievements', async (event, appid) => {
  return await getSteamData(appid, 'steamhunters');
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

async function scrapeWithPuppeteer(info = { appid: 269770 }, alternate) {
  //if (Date.now() - lastScrape < 3000) {
  //  await delay(Math.floor(Math.random() * 1500) + (Date.now() - lastScrape));
  //  lastScrape = Date.now();
  //}
  try {
    const chromePath = ChromeLauncher.Launcher.getInstallations()[0];
    const url = `https://steamhunters.com/apps/${info.appid}/achievements`;
    if (!puppeteerWindow.browser)
      puppeteerWindow.browser = await puppeteer.launch({
        headless: alternate && alternate.steamhunters ? 'new' : false,
        executablePath: chromePath || puppeteer.executablePath(),
      });
    if (!puppeteerWindow.context) puppeteerWindow.context = await puppeteerWindow.browser.createIncognitoBrowserContext();
    if (!puppeteerWindow.page) puppeteerWindow.page = await puppeteerWindow.context.newPage();
    //if (info.achievements) return;
    if (alternate) {
      if (alternate.steamhunters) {
        const url = `https://steamhunters.com/apps/${info.appid}/achievements?group=&sort=name`;
        const page = puppeteerWindow.page;
        try {
          await page.setRequestInterception(true);
          page.on('request', (req) => {
            const type = req.resourceType();
            if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
              req.abort();
            } else {
              req.continue();
            }
          });
          await page.goto(url);
          await page.waitForFunction(() => {
            return Array.from(document.querySelectorAll('script')).some((s) => s.textContent.includes('var sh'));
          });
          await page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'));
            const target = scripts.find((s) => s.textContent.includes('var sh'));
            eval(target.textContent);
          });
          const achievements = (await page.evaluate(() => sh.model.listData.pagedList.items)) || [];

          const results = [];
          achievements.forEach((item) => {
            results.push({
              name: item.apiName,
              default_value: 0,
              displayName: item.name,
              hidden: item.hidden ? 1 : 0,
              description: item.description,
              icon: item.icon,
              icongray: item.iconGray,
            });
          });
          info.achievements = results;
        } catch (e) {
          console.log(e);
        }
        return;
      }

      const url = `https://steamcommunity.com/profiles/${alternate.steamid}`;
      const page = puppeteerWindow.page;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
      } catch (e) {
        console.log(e);
      }
      const url3 = page.url();
      await page.goto(`${url3}/stats/${info.appid}/?tab=achievements`, { waitUntil: 'domcontentloaded' });
      return;
    }
    const url1 = `https://steamdb.info/app/${info.appid}/info/`;
    const url2 = `https://steamdb.info/app/${info.appid}/stats/`;
    const page2 = puppeteerWindow.page;

    await page2.goto(url2, { waitUntil: 'domcontentloaded' });
    const pageText = await page2.evaluate(() => document.body.innerText || '');
    if (pageText.includes('No app was found matching this AppID')) {
      info.achievements = [];
      return;
    }
    if (!page2.url().includes('/stats')) {
      info.achievements = [];
      return;
    }
    info.name = await page2.evaluate(() => {
      const el = document.querySelector('.pagehead-title h1');
      return el?.innerText.trim() || null;
    });
    await page2.waitForSelector('.achievements_list', { timeout: 5000 }).catch(() => {
      throw new Error('Achievements list container not found');
    });
    // Get achievements
    info.achievements = await page2.evaluate(() => {
      const items = document.querySelectorAll('.achievements_list .achievement');
      const data = [];

      const appid = document.querySelector('.row.app-row table tbody tr')?.children?.[1]?.innerText.trim() || '';

      items.forEach((item) => {
        const idRaw = item.getAttribute('id') || '';
        const id = idRaw.replace(/^achievement-/, '');
        const name = item.querySelector('.achievement_name')?.innerText.trim() || '';

        const descContainer = item.querySelector('.achievement_desc');
        const spoiler = descContainer?.querySelector('.achievement_spoiler');
        const hidden = !!spoiler;
        const description = hidden ? spoiler?.innerText.trim() : descContainer?.innerText.trim() || '';

        const icon = appid
          ? 'https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/' +
            appid +
            '/' +
            (item.querySelector('.achievement_image')?.getAttribute('data-name') || '')
          : '';

        const icongray = appid
          ? 'https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/' +
            appid +
            '/' +
            (item.querySelector('.achievement_image_small')?.getAttribute('data-name') || '')
          : '';

        data.push({
          name: id,
          default_value: 0,
          displayName: name,
          hidden: hidden ? 1 : 0,
          description,
          icon,
          icongray,
        });
      });

      return data;
    });
    await delay(Math.floor(Math.random() * (1500 - 800 + 1)) + 800);
    lastScrape = Date.now();
    await page2.goto(url1, { waitUntil: 'domcontentloaded' });
    info.icon = await page2.evaluate(() => {
      const el = document.querySelector('#js-assets-table');
      const row = Array.from(el.rows).find((r) => r.cells[0].textContent.trim() === 'icon');

      if (row) {
        return row.cells[1].querySelector('a').textContent.trim();
      }
    });
    return;
  } catch (err) {
    debug.log(err);
  }
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
    if (!puppeteerWindow.browser) puppeteerWindow.browser = await puppeteer.launch({ headless: false, executablePath: puppeteer.executablePath() });
    if (!puppeteerWindow.context) puppeteerWindow.context = await puppeteerWindow.browser.createIncognitoBrowserContext();
    const page = await puppeteerWindow.context.newPage();

    const url = `https://store.epicgames.com/pt/browse?sortBy=releaseDate&sortDir=DESC&tag=Windows&priceTier=tier3&category=Game&count=40&start=${
      40 * startIndex
    }`;

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
    }
    return matchResult;
  }

  async function run(start) {
    const tasks = [];
    for (let i = start; i < start + 5; i++) {
      const startIndex = i;
      tasks.push(scrapePage(startIndex));
    }

    await Promise.all(tasks);
  }

  while (!info.title) {
    await run(startIndex);
    info.title = matchResult;
    startIndex += 5;
  }
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
      backgroundThrottling: false,
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
    backgroundThrottling: false,
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
 * @param {{appid: string, action:string}} info
 */
async function createOverlayWindow(info) {
  if (!info.action) info.action = 'open';
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    if (String(info.appid) === '0' || info.action == 'close') {
      overlayWindow.close();
      return;
    }
    if (info.action === 'refresh') {
      overlayWindow.webContents.send('refresh-achievements-table', String(info.appid));
      return;
    }
  }
  if (String(info.appid) === '0' || info.action === 'refresh') return;
  const { width, height } = require('electron').screen.getPrimaryDisplay().workAreaSize;
  isOverlayShowing = true;

  await startEngines();
  await getCachedData(info);
  info.game = await achievementsJS.getSavedAchievementsForAppid(configJS, { appid: info.appid });

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
      additionalArguments: [`--isDev=${app.isDev ? 'true' : 'false'}`, `--userDataPath=${userData}`],
      contextIsolation: true,
      nodeIntegration: false,
      devTools: manifest.config.debug || false,
      backgroundThrottling: false,
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
    overlayWindow.webContents.send('show-overlay', info.game);
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

  await startEngines();
  await clientLogOn();
  await getCachedData(info);
  closePuppeteer();
  const message = {
    displayName: info.a.displayName || '',
    description: info.a.description || '',
    icon: pathToFileURL(await fetchIcon(info.a.icon, info.appid)).href,
    icon_gray: pathToFileURL(await fetchIcon(info.a.icongray, info.appid)).href,
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
      additionalArguments: [`--isDev=${app.isDev ? 'true' : 'false'}`, `--userDataPath=${userData}`],
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
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
  notificationWindow.info = info;

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
    createOverlayWindow({ appid: info.appid, action: 'refresh' });
  });

  notificationWindow.on('closed', async () => {
    isNotificationShowing = false;
    notificationWindow = null;
    if (earnedNotificationQueue.length > 0) createNotificationWindow(earnedNotificationQueue.shift());
  });

  notificationWindow.webContents.on('console-message', (e, level, message, line, sourceID) => {
    debug.log(message, sourceID, line);
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
      additionalArguments: [`--isDev=${app.isDev ? 'true' : 'false'}`, `--userDataPath=${userData}`],
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  playtimeWindow.setIgnoreMouseEvents(true, { forward: true });
  playtimeWindow.setAlwaysOnTop(true, 'screen-saver');
  playtimeWindow.setVisibleOnAllWorkspaces(true);
  playtimeWindow.setFullScreenable(false);
  playtimeWindow.setFocusable(false);

  await startEngines();
  await clientLogOn();
  await getCachedData(info);
  closePuppeteer();
  info.headerUrl = pathToFileURL(await fetchIcon(info.game.img.header, info.appid)).href;
  playtimeWindow.once('ready-to-show', () => {
    if (playtimeWindow && !playtimeWindow.isDestroyed()) {
      playtimeWindow.showInactive();

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

  playtimeWindow.loadFile(path.join(manifest.config.debug ? path.join(__dirname, '..') : userData, 'view', 'playtime.html'));
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
      additionalArguments: [`--isDev=${app.isDev ? 'true' : 'false'}`, `--userDataPath=${userData}`],
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  progressWindow.setAlwaysOnTop(true, 'screen-saver');
  progressWindow.setVisibleOnAllWorkspaces(true);
  progressWindow.setFullScreenable(false);
  progressWindow.setFocusable(true);
  progressWindow.setIgnoreMouseEvents(true, { forward: true });

  await startEngines();
  await getCachedData(info);
  closePuppeteer();
  info.a.icongray = pathToFileURL(await fetchIcon(info.a.icongray, info.appid)).href;

  progressWindow.webContents.on('did-finish-load', () => {
    progressWindow.showInactive();
    progressWindow.webContents.send('show-progress', info);
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
  let source = args['source'] || 'steam'; // source: steam, epic, gog, luma
  let ach = args['ach']; // achievement name
  let description = args['description']; // text
  let count = args['count'] || '0/100'; // count / max_count
  console.log('opening ' + windowType + ' window');
  switch (windowType) {
    case 'playtime':
      createPlaytimeWindow({ appid, source, description });
      break;
    case 'overlay':
      createOverlayWindow({ appid, source, action: description });
      break;
    case 'progress':
      createProgressWindow({ appid, source, ach, count });
      break;
    case 'achievement':
      createNotificationWindow({ appid, source, ach });
      break;
    case 'main':
    default:
      checkResources();
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
        copyFolderRecursive(srcPath, dstPath);
      } else {
        let shouldCopy = false;
        if (!fs.existsSync(dstPath)) shouldCopy = true;
        else {
          try {
            fs.accessSync(dstPath, fs.constants.W_OK);
            const srcStat = fs.statSync(srcPath);
            const dstStat = fs.statSync(dstPath);
            if (srcStat.size !== dstStat.size || srcStat.mtimeMs > dstStat.mtimeMs) shouldCopy = true;
          } catch {}
        }
        if (shouldCopy) fs.copyFileSync(srcPath, dstPath);
      }
    }
  }

  const resourcesPath = path.join(manifest.config.debug ? path.join(__dirname, '..') : path.join(process.resourcesPath, 'userdata'));

  const presets = path.join(resourcesPath, 'presets');
  copyFolderRecursive(presets, path.join(userData, 'Presets'));

  const media = path.join(resourcesPath, 'Media');
  copyFolderRecursive(media, path.join(userData, 'Media'));

  const view = path.join(resourcesPath, 'view');
  copyFolderRecursive(view, path.join(userData, 'view'));

  const source = path.join(resourcesPath, 'Source');
  copyFolderRecursive(source, path.join(userData, 'Source'));

  if (!fs.existsSync(path.join(app.getPath('appData'), 'obs-studio', 'basic', 'profiles', 'AW'))) {
    const profile = path.join(resourcesPath, 'obs', 'AW');
    copyFolderRecursive(profile, path.join(app.getPath('appData'), 'obs-studio', 'basic', 'profiles', 'AW'));
    fs.copyFileSync(path.join(resourcesPath, 'obs', 'AW.json'), path.join(app.getPath('appData'), 'obs-studio', 'basic', 'scenes', 'AW.json'));
  }
}

try {
  if (app.requestSingleInstanceLock() !== true) app.quit();
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
