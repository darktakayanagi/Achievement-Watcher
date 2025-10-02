'use strict';

const { crc32 } = require('crc');
const path = require('path');
const appPath = __dirname;
const gog = require(path.join(appPath, 'gog.js'));
const epic = require(path.join(appPath, 'epic.js'));
const steam = require(path.join(appPath, 'steam.js'));
const uplay = require(path.join(appPath, 'uplay.js'));
const rpcs3 = require(path.join(appPath, 'rpcs3.js'));
const greenluma = require(path.join(appPath, 'greenluma.js'));
const userDir = require(path.join(appPath, 'userDir.js'));
const blacklist = require(path.join(appPath, 'blacklist.js'));
const watchdog = require(path.join(appPath, 'watchdog.js'));
let debug;

module.exports.initDebug = ({ isDev, userDataPath }) => {
  if (debug) {
    return;
  }
  userDir.setUserDataPath(userDataPath);
  gog.initDebug({ isDev, userDataPath });
  epic.initDebug({ isDev, userDataPath });
  steam.initDebug({ isDev, userDataPath });
  blacklist.initDebug({ isDev, userDataPath });
  debug = new (require('@xan105/log'))({
    console: isDev || false,
    file: path.join(userDataPath, 'logs/parser.log'),
  });
};

async function discover(source, steamAccFilter) {
  debug.log('Scanning for games ...');

  let data = [];

  //UserCustomDir
  let additionalSearch = [];
  try {
    for (let dir of await userDir.get()) {
      debug.log(`[userdir] ${dir.path}`);

      let scanned = [];
      if (source.rpcs3) scanned = await rpcs3.scan(dir.path);
      if (scanned.length > 0) {
        data = data.concat(scanned);
        debug.log('-> RPCS3 data added');
      } else if (source.steamEmu) {
        scanned = await userDir.scan(dir.path);
        if (scanned.length > 0) {
          data = data.concat(scanned);
          debug.log('-> Steam emu data added');
        } else {
          additionalSearch.push(dir.path);
          debug.log('-> will be scanned for appid folder(s)');
        }
      }
    }
  } catch (err) {
    debug.log(err);
  }

  //Non-Legit Steam
  if (source.steamEmu) {
    try {
      data = data.concat(await steam.scan(additionalSearch));
    } catch (err) {
      debug.error(err);
    }
  }

  //GreenLuma
  if (source.greenLuma) {
    try {
      data = data.concat(await greenluma.scan());
    } catch (err) {
      debug.error(err);
    }
  }

  //Legit Steam
  if (source.legitSteam > 0) {
    try {
      data = data.concat(await steam.scanLegit(source.legitSteam, steamAccFilter));
    } catch (err) {
      debug.error(err);
    }
  }

  if (source.lumaPlay) {
    //Lumaplay
    try {
      data = data.concat(await uplay.scan());
    } catch (err) {
      debug.error(err);
    }

    //Uplay
    try {
      data = data.concat(await uplay.scanLegit());
    } catch (err) {
      debug.error(err);
    }
  }

  if (source.gog) {
    try {
      data = data.concat(await gog.scan());
    } catch (err) {
      debug.error(err);
    }
  }

  if (source.epic) {
    try {
      data = data.concat(await epic.scan());
    } catch (err) {
      debug.error(err);
    }
  }

  if (source.importCache) {
    try {
      data = data.concat(await watchdog.scan());
    } catch (err) {
      debug.error(err);
    }
  }

  //AppID Blacklisting
  try {
    let exclude = await blacklist.get();
    data = data.filter((appid) => {
      return !exclude.some((id) => id == appid.appid);
    });
  } catch (err) {
    debug.error(err);
  }

  return data;
}

module.exports.getGameFromCache = async (appid, source, option) => {
  let result;
  switch (source) {
    case 'gog':
      return gog.getCachedData({ appID: appid, lang: option.achievement.lang });
    case 'epic':
      return epic.getCachedData({ appID: appid, lang: option.achievement.lang });
    case 'uplay':
      return uplay.getGameFromCache(appid);
    case 'steam':
    default:
      result = await steam.getCachedData({ appID: appid, lang: option.achievement.lang });
  }
  return result;
};

module.exports.saveGameToCache = async (info, lang) => {
  switch (info.source) {
    case 'steam':
    default:
      let cfg = info.game;
      cfg.lang = lang;
      steam.saveGameToCache(cfg);
  }
};

module.exports.getAchievementsForAppid = async (option, requestedAppid) => {
  try {
    let game;
    if (/^[0-9]+$/.test(requestedAppid)) {
      game = await steam.getGameData({ appID: requestedAppid, lang: option.achievement.lang, key: option.steam.apiKey });
    } else {
      game = await epic.getGameData({ appID: requestedAppid });
    }
    return game;
  } catch (err) {
    debug.log(err);
    return {};
  }
};

