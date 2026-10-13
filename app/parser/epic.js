'use strict';

const path = require('path');
const fs = require('fs');
const urlParser = require('url');
const glob = require('fast-glob');
const request = require('request-zero');

let gameList;
let cacheRoot;
let debug;
module.exports.initDebug = ({ isDev, userDataPath }) => {
  this.setUserDataPath(userDataPath);
  debug = new (require('@xan105/log'))({
    console: isDev || false,
    file: path.join(userDataPath, 'logs/parser.log'),
  });
};

module.exports.setUserDataPath = (p) => {
  cacheRoot = path.join(p, 'epic_cache');
};

async function getEpicProductMapping() {
  const res = await request.get('https://store-content.ak.epicgames.com/api/content/productmapping');
  return res.body;
}

async function getEpicProductDetails(slug, locale = 'en-US') {
  const url = `https://store-content.ak.epicgames.com/api/${locale}/content/products/${slug}`;
  const res = await request.get(url);
  return res.body;
}

async function getGameTitleFromMapping(slug) {
  const product = JSON.parse(await getEpicProductDetails(slug));
  return product?.productName;
}

module.exports.isExclusive = (appid) => {
  const cacheFile = path.join(cacheRoot, 'epic.db');
  let cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, { encoding: 'utf8' })) : [];
  let cached = cache.find((g) => g.epicid === appid || g.steamid === appid);
  if (cached) return cached.steamid === undefined;
  //TODO: in case appid is not cached, look it up
  return false;
};

module.exports.scan = async (dir) => {
  const cacheFile = path.join(cacheRoot, 'epic.db');
  let data = [];
  let cache = [];
  const { ipcRenderer } = require('electron');
  if (!gameList) gameList = JSON.parse(await getEpicProductMapping());

  if (fs.existsSync(cacheFile)) {
    cache = JSON.parse(fs.readFileSync(cacheFile, { encoding: 'utf8' }));
  }

  try {
    for (let dir of await glob(path.join(process.env['APPDATA'], 'NemirtingasEpicEmu', '*/*/').replace(/\\/g, '/'), {
      onlyDirectories: true,
      absolute: true,
    })) {
      let game = {
        appid: path.parse(dir).name,
        source: 'epic',
        data: {
          type: 'file',
          path: dir,
        },
      };
      if (game.appid.toLowerCase() === 'invalidappid') continue;

      let steamid;
      let cached = cache.find((g) => g.epicid === game.appid);
      if (cached) {
        steamid = cached.steamid;
      } else {
        try {
          const title = await getGameTitleFromMapping(gameList[game.appid]);
          steamid = ipcRenderer.sendSync('get-steam-appid-from-title', { title });
          cache.push({ epicid: game.appid, steamid });
        } catch (err) {
          //appid not found on mapping, either a new game or using custom appid
          //lets assume its new and treat it as exclusive
          cache.push({ epicid: game.appid });
        }
      }
      game.steamappid = steamid;
      game.appid = game.appid;
      data.push(game);
    }
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
    return data;
  } catch (err) {
    throw err;
  }
};

module.exports.getCachedData = async (cfg) => {
  let result;
  return result;
};

module.exports.getGameData = async (cfg) => {
  const cache = path.join(cacheRoot, 'schema', cfg.lang);
  let filePath = path.join(`${cache}`, `${cfg.appID}.db`);
  let result;
  try {
    if (fs.existsSync(filePath)) {
      result = JSON.parse(fs.readFileSync(filePath));
      return result;
    }
  } catch (err) {
    debug.log(`Failed to load cache file for ${cfg.appID}. Fetching updated info`);
  }
  let list = [];
  let title;
  let icon;
  try {
    if (!gameList) gameList = JSON.parse(await getEpicProductMapping());
    const gameSlug = gameList[cfg.appID];
    if (!gameSlug) throw !gameSlug; //return result;
    title = await getGameTitleFromMapping(gameSlug);
  } catch (err) {
    //appid not found on mapping, either a new game or using custom appid
    //lets assume its new and search for it on the epic games store
    title = ipcRenderer.sendSync('get-title-from-epic-id', { appid: cfg.appID }) || 'Unknown game';
  }
  if (!title) return result;
  let achievements;
  try {
    achievements = await request.getJson(
      `https://api.epicgames.dev/epic/achievements/v1/public/achievements/product/${cfg.appID}/locale/en-us?includeAchievements=true`
    );
    for (let achievement of achievements.achievements) {
      list.push({
        name: achievement.achievement.name,
        default_value: 0,
        displayName:
          achievement.achievement.lockedDisplayName.length === 0
            ? achievement.achievement.unlockedDisplayName
            : achievement.achievement.lockedDisplayName,
        hidden: achievement.achievement.hidden ? 1 : 0,
        description: achievement.achievement.lockedDescription,
        icon: achievement.achievement.unlockedIconLink,
        icongray: achievement.achievement.lockedIconLink,
      });
    }
  } catch (err) {
    // probably hidden achievements, lets try to get steam's data
    if (err.code !== 404) debug.log(err);
    if (!cfg.steamappid) return result;
    const achs = await ipcRenderer.invoke('get-steam-data', { appid: cfg.steamappid, type: 'steamhunters' });
    list = achs.achievements;
  }

  result = {
    name: title,
    appid: cfg.appID,
    binary: null,
    achievement: {
      total: list.length,
      list,
    },
  };
  if (!cfg.steamappid) {
    // if its exclusive then use epic images instead of steam's
    const links = ipcRenderer.sendSync('get-images-for-game', { name: title });
    result.img = {
      header: links.landscape,
      background: links.background,
      portrait: links.portrait,
      icon: links.icon,
    };
    ipcRenderer.send('stylize-background-for-appid', { background: links.background, appid: cfg.appID });
  } else {
    let imgs = await ipcRenderer.invoke('get-steam-data', { appid: cfg.steamappid, type: 'common' });
    result.img = {
      header: imgs.header || 'header',
      background: imgs.background || 'page_bg_generated_v6b.jpg',
      portrait: imgs.portrait || 'library_600x900.jpg',
      icon: imgs.icon,
    };
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2));
  return result;
};

const fetchIcon = (module.exports.fetchIcon = async (url, appID) => {
  let validUrl;
  let filePath;
  try {
    const cache = path.join(cacheRoot, 'icon', `${appID}`);
    let filename = path.parse(url).base;
    filePath = path.join(cache, filename);
    if (fs.existsSync(filePath)) return filePath;
    let exts = ['.jpg', '.png'];
    if (!url.endsWith('.jpg') && !url.endsWith('.png'))
      for (let ext of exts) {
        filePath = path.join(cache, filename + ext);
        if (fs.existsSync(filePath)) return filePath;
      }
    //legacy url are full urls, check if they are still valid
    let isValid = false;
    validUrl = url;
    try {
      new URL(url);
      const res = await request(url, { method: 'HEAD' });
      isValid = res.code !== 200 ? false : true;
      isValid = isValid ? res.headers['content-type'] : isValid;
    } catch (e) {}

    filename = path.parse(urlParser.parse(validUrl).pathname).base;

    filePath = path.join(cache, filename);

    if (fs.existsSync(filePath)) {
      return filePath;
    } else {
      return (await request.download(validUrl, cache, { validateFileSize: false })).path;
    }
  } catch (err) {
    if (err.code === 'ESIZEMISMATCH') {
      try {
        const fetch = require('node-fetch');
        const res = await fetch(validUrl);
        if (!res.ok) return validUrl;
        const buffer = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(filePath, buffer);
        return filePath;
      } catch (e) {
        return validUrl;
      }
    }
    return url;
  }
});
