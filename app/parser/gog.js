'use strict';

const path = require('path');
const fs = require('fs');
const urlParser = require('url');
const glob = require('fast-glob');
const request = require('request-zero');
const normalize = require('normalize-path');

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

module.exports.getCachedData = (cfg) => {
  const cache = path.join(cacheRoot, 'gog_cache/schema', 'english'); //gog only has data in english
  let result;
  try {
    let filePath = path.join(`${cache}`, `${cfg.appID}.db`);
    if (fs.existsSync(filePath)) {
      result = JSON.parse(fs.readFileSync(filePath));
    }
  } catch (err) {
    if (err.code) throw `Could not load GOG data: ${err.code} - ${err.message}`;
    else throw `Could not load GOG data: ${err}`;
  }
  return result;
};

module.exports.scan = async (additionalSearch = []) => {
  try {
    let data = [];
    for (let dir of await glob(path.join(process.env['APPDATA'], 'NemirtingasGalaxyEmu', '*/*/').replace(/\\/g, '/'), {
      onlyDirectories: true,
      absolute: true,
    })) {
      let game = {
        appid: path.parse(dir).name,
        source: 'gog',
        data: {
          type: 'file',
          path: dir,
        },
      };

      data.push(game);
    }
    for (let dir of await glob(path.join(process.env['LOCALAPPDATA'], 'UniverseLan', '*/').replace(/\\/g, '/'), {
      onlyDirectories: true,
      absolute: true,
    })) {
      const matches = await glob(dir.replace(/\\/g, '/') + '/**/Achievements.ini', {
        absolute: true,
      });
      if (matches.length <= 0) continue;
      let game = {
        appid: path.parse(dir).name,
        source: 'gog',
        data: {
          type: 'file',
          path: path.dirname(matches[0]),
        },
      };

      data.push(game);
    }
    return data;
  } catch (err) {
    throw err;
  }
};

module.exports.saveGameToCache = async (cfg) => {
  const cache = path.join(cacheRoot, 'gog_cache/schema', 'english');
  const filePath = path.join(`${cache}`, `${cfg.appid}.db`);

  const result = {
    name: cfg.name,
    appid: cfg.appid,
    binary: null,
    img: {
      header: cfg.header,
      background: cfg.background,
      portrait: cfg.portrait,
      icon: cfg.icon,
    },
    achievement: {
      total: cfg.achievement.length,
      list: cfg.achievement,
    },
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2));
};

module.exports.findAppIDinFolder = (dir) => {
  let currentDir = dir;
  try {
    while (true) {
      const infoFiles = glob.sync(currentDir.replace(/\\/g, '/') + '/**/*.info', {
        absolute: true,
        nodir: true,
      });

      for (const infoFile of infoFiles) {
        try {
          const json = JSON.parse(fs.readFileSync(infoFile, 'utf8'));

          if (json?.rootGameId) return json.rootGameId;
        } catch {}
      }

      const parent = path.dirname(currentDir);

      if (parent === currentDir) return null; //system root

      currentDir = parent;
    }
  } catch {
    return null;
  }
};

module.exports.getSteamIDof = async (gogID) => {
  const url = `https://gamesdb.gog.com/platforms/gog/external_releases/${gogID}`;
  let gameinfo = await request.getJson(url);
  let steamid;
  if (gameinfo) {
    steamid = gameinfo.game?.releases?.find((r) => r.platform_id === 'steam')?.external_id;
  }
  return steamid;
};

module.exports.getGameData = async (cfg) => {
  let result;
  let needSaving = false;
  const cache = path.join(cacheRoot, 'gog_cache/schema', 'english'); //GOG only stores english data
  let filePath = path.join(`${cache}`, `${cfg.appID}.db`);

  try {
    result = this.getCachedData(cfg);
    if (!result || !result.name) {
      if (cfg.useToken) {
        result = await getGogDataFromSRV(cfg.appID);
      } else {
        const { getGameData } = require('./steam.js');
        result = await getGameData(await this.getSteamIDof(cfg.appID), cfg.lang);
      }
      needSaving = true;
    }
    if (needSaving) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(result, null, 2));
    }
    return result;
  } catch (err) {
    if (err.code) debug.log(`Could not load GOG data: ${err.code} - ${err.message}`);
    else debug.log(`Could not load GOG data: ${err}`);
  }
};

async function getGogDataFromSRV(appID) {
  const { ipcRenderer } = require('electron');
  const result = await ipcRenderer.invoke('get-gog-data', {
    appid: appID,
    type: 'common',
  });
  const achievements = result.isGame ? await ipcRenderer.invoke('get-gog-data', { appid: appID, type: 'data' }) : [];

  return {
    name: result.name,
    appid: appID,
    binary: null,
    img: {
      header: result.header || 'header',
      background: result.background || 'page_bg_generated_v6b',
      portrait: result.portrait || 'portrait',
      icon: result.icon,
    },
    achievement: {
      total: achievements.length,
      list: achievements,
    },
  };
}

const fetchIcon = (module.exports.fetchIcon = async (url, appID) => {
  let validUrl;
  let filePath;
  try {
    const cache = path.join(cacheRoot, `gog_cache/icon/${appID}`);
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
