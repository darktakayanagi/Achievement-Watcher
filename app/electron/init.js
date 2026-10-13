'use strict';

const { app } = require('electron');
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
const path = require('path');
const { Tray, Menu, nativeImage } = require('electron');
app.setName('Achievement Watcher');
app.setPath('userData', path.join(app.getPath('appData'), app.getName()));
app.setAsDefaultProtocolClient('ach');
const CHROMIUM_REVISION = '1108766';
const { BrowserWindow, dialog, session, shell, ipcMain, globalShortcut } = require('electron');
const { autoUpdater } = require('electron-updater');
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.autoDownload = true;
const remote = require('@electron/remote/main');
remote.initialize();
const minimist = require('minimist');
const { XMLParser } = require('fast-xml-parser');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const semver = require('semver');
const ipc = require(path.join(__dirname, 'ipc.js'));
const player = require('node-wav-player');
const { fetchIcon: fetchIconSteam } = require(path.join(__dirname, '../parser/steam.js'));
const { fetchIcon: fetchIconGog } = require(path.join(__dirname, '../parser/gog.js'));
const { fetchIcon: fetchIconEpic } = require(path.join(__dirname, '../parser/epic.js'));
const { pathToFileURL } = require('url');
const fetch = require('node-fetch');
const BASE_URL = 'https://www.steamgriddb.com/api/v2';
const API_KEY = '2a9d32ddd0bfe4e1191b4f6ff56fef60'; // TODO: remove this and load from config file

let client; //lazyload SteamUser
let clientLoginPromise;

function clientLogOn() {
  const SteamUser = require('steam-user');
  if (!client) client = new SteamUser();
  if (client.steamID) return Promise.resolve();
  if (clientLoginPromise) return clientLoginPromise;

  clientLoginPromise = new Promise((resolve, reject) => {
    const cleanup = () => {
      client.removeListener('loggedOn', onLogOn);
      client.removeListener('error', onError);
      client.removeListener('disconnected', onError);
      clientLoginPromise = null;
      debug.log('Steam client logged on');
    };

    const onLogOn = () => {
      cleanup();
      resolve();
    };

    const onError = (err) => {
      cleanup();
      reject(err || new Error('Steam login failed'));
    };

    client.once('loggedOn', onLogOn);
    client.once('error', onError);
    client.once('disconnected', onError);

    client.logOn({ anonymous: true });
  });

  return clientLoginPromise;
}
class Mutex {
  constructor() {
    this._locked = false;
    this._waiting = [];
  }

  lock() {
    const unlock = () => {
      const next = this._waiting.shift();
      if (next) {
        next(unlock);
      } else {
        this._locked = false;
      }
    };

    if (this._locked) {
      return new Promise((resolve) => this._waiting.push(resolve));
    } else {
      this._locked = true;
      return Promise.resolve(unlock);
    }
  }
}
const manifest = require('../package.json');
const userData = app.getPath('userData');
let currentlyscraping = { steamcommunity: new Mutex(), steamhunters: new Mutex(), steamclient: new Mutex() };
let settingsJS = null;
let configJS = null;
let achievementsJS = null;

if (manifest.config['disable-gpu']) app.disableHardwareAcceleration();
if (manifest.config.appid) app.setAppUserModelId(manifest.config.appid);
manifest.config.debug = process.env.NODE_ENV === 'development' || process.defaultApp || /[\\/]electron/.test(process.execPath);

let tray;
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

