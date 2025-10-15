'use strict';

//const axios = require('axios');
//const cheerio = require('cheerio');
const path = require('path');
const glob = require('fast-glob');
const normalize = require('normalize-path');
const ini = require('@xan105/ini');
const omit = require('lodash.omit');
const moment = require('moment');
const request = require('request-zero');
const urlParser = require('url');
const ffs = require('@xan105/fs');
const { readRegistryStringAndExpand, regKeyExists, readRegistryInteger, readRegistryString, listRegistryAllSubkeys } = require('../util/reg');
const appPath = path.join(__dirname, '../');
const steamID = require(path.join(appPath, 'util/steamID.js'));
const steamLanguages = require(path.join(appPath, 'locale/steam.json'));
const sse = require(path.join(appPath, 'parser/sse.js'));
const htmlParser = require('node-html-parser');
const fs = require('fs');
const SteamUser = require('steam-user');
const client = new SteamUser();
client.logOn({ anonymous: true });

let debug;
let cacheRoot;
module.exports.setUserDataPath = (p) => {
  cacheRoot = p;
};

module.exports.initDebug = ({ isDev, userDataPath }) => {
  this.setUserDataPath(userDataPath);
  debug = new (require('@xan105/log'))({
    console: isDev || false,
    file: path.join(userDataPath, 'logs/parser.log'),
  });
};

module.exports.scan = async (additionalSearch = []) => {
  try {
    let search = [
      path.join(process.env['Public'], 'Documents/Steam/CODEX'),
      path.join(process.env['Public'], 'Documents/Steam/RUNE'),
      path.join(process.env['Public'], 'Documents/OnlineFix'),
      path.join(process.env['Public'], 'Documents/EMPRESS'),
      path.join(process.env['APPDATA'], 'Goldberg SteamEmu Saves'),
      path.join(process.env['APPDATA'], 'GSE Saves'),
      path.join(process.env['APPDATA'], 'EMPRESS'),
      path.join(process.env['APPDATA'], 'Steam/CODEX'),
      path.join(process.env['APPDATA'], 'SmartSteamEmu'),
      path.join(process.env['APPDATA'], 'CreamAPI'),
      path.join(process.env['PROGRAMDATA'], 'Steam') + '/*',
      path.join(process.env['LOCALAPPDATA'], 'SKIDROW'),
    ];

    const mydocs = readRegistryStringAndExpand('HKCU', 'Software/Microsoft/Windows/CurrentVersion/Explorer/User Shell Folders', 'Personal');
    if (mydocs) {
      search = search.concat([path.join(mydocs, 'SkidRow')]);
    }

    if (additionalSearch.length > 0) search = search.concat(additionalSearch);

    search = search.map((dir) => {
      return normalize(dir) + '/([0-9]+)';
    });

    let data = [];
    for (let dir of await glob(search, { onlyDirectories: true, absolute: true })) {
      let game = {
        appid: path.parse(dir).name,
        data: {
          type: 'file',
          path: dir,
        },
      };

      if (dir.includes('CODEX')) {
        game.source = 'Codex';
      } else if (dir.includes('RUNE')) {
        game.source = 'Rune';
      } else if (dir.includes('OnlineFix')) {
        game.source = 'OnlineFix';
      } else if (dir.includes('Goldberg') || dir.includes('GSE')) {
        game.source = 'Goldberg';
      } else if (dir.includes('EMPRESS')) {
        game.source = 'Goldberg (EMPRESS)';
        game.data.path = path.join(game.data.path, 'remote', game.appid);
      } else if (dir.includes('SKIDROW')) {
        game.source = 'Skidrow';
      } else if (dir.includes('SmartSteamEmu')) {
        game.source = 'SmartSteamEmu';
      } else if (dir.includes('ProgramData/Steam')) {
        game.source = 'Reloaded - 3DM';
      } else if (dir.includes('CreamAPI')) {
        game.source = 'CreamAPI';
      } else if (dir.includes('Steam')) {
        game.source = 'Steam';
      }

      data.push(game);
    }
    return data;
  } catch (err) {
    throw err;
  }
};

