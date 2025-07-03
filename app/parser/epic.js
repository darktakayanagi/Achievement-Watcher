'use strict';

const path = require('path');
const fs = require('fs');
const ffs = require('@xan105/fs');
const glob = require('fast-glob');
const request = require('request-zero');

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
  cacheRoot = p;
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
  const cacheFile = path.join(cacheRoot, 'steam_cache', 'epic.db');
  let cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, { encoding: 'utf8' })) : [];
  let cached = cache.find((g) => g.epicid === appid || g.steamid === appid);
  if (cached) return cached.steamid === undefined;
  //TODO: in case appid is not cached, look it up
  return false;
};

module.exports.scan = async (dir) => {
  const cacheFile = path.join(cacheRoot, 'steam_cache', 'epic.db');
  let data = [];
  let cache = [];
  const { ipcRenderer } = require('electron');
  const gameList = JSON.parse(await getEpicProductMapping());

  if (fs.existsSync(cacheFile)) {
    cache = JSON.parse(fs.readFileSync(cacheFile, { encoding: 'utf8' }));
  }

  try {
    for (let dir of await glob(path.join(process.env['APPDATA'], 'NemirtingasEpicEmu', '*/*/'), { onlyDirectories: true, absolute: true })) {
      let game = {
        appid: path.parse(dir).name,
        source: 'epic',
        data: {
          type: 'file',
          path: dir,
        },
      };

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
    ffs.writeFile(cacheFile, JSON.stringify(cache, null, 2));
    return data;
  } catch (err) {
    throw err;
  }
};

module.exports.getGameData = async (cfg) => {
  const cache = path.join(cacheRoot, 'steam_cache/schema', cfg.lang);
  let filePath = path.join(`${cache}`, `${cfg.appID}.db`);
  let result;
  try {
    if (await ffs.existsAndIsYoungerThan(filePath, { timeUnit: 'M', time: 12 })) {
      result = JSON.parse(await ffs.readFile(filePath));
      return result;
    }
  } catch (err) {
    debug.log(`Failed to load cache file for ${cfg.appID}. Fetching updated info`);
  }
  let list = [];
  let title;
  try {
    title = await getGameTitleFromMapping(JSON.parse(await getEpicProductMapping())[cfg.appID]);
  } catch (err) {
    //appid not found on mapping, either a new game or using custom appid
    //lets assume its new and search for it on the epic games store
    title = ipcRenderer.sendSync('get-title-from-epic-id', { appid: cfg.appID }) || 'Unknown game';
  }
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
    const achs = ipcRenderer.sendSync('get-steam-data', { appid: cfg.steamappid, type: 'data' });
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
    result.img = {
      header: `https://cdn.akamai.steamstatic.com/steam/apps/${cfg.steamappid}/header.jpg`,
      background: `https://cdn.akamai.steamstatic.com/steam/apps/${cfg.steamappid}/page_bg_generated_v6b.jpg`,
      portrait: `https://cdn.akamai.steamstatic.com/steam/apps/${cfg.steamappid}/library_600x900.jpg`,
      icon: ipcRenderer.sendSync('get-steam-data', { appid: cfg.steamappid, type: 'icon' }),
    };
  }

  ffs.writeFile(filePath, JSON.stringify(result, null, 2)).catch((err) => {});
  return result;
};