async function getGogData(request) {
  const CLIENT_ID = '46899977096215655'; //GOG id, don't change
  const CLIENT_SECRET = '9d85c43b1482497dbbce61f6e4aa173a433796eeae2ca8c5f6129f2dc4de46d9'; //GOG secret, don't change

  async function refreshToken(oldToken) {
    const url =
      'https://auth.gog.com/token?' +
      new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: oldToken.refresh_token,
      });

    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to refresh token');
    const newToken = await res.json();

    newToken.user_id = oldToken.user_id;

    saveToken(newToken);
    return newToken;
  }

  function loadToken() {
    const aes = require(path.join(__dirname, '../util/aes.js'));
    try {
      let encryptedToken = JSON.parse(fs.readFileSync(path.join(userData, 'cfg', 'gog_token'), 'utf8'));
      return {
        access_token: aes.decrypt(encryptedToken.access_token),
        expires_in: encryptedToken.expires_in,
        refresh_token: aes.decrypt(encryptedToken.refresh_token),
        scope: '',
        session_id: aes.decrypt(encryptedToken.session_id),
        token_type: 'bearer',
        user_id: aes.decrypt(encryptedToken.user_id),
      };
    } catch {
      return null;
    }
  }

  function saveToken(token) {
    const aes = require(path.join(__dirname, '../util/aes.js'));
    let encryptedToken = {
      access_token: aes.encrypt(token.access_token),
      expires_in: token.expires_in,
      refresh_token: aes.encrypt(token.refresh_token),
      scope: token.scope,
      session_id: aes.encrypt(token.session_id),
      token_type: 'bearer',
      user_id: aes.encrypt(token.user_id),
    };
    fs.writeFileSync(path.join(userData, 'cfg', 'gog_token'), JSON.stringify(encryptedToken, null, 2));
  }

  async function loginAndGetToken() {
    const REDIRECT_URI = 'https://embed.gog.com/on_login_success?origin=client';
    const puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
    const ChromeLauncher = require('chrome-launcher');
    const installedChromePath = ChromeLauncher.Launcher.getInstallations()[0];
    const chromiumPath = fs.existsSync(installedChromePath) ? installedChromePath : (await ensureChromium()).executablePath;
    const browser = await puppeteer.launch({
      headless: false,
      executablePath: chromiumPath,
    });

    const authUrl = `https://auth.gog.com/auth?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(
      REDIRECT_URI
    )}&response_type=code&layout=client2`;

    const page = await browser.newPage();

    console.log('Opening GOG login page. Please log in manually...');
    await page.goto(authUrl);

    // Wait for redirect to on_login_success and grab the code
    const loginCode = await new Promise((resolve, reject) => {
      page.on('framenavigated', (frame) => {
        const url = frame.url();
        if (url.startsWith(REDIRECT_URI)) {
          const code = new URL(url).searchParams.get('code');
          if (code) resolve(code);
          else reject(new Error('No login code found in redirect URL.'));
        }
      });
    });

    // Exchange login code for access token
    const tokenResponse = await fetch(
      `https://auth.gog.com/token?` +
        new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: 'authorization_code',
          code: loginCode,
          redirect_uri: REDIRECT_URI,
        }),
      {
        method: 'GET',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );

    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) throw new Error('Failed to get access token: ' + JSON.stringify(tokenData));

    await browser.close();

    return tokenData; // Contains access_token, refresh_token, expires_in, etc.
  }

  async function getValidToken() {
    let token = loadToken();

    if (!token) {
      // No cached token → open Puppeteer login window
      token = await loginAndGetToken();
      saveToken(token);
      return token;
    }

    // Try using existing token
    const test = await fetch('https://users.gog.com/users/info', {
      headers: { Authorization: 'Bearer ' + token.access_token },
    });

    if (test.status !== 401) {
      return token; // token still good
    }

    // Token expired → try refreshing
    try {
      const newToken = await refreshToken(token);
      return newToken;
    } catch {
      console.warn('Refresh failed — need full login again');
      const freshToken = await loginAndGetToken();
      saveToken(freshToken);
      return freshToken;
    }
  }
  const appid = String(request.appid);
  const type = request.type;
  const token = await getValidToken();
  if (type == 'store') {
    let url2 = `https://api.gog.com/v2/games/${appid}`;
    let data2 = await (await fetch(url2)).json();

    return data2?._links?.store?.href;
  }
  if (type == 'percentage') {
    try {
      const res = await fetch(`https://gameplay.gog.com/clients/${appid}/users/${token.user_id}/achievements`, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });

      if (!res.ok) throw new Error(`Failed to fetch achievements: ${res.status}`);

      const data = await res.json();

      return data.items.map((a) => ({
        name: a.achievement_key,
        percent: a.rarity,
      }));
    } catch (e) {
      debug.log(e);
    }
  }
  if (type == 'data') {
    try {
      const res = await fetch(`https://gameplay.gog.com/clients/${appid}/users/${token.user_id}/achievements`, {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });

      if (!res.ok) throw new Error(`Failed to fetch achievements: ${res.status}`);

      const data = await res.json();

      return data.items.map((a) => ({
        name: a.achievement_key,
        displayName: a.name,
        description: a.description,
        hidden: a.visible ? '0' : '1',
        default_value: '0',
        icongray: a.image_url_locked,
        icon: a.image_url_unlocked,
      }));
    } catch (e) {
      debug.log(e);
    }
  }
  if (type == 'common') {
    let url = `https://www.gogdb.org/data/products/${appid}/product.json`;
    let url2 = `https://api.gog.com/v2/games/${appid}`;
    try {
      let data1 = await (await fetch(url)).json();
      let data2 = await (await fetch(url2)).json();
      const baseImgUrl = 'https://images.gog-statics.com/'; // join with hash
      stylizeBackground(baseImgUrl + data1.image_background + '.jpg', appid, 'gog');
      return {
        name: data1.title,
        isGame: data1.type?.toLowerCase() === 'game',
        translated: false,
        icon: baseImgUrl + (data1.image_icon_square || data1.image_icon) + '.jpg',
        header: baseImgUrl + data1.image_logo + '.jpg',
        portrait: baseImgUrl + data1.image_boxart + '.jpg',
        background: baseImgUrl + data1.image_background + '.jpg',
      };
    } catch (e) {
      debug.log(e);
    }
  }
}