module.exports.scanLegit = async (listingType = 0, steamAccFilter = '0') => {
  try {
    let data = [];

    if (regKeyExists('HKCU', 'Software/Valve/Steam') && listingType > 0) {
      let steamPath = await getSteamPath();
      let publicUsers = await getSteamUsers(steamPath);
      if (steamAccFilter !== '0' && publicUsers.find((p) => p.user === steamAccFilter))
        publicUsers = publicUsers.filter((u) => u.user === steamAccFilter);

      let steamCache = path.join(steamPath, 'appcache/stats');
      let list = (await glob('UserGameStats_*([0-9])_*([0-9]).bin', { cwd: steamCache, onlyFiles: true, absolute: false })).map((filename) => {
        let matches = filename.match(/([0-9]+)/g);
        return {
          userID: matches[0],
          appID: matches[1],
        };
      });

      for (let stats of list) {
        let isInstalled = true;
        if (listingType == 1)
          isInstalled = readRegistryInteger('HKCU', `Software/Valve/Steam/Apps/${stats.appID}`, 'Installed') === '1' ? true : false;

        let user = publicUsers.find((user) => user.user == stats.userID);

        if (user && isInstalled) {
          data.push({
            appid: stats.appID,
            source: `Steam (${user.name})`,
            data: {
              type: 'steamAPI',
              userID: user,
              cachePath: steamCache,
            },
          });
        }
      }
    } else {
      throw 'Legit Steam not found or disabled.';
    }

    return data;
  } catch (err) {
    throw err;
  }
};

module.exports.getCachedData = (cfg) => {
  if (!steamLanguages.some((language) => language.api === cfg.lang)) {
    throw 'Unsupported API language code';
  }

  const cache = path.join(cacheRoot, 'steam_cache/schema', cfg.lang);
  let result;
  try {
    let filePath = path.join(`${cache}`, `${cfg.appID}.db`);
    if (fs.existsSync(filePath)) {
      result = JSON.parse(fs.readFileSync(filePath));
    }
  } catch (err) {
    if (err.code) throw `Could not load Steam data: ${err.code} - ${err.message}`;
    else throw `Could not load Steam data: ${err}`;
  }
  return result;
};

module.exports.saveGameToCache = async (cfg) => {
  const cache = path.join(cacheRoot, 'steam_cache/schema', cfg.lang);
  const filePath = path.join(`${cache}`, `${cfg.appid}.db`);

  const result = {
    name: cfg.name,
    appid: cfg.appid,
    binary: null,
    img: {
      header: `https://cdn.akamai.steamstatic.com/steam/apps/${cfg.appid}/header.jpg`,
      background: `https://cdn.akamai.steamstatic.com/steam/apps/${cfg.appid}/page_bg_generated_v6b.jpg`,
      portrait: `https://cdn.akamai.steamstatic.com/steam/apps/${cfg.appid}/library_600x900.jpg`,
      icon: `https://cdn.akamai.steamstatic.com/steam/apps/${cfg.appid}/${cfg.icon}.jpg`,
    },
    achievement: {
      total: cfg.achievements.length,
      list: cfg.achievements,
    },
  };
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2));
};

module.exports.getGameData = async (cfg) => {
  if (!steamLanguages.some((language) => language.api === cfg.lang)) {
    throw 'Unsupported API language code';
  }
  let result;
  let needSaving = false;
  const cache = path.join(cacheRoot, 'steam_cache/schema', cfg.lang);
  let filePath = path.join(`${cache}`, `${cfg.appID}.db`);
  try {
    result = this.getCachedData(cfg);
    if (!result || !result.name) {
      if (!(await findInAppList(+cfg.appID))) throw `Error trying to load steam data for ${cfg.appID}`;
      if (cfg.key) {
        result = await getSteamData(cfg);
      } else {
        result = await getSteamDataFromSRV(cfg.appID, cfg.lang);
      }
      needSaving = true;
    }
    needSaving = needSaving || GetMissingData(result);
    if (needSaving) fs.writeFileSync(filePath, JSON.stringify(result, null, 2));
    return result;
  } catch (err) {
    if (err.code) debug.log(`Could not load Steam data: ${err.code} - ${err.message}`);
    else debug.log(`Could not load Steam data: ${err}`);
  }
};

