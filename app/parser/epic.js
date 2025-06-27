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
        const title = await getGameTitleFromMapping(gameList[game.appid]);
        steamid = ipcRenderer.sendSync('get-steam-appid-from-title', { title });
        cache.push({ epicid: game.appid, steamid });
      }

      game.appid = steamid || game.appid;
      data.push(game);
    }
    ffs.writeFile(cacheFile, JSON.stringify(cache, null, 2));
    return data;
  } catch (err) {
    throw err;
  }
};

module.exports.getGameData = async (cfg) => {
  //TODO: look up if is in cache first and if not then save fecthed data to cache
  let list = [];
  let title = await getGameTitleFromMapping(JSON.parse(await getEpicProductMapping())[cfg.appID]);
  let achievements;
  try {
    achievements = await request.getJson(
      `https://api.epicgames.dev/epic/achievements/v1/public/achievements/product/${cfg.appID}/locale/en-us?includeAchievements=true`
    );
  } catch (err) {
    debug.log(err);
  }
  for (let achievement of achievements.achievements) {
    list.push({
      name: achievement.achievement.name,
      default_value: 0,
      displayName: achievement.achievement.lockedDisplayName,
      hidden: achievement.achievement.hidden ? 1 : 0,
      description: achievement.achievement.lockedDescription,
      icon: achievement.achievement.unlockedIconLink + '.png',
      icongray: achievement.achievement.lockedIconLink + '.png',
    });
  }

  //TODO: get proper images from somewhere
  return {
    name: title,
    appid: cfg.appID,
    binary: null,
    img: {
      header: `https://cdn.akamai.steamstatic.com/steam/apps/${cfg.appID}/header.jpg`,
      background: `https://cdn.akamai.steamstatic.com/steam/apps/${cfg.appID}/page_bg_generated_v6b.jpg`,
      portrait: `https://cdn.akamai.steamstatic.com/steam/apps/${cfg.appID}/library_600x900.jpg`,
      icon: `https://cdn.akamai.steamstatic.com/steam/apps/${cfg.appID}/header.jpg`,
    },
    achievement: {
      total: achievements.totalAchievements,
      list,
    },
  };
};