async function getSteamData(request) {
  const appid = request.appid;
  const type = request.type;
  let user = request.user;
  let userid;
  const lang = request.lang || 'english';
  try {
    if (type === 'user') {
      const url = `https://steamcommunity.com/profiles/${user}/stats/${appid}/?xml=1`;
      const res = await fetch(url);
      const xml = await res.text();
      const parser = new XMLParser({ ignoreAttributes: false, allowBooleanAttributes: true, cdataPropName: '__cdata' });
      const data = parser.parse(xml);
      const achievements = data?.playerstats?.achievements?.achievement || [];
      const list = Array.isArray(achievements) ? achievements : [achievements];

      return list.map((a) => {
        const name = a.apiname?.__cdata || a.apiname || '';
        const unlock = parseInt(a.unlockTimestamp ?? 0);
        return {
          apiname: name,
          achieved: unlock > 0 ? 1 : 0,
          unlocktime: unlock || 0,
        };
      });
    }
    if (type === 'steamcommunity') {
      const communityunlock = await currentlyscraping.steamcommunity.lock();
      try {
        let info = { appid };
        const url = `https://steamcommunity.com/stats/${appid}/achievements?l=${lang.api}`; //this doesnt give hidden descriptions
        await scrapeWithPuppeteer(info, { steamcommunity: true, url: url });

        if (info.achievements.every((a) => a.description)) {
          return info;
        }

        let validXml = false;
        let xml;

        //instead of looping steamuserids,
        //lets get users from steamhunters and try those

        await scrapeWithPuppeteer(info, { userlist: true, steamhunters: true, appid });
        let u = info.users.map((user) => user.steamId);

        for (let id of u) {
          userid = id;
          const url = `https://steamcommunity.com/profiles/${userid}/stats/${appid}/?xml=1`; // this for all data
          const res = await fetch(url);
          xml = await res.text();
          validXml = !(xml.startsWith('<!DOCTYPE html') || xml.includes('<html'));
          if (!validXml) continue;

          const parser = new XMLParser({ ignoreAttributes: false, allowBooleanAttributes: true, cdataPropName: '__cdata' });
          const data = parser.parse(xml);
          const achievements = data?.playerstats?.achievements?.achievement || [];
          const list = achievements.map((a) => {
            const unlocked = a['@_closed'] === '1';
            const name = a.name.__cdata;
            const description = a.description.__cdata;
            return { name, description, unlocked };
          });
          const allgood = list.every((a) => a.description);
          if (!allgood) continue;
          const url2 = `https://steamcommunity.com/profiles/${userid}/stats/${appid}?l=${lang.api}`; // this for name and description, match them via icon hash
          await scrapeWithPuppeteer(info, { steamcommunity: true, url: url2 });

          return info;
        }
        // TODO: fallback to steamuserids if noone on steamhunters has 100% the game
        return info;
      } finally {
        communityunlock();
      }
    }
    if (type === 'steamhunters') {
      const huntersunlock = await currentlyscraping.steamhunters.lock();
      try {
        let info = { appid };
        await scrapeWithPuppeteer(info, { steamhunters: true });
        return info;
      } finally {
        huntersunlock();
      }
    }

    const clientunlock = await currentlyscraping.steamclient.lock();

    try {
      await clientLogOn();
      const storeURL = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=en`;
      const json = await Promise.race([
        (async () => {
          const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36',
            Accept: 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: `https://store.steampowered.com/app/${appid}/`,
          };
          const storeRes = await fetch(storeURL, { method: 'GET', headers, timeout: 10000 });
          const json = await storeRes.json();
          return json;
        })(),
        (async () => {
          await startPuppeteer(true, false);

          const page = await puppeteerWindow.context.newPage();
          await page.setUserAgent(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
          );
          await page.goto(storeURL, { waitUntil: 'networkidle2', timeout: 15000 });
          const jsonText = await page.evaluate(() => document.querySelector('body').innerText);
          await page.close();
          const json = JSON.parse(jsonText);
          return json;
        })(),
      ]);
      const storeData = json[appid] && json[appid].data;

      const { apps, packages, unknownApps, unknownPackages } = await client.getProductInfo([appid], [], false);
      const appInfo = apps[appid]?.appinfo;

      switch (type) {
        case 'name':
          return appInfo?.common?.name || storeData?.name || undefined;

        case 'header':
          return (
            appInfo.common.header_image?.[lang.api] ||
            appInfo.common.library_assets_full?.library_header?.image[lang.api] ||
            appInfo.common.header_image.english ||
            appInfo.common.library_assets_full?.library_header?.image?.english
          );
        case 'icon':
          return appInfo.common.icon;
        case 'portrait':
          return (
            appInfo.common.library_assets_full?.library_capsule?.image[lang] || appInfo.common.library_assets_full?.library_capsule?.image?.english
          );
        default:
        case 'common':
          return {
            name: appInfo.common.name,
            isGame: appInfo?.common?.type?.toLowerCase() === 'game',
            translated: appInfo?.common?.languages?.[lang.api] || false,
            icon: appInfo.common.icon,
            header:
              appInfo.common.header_image?.[lang.api] ||
              appInfo.common.library_assets_full?.library_header?.image?.[lang.api] ||
              appInfo.common.header_image?.english ||
              appInfo.common.library_assets_full?.library_header?.image?.english ||
              storeData?.header_image,
            portrait:
              appInfo.common.library_assets_full?.library_capsule?.image?.[lang.api] ||
              appInfo.common.library_assets_full?.library_capsule?.image?.english,
            background: storeData?.background.replace(/(\?|&)t=\d+$/, ''),
          };
      }
    } finally {
      clientunlock();
    }

    await delay(1000);
  } catch (err) {
    debug.log(err);
  }
  return {};
}

async function closePuppeteer() {
  if (!puppeteerWindow) puppeteerWindow = {};
  if (puppeteerWindow.context) await puppeteerWindow.context.close();
  if (puppeteerWindow.browser) await puppeteerWindow.browser.close();
  puppeteerWindow.browser = undefined;
  puppeteerWindow.pagesh = undefined;
  puppeteerWindow.pagesc = undefined;
  puppeteerWindow.context = undefined;
}

async function startEngines() {
  if (!settingsJS) {
    settingsJS = require(path.join(__dirname, '../settings.js'));
    settingsJS.setUserDataPath(userData);
  }
  configJS = await settingsJS.load();
  if (!achievementsJS) {
    achievementsJS = require(path.join(__dirname, '../parser/achievements.js'));
    achievementsJS.initDebug({ isDev: app.isDev || false, userDataPath: userData });
  }
}

async function getCachedData(info) {
  await startEngines();
  if (!info.source) info.source = 'steam';
  let game = await achievementsJS.getGameFromCache(info.appid, info.source, configJS);
  if (!game) {
    switch (info.source.toLowerCase()) {
      case 'epic':
        break;
      case 'gog':
        const c = await getGogData({ appid: info.appid, type: 'common' });
        const d = await getGogData({ appid: info.appid, type: 'data' });
        game = c;
        game.achievement = d;
        await achievementsJS.saveGameToCache({ appid: info.appid, source: info.source, game }, configJS.achievement.lang);
        break;
      case 'luma':
        break;
      case 'steam':
      default:
        const [data, com] = await Promise.all([
          getSteamData({ appid: info.appid, type: 'steamhunters' }),
          getSteamData({ appid: info.appid, type: 'common' }),
        ]);
        game = com;
        game.achievement = data.achievements;
        await achievementsJS.saveGameToCache({ appid: info.appid, source: info.source, game }, configJS.achievement.lang);
    }
    await closePuppeteer();
  }
  info.game = game;
}