module.exports.getAchievementsFromFile = async (filePath) => {
  try {
    const files = [
      'achievements.ini',
      'achievements.json',
      'achiev.ini',
      'stats.ini',
      'Achievements.Bin',
      'achieve.dat',
      'Achievements.ini',
      'stats/achievements.ini',
      'stats.bin',
      'stats/CreamAPI.Achievements.cfg',
    ];

    const filter = ['SteamAchievements', 'Steam64', 'Steam'];

    let local;
    for (let file of files) {
      try {
        if (path.parse(file).ext == '.json') {
          local = JSON.parse(fs.readFileSync(path.join(filePath, file), 'utf8'));
        } else if (file === 'stats.bin') {
          local = sse.parse(fs.readFileSync(path.join(filePath, file)));
        } else {
          local = ini.parse(fs.readFileSync(path.join(filePath, file), 'utf8'));
        }
        break;
      } catch (e) {}
    }
    if (!local) throw `No achievement file found in '${filePath}'`;

    let result = {};

    if (local.AchievementsUnlockTimes && local.Achievements) {
      //hoodlum DARKSiDERS

      for (let i in local.Achievements) {
        if (Object.prototype.hasOwnProperty.call(local.Achievements, i)) {
          if (local.Achievements[i] == 1) {
            result[`${i}`] = { Achieved: '1', UnlockTime: local.AchievementsUnlockTimes[i] || null };
          }
        }
      }
    } else if (local.State && local.Time) {
      //3DM

      for (let i in local.State) {
        if (Object.prototype.hasOwnProperty.call(local.State, i)) {
          if (local.State[i] == '0101') {
            result[i] = {
              Achieved: '1',
              UnlockTime: new DataView(new Uint8Array(Buffer.from(local.Time[i].toString(), 'hex')).buffer).getUint32(0, true) || null,
            };
          }
        }
      }
    } else {
      result = omit(local.ACHIEVE_DATA || local, filter);
    }

    for (let i in result) {
      if (Object.prototype.hasOwnProperty.call(result, i)) {
        if (result[i].State) {
          //RLD!
          try {
            //uint32 little endian
            result[i].State = new DataView(new Uint8Array(Buffer.from(result[i].State.toString(), 'hex')).buffer).getUint32(0, true);
            result[i].CurProgress = new DataView(new Uint8Array(Buffer.from(result[i].CurProgress.toString(), 'hex')).buffer).getUint32(0, true);
            result[i].MaxProgress = new DataView(new Uint8Array(Buffer.from(result[i].MaxProgress.toString(), 'hex')).buffer).getUint32(0, true);
            result[i].Time = new DataView(new Uint8Array(Buffer.from(result[i].Time.toString(), 'hex')).buffer).getUint32(0, true);
          } catch (e) {}
        } else if (result[i].unlocktime && result[i].unlocktime.length === 7) {
          //creamAPI
          result[i].unlocktime = +result[i].unlocktime * 1000; //cf: https://cs.rin.ru/forum/viewtopic.php?p=2074273#p2074273 | timestamp is invalid/incomplete
        }
      }
    }

    return result;
  } catch (err) {
    throw err;
  }
};

module.exports.getAchievementsFromAPI = async (cfg) => {
  try {
    let result;

    let cache = {
      local: path.join(cacheRoot, 'steam_cache/user', cfg.user.user, `${cfg.appID}.db`),
      steam: path.join(`${cfg.path}`, `UserGameStats_${cfg.user.user}_${cfg.appID}.bin`),
    };

    let time = {
      local: 0,
      steam: 0,
    };

    let local = await ffs.stats(cache.local);
    if (Object.keys(local).length > 0) {
      time.local = moment(local.mtime).valueOf();
    }

    let steamStats = await ffs.stats(cache.steam);
    if (Object.keys(steamStats).length > 0) {
      time.steam = moment(steamStats.mtime).valueOf();
    } else {
      throw 'No Steam cache file found';
    }

    if (time.steam > time.local) {
      if (cfg.key) {
        result = await getSteamUserStats(cfg);
      } else {
        result = await getSteamUserStatsFromSRV(cfg.user.id, cfg.appID);
      }
      fs.writeFileSync(cache.local, JSON.stringify(result, null, 2));
    } else {
      result = JSON.parse(fs.readFileSync(cache.local));
    }

    return result;
  } catch (err) {
    if (err.code) throw `Could not load Steam User Stats: ${err.code} - ${err.message}`;
    else throw `Could not load Steam User Stats: ${err}`;
  }
};

