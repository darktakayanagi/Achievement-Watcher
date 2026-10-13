'use strict';

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  debug?.error?.(`Uncaught exception: ${err}`); // safe optional chaining if debug isn’t loaded yet
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled promise rejection:', reason);
  debug?.error?.(`Unhandled promise rejection: ${reason}`);
});

const debug = require('./util/log.js');
const instance = new (require('single-instance'))('Achievement Watchdog');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');
const getStartApps = require('get-startapps');
const watch = require('node-watch');
const tasklist = require('win-tasklist');
const moment = require('moment');
const websocket = require('./websocket.js');
const processPriority = require('./util/priority.js');
const fs = require('fs');
const reg = require('native-reg');
const request = require('request-zero');
const settings = require('./settings.js');
const monitor = require('./monitor.js');
const steam = require('./steam.js');
const gog = require('./gog.js');
const epic = require('./epic.js');
const track = require('./track.js');
const playtimeMonitor = require('./playtime/monitor.js');
const notify = require('./notification/toaster.js');
const { crc32 } = require('crc');
const { isWinRTAvailable } = require('powertoast');
const { isFullscreenAppRunning } = require('./queryUserNotificationState.js');
const { enableObs, startObs, recordGame, setRecordPath, setRecordResolution } = require('./obsHandler.js');
const userShellFolder = require('./util/userShellFolder.js');
let hotkeys; // required later to avoid io conflict

const cfg_file = {
  option: path.join(process.env['APPDATA'], 'Achievement Watcher/cfg', 'options.ini'),
  userDir: path.join(process.env['APPDATA'], 'Achievement Watcher/cfg', 'userdir.db'),
};

const appRoot = path.join(__dirname, '../');

let pingServer;
let isDev = process.env.NODE_ENV === 'development';
let iohookRunning = false;
let runningAppid;
let overlayOpened = false;
let overlayHotkey;
let runningGames = [];

function parseOverlayHotkey(hotkey) {
  return hotkey
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .join(' + ');
}

function RegisterOverlayHotkey(hotkey) {
  const newHotkey = parseOverlayHotkey(hotkey);
  if (typeof newHotkey !== 'string' || newHotkey.trim().length === 0) {
    debug.error('Invalid hotkey:' + hotkey);
    return;
  }
  debug.log('Registering Overlay hotkey...');
  if (iohookRunning && overlayHotkey && newHotkey === overlayHotkey) return;
  if (overlayHotkey) hotkeys.remove({ hotkeys: overlayHotkey });
  hotkeys.on({
    hotkeys: newHotkey,
    matchAllModifiers: true,
    callback: function () {
      if (runningAppid) {
        debug.log('Overlay hotkey pressed, ' + (overlayOpened ? 'closing' : 'opening') + 'overlay');
        SpawnNotification([`--wintype=overlay`, `--appid=${runningAppid}`, `--description=${overlayOpened ? 'close' : 'open'}`]);
        overlayOpened = !overlayOpened;
      } else {
        debug.log('Overlay hotkey pressed, no game is running; ignoring.');
      }
    },
  });
  iohookRunning = true;
  overlayHotkey = newHotkey;
}

function SpawnNotification(args) {
  const wintypeArg = args.find((arg) => arg.startsWith('--wintype='));
  const wintype = wintypeArg ? wintypeArg.split('=')[1] : 'unknown';
  debug.log(
    wintype == 'data' ? `Fetching data for ${args.find((arg) => arg.startsWith('--appid=')).split('=')[1]}` : `Spawning ${wintype} notification...`
  );
  if (isDev) {
    const electronPath = require(path.join(appRoot, 'app/node_modules/electron'));
    spawn(electronPath, ['.', ...args], {
      cwd: path.join(appRoot, 'app'),
      detached: true,
      stdio: 'ignore',
    }).unref();
  } else {
    const execPath = path.join(appRoot, 'Achievement Watcher.exe');
    spawn(execPath, args, {
      detached: true,
      stdio: ['ignore', process.stdout, process.stderr],
    }).unref();
  }
}
module.exports = { SpawnNotification };