ipcMain.on('capture-screen', async (event, { image, game, name }) => {
  await captureScreen(game, name, image);
});

ipcMain.on('close-notification-window', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  if (win.isVisible() && !app.isQuitting) {
    win.hide();
    await new Promise((r) => setTimeout(r, 50));
  }
  isNotificationShowing = false;
  if (earnedNotificationQueue.length > 0) {
    showNotificationWindow(earnedNotificationQueue.shift());
    return;
  } else if (configJS.general.closeToTray) return;
  win.close();
});

ipcMain.on('close-puppeteer', async (event, arg) => {
  await closePuppeteer();
  event.returnValue = true;
});

ipcMain.on('get-store-link', async (event, arg) => {
  if (arg.source == 'gog') event.returnValue = await getGogData({ appid: arg.appid, type: 'store' });
  event.returnValue = null;
});

ipcMain.handle('get-steam-data', async (event, arg) => {
  const appid = +arg.appid;
  return await getSteamData({ appid, type: arg.type, user: arg.user, lang: arg.lang });
});

ipcMain.handle('get-gog-data', async (event, arg) => {
  const appid = +arg.appid;
  return await getGogData({ appid, type: arg.type });
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
      debug.log('Game not found');
      return;
    }

    const gameId = game.id;

    const [iconsRes, gridsRes, heroesRes, logosRes] = await Promise.all([
      fetch(`${BASE_URL}/icons/game/${gameId}`, { headers: { Authorization: `Bearer ${API_KEY}` } }),
      fetch(`${BASE_URL}/grids/game/${gameId}`, { headers: { Authorization: `Bearer ${API_KEY}` } }),
      fetch(`${BASE_URL}/heroes/game/${gameId}`, { headers: { Authorization: `Bearer ${API_KEY}` } }),
      fetch(`${BASE_URL}/logos/game/${gameId}`, { headers: { Authorization: `Bearer ${API_KEY}` } }),
    ]);

    const [icons, grids, heroes, logos] = await Promise.all([iconsRes.json(), gridsRes.json(), heroesRes.json(), logosRes.json()]);

    const portrait = grids.data.find((g) => g.width === 600 && g.height === 900);
    const landscape = grids.data.find((g) => g.width === 920 && g.height === 430);
    const links = {
      icon: icons.data?.[0]?.url || logos.data?.[0]?.url,
      background: heroes.data?.[0]?.url,
      portrait: portrait?.url,
      landscape: landscape?.url,
    };
    event.returnValue = links;
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
});

ipcMain.on('stylize-background-for-appid', async (event, arg) => {
  await stylizeBackground(arg.background, arg.appid, arg.source);
});

ipcMain.on('fetch-source-img', async (event, arg) => {
  switch (arg) {
    case 'epic':
      event.returnValue = path.join(process.env['APPDATA'], 'Achievement Watcher', 'Source', 'epic.svg');
      break;
    case 'gog':
      event.returnValue = path.join(process.env['APPDATA'], 'Achievement Watcher', 'Source', 'gog.svg');
      break;
    case 'RPCS3 Emulator':
      event.returnValue = path.join(process.env['APPDATA'], 'Achievement Watcher', 'Source', 'playstation.svg');
      break;
    case 'steam':
    default:
      event.returnValue = path.join(process.env['APPDATA'], 'Achievement Watcher', 'Source', 'steam.svg');
      break;
  }
});

ipcMain.handle('fetch-icon', async (event, url, appid, source = 'steam', asPath = false) => {
  return await getIcon(url, appid, source, asPath);
});

ipcMain.handle('reset-notification-window', async (event, arg) => {
  await initNotificationWindow(true);
});
ipcMain.on('notify-test', async (event, arg) => {
  await showNotificationWindow({ appid: 400, ach: 'PORTAL_TRANSMISSION_RECEIVED', source: 'steam' });
});

ipcMain.on('playtime-test', async (event, arg) => {
  await createPlaytimeWindow({ appid: 400, description: 'Testing notification', source: 'steam' });
});
ipcMain.on('progress-test', async (event, arg) => {
  await createProgressWindow({ appid: 400, ach: 'PORTAL_TRANSMISSION_RECEIVED', description: 'Testing progress', count: '50/100', source: 'steam' });
});

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

ipcMain.on('achievement-data-ready', () => {
  progressWindow.showInactive();
});

ipcMain.handle('get-achievements', async (event, appid) => {
  return await getSteamData({ appid, type: 'steamhunters' });
});