const getSteamPath = (module.exports.getSteamPath = async () => {
  /*
       Some SteamEmu change HKCU/Software/Valve/Steam/SteamPath to the game's dir
       Fallback to Software/WOW6432Node/Valve/Steam/InstallPath in this case 
       NB: Steam client correct the key on startup
     */

  const regHives = [
    { root: 'HKCU', key: 'Software/Valve/Steam', name: 'SteamPath' },
    { root: 'HKLM', key: 'Software/WOW6432Node/Valve/Steam', name: 'InstallPath' },
  ];

  let steamPath;

  for (let regHive of regHives) {
    steamPath = readRegistryString(regHive.root, regHive.key, regHive.name);
    if (steamPath) {
      if (await ffs.exists(path.join(steamPath, 'steam.exe'))) {
        break;
      }
    }
  }

  if (!steamPath) throw 'Steam Path not found';
  return steamPath;
});

const getSteamUsers = (module.exports.getSteamUsers = async (steamPath) => {
  let result = [];

  let users = listRegistryAllSubkeys('HKCU', 'Software/Valve/Steam/Users');
  if (!users) users = await glob('*([0-9])', { cwd: path.join(steamPath, 'userdata'), onlyDirectories: true, absolute: false });

  if (users.length == 0) throw 'No Steam User ID found';
  for (let user of users) {
    let id = steamID.to64(user);
    let data = await steamID.whoIs(id);

    if (data.privacyState === 'public') {
      debug.log(`${user} - ${id} (${data.steamID}) is public`);
      result.push({
        user: user,
        id: id,
        name: data.steamID,
        profile: data,
      });
    } else {
      debug.log(`${user} - ${id} (${data.steamID}) is not public`);
    }
  }

  if (result.length > 0) {
    return result;
  } else {
    throw 'Public profile: none.';
  }
});

const getSteamUsersList = (module.exports.getSteamUsersList = async () => {
  if (!regKeyExists('HKCU', 'Software/Valve/Steam')) return [];
  try {
    let steamPath = await getSteamPath();
    let publicUsers = await getSteamUsers(steamPath);
    return publicUsers;
  } catch (e) {
    return [];
  }
});

function getSteamUserStatsFromSRV(user, appID) {
  const url = `https://api.xan105.com/steam/user/${user}/stats/${appID}`;

  return new Promise((resolve, reject) => {
    request
      .getJson(url)
      .then((data) => {
        if (data.error) {
          return reject(data.error);
        } else if (data.data) {
          return resolve(data.data);
        } else {
          return reject('Unexpected Error');
        }
      })
      .catch((err) => {
        return reject(err);
      });
  });
}

async function getSteamUserStats(cfg) {
  const url = `http://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/?appid=${cfg.appID}&key=${cfg.key}&steamid=${cfg.user.id}"`;

  try {
    let result = await request.getJson(url);
    return result.playerstats.achievements;
  } catch (err) {
    throw err;
  }
}

async function getSteamDataFromSRV(appID, lang) {
  const { ipcRenderer } = require('electron');
  const result = ipcRenderer.sendSync('get-steam-data', { appid: appID, type: 'common' });
  const achievements = result.isGame ? ipcRenderer.sendSync('get-steam-data', { appid: appID, type: 'steamhunters' }).achievements : [];

  return {
    name: result.name,
    appid: appID,
    binary: null,
    img: {
      header: result.header || 'header',
      background: result.background || 'page_bg_generated_v6b',
      portrait: result.portrait || 'library_600x900',
      icon: result.icon,
    },
    achievement: {
      total: achievements.length,
      list: achievements,
    },
  };
}

