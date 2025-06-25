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

module.exports.scan = async (dir) => {
  const cacheFile = path.join(cacheRoot, 'steam_cache', 'gog.db');
  let data = [];
  let cache = [];
  let update_cache = false;

  if (fs.existsSync(cacheFile)) {
    cache = JSON.parse(fs.readFileSync(cacheFile, { encoding: 'utf8' }));
  }

  try {
    for (let dir of await glob(path.join(process.env['APPDATA'], 'NemirtingasGalaxyEmu', '*/*/'), { onlyDirectories: true, absolute: true })) {
      let game = {
        appid: path.parse(dir).name,
        source: 'gog',
        data: {
          type: 'file',
          path: dir,
        },
      };
      let steamid;
      let cached = cache.find((g) => g.gogid === game.appid);
      if (cached) {
        steamid = cached.steamid;
      } else {
        const url = `https://gamesdb.gog.com/platforms/gog/external_releases/${game.appid}`;
        let gameinfo = await request.getJson(url);
        if (gameinfo) {
          steamid = gameinfo.game.releases.find((r) => r.platform_id === 'steam').external_id;
          if (steamid) {
            cache.push({ gogid: game.appid, steamid });
            update_cache = true;
          }
        }
      }
      if (steamid) {
        game.appid = steamid || game.appid;
        data.push(game);
      }
    }
    if (update_cache) ffs.writeFile(cacheFile, JSON.stringify(cache, null, 2));
    return data;
  } catch (err) {
    throw err;
  }
};
