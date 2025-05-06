'use strict';

const { app, ipcMain } = require('electron');
const path = require('path');
const achievementsJS = require(path.join(__dirname, '../parser/achievements.js'));
achievementsJS.initDebug({ isDev: app.isDev || false, userDataPath: app.getPath('userData') });
const settingsJS = require(path.join(__dirname, '../settings.js'));
settingsJS.setUserDataPath(app.getPath('userData'));

//const settings = require(path.join(__dirname, '../settings.js'));
const achievements = require(path.join(__dirname, '../parser/achievements.js'));

let overlayWindow = null;
let mainWindow = null;

/*
achievementsJS.module.exports = {
  getOverlayWindow: () => overlayWindow,
  setOverlayWindow: (win) => {
    overlayWindow = win;
  },
};
*/
function notifyError(message) {
  console.error(message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('notify', { message, color: '#f44336' });
  }
}
function notifyInfo(message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('notify', {
      message,
      color: '#2196f3',
    });
  }
}

function notifyError(message) {
  console.error(message);
}
function notifyInfo(message) {
  console.log(message);
}

// Handler for json load
ipcMain.handle('load-achievements', async (event, configName) => {
  try {
    let userDataPath = app.getPath('userData');
    let configJS = await settingsJS.load();
    await achievementsJS
      .makeList(configJS, (percent) => {})
      .then((list) => {
        if (list) {
        }
      });

    return { achievements: [], config_path: '' };
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

module.exports.window = (win) => {
  ipcMain.handle('win-close', async (event) => {
    win.close();
  });

  ipcMain.handle('win-minimize', async (event) => {
    win.minimize();
  });

  ipcMain.handle('win-maximize', async (event) => {
    win.isMaximized() ? win.unmaximize() : win.maximize();
  });

  ipcMain.handle('win-isMinimizable', async (event) => {
    return win.minimizable;
  });

  ipcMain.handle('win-isMaximizable', async (event) => {
    return win.maximizable;
  });

  ipcMain.handle('win-isFrameless', async (event) => {
    return win.isFrameless;
  });

  //Sync

  ipcMain.on('win-isDev', (event) => {
    event.returnValue = win.isDev;
  });
};