async function getSteamData(cfg) {
  const url = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v0002/?key=${cfg.key}&appid=${cfg.appID}&l=${cfg.lang}&format=json`;

  const data = await request.getJson(url);

  const schema = data.game.availableGameStats;
  if (!(schema && schema.achievements && schema.achievements.length > 0)) throw "Schema doesn't have any achievement";

  const store = await getDataFromSteamStore(+cfg.appID);
  let portrait_options = [
    `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${cfg.appID}/portrait.png`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${cfg.appID}/library_600x900.jpg`,
  ];
  if (store.portrait) portrait_options.push(store.portrait);
  portrait_options.push(null);

  const result = {
    name: store.name || (await findInAppList(+cfg.appID)),
    appid: cfg.appID,
    binary: null,
    img: {
      header: `https://cdn.akamai.steamstatic.com/steam/apps/${cfg.appID}/header.jpg`,
      background: `https://cdn.akamai.steamstatic.com/steam/apps/${cfg.appID}/page_bg_generated_v6b.jpg`,
      portrait: `https://cdn.akamai.steamstatic.com/steam/apps/${cfg.appID}/library_600x900.jpg`,
      icon: store.icon ? `https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/${cfg.appID}/${store.icon}.jpg` : null,
    },
    achievement: {
      total: schema.achievements.length,
      list: schema.achievements,
    },
  };

  try {
    if ((await fetchIcon(result.img.header, result.appid)) === result.img.header) {
      result.img.header = store.header;
    }
    if ((await fetchIcon(result.img.background, result.appid)) === result.img.background) {
      result.img.background = store.background;
    }
    while (portrait_options.length > 0) {
      if ((await fetchIcon(result.img.portrait, result.appid)) !== result.img.portrait) {
        break;
      }
      result.img.portrait = portrait_options.shift();
    }
  } catch (err) {
    console.log(err);
  }
  return result;
}

