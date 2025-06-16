'use strict';

const path = require('path');
const fs = require('fs');
const glob = require('fast-glob');
const request = require('request-zero');
const { parse } = require('node-html-parser');

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
  const cacheFile = path.join(cacheRoot, 'steam_cache', 'epic.db');
  let data = [];
  let cache = [];

  if (fs.existsSync(cacheFile)) {
    cache = JSON.parse(fs.readFileSync(cacheFile, { encoding: 'utf8' }));
  }

  try {
    for (let dir of await glob(
      path.join(process.env['APPDATA'] || path.join(os.homedir(), 'Library', 'Application Support'), 'NemirtingasEpicEmu', '*/*/'),
      { onlyDirectories: true, absolute: true }
    )) {
      let game = {
        appid: path.parse(dir).name,
        source: 'epic',
        data: {
          type: 'file',
          path: dir,
        },
      };

      //TODO: refactor this so that we get the game name from the id
      // then find the matching steamappid of that game and cache it
      // if epic exclusive the get achievement data from epic
      // create AW db files with that
      let steamid;
      let cached = cache.find((g) => g.epicid === game.appid);
      if (cached) {
        steamid = cached.steamid;
      } else {
        const url = `https://store.epicgames.com/en-US`;
        let response = await request(url);
        const root = parse(response);
        const scripts = root.querySelectorAll('script');
        for (const script of scripts) {
          const content = script.innerHTML;
          if (content.includes('window.__epic_client_state')) {
            const info = content.match(/window\.__epic_client_state\s*=\s*({.*});?/s);
          }
        }
        // Extract "latestValue" JSON section
        const regex = /"latestValue"\s*:\s*({[\s\S]*?})\s*,\s*"collections"/;
        const match = response.body.match(regex);
        let gameinfo = JSON.parse();
        if (gameinfo) {
          steamid = gameinfo.game.releases.find((r) => r.platform_id === 'steam').external_id;
          if (steamid) cache.push({ epicid: game.appid, steamid });
        }
      }
      if (steamid) {
        game.appid = steamid || game.appid;
        data.push(game);
      }
    }
    fs.writeFile(filePath, JSON.stringify(cache, null, 2));
    return data;
  } catch (err) {
    throw err;
  }
};