function startAWtoTray() {
  if (isDev) {
    const electronPath = require(path.join(appRoot, 'app/node_modules/electron'));
    spawn(electronPath, ['.', ...['--wintype=tray']], {
      cwd: path.join(appRoot, 'app'),
      detached: true,
      stdio: 'ignore',
    }).unref();
  } else {
    const execPath = path.join(appRoot, 'Achievement Watcher.exe');
    spawn(execPath, ['--wintype=tray'], {
      detached: true,
      stdio: ['ignore', process.stdout, process.stderr],
    }).unref();
  }
}

var app = {
  isRecording: false,
  cache: [],
  options: {},
  watcher: [],
  luma_keys: [],
  tick: 0,
  toastID: 'Microsoft.XboxApp_8wekyb3d8bbwe!Microsoft.XboxApp',
  start: async function (restarting = false) {
    try {
      let self = this;
      if (!restarting) self.cache = [];

      debug.log(`Achievement Watchdog ${restarting ? 're' : ''}starting ...`);
      const net = require('net');
      const PIPE_NAME = '\\\\.\\pipe\\AchievementWatchdogPipe';

      if (!pingServer) {
        pingServer = net.createServer(() => {});
        pingServer.listen(PIPE_NAME, () => {
          console.log('Watchdog process running, pipe open');
        });
      }
      processPriority
        .set('high priority')
        .then(() => {
          debug.log('Process priority set to HIGH');
        })
        .catch((err) => {
          debug.error('Fail to set process priority to HIGH');
        });

      debug.log('Loading Options ...');
      self.options = await settings.load(cfg_file.option);
      debug.log(self.options);

      if (self.options?.general?.closeToTray) startAWtoTray();

      RegisterOverlayHotkey(self.options.overlay.hotkey);
      await enableObs(self.options.souvenir_video.video != '0');

      try {
        startObs(!restarting).then(async () => {
          await setRecordPath(userShellFolder['myvideo']);
          await setRecordResolution();
        });
      } catch (err) {
        debug.log(err);
      }
      if (isWinRTAvailable() === true && self.options.notification_transport.winRT === true) debug.log('[Toast] will use WinRT');
      else if (self.options.notification_transport.toast) debug.warn('[Toast] will use PowerShell');

      getStartApps
        .has({ id: 'GamingOverlay' })
        .then((hasXboxOverlay) => {
          let win_ver = os.release().split('.');

          if (self.options.notification_advanced.appID && self.options.notification_advanced.appID !== '') {
            self.toastID = self.options.notification_advanced.appID;
          } else if (win_ver[0] == '6' && (win_ver[1] == '3' || win_ver[1] == '2')) {
            self.toastID = 'microsoft.XboxLIVEGames_8wekyb3d8bbwe!Microsoft.XboxLIVEGames';
          } else if (hasXboxOverlay === true) {
            self.toastID = 'Microsoft.XboxGamingOverlay_8wekyb3d8bbwe!App';
          }
          if (self.options.notification_transport.toast) debug.log(`[Toast] will use appid: "${self.toastID}"`);
        })
        .then(() => {
          return getStartApps.isValidAUMID(self.toastID);
        })
        .then((res) => {
          if (!res) {
            if (self.options.notification_transport.toast) debug.warn('[Toast] which is not a valid AUMID !');
            if (!self.options.notification_advanced.iconPrefetch) {
              self.options.notification_advanced.iconPrefetch = true;
              debug.warn('[Toast] Forcing iconPrefetch to true so you will have achievement icon');
            }
          } else {
            if (self.options.notification_transport.toast) debug.log('[Toast] which is a valid AUMID');
          }
        })
        .catch(() => {});

      try {
        self.watcher[0] = watch(cfg_file.option, function (evt, name) {
          if (evt === 'update') {
            debug.log('option file change detected -> reloading');
            self.watcher.forEach((watcher) => watcher.close());
            self.stop_lumaPlay();
            self.start(true);
          }
        });
      } catch (err) {
        debug.warn('No option file > settings live reloading disabled');
      }

      let i = 1;
      for (let folder of await monitor.getFolders(cfg_file.userDir)) {
        try {
          if (fs.existsSync(folder.dir)) {
            self.watch(i, folder.dir, folder.options);
            i = i + 1;
          }
        } catch (err) {
          debug.log(err);
        }
      }
      self.watch_lumaPlay();
      debug.log('Waiting for achievements...');
    } catch (err) {
      debug.error(err);
      instance.unlock();
      process.exit();
    }
  },
  watch: function (i, dir, options) {
    let self = this;
    debug.log(`Monitoring ach change in "${dir}" ...`);

    self.watcher[i] = watch(dir, { recursive: options.recursive, filter: options.filter }, async function (evt, name) {
      try {
        if (evt !== 'update') return;

        const currentTime = Date.now();
        const fileLastModified = fs.statSync(name).mtimeMs || 0;
        if (currentTime - fileLastModified > 1000) return;

        let filePath = path.parse(name);
        if (!options.file.some((file) => file == filePath.base)) return;

        debug.log(`achievement file change detected: ${filePath.dir}`);

        if (moment().diff(moment(self.tick)) <= Number(self.options.notification_advanced.tick)) throw 'Spamming protection is enabled > SKIPPING';
        self.tick = moment().valueOf();

        let appID;
        let source = 'steam';
        try {
          appID = options.appid
            ? options.appid
            : filePath.dir.replace(/(\\stats$)|(\\SteamEmu$)|(\\SteamEmu\\UserStats$)/gi, '').match(/([0-9]+$)/g)[0];
        } catch (err) {
          throw "Unable to find game's appID";
        }

        if (
          dir.toLowerCase().includes(String('NemirtingasGalaxyEmu').toLowerCase()) ||
          dir.toLowerCase().includes(String('UniverseLAN').toLowerCase())
        ) {
          source = 'gog';
        }
        if (dir.includes('NemirtingasEpicEmu')) source = 'epic';

        let game = runningGames.find((g) => String(g.appid) === appID) || (await self.load(appID, source));
        if (game.achievement === undefined) {
          let g = await self.load(appID, source);
          game.achievement = g.achievement;
        }

        let isRunning = false;

        if (options.disableCheckIfProcessIsRunning === true) {
          isRunning = true;
        } else if (self.options.notification_advanced.checkIfProcessIsRunning) {
          isRunning = runningGames.find((g) => String(g.appid) === appID);
          if (!isRunning)
            if (await isFullscreenAppRunning()) {
              isRunning = true;
              debug.log('Fullscreen application detected on primary display. Assuming process is running');
            } else if (game.binary) {
              isRunning = await tasklist.isProcessRunning(game.binary).catch((err) => {
                debug.error(err);
                debug.warn('Assuming process is NOT running');
                return false;
              });

              if (!isRunning) {
                debug.log("Trying with '-Win64-Shipping' (Unreal Engine Game) ...");
                isRunning = await tasklist.isProcessRunning(game.binary.replace('.exe', '-Win64-Shipping.exe')).catch((err) => {
                  debug.error(err);
                  debug.warn('Assuming process is NOT running');
                  return false;
                });
              }
            } else {
              debug.warn(`Warning! Missing "${game.name}" (${game.appid}) binary name > Overriding user choice to check if process is running`);
              isRunning = true;
            }
        } else {
          isRunning = true;
        }

        if (isRunning) {
          let achievements = await monitor.parse(name);

          if (achievements.length > 0) {
            let cache = track.load(appID, source);

            let j = 0;
            for (let i in achievements) {
              if (Object.prototype.hasOwnProperty.call(achievements, i)) {
                try {
                  let ach = game.achievement.list.find((achievement) => {
                    if (achievements[i].crc) {
                      return achievements[i].crc.includes(crc32(achievement.name).toString(16)); //(SSE) crc module removes leading 0 when dealing with anything below 0x1000 -.-'
                    } else {
                      return achievement.name == achievements[i].name || achievement.name.toUpperCase() == achievements[i].name.toUpperCase(); //uppercase == uppercase : cdx xcom chimera (apiname doesn't match case with steam schema)
                    }
                  });
                  if (!ach) throw 'ACH_NOT_FOUND_IN_SCHEMA';

                  if (achievements[i].crc) {
                    achievements[i].name = ach.name;
                    delete achievements[i].crc;
                  }

                  let previous = cache.find((achievement) => achievement.name === ach.name) || {
                    Achieved: false,
                    CurProgress: 0,
                    MaxProgress: 0,
                    UnlockTime: 0,
                  };

                  if (!previous.Achieved && achievements[i].Achieved) {
                    if (!achievements[i].UnlockTime || achievements[i].UnlockTime == 0) achievements[i].UnlockTime = moment().unix();
                    let elapsedTime = moment().diff(moment.unix(achievements[i].UnlockTime), 'seconds');
                    if (options.disableCheckTimestamp || (elapsedTime >= 0 && elapsedTime <= self.options.notification_advanced.timeTreshold)) {
                      debug.log('Unlocked:' + ach.displayName);

                      try {
                        if (self.options.action.target) {
                          debug.log(`Action: ${self.options.action.target}`);
                          if (fs.existsSync(self.options.action.target)) {
                            const exec = spawn(self.options.action.target, {
                              cwd: self.options.action.cwd || path.parse(self.options.action.target).dir,
                              stdio: 'ignore',
                              detached: true,
                              windowsHide: self.options.action.hide ?? true,
                              env: {
                                ...process.env,
                                AW_APPID: appID.toString(),
                                AW_GAME: game.name.toString(),
                                AW_ACHIEVEMENT: ach.name.toString(),
                                AW_DISPLAYNAME: ach.displayName.toString(),
                                AW_DESCRIPTION: ach.description?.toString() || '',
                                AW_ICON: ach.icon?.toString() || '',
                                AW_TIME: achievements[i].UnlockTime.toString(),
                              },
                            });
                            exec.unref();
                          } else {
                            debug.warn('Action target missing');
                          }
                        } else {
                          debug.log('No action set');
                        }
                      } catch (err) {
                        debug.error(`Action failed: ${err}`);
                      }

                      await notify(
                        {
                          source: game.source,
                          appid: game.appid,
                          gameDisplayName: game.name,
                          achievementName: ach.name,
                          achievementDisplayName: ach.displayName,
                          achievementDescription: ach.description,
                          icon: ach.icon,
                          time: achievements[i].UnlockTime,
                          delay: j,
                        },
                        {
                          notify: self.options.notification.notify,
                          transport: {
                            toast: self.options.notification_transport.toast,
                            gntp: self.options.notification_transport.gntp,
                            websocket: self.options.notification_transport.websocket,
                            chromium: self.options.notification_transport.chromium,
                          },
                          toast: {
                            appid: self.toastID,
                            winrt: self.options.notification_transport.winRT,
                            balloonFallback: self.options.notification_transport.balloon,
                            customAudio: self.options.notification_toast.customToastAudio,
                            imageIntegration: self.options.notification_toast.toastSouvenir,
                            group: self.options.notification_toast.groupToast,
                            attribution: 'Achievement',
                          },
                          prefetch: self.options.notification_advanced.iconPrefetch,
                          souvenir: {
                            screenshot: self.options.souvenir_screenshot.screenshot,
                            video: self.options.souvenir_video.video,
                            screenshot_options: self.options.souvenir_screenshot,
                            video_options: self.options.souvenir_video,
                          },
                          rumble: self.options.notification.rumble,
                        }
                      );

                      j += 1;
                    } else {
                      debug.warn('Outatime:' + ach.displayName);
                    }
                  } else if (previous.Achieved && achievements[i].Achieved) {
                    debug.log('Already unlocked:' + ach.displayName);
                    if (previous.UnlockTime > 0 && previous.UnlockTime != achievements[i].UnlockTime)
                      achievements[i].UnlockTime = previous.UnlockTime;
                  } else if (!achievements[i].Achieved && achievements[i].MaxProgress > 0 && +previous.CurProgress < +achievements[i].CurProgress) {
                    debug.log('Progress update:' + ach.displayName);
                    if (self.options.notification.notifyOnProgress)
                      await notify(
                        {
                          appid: game.appid,
                          source: game.source,
                          gameDisplayName: game.name,
                          achievementName: ach.name,
                          achievementDisplayName: ach.displayName,
                          achievementDescription: ach.description,
                          icon: ach.icongray,
                          progress: {
                            current: achievements[i].CurProgress,
                            max: achievements[i].MaxProgress,
                          },
                        },
                        {
                          notify: self.options.notification.notify,
                          transport: {
                            toast: self.options.notification_transport.toast,
                            gntp: self.options.notification_transport.gntp,
                            websocket: self.options.notification_transport.websocket,
                            chromium: self.options.notification_transport.chromium,
                          },
                          toast: {
                            appid: self.toastID,
                            winrt: self.options.notification_transport.winRT,
                            balloonFallback: self.options.notification_transport.balloon,
                            customAudio: '0',
                            imageIntegration: self.options.notification_toast.toastSouvenir,
                            group: self.options.notification_toast.groupToast,
                          },
                          prefetch: self.options.notification_advanced.iconPrefetch,
                          souvenir: {
                            screenshot: false,
                            video: 0,
                          },
                          rumble: false,
                        }
                      );
                  }
                } catch (err) {
                  if (err === 'ACH_NOT_FOUND_IN_SCHEMA') {
                    debug.warn(
                      `${
                        achievements[i].crc ? `${achievements[i].crc} (CRC32)` : `${achievements[i].name}`
                      } not found in game schema data ?! ... Achievement was probably deleted or renamed over time > SKIPPING`
                    );
                  } else {
                    debug.error(`Unexpected Error for achievement "${achievements[i].name}": ${err}`);
                  }
                }
              }
            }
            track.save(appID, source, achievements);
          }
        } else {
          debug.warn(`game's process "${game.binary}" not running`);
        }
      } catch (err) {
        debug.warn(err);
      }
    });
  },
  watch_lumaPlay: async function () {
    return;
    let self = this;
    debug.log(`watching changes in LumaPlay`);
    const BASE_PATH = 'SOFTWARE\\LumaPlay';
    const HIVE = reg.HKEY.HKEY_CURRENT_USER;
    const baseKey = reg.openKey(HIVE, BASE_PATH, reg.Access.ALL_ACCESS);

    // Watch for changes under SOFTWARE\LumaPlay
    this.luma_keys.push(baseKey);
    reg.watch(baseKey, (change) => {
      console.log('Registry change detected at LumaPlay');

      // enumerate subkeys
      const userKeys = reg.subKeys(baseKey);
      userKeys.forEach((userId) => {
        const userKey = reg.openKey(HIVE, `${BASE_PATH}\\${userId}`, reg.Access.ALL_ACCESS);
        const gameKeys = reg.subKeys(userKey);

        gameKeys.forEach((gameId) => {
          const gamePath = `${BASE_PATH}\\${userId}\\${gameId}\\Achievements`;
          try {
            const gameKey = reg.openKey(HIVE, gamePath, reg.Access.ALL_ACCESS);
            const values = reg.values(gameKey);

            const dwordValues = values
              .filter((v) => v.type === 'REG_DWORD')
              .reduce((acc, v) => {
                acc[v.name] = v.value;
                return acc;
              }, {});

            //update achievements.json (cached file in aw folder luma_cache)
            const folderPath = path.join(process.cwd(), gameId);
            if (!fs.existsSync(folderPath)) {
              fs.mkdirSync(folderPath, { recursive: true });
            }

            const jsonFile = path.join(folderPath, 'achievements.json');
            let existingData = {};

            if (fs.existsSync(jsonFile)) {
              try {
                existingData = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));
              } catch {
                existingData = {};
              }
            }

            const newKeys = [];
            for (const key of Object.keys(dwordValues)) {
              if (!(key in existingData)) {
                existingData[key] = {
                  earned: true,
                  earned_time: Math.floor(Date.now() / 1000),
                };
                newKeys.push(key);
              }
            }

            if (newKeys.length) {
              fs.writeFileSync(jsonFile, JSON.stringify(existingData, null, 2), 'utf-8');
              fs.utimesSync(folderPath, new Date(), new Date());
              console.log(`\n${gameId}: ${newKeys.join(', ')}`);
            }
          } catch (err) {
            // ignore if Achievements key doesn’t exist
          }
        });
      });
    });
  },
  stop_lumaPlay: function () {
    for (const key of this.luma_keys) {
      reg.closeKey(key);
    }
    this.luma_keys = [];
  },
  load: async function (appID, source) {
    try {
      let self = this;

      debug.log(`loading schema for ${appID} (${source})`);

      let search = self.cache.find((game) => game.appid == appID);
      let game;

      if (search) {
        game = search;
        debug.log('from memory cache');
      } else {
        switch (source) {
          case 'steam':
            game = await steam.loadSteamData(appID, self.options.achievement.lang, self.options.steam.apiKey);
            break;
          case 'gog':
            game = await gog.loadGogData(appID);
            break;
          case 'epic':
            game = await epic.loadEpicData(appID);
            break;
        }
        self.cache.push(game);
        debug.log('from file cache or remote');
      }

      return game;
    } catch (err) {
      throw err;
    }
  },
};