async function getDataFromSteamStore(appID) {
  if (!appID || !(Number.isInteger(appID) && appID > 0)) throw 'ERR_INVALID_APPID';

  const url = `https://store.steampowered.com/app/${appID}`;

  try {
    const { body } = await request(url, {
      headers: {
        Cookie: 'birthtime=662716801; wants_mature_content=1; path=/; domain=store.steampowered.com', //Bypass age check and mature filter
        'Accept-Language': 'en-US;q=1.0', //force result to english
      },
    });

    const html = htmlParser.parse(body);

    // Extract from inline style
    const bgDiv = html.querySelector('.game_page_background.game');
    let background = null;

    if (bgDiv) {
      const styleAttr = bgDiv.getAttribute('style') || '';
      const match = styleAttr.match(/url\(\s*(['"])?(.*?)\1\s*\)/i);
      if (match && match[2]) {
        background = match[2].trim().split('?')[0];
      }
    }

    const result = {
      name: html.querySelector('.apphub_AppName').innerHTML,
      icon: html
        .querySelector('.apphub_AppIcon img')
        .attributes.src.match(/([^\\\/\:\*\?\"\<\>\|])+$/)[0]
        .replace('.jpg', ''),
      header:
        html.querySelector('meta[property="og:image"]')?.attributes.content.split('?')[0] ||
        html.querySelector('.game_header_image_full')?.attributes.src.split('?')[0] ||
        null,
      portrait: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appID}/portrait.png`,
      background,
    };

    return result;
  } catch {
    return {};
  }
}

async function findInAppList(appID) {
  if (!appID || !(Number.isInteger(appID) && appID > 0)) throw 'ERR_INVALID_APPID';

  const cache = path.join(cacheRoot, 'steam_cache/schema');
  const filepath = path.join(cache, 'appList.json');

  try {
    const list = JSON.parse(fs.readFileSync(filepath));
    const app = list.find((app) => app.appid === appID);
    if (!app) throw 'ERR_NAME_NOT_FOUND';
    return app.name;
  } catch {
    if (Date.now() - fs.statSync(filepath).mtimeMs < 60 * 60 * 1000) {
      throw 'ERR_NAME_NOT_FOUND';
    }
    const url = 'http://api.steampowered.com/ISteamApps/GetAppList/v0002/?format=json';

    const data = await request.getJson(url, { timeout: 4000 });

    let list = data.applist.apps;
    list.sort((a, b) => b.appid - a.appid); //recent first

    fs.writeFileSync(filepath, JSON.stringify(list, null, 2));

    const app = list.find((app) => app.appid === appID);
    if (!app) throw 'ERR_NAME_NOT_FOUND';
    return app.name;
  }
}

const cdnProviders = [
  'https://cdn.akamai.steamstatic.com/steam/apps/',
  'https://cdn.cloudflare.steamstatic.com/steam/apps/',
  'https://media.steampowered.com/steam/apps/',
  'https://steamcdn-a.akamaihd.net/steam/apps/',
  'https://shared.fastly.steamstatic.com/steam/apps/',
  'https://shared.fastly.steamstatic.com/community_assets/images/apps/',
  'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/',
  'https://steampipe.akamaized.net/steam/apps/',
  'https://google2.cdn.steampipe.steamcontent.com/steam/apps/',
  'https://steamcdn-a.akamaihd.net/steam/apps/',
  'https://media.steampowered.com/steam/apps/',
];
async function findWorkingLink(appid, basename) {
  for (const ext of ['.jpg', '.png']) {
    for (const cdn of cdnProviders) {
      const url = `${cdn}${appid}/${basename}${ext}`;
      try {
        const res = await request(url, { method: 'HEAD' });
        if (res.code === 200) {
          const contentType = res.headers['content-type'];
          if (contentType) return url;
        }
      } catch (e) {}
    }
  }
  return null;
}

function GetMissingData(data) {
  let updated = false;
  const { ipcRenderer } = require('electron');
  let updatedImgs, updatedDesc;
  if (Object.values(data.img).some((im) => !im)) {
    updated = true;
    updatedImgs = ipcRenderer.sendSync('get-steam-data', { appid: data.appid, type: 'full' });
    for (let [type, value] of Object.entries(data.img)) {
      if (!value) data.img[type] = updatedImgs[type];
    }
  }
  if (data.achievement.list.some((ac) => !ac.description || ac.description === '')) {
    updated = true;
    const missing = data.achievement.list.filter((ac) => !ac.description || ac.description === '');
    updatedDesc = ipcRenderer.sendSync('get-steam-data', { appid: data.appid, type: 'desc' });
    const map = new Map(updatedDesc.achievements.map((item) => [item.title, item.desc]));
    for (let ach of data.achievement.list) {
      if (!ach.description && (map.has(ach.displayName) || map.has(ach.name))) ach.description = map.get(ach.displayName) || map.get(ach.name);
    }
  }
  return updated;
}

const fetchIcon = (module.exports.fetchIcon = async (url, appID) => {
  try {
    const cache = path.join(process.env['APPDATA'], `Achievement Watcher/steam_cache/icon/${appID}`);

    //legacy url are full urls, check if they are still valid
    let isValid = false;
    let validUrl = url;
    try {
      new URL(url);
      const res = await request(url, { method: 'HEAD' });
      isValid = res.code !== 200 ? false : true;
      isValid = isValid ? res.headers['content-type'] : isValid;
    } catch (e) {}

    if (!isValid)
      validUrl = await findWorkingLink(
        appID,
        url.startsWith('http')
          ? url
              .split('/')
              .pop()
              .split('?')[0]
              .replace(/\.[^.]+$/, '')
          : url.endsWith('.jpg') || url.endsWith('.png')
          ? url.slice(0, url.length - 4)
          : url
      );

    const filename = path.parse(urlParser.parse(validUrl).pathname).base;

    let filePath = path.join(cache, filename);

    if (fs.existsSync(filePath)) {
      return filePath;
    } else {
      return (await request.download(validUrl, cache)).path;
    }
  } catch (err) {
    return url;
  }
});
