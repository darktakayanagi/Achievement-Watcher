'use strict';

const { app, ipcMain, BrowserWindow } = require('electron');
const path = require('path');
const { fetchIcon } = require('../parser/steam');
const { pathToFileURL } = require('url');
const achievementsJS = require(path.join(__dirname, '../parser/achievements.js'));
achievementsJS.initDebug({ isDev: app.isDev || false, userDataPath: app.getPath('userData') });
const settingsJS = require(path.join(__dirname, '../settings.js'));
settingsJS.setUserDataPath(app.getPath('userData'));
const { getSteamUsersList } = require(path.join(__dirname, '../parser/steam.js'));

function notifyError(message) {
  console.error(message);
}

// Handler for renderer process
ipcMain.handle('get-app-name', () => {
  return app.getName();
});
ipcMain.handle('get-user-data-path', () => {
  return app.getPath('userData');
});

ipcMain.on('get-app-name-sync', (event) => {
  event.returnValue = app.getName();
});

ipcMain.on('get-user-data-path-sync', (event) => {
  const t = app.getPath('userData');
  event.returnValue = t;
});

ipcMain.on('get-steam-user-list', async (event) => {
  await getSteamUsersList()
    .then((p) => (event.returnValue = p))
    .catch((err) => (event.returnValue = null));
});

ipcMain.on('fetch-icon', async (event, url, appid) => {
  await fetchIcon(url, appid).then((p) => (event.returnValue = pathToFileURL(p).href));
});

// Handler for json load
ipcMain.handle('load-achievements', async (event, requestedAppid) => {
  try {
    let configJS = await settingsJS.load();
    let ach = await achievementsJS.getAchievementsForAppid(configJS, requestedAppid);

    return { achievements: ach.achievement.list, config_path: '' };
    const configPath = path.join(process.env.APPDATA, 'Achievements', 'configs', `${configName}.json`);
    const configData = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configData);

    const achievementsFilePath = path.join(config.config_path, 'achievements.json');

    const achievementsData = fs.readFileSync(achievementsFilePath, 'utf-8');
    const achievements = JSON.parse(achievementsData);
    //achievements is array with objects like so {hidden, displayname, icon, description, icon_gray, name}
    return { achievements, config_path: config.config_path };
  } catch (error) {
    notifyError('Error reading achievements.json file: ' + error.message);
    if (error.code === 'ENOENT') {
      const webContents = event.sender;
      webContents.send('achievements-missing', configName);
    }

    return { achievements: [], config_path: '' };
  }
});

ipcMain.handle('load-saved-achievements', async (event, configName) => {
  try {
    const configPath = path.join(process.env.APPDATA, 'Achievements', 'configs', `${configName}.json`);
    const configData = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configData);

    const saveDir = path.join(config.save_path, config.appid);
    const achievementsJsonPath = path.join(saveDir, 'achievements.json');
    const achievementsIniPath = path.join(saveDir, 'achievements.ini');
    const achievementsBinPath = path.join(saveDir, 'stats.bin');
    let achievements = {};

    if (fs.existsSync(achievementsJsonPath)) {
      const jsonData = fs.readFileSync(achievementsJsonPath, 'utf-8');
      const parsed = JSON.parse(jsonData);

      if (Array.isArray(parsed)) {
        parsed.forEach((item) => {
          if (item.name) {
            achievements[item.name] = {
              earned: item.achieved === true,
              earned_time: item.UnlockTime || 0,
            };
          }
        });
      } else {
        achievements = parsed;
      }
    } else if (fs.existsSync(achievementsIniPath)) {
      const iniData = fs.readFileSync(achievementsIniPath, 'utf-8');
      const parsedIni = ini.parse(iniData);

      Object.keys(parsedIni).forEach((key) => {
        const item = parsedIni[key];
        achievements[key] = {
          earned: item.Achieved === '1' || item.Achieved === 1,
          progress: item.CurProgress ? Number(item.CurProgress) : undefined,
          max_progress: item.MaxProgress ? Number(item.MaxProgress) : undefined,
          earned_time: item.UnlockTime ? Number(item.UnlockTime) : 0,
        };
      });
    } else if (fs.existsSync(achievementsBinPath)) {
      try {
        const parseStatsBin = require('./utils/parseStatsBin');
        const raw = parseStatsBin(achievementsBinPath);
        const configJsonPath = path.join(config.config_path, 'achievements.json');
        let crcMap = {};

        if (fs.existsSync(configJsonPath)) {
          const configJson = JSON.parse(fs.readFileSync(configJsonPath, 'utf8'));
          crcMap = buildCrcNameMap(configJson);
        }

        Object.entries(raw).forEach(([crc, item]) => {
          const key = crcMap[crc.toLowerCase()]?.name || crc.toLowerCase();
          achievements[key] = {
            earned: item.earned,
            earned_time: item.earned_time,
          };
        });
      } catch (e) {
        notifyError('Error reading stats.bin: ' + e.message);
      }
    }

    return { achievements, save_path: saveDir };
  } catch (error) {
    return { achievements: [], save_path: '', error: error.message };
  }
});

ipcMain.on('close-notification-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);

  if (win && !win.isDestroyed()) {
    win.close();
  }
});

module.exports.window = () => {
  ipcMain.handle('win-close', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win.close();
  });

  ipcMain.handle('win-minimize', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win.minimize();
  });

  ipcMain.handle('win-maximize', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win.isMaximized() ? win.unmaximize() : win.maximize();
  });

  ipcMain.handle('win-isMinimizable', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win.minimizable;
  });

  ipcMain.handle('win-isMaximizable', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win.maximizable;
  });

  ipcMain.handle('win-isFrameless', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win.isFrameless;
  });

  //Sync

  ipcMain.on('win-isDev', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    event.returnValue = win.isDev;
  });
};