ipcMain.handle('start-watchdog', async (event, arg) => {
  event.sender.send('reset-watchdog-status');
  startWatchdog();
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startWatchdog() {
  const wd = spawn(
    path.join(manifest.config.debug ? path.join(__dirname, '../../') : path.dirname(process.execPath), 'nw/nw.exe'),
    ['-config', 'watchdog.json'],
    {
      cwd: path.join(manifest.config.debug ? path.join(__dirname, '../../') : path.dirname(process.execPath), 'nw/'),
      detached: true,
      stdio: 'ignore',
      shell: false,
    }
  );
  wd.unref(); // Let it run independently
}

async function captureScreen(game, name, image) {
  function sanitizeName(name) {
    // Remove invalid characters
    name = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '');
    // Remove trailing spaces or dots
    name = name.replace(/[. ]+$/, '');
    // Trim just in case
    return name.trim();
  }
  if (!configJS.souvenir_screenshot.screenshot || manifest.config.debug) return;
  if (!image) {
    const { screen, desktopCapturer } = require('electron');
    const primary = screen.getPrimaryDisplay();
    const { width, height } = primary.size;

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
    });

    // Use the first screen (primary display)
    const screenshot = sources[0].thumbnail.toPNG();
    image = screenshot.toString('base64');
  }

  const buffer = Buffer.from(image, 'base64');
  const savePath = path.join(configJS.souvenir_screenshot.custom_dir || app.getPath('pictures'), sanitizeName(game), sanitizeName(name) + '.png');
  fs.mkdirSync(path.dirname(savePath), { recursive: true });
  if (!configJS.souvenir_screenshot.overwrite_image && fs.existsSync(savePath)) return;
  fs.writeFileSync(savePath, buffer);
}

async function getIcon(url, appid, source, asPath = false) {
  let p;
  switch (source) {
    case 'epic':
      p = await fetchIconEpic(url, appid);
      break;
    case 'gog':
      p = await fetchIconGog(url, appid);
      break;
    case 'steam':
    default:
      p = await fetchIconSteam(url, appid);
      break;
  }
  return asPath ? p : pathToFileURL(p).href;
}

async function grayscaleIcon(imageUrl, appid, source = 'steam') {
  const t = path.parse(imageUrl).base + '_gray';
  const outputPath = path.join(app.getPath('userData'), `${source}_cache`, 'icon', String(appid), t);
  const sharp = require('sharp');
  try {
    const i = await getIcon(imageUrl, appid, source, true);
    const buffer = await sharp(i).grayscale().modulate({ brightness: 0.55, contrast: 0.65 }).toBuffer();
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, buffer);
    return t;
  } catch (err) {
    console.error('❌ Error:', err.message);
    return null;
  }
}

async function stylizeBackground(imageUrl, appid, source = 'steam') {
  const t = path.parse(imageUrl).base;
  const outputPath = path.join(app.getPath('userData'), `${source}_cache`, 'icon', String(appid), t);
  const sharp = require('sharp');

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
}

async function ensureChromium() {
  const { BrowserFetcher } = require('puppeteer');
  const chromium = path.join(process.env['APPDATA'], 'Achievement Watcher', 'Chromium');
  const fetcher = new BrowserFetcher({ path: chromium });
  const revisionInfo = fetcher.revisionInfo(CHROMIUM_REVISION);
  if (revisionInfo.local) return revisionInfo;
  const info = await fetcher.download(CHROMIUM_REVISION);
  return info;
}

async function startPuppeteer(headless = true, strip = false) {
  try {
    const puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());
    const ChromeLauncher = require('chrome-launcher');
    const installedChromePath = ChromeLauncher.Launcher.getInstallations()[0];
    const chromiumPath = fs.existsSync(installedChromePath) ? installedChromePath : (await ensureChromium()).executablePath;
    if (!puppeteerWindow.browser)
      puppeteerWindow.browser = await puppeteer.launch({
        headless: headless ? 'new' : false,
        executablePath: chromiumPath,
        args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-extensions'],
      });
    if (!puppeteerWindow.context) puppeteerWindow.context = await puppeteerWindow.browser.createIncognitoBrowserContext();
    if (!puppeteerWindow.pagesc) {
      puppeteerWindow.pagesc = await puppeteerWindow.context.newPage();
    }
    if (!puppeteerWindow.pagesh) {
      puppeteerWindow.pagesh = await puppeteerWindow.context.newPage();
      if (strip) {
        const page = puppeteerWindow.pagesh;
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          const type = req.resourceType();
          if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
            req.abort();
          } else {
            req.continue();
          }
        });
      }
    }
  } catch (e) {
    debug.log(e);
  }
}

