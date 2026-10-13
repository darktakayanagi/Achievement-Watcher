'use strict';

const path = require('path');
const fs = require('fs');
const glob = require('fast-glob');
const ini = require('@xan105/ini');
const request = require('request-zero');

const appdataPath = process.env['APPDATA'];
const cacheFile = path.join(appdataPath, 'Achievement Watcher', 'steam_cache', 'epic.db');

async function findByReadingContentOfKnownConfigfilesIn(dirPath) {
  const files = ['UniverseLAN.ini'];

  const list = await glob(
    files.map((file) => '**/' + file),
    { cwd: dirPath, onlyFiles: true, absolute: true }
  );

  let appid = null;

  for (const file of list) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      if (path.parse(file).ext === '.txt') {
        appid = content.toString().trim();
      } else {
        const data = ini.parse(content);

        //Node14: use ?.
        //Nb: order of if test is ~somewhat~ important

        if (data.GameSettings?.AppID) appid = data.GameSettings.AppID;
        else throw 'ERROR_UNEXPECTED_CONTENT';
      }
      break;
    } catch (err) {
      /*Do Nothing; Try next file if any*/
    }
  }

  if (!appid) throw 'ERROR_NOT_FOUND';
  let cache = [];
  let steamid;
  if (fs.existsSync(cacheFile)) {
    cache = JSON.parse(fs.readFileSync(cacheFile, { encoding: 'utf8' }));
  }
  let cached = cache.find((g) => g.gogid === appid);
  if (cached) return cached.steamid;
  const url = `https://gamesdb.gog.com/platforms/gog/external_releases/${appid}`;
  try {
    let gameinfo = await request.getJson(url);
    if (gameinfo) {
      steamid = gameinfo.game.releases.find((r) => r.platform_id === 'steam').external_id;
      if (steamid) {
        cache.push({ gogid: appid, steamid });
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
        return steamid;
      }
    }
  } catch (e) {
    debug.log(e);
  }
}

module.exports = { findByReadingContentOfKnownConfigfilesIn };