module.exports.getSavedAchievementsForAppid = async (option, requestedAppid) => {
  let game;
  let result = [];

  try {
    let appidList = await discover(option.achievement_source, option.steam.main);
    let appid = appidList.find((a) => a.appid == requestedAppid);

    if (appid.data.type === 'rpcs3') {
      game = await rpcs3.getGameData(appid.data.path);
    } else if (appid.data.type === 'uplay' || appid.data.type === 'lumaplay') {
      game = await uplay.getGameData(appid.appid, option.achievement.lang);
    } else if (appid.source === 'epic') {
      game = await epic.getGameData({ appID: appid.appid, steamappid: appid.steamappid, lang: option.achievement.lang });
    } else {
      game = await steam.getGameData({
        appID: appid.appid,
        lang: option.achievement.lang,
        key: option.steam.apiKey,
      });
    }
    if (appid.steamappid) game.steamappid = appid.steamappid;
    game.source = appid.source;
    if (!option.achievement.mergeDuplicate && appid.source) game.source = appid.source;

    let root = {};
    try {
      if (appid.data.type === 'file') {
        root = await steam.getAchievementsFromFile(appid.data.path);
        //Note to self: Empty file should be considered as a 0% game -> do not throw an error just issue a warning
        if (root.constructor === Object && Object.entries(root).length === 0)
          debug.warn(`[${appid.appid}] Warning ! Achievement file in '${appid.data.path}' is probably empty`);
      } else if (appid.data.type === 'reg') {
        root = await greenluma.getAchievements(appid.data.root, appid.data.path);
      } else if (appid.data.type === 'steamAPI') {
        root = await steam.getAchievementsFromAPI({
          appID: appid.appid,
          user: appid.data.userID,
          path: appid.data.cachePath,
          key: option.steam.apiKey,
        });
      } else if (appid.data.type === 'rpcs3') {
        root = await rpcs3.getAchievements(appid.data.path, game.achievement.total);
      } else if (appid.data.type === 'lumaplay') {
        root = uplay.getAchievementsFromLumaPlay(appid.data.root, appid.data.path);
      } else if (appid.data.type === 'cached') {
        root = await watchdog.getAchievements(appid.appid);
      } else {
        throw 'Not yet implemented';
      }
    } catch (err) {
      debug.error(`[${appid.appid}] Error parsing local achievements data => ${err}`);
    }

    for (let i in root) {
      if (Object.prototype.hasOwnProperty.call(root, i)) {
        try {
          let achievement = game.achievement.list.find((elem) => {
            if (root[i].crc) {
              return root[i].crc.includes(crc32(elem.name).toString(16)); //(SSE) crc module removes leading 0 when dealing with anything below 0x1000 -.-'
            } else {
              let apiname = root[i].id || root[i].apiname || root[i].name || root[i].AchievementId || i;
              return elem.name == apiname || elem.name.toString().toUpperCase() == apiname.toString().toUpperCase(); //uppercase == uppercase : cdx xcom chimera (apiname doesn't match case with steam schema)
            }
          });
          if (!achievement) throw 'ACH_NOT_FOUND_IN_SCHEMA';

          let parsed = {
            Achieved:
              root[i].Achieved == 1 ||
              root[i].achieved == 1 ||
              root[i].State == 1 ||
              root[i].HaveAchieved == 1 ||
              root[i].Unlocked == 1 ||
              root[i].earned ||
              root[i] === '1'
                ? true
                : false,
            CurProgress: root[i].CurProgress || root[i].progress || 0,
            MaxProgress: root[i].MaxProgress || root[i].max_progress || 0,
            UnlockTime:
              root[i].UnlockTime ||
              root[i].unlocktime ||
              root[i].HaveAchievedTime ||
              root[i].HaveHaveAchievedTime ||
              root[i].Time ||
              root[i].earned_time ||
              root[i].unlock_time ||
              0,
          };

          if (
            (!parsed.Achieved && parsed.MaxProgress != 0 && parsed.CurProgress != 0 && parsed.MaxProgress == parsed.CurProgress) ||
            game.source === 'gog' ||
            game.source === 'epic'
          ) {
            //CODEX Gears5 (09/2019)  && Gears tactics (05/2020)
            //gog and epic only save unlocked achivements so if they are in the root it means they are unlocked
            parsed.Achieved = true;
          }

          Object.assign(achievement, parsed);
        } catch (err) {
          if (err === 'ACH_NOT_FOUND_IN_SCHEMA') {
            debug.warn(`[${appid.appid}] Achievement not found in game schema data ?! ... Achievement was probably deleted or renamed over time`);
          } else {
            debug.error(`[${appid.appid}] Unexpected Error: ${err}`);
          }
        }
      }
    }

    game.achievement.unlocked = game.achievement.list.filter((ach) => ach.Achieved == 1).length;

    return game;
    //loop appid
  } catch (err) {
    debug.error(`[${requestedAppid}] Error parsing local achievements data => ${err} > SKIPPING`);
  }
};

module.exports.makeList = async (option, callbackProgress = () => {}) => {
  try {
    let result = [];

    let appidList = await discover(option.achievement_source, option.steam.main);

    if (appidList.length > 0) {
      let count = 0;

      for (let appid of appidList) {
        this.getSavedAchievementsForAppid(option, appid);
      }
    }

    return result;
  } catch (err) {
    debug.error(err);
    throw err;
  }
};