async function scrapeWithPuppeteer(info = { appid: 269770 }, options) {
  try {
    await startPuppeteer(true, options?.steamhunters);
  } catch (e) {
    debug.log(e);
  }
  try {
    if (options.steamhunters) {
      if (options.userlist) {
        const url = `https://steamhunters.com/apps/${info.appid}/users?sort=completionstate`;
        const page = puppeteerWindow.pagesh;
        try {
          await page.goto(url);
          await page.waitForFunction(() => {
            return Array.from(document.querySelectorAll('script')).some((s) => s.textContent.includes('var sh'));
          });
          await page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'));
            const target = scripts.find((s) => s.textContent.includes('var sh'));
            eval(target.textContent);
          });
          const users = (await page.evaluate(() => sh.model.listData.pagedList.items)) || [];

          const results = [];
          users.forEach((item) => {
            results.push({
              id: item.steamId,
              isPublic: item.privacyState === 0,
            });
          });
          info.users = users;
        } catch (e) {
          debug.log(e);
        }
        return;
      }
      let start = Date.now();
      const url = `https://steamhunters.com/apps/${info.appid}/achievements?group=&sort=name`;
      const page = puppeteerWindow.pagesh;
      try {
        await page.goto(url, { timeout: 5000 });
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
            description: item.description || ' ',
            icon: item.icon,
            icongray: item.iconGray,
          });
        });
        info.achievements = results;
        for (let ach of info.achievements) {
          if (ach.icon && !ach.icongray) {
            ach.icongray = await grayscaleIcon(ach.icon, info.appid);
          }
        }
        debug.log(`[${info.appid}] steamhunters took ${(Date.now() - start) / 1000}s`);
      } catch (e) {
        debug.log(e);
      }
      return;
    }

    if (options.steamcommunity) {
      const page = puppeteerWindow.pagesc;
      try {
        await page.goto(options.url, { waitUntil: 'domcontentloaded' });
      } catch (e) {
        debug.log(e);
      }
      const achs = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.achieveRow')).map((row) => {
          const img = row.querySelector('.achieveImgHolder img')?.src.split('/').pop().split('.jpg')[0] || null;
          const title = row.querySelector('.achieveTxt h3')?.innerText.trim() || null;
          const description = row.querySelector('.achieveTxt h5')?.innerText.trim() || null;
          return { img, title, description };
        });
      });
      info.achievements = achs;
      return;
    }

    const url = `https://steamcommunity.com/profiles/${options.steamid}`;
    const page = puppeteerWindow.pagesc;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (e) {
      debug.log(e);
    }
    const url3 = page.url();
    await page.goto(`${url3}/stats/${info.appid}/?tab=achievements`, { waitUntil: 'domcontentloaded' });
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
  await startPuppeteer(true, false);

  async function scrapePage(startIndex) {
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
  const pageLimit = 30; //TODO: change this magic number
  while (!info.title && startIndex < pageLimit) {
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
            debug.log(rows);
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

async function createMainWindow(show = true) {
  try {
    if (MainWin && show) {
      if (MainWin.isMinimized()) MainWin.restore();
      if (!MainWin.isVisible()) {
        MainWin.show();
        MainWin.setOverlayIcon(getStatusTrayIcon(tray.status === 'true').circle, '');
      }
      setTimeout(() => {
        MainWin.focus();
      }, 250);
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
    //getSteamData({ appid: 2321470, type: 'user' });
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
      if (show) {
        MainWin.show();
        MainWin.focus();
      }
      const net = require('net');
      const PIPE_NAME = '\\\\.\\pipe\\AchievementWatchdogPipe';
      function checkWatchdogStatus(callback) {
        const client = net.createConnection(PIPE_NAME);

        client.on('connect', () => {
          callback(true);
          client.end();
        });

        client.on('error', () => {
          callback(false);
        });
      }
      setInterval(() => {
        checkWatchdogStatus(async (running) => {
          if (MainWin && MainWin.isVisible() && !MainWin.isMinimized()) MainWin.webContents.send('watchdog-status', running);
          if (configJS.general.closeToTray) await updateTrayStatus(running);
        });
      }, 5000);
    });

    MainWin.on('close', (event) => {
      if (configJS.general.closeToTray && !app.isQuitting) {
        event.preventDefault();
        MainWin.hide();
        return;
      }
      MainWin = null;
      if (shouldQuitApp()) app.quit();
    });
  } catch (e) {
    debug.log(`Error creating main window: ${e}`);
    if (shouldQuitApp()) app.quit();
  }
}

/**
 * @param {{appid: string, action:string}} info
 */
async function createOverlayWindow(info) {
  try {
    if (!info.action) info.action = 'open';
    if (info.action === 'fetch') {
      await getCachedData(info);
      return;
    }
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
  } catch (e) {
    debug.log(`Error creating overlay window, ${e}`);
    if (shouldQuitApp()) app.quit();
  }
}

async function initNotificationWindow(reset = false) {
  if (notificationWindow && !reset) return;
  if (notificationWindow) {
    const old = notificationWindow;
    notificationWindow = null;
    old.close();
    await Promise.race([
      new Promise((resolve) => old.once('closed', resolve)),
      new Promise((resolve) => setTimeout(resolve, 250)), // fallback: 250ms
    ]);
    if (!old.isDestroyed()) {
      try {
        old.destroy();
      } catch (err) {
        /* ignore */
      }
    }
  }
  const display = require('electron').screen.getPrimaryDisplay();
  const { x: screenX, y: screenY, width: screenWidth, height: screenHeight } = display.workArea;
  await startEngines();
  const preset = configJS.overlay.preset || 'default';
  const presetFolder = path.join(manifest.config.debug ? path.join(__dirname, '../') : userData, 'presets', preset);
  const presetHtml = path.join(presetFolder, 'index.html');
  const position = configJS.overlay.position || 'center-bot';
  const scale = parseFloat(parseFloat(configJS.overlay.scale) * 0.01) || 1;
  const duration = parseFloat(configJS.overlay.duration) * 0.01 || 1;

  const { width: windowWidth, height: windowHeight } = getPresetDimensions(presetFolder);

  const scaledWidth = Math.ceil(windowWidth * scale);
  const scaledHeight = Math.ceil(windowHeight * scale);

  let x = 0,
    y = 0;

  if (position.includes('left')) {
    x = screenX + Math.round(16 * scale);
  } else if (position.includes('right')) {
    x = screenX + screenWidth - scaledWidth - Math.round(16 * scale);
  } else if (position.includes('center')) {
    x = screenX + Math.floor((screenWidth - scaledWidth) / 2);
  }

  if (position.includes('top')) {
    y = screenY;
  } else if (position.includes('bot')) {
    y = screenHeight - Math.round(scaledHeight) - 20;
  } else if (position.includes('mid')) {
    y = Math.floor(screenHeight / 2) - Math.round(scaledHeight / 2);
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
    focusable: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    type: 'notification',
    webPreferences: {
      preload: path.join(__dirname, '../overlayPreload.js'),
      additionalArguments: [`--isDev=${app.isDev ? 'true' : 'false'}`, `--userDataPath=${userData}`],
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  notificationWindow.isReady = false;
  notificationWindow.setAlwaysOnTop(true, 'screen-saver');
  notificationWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  notificationWindow.setFullScreenable(false);
  notificationWindow.setFocusable(false);
  setTimeout(() => {
    notificationWindow.setIgnoreMouseEvents(true, { forward: true });
  }, 50);
  notificationWindow.webContents.on('console-message', (e, level, message, line, sourceID) => {
    debug.log(message, sourceID, line);
  });
  notificationWindow.loadFile(presetHtml);
  notificationWindow.scale = scale;
  notificationWindow.duration = duration;
  notificationWindow.webContents.once('did-finish-load', () => {
    notificationWindow.isReady = true;
  });
}

async function showNotificationWindow(info) {
  if (isNotificationShowing) {
    earnedNotificationQueue.push(info);
    return;
  }
  isNotificationShowing = true;
  await initNotificationWindow();
  await getCachedData(info);
  const ach = info.game.achievement.list.find((ac) => ac.name == info.ach);
  const message = {
    name: info.game.name,
    displayName: ach.displayName || '',
    description: ach.description || '',
    icon: await getIcon(ach.icon, info.appid, info.source),
    icon_gray: await getIcon(ach.icongray, info.appid, info.source),
  };
  if (MainWin && !MainWin.isMinimized() && MainWin.isVisible()) MainWin.webContents.send('achievement-unlock', { appid: info.appid, ach_data: ach });
  let soundFile;
  if (configJS.notification_toast.customToastAudio === '2' || configJS.notification_toast.customToastAudio === '1') {
    let toastAudio = require(path.join(__dirname, '../util/toastAudio.js'));
    soundFile =
      configJS.notification_toast.customToastAudio === '1'
        ? path.join(process.env.SystemRoot || process.env.WINDIR, 'media', toastAudio.getDefault())
        : toastAudio.getCustom();
  }

  if (!notificationWindow.isReady) {
    await new Promise((resolve) => {
      notificationWindow.webContents.once('did-finish-load', resolve);
    });
  }
  debug.log(`Showing chromium notification window for ${message.name}: ${message.displayName}`);
  notificationWindow.showInactive();
  //notificationWindow.webContents.send('set-window-scale', notificationWindow.scale);
  notificationWindow.webContents.send('set-animation-scale', (configJS.overlay?.duration ?? 1) * 0.01);
  setTimeout(() => captureScreen(message.name, message.displayName), 250 * (configJS.overlay?.duration * 0.01) ?? 1);
  notificationWindow.webContents.send('show-notification', {
    game: message.name,
    displayName: message.displayName,
    description: message.description,
    iconPath: message.icon,
    scale: notificationWindow.scale,
    duration: notificationWindow.duration,
    position: configJS.overlay.position || 'center-bot',
  });

  createOverlayWindow({ appid: info.appid, action: 'refresh' });
  player.play({ path: soundFile });
}

async function createPlaytimeWindow(info) {
  try {
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
    setTimeout(() => {
      playtimeWindow.setIgnoreMouseEvents(true, { forward: true });
    }, 50);
    playtimeWindow.setAlwaysOnTop(true, 'screen-saver');
    playtimeWindow.setVisibleOnAllWorkspaces(true);
    playtimeWindow.setFullScreenable(false);
    playtimeWindow.setFocusable(false);

    const desc = info.description;
    await getCachedData(info);
    info.description = desc;
    info.headerUrl = await getIcon(info.game.img.header, info.appid, info.source);
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
        return;
      }
      if (shouldQuitApp()) app.quit();
    });

    playtimeWindow.loadFile(path.join(manifest.config.debug ? path.join(__dirname, '..') : userData, 'view', 'playtime.html'));
  } catch (e) {
    debug.log(`Error creating playtime window: ${e}`);
    if (shouldQuitApp()) app.quit();
  }
}

