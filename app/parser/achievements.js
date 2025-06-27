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

module.exports.getAchievementsForAppid = async (option, requestedAppid, callbackProgress = () => {}) => {
  let appidList = await discover(option.achievement_source, option.steam.main);
  let finds = appidList.filter((app) => app.appid === String(requestedAppid));
  if (finds.length === 0)
    finds.push({
      appid: requestedAppid,
      data: { type: 'unknown' },
    });

  let game;

  try {
    if (finds[0].data.type === 'rpcs3') {
      game = await rpcs3.getGameData(appid.data.path);
    } else if (finds[0].data.type === 'uplay' || finds[0].data.type === 'lumaplay') {
      game = await uplay.getGameData(finds[0].appid, option.achievement.lang);
    } else if (finds[0].source === 'epic' && epic.isExclusive(finds[0].appid)) {
      game = await epic.getGameData({ appID: finds[0].appid });
    } else {
      game = await steam.getGameData({
        appID: finds[0].appid,
        lang: option.achievement.lang,
        key: option.steam.apiKey,
      });
    }

    if (!option.achievement.mergeDuplicate && finds[0].source) game.source = finds[0].source;

    if (finds[0].data.type === 'unknown') return game;

    let root = {};
    for (let app of finds) {
      try {
        if (app.data.type === 'file') {
          root = await steam.getAchievementsFromFile(app.data.path);
          //Note to self: Empty file should be considered as a 0% game -> do not throw an error just issue a warning
          if (root.constructor === Object && Object.entries(root).length === 0)
            debug.warn(`[${app.appid}] Warning ! Achievement file in '${app.data.path}' is probably empty`);
        } else if (app.data.type === 'reg') {
          root = await greenluma.getAchievements(app.data.root, app.data.path);
        } else if (app.data.type === 'steamAPI') {
          root = await steam.getAchievementsFromAPI({
            appID: app.appid,
            user: app.data.userID,
            path: app.data.cachePath,
            key: option.steam.apiKey,
          });
        } else if (app.data.type === 'rpcs3') {
          root = await rpcs3.getAchievements(app.data.path, game.achievement.total);
        } else if (app.data.type === 'lumaplay') {
          root = uplay.getAchievementsFromLumaPlay(app.data.root, app.data.path);
        } else if (app.data.type === 'cached') {
          root = await watchdog.getAchievements(app.appid);
        } else {
          throw 'Not yet implemented';
        }
      } catch (err) {
        debug.error(`[${app.appid}] Error parsing local achievements data => ${err}`);
      }

      for (let i in root) {
        if (Object.prototype.hasOwnProperty.call(root, i)) {
          try {
            let achievement = game.achievement.list.find((elem) => {
              if (root[i].crc) {
                return root[i].crc.includes(crc32(elem.name).toString(16)); //(SSE) crc module removes leading 0 when dealing with anything below 0x1000 -.-'
              } else {
                let apiname = root[i].id || root[i].apiname || root[i].name || i;
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
                root[i].unlocked == 1 ||
                root[i] === '1'
                  ? true
                  : false,
              CurProgress: root[i].CurProgress || root[i].progress || 0,
              MaxProgress: root[i].MaxProgress || root[i].max_progress || 0,
              UnlockTime:
                root[i].UnlockTime ||
                root[i].unlocktime ||
                root[i].unlock_time ||
                root[i].HaveAchievedTime ||
                root[i].HaveHaveAchievedTime ||
                root[i].Time ||
                root[i].earned_time ||
                0,
            };

            if (!parsed.Achieved && parsed.MaxProgress != 0 && parsed.CurProgress != 0 && parsed.MaxProgress == parsed.CurProgress) {
              //CODEX Gears5 (09/2019)  && Gears tactics (05/2020)
              parsed.Achieved = true;
            }

            if (parsed.Achieved && !achievement.Achieved) {
              achievement.Achieved = true;
            }

            if (
              (!achievement.CurProgress && parsed.CurProgress > 0) ||
              (parsed.CurProgress > 0 && parsed.MaxProgress == achievement.MaxProgress && parsed.CurProgress > achievement.CurProgress)
            ) {
              achievement.CurProgress = parsed.CurProgress;
            }

            if (!achievement.MaxProgress && parsed.MaxProgress > 0) {
              achievement.MaxProgress = parsed.MaxProgress;
            }

            if (option.achievement.timeMergeRecentFirst) {
              if (!achievement.UnlockTime || achievement.UnlockTime == 0 || parsed.UnlockTime > achievement.UnlockTime) {
                //More recent first
                achievement.UnlockTime = parsed.UnlockTime;
              }
            } else {
              if (!achievement.UnlockTime || achievement.UnlockTime == 0 || (parsed.UnlockTime > 0 && parsed.UnlockTime < achievement.UnlockTime)) {
                //Oldest first
                achievement.UnlockTime = parsed.UnlockTime;
              }
            }
          } catch (err) {
            if (err === 'ACH_NOT_FOUND_IN_SCHEMA') {
              debug.warn(`[${app.appid}] Achievement not found in game schema data ?! ... Achievement was probably deleted or renamed over time`);
            } else {
              debug.error(`[${app.appid}] Unexpected Error: ${err}`);
            }
          }
        }
      }

      game.achievement.unlocked = game.achievement.list.filter((ach) => ach.Achieved == 1).length;
    }
  } catch (err) {
    debug.error(`[${app.appid}] Error parsing local achievements data => ${err} > SKIPPING`);
  }

  return game;
};

module.exports.makeList = async (option, callbackProgress = () => {}) => {
  try {
    let result = [];

    let appidList = await discover(option.achievement_source, option.steam.main);

    if (appidList.length > 0) {
      let count = 0;

      for (let appid of appidList) {
        let game;
        let isDuplicate = false;

        try {
          if (result.some((res) => res.appid == appid.appid) && option.achievement.mergeDuplicate) {
            game = result.find((elem) => elem.appid == appid.appid);
            isDuplicate = true;
          } else if (appid.data.type === 'rpcs3') {
            game = await rpcs3.getGameData(appid.data.path);
          } else if (appid.data.type === 'uplay' || appid.data.type === 'lumaplay') {
            game = await uplay.getGameData(appid.appid, option.achievement.lang);
          } else if (appid.source === 'epic' && epic.isExclusive(appid.appid)) {
            game = await epic.getGameData({ appID: appid.appid, lang: option.achievement.lang });
          } else {
            game = await steam.getGameData({
              appID: appid.appid,
              lang: option.achievement.lang,
              key: option.steam.apiKey,
            });
          }
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
                    let apiname = root[i].id || root[i].apiname || root[i].name || i;
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
                    0,
                };

                if (!parsed.Achieved && parsed.MaxProgress != 0 && parsed.CurProgress != 0 && parsed.MaxProgress == parsed.CurProgress) {
                  //CODEX Gears5 (09/2019)  && Gears tactics (05/2020)
                  parsed.Achieved = true;
                }

                if (isDuplicate) {
                  if (parsed.Achieved && !achievement.Achieved) {
                    achievement.Achieved = true;
                  }

                  if (
                    (!achievement.CurProgress && parsed.CurProgress > 0) ||
                    (parsed.CurProgress > 0 && parsed.MaxProgress == achievement.MaxProgress && parsed.CurProgress > achievement.CurProgress)
                  ) {
                    achievement.CurProgress = parsed.CurProgress;
                  }

                  if (!achievement.MaxProgress && parsed.MaxProgress > 0) {
                    achievement.MaxProgress = parsed.MaxProgress;
                  }

                  if (option.achievement.timeMergeRecentFirst) {
                    if (!achievement.UnlockTime || achievement.UnlockTime == 0 || parsed.UnlockTime > achievement.UnlockTime) {
                      //More recent first
                      achievement.UnlockTime = parsed.UnlockTime;
                    }
                  } else {
                    if (
                      !achievement.UnlockTime ||
                      achievement.UnlockTime == 0 ||
                      (parsed.UnlockTime > 0 && parsed.UnlockTime < achievement.UnlockTime)
                    ) {
                      //Oldest first
                      achievement.UnlockTime = parsed.UnlockTime;
                    }
                  }
                } else {
                  Object.assign(achievement, parsed);
                }
              } catch (err) {
                if (err === 'ACH_NOT_FOUND_IN_SCHEMA') {
                  debug.warn(
                    `[${appid.appid}] Achievement not found in game schema data ?! ... Achievement was probably deleted or renamed over time`
                  );
                } else {
                  debug.error(`[${appid.appid}] Unexpected Error: ${err}`);
                }
              }
            }
          }

          game.achievement.unlocked = game.achievement.list.filter((ach) => ach.Achieved == 1).length;
          if (!isDuplicate) result.push(game);

          //loop appid
        } catch (err) {
          debug.error(`[${appid.appid}] Error parsing local achievements data => ${err} > SKIPPING`);
        }

        count = count + 1;
        let percent = Math.floor((count / appidList.length) * 100);
        callbackProgress(percent);
      }
    }

    return result;
  } catch (err) {
    debug.error(err);
    throw err;
  }
};