(async () => {
  try {
    await instance.lock();
    hotkeys = require('node-hotkeys');

    app.start().catch((err) => {
      debug.log(err);
    });

    try {
      websocket();
    } catch (err) {
      debug.error(err);
    }

    playtimeMonitor
      .init()
      .then((monitor) => {
        debug.log('Playtime monitoring activated');

        monitor.on('disable-overlay', () => {
          runningAppid = null;
          SpawnNotification([`--wintype=overlay`, `--appid=0`]);
        });

        monitor.on('enable-overlay', ({ appid, source }) => {
          runningAppid = appid;
          SpawnNotification([`--wintype=overlay`, `--appid=${appid}`, `--source=${source || 'steam'}`, `--description=fetch`]);
        });

        monitor.on('fetch-data', ({ appid, source }) => {
          runningAppid = appid;
          SpawnNotification([`--wintype=data`, `--appid=${appid}`, `--source=${source}`]);
        });

        monitor.on('notify', async ([game, time]) => {
          if (time) {
            let gameIndex = runningGames.findIndex((g) => g.appid === game.appid);
            if (gameIndex !== -1) runningGames.splice(gameIndex, 1);
          } else {
            runningGames.push(game);
            recordGame(game);
            await setRecordPath(userShellFolder['myvideo']);
            await setRecordResolution();
          }
          if (app.options.notification.playtime) {
            notify(
              {
                appid: game.appid,
                source: game.source,
                gameDisplayName: game.name,
                achievementDisplayName: game.name,
                achievementDescription: time ? time : 'Tracking playtime',
                icon: `https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/${game.appid}/${game.icon}.jpg`,
                image: `https://cdn.cloudflare.steamstatic.com/steam/apps/${game.appid}/header.jpg`,
              },
              {
                notify: app.options.notification.notify,
                transport: {
                  toast: app.options.notification_transport.toast,
                  gntp: app.options.notification_transport.gntp,
                  websocket: false,
                  chromium: app.options.notification_transport.chromium,
                },
                toast: {
                  appid: app.toastID,
                  winrt: app.options.notification_transport.winRT,
                  balloonFallback: app.options.notification_transport.balloon,
                  customAudio: '0',
                  imageIntegration: '1',
                  group: app.options.notification_toast.groupToast,
                  cropIcon: true,
                  attribution: 'Achievement Watcher',
                },
                gntpLabel: 'Playtime',
                prefetch: app.options.notification_advanced.iconPrefetch,
                souvenir: {
                  screenshot: false,
                  video: 0,
                },
                rumble: false,
              }
            );
          }
        });
      })
      .catch((err) => {
        debug.error(err);
      });
  } catch (err) {
    debug.error(err);
    process.exit();
  }
})();