async function createProgressWindow(info) {
  try {
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

    await getCachedData(info);
    info.a = info.game.achievement.list.find((ac) => ac.name == info.ach);
    info.a.icongray = await getIcon(info.a.icongray, info.appid, info.source);

    progressWindow.webContents.on('did-finish-load', () => {
      progressWindow.showInactive();
      progressWindow.setIgnoreMouseEvents(true, { forward: true });
      progressWindow.webContents.send('show-progress', info);
    });

    progressWindow.on('closed', () => {
      isProgressWindowShowing = false;
      progressWindow = null;
      if (progressQueue.length > 0) {
        createProgressWindow(progressQueue.shift());
        return;
      }
      if (shouldQuitApp()) app.quit();
    });

    setTimeout(() => {
      if (progressWindow && !progressWindow.isDestroyed()) progressWindow.close();
    }, 5000);

    progressWindow.loadFile(path.join(manifest.config.debug ? path.join(__dirname, '..') : userData, 'view/progress.html'));
    progressWindow.appid = info.appid;
  } catch (e) {
    debug.log(`Error creating progress window: ${e}`);
    if (shouldQuitApp()) app.quit();
  }
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

function shouldQuitApp() {
  const noMain = !MainWin;
  const noNotifications = !isNotificationShowing && earnedNotificationQueue.length === 0;
  const noOverlay = !isOverlayShowing;
  const noProgress = !isProgressWindowShowing && progressQueue.length === 0;
  const noPlaytime = !isplaytimeWindowShowing && playtimeQueue.length === 0;

  return noMain && noNotifications && noOverlay && noProgress && noPlaytime;
}

function parseArgs(args) {
  let windowType = args['wintype'] || 'main'; // overlay, playtime, progress, achievement
  let appid = args['appid']; // appid
  let source = args['source'] || 'steam'; // source: steam, epic, gog, luma
  let ach = args['ach']; // achievement name
  let description = args['description']; // text
  let count = args['count'] || '0/100'; // count / max_count
  debug.log('opening ' + windowType + ' window');
  switch (windowType) {
    case 'data':
      getCachedData({ appid, source });
      break;
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
      showNotificationWindow({ appid, source, ach });
      break;
    case 'tray':
      if (!configJS.general.closeToTray)
        if (shouldQuitApp()) {
          app.quit();
          break;
        }
      initNotificationWindow();
      createMainWindow(false);
      break;
    case 'main':
    default:
      autoUpdater.checkForUpdates();
      checkResources();
      initNotificationWindow();
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
    const profile = manifest.config.debug ? path.join(resourcesPath, '..', 'obs', 'profiles', 'AW') : path.join(resourcesPath, 'obs', 'AW');
    copyFolderRecursive(profile, path.join(app.getPath('appData'), 'obs-studio', 'basic', 'profiles', 'AW'));
  }
  if (!fs.existsSync(path.join(app.getPath('appData'), 'obs-studio', 'basic', 'scenes', 'AW.json'))) {
    fs.mkdirSync(path.join(app.getPath('appData'), 'obs-studio', 'basic', 'scenes'), { recursive: true });
    fs.copyFileSync(
      manifest.config.debug ? path.join(resourcesPath, '..', 'obs', 'scenes', 'AW.json') : path.join(resourcesPath, 'obs', 'AW.json'),
      path.join(app.getPath('appData'), 'obs-studio', 'basic', 'scenes', 'AW.json')
    );
  }

  app.setLoginItemSettings({
    openAtLogin: configJS?.watchdog?.startAtLogin ?? true,
    openAsHidden: true,
    path: path.join(manifest.config.debug ? path.join(__dirname, '../../') : path.dirname(process.execPath), 'nw/nw.exe'),
    args: ['-config', 'watchdog.json'],
  });
}

async function checkDownloadedUpdate(info) {
  await startEngines();
  const skippedVersion = configJS.general.skippedVersion;
  if (skippedVersion.toLowerCase() !== 'none' && semver.gte(skippedVersion, info.version)) {
    return;
  }
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: 'Update Ready',
    message: `A new version (${info.version}) has been downloaded.`,
    detail: `Would you like to install it now?`,
    buttons: ['Yes', 'Later', 'Skip this version'],
    defaultId: 0,
    cancelId: 1,
  });

  if (response === 0) {
    app.isQuitting = true;
    autoUpdater.quitAndInstall();
  } else if (response === 2) {
    configJS.general.skippedVersion = info.version;
    settingsJS.save(configJS);
  }
}

async function traySetup() {
  if (!configJS) await startEngines();
  if (!configJS.general.closeToTray) return;
  if (tray) return;
  tray = new Tray(path.join(manifest.config.debug ? path.join(__dirname, '..', 'resources', 'icon') : path.dirname(process.execPath), 'icon.ico'));
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show App',
      click: async () => {
        createMainWindow();
      },
    },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setToolTip('Achievement Watcher');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (MainWin?.isVisible()) {
      MainWin.hide();
      return;
    }
    createMainWindow();
  });
}

function getStatusTrayIcon(isOnline) {
  const baseIconPath = path.join(
    path.join(manifest.config.debug ? path.join(__dirname, '..', 'resources', 'icon') : path.dirname(process.execPath)),
    process.platform == 'win32' ? 'icon.ico' : 'icon_22.png'
  );
  const outputPath = path.join(
    path.join(manifest.config.debug ? path.join(__dirname, '..', 'resources', 'icon') : path.dirname(process.execPath)),
    process.platform == 'win32' ? `icon_${isOnline ? 'green' : 'red'}.ico` : `icon_22_${isOnline ? 'green' : 'red'}.png`
  );
  const circle = path.join(path.dirname(outputPath || baseIconPath), isOnline ? 'green.png' : 'red.png');
  if (fs.existsSync(outputPath)) return { img: outputPath, circle };
  if (fs.existsSync(baseIconPath)) return { img: baseIconPath, circle };
  return null;
}

async function updateTrayStatus(running) {
  if (!tray || tray.status == String(running)) return;
  const iconPath = getStatusTrayIcon(running);
  tray.status = String(running);
  if (!iconPath) return;
  tray.setImage(iconPath.img);
  MainWin?.setIcon(iconPath.img);
  MainWin.setOverlayIcon(nativeImage.createFromPath(iconPath.circle), '');
}

try {
  if (app.requestSingleInstanceLock() !== true) app.quit();

  autoUpdater.on('update-available', async (info) => {
    await checkDownloadedUpdate(info);
  });

  autoUpdater.on('update-downloaded', async (info) => {
    await checkDownloadedUpdate(info);
  });

  app
    .on('ready', async function () {
      const args = minimist(process.argv.slice(1));
      await startEngines();
      await traySetup();
      if (configJS.general.closeToTray) startWatchdog();
      parseArgs(args);
    })
    .on('window-all-closed', function () {
      if (shouldQuitApp()) app.quit();
    })
    .on('before-quit', async (event) => {
      await startEngines();
      if (configJS.watchdog.keepRunning && !configJS.general.closeToTray) return;
      try {
        const command = `powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*watchdog*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`;

        exec(command, (error, stdout, stderr) => {
          if (error) {
            console.error(`Error killing process: ${error.message}`);
            return;
          }
          if (stderr) {
            console.error(`PowerShell error: ${stderr}`);
            return;
          }
          console.log(`Processes with description containing 'Achievement Watchdog' killed.`);
        });
      } catch (e) {
        debug.log(e);
      }
    })
    .on('web-contents-created', (event, contents) => {
      contents.on('new-window', (event, url) => {
        event.preventDefault();
      });
    })
    .on('second-instance', async (event, argv, cwd) => {
      const args = minimist(argv.slice(1));
      parseArgs(args);
    });
} catch (err) {
  dialog.showErrorBox('Critical Error', `Failed to initialize:\n${err}`);
  app.quit();
}
