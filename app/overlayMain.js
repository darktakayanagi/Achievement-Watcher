const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ini = require('ini');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const CRC32 = require('crc-32');
const { copyFolderOnce } = require('./utils/fileCopy');
const {
  defaultSoundsFolder,
  defaultPresetsFolder,
  userSoundsFolder,
  userPresetsFolder,
  preferencesPath,
  configsDir,
  cacheDir,
} = require('./utils/paths');
const { startPlaytimeLogWatcher } = require('./playtime-log-watcher');

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
const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

function sendConsoleMessageToUI(message, color) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('notify', { message, color });
  }
}

console.log = (...args) => {
  originalConsole.log(...args);
  sendConsoleMessageToUI(args.join(' '), '#4CAF50');
};

console.info = (...args) => {
  originalConsole.info(...args);
  sendConsoleMessageToUI(args.join(' '), '#2196F3');
};

console.warn = (...args) => {
  originalConsole.warn(...args);
  sendConsoleMessageToUI(args.join(' '), '#FFC107');
};

console.error = (...args) => {
  originalConsole.error(...args);
  sendConsoleMessageToUI(args.join(' '), '#f44336');
};

if (!fs.existsSync(configsDir)) {
  fs.mkdirSync(configsDir, { recursive: true });
}
let selectedLanguage = 'english';
let manualLaunchInProgress = false;

ipcMain.handle('save-preferences', async (event, newPrefs) => {
  let currentPrefs = {};

  try {
    if (fs.existsSync(preferencesPath)) {
      currentPrefs = JSON.parse(fs.readFileSync(preferencesPath, 'utf-8'));
    }
  } catch (err) {
    notifyError('❌ Error reading existing preferences: ' + err.message);
  }

  const mergedPrefs = { ...currentPrefs, ...newPrefs };

  if (mergedPrefs.language) {
    selectedLanguage = mergedPrefs.language;
  }
  if ('disableProgress' in newPrefs) {
    global.disableProgress = newPrefs.disableProgress;
  }
  try {
    fs.writeFileSync(preferencesPath, JSON.stringify(mergedPrefs, null, 2));
  } catch (err) {
    notifyError('Error writing merged preferences: ' + err.message);
  }
});

ipcMain.on('set-zoom', (event, zoomFactor) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.setZoomFactor(zoomFactor);

    try {
      const currentPrefs = fs.existsSync(preferencesPath) ? JSON.parse(fs.readFileSync(preferencesPath, 'utf-8')) : {};
      const newPrefs = { ...currentPrefs, windowZoomFactor: zoomFactor };
      fs.writeFileSync(preferencesPath, JSON.stringify(newPrefs, null, 2));
    } catch (err) {
      notifyError('❌ Failed to save zoom preference: ' + err.message);
    }
  }
});

function waitForFile(filePath, callback, interval = 1000) {
  const checkFile = () => {
    if (fs.existsSync(filePath)) {
      callback();
    } else {
      setTimeout(checkFile, interval);
    }
  };
  checkFile();
}

ipcMain.handle('load-preferences', () => {
  if (fs.existsSync(preferencesPath)) {
    return JSON.parse(fs.readFileSync(preferencesPath));
  } else {
    return {};
  }
});

ipcMain.handle('get-sound-files', () => {
  if (!fs.existsSync(userSoundsFolder)) return [];
  const files = fs.readdirSync(userSoundsFolder).filter((file) => file.endsWith('.wav'));
  return files;
});

ipcMain.handle('get-sound-path', (event, fileName) => {
  const fullPath = path.join(app.getPath('userData'), 'sounds', fileName);
  return `file://${fullPath.replace(/\\/g, '/')}`;
});

// List existing configs
function listConfigs() {
  const files = fs.readdirSync(configsDir);
  return files.filter((file) => file.endsWith('.json')).map((file) => file.replace('.json', ''));
}

// Handler for config saving
ipcMain.handle('saveConfig', (event, config) => {
  const configPath = path.join(configsDir, `${config.name}.json`);

  if (!fs.existsSync(configsDir)) {
    fs.mkdirSync(configsDir, { recursive: true });
  }

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
    return { success: true, message: 'Configuration saved successfully!' };
  } catch (error) {
    return { success: false, message: 'Error saving configuration!' };
  }
});

// Handler for config load
ipcMain.handle('loadConfigs', () => {
  const configFiles = fs.readdirSync(configsDir).filter((file) => file.endsWith('.json'));
  const configs = configFiles.map((file) => path.basename(file, '.json'));
  return configs;
});

// Handler for folder load
ipcMain.handle('selectFolder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });
  if (!result.canceled) {
    return result.filePaths[0];
  }
  return null;
});

// Handler for json load
ipcMain.handle('load-achievements', async (event, configName) => {
  try {
    const configPath = path.join(process.env.APPDATA, 'Achievements', 'configs', `${configName}.json`);
    const configData = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configData);

    const achievementsFilePath = path.join(config.config_path, 'achievements.json');

    const achievementsData = fs.readFileSync(achievementsFilePath, 'utf-8');
    const achievements = JSON.parse(achievementsData);

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

function waitForFile(filePath, timeout = 30000, interval = 1000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const checkFile = () => {
      if (fs.existsSync(filePath)) {
        resolve();
      } else if (Date.now() - startTime >= timeout) {
        reject(new Error(`Timeout: File ${filePath} was not found in ${timeout / 1000} seconds.`));
      } else {
        setTimeout(checkFile, interval);
      }
    };
    checkFile();
  });
}

function buildCrcNameMap(achievements) {
  const map = {};
  for (const ach of achievements) {
    if (ach.name) {
      const crc = CRC32.str(ach.name) >>> 0;
      const hexCrc = crc.toString(16).padStart(8, '0');
      map[hexCrc.toLowerCase()] = ach;
    }
  }
  return map;
}

// Handler for config deletion
ipcMain.handle('delete-config', async (event, configName) => {
  try {
    const configPath = path.join(process.env.APPDATA, 'Achievements', 'configs', `${configName}.json`);

    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
      return { success: true };
    } else {
      return { success: false, error: 'File not found.' };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.on('set-animation-duration', (event, duration) => {
  global.animationDuration = Number(duration);
});

function getPresetAnimationDuration(presetFolder) {
  const presetIndexPath = path.join(presetFolder, 'index.html');
  try {
    const content = fs.readFileSync(presetIndexPath, 'utf-8');
    const durationMatch = content.match(/<meta\s+name="duration"\s+content="(\d+)"\s*\/>/i);
    if (durationMatch && !isNaN(durationMatch[1])) {
      const duration = parseInt(durationMatch[1], 10);
      return duration;
    }
  } catch (error) {
    notifyError('Error reading animation duration from preset:' + error.message);
  }
  return 5000; // fallback default
}

function getUserPreferredSound() {
  try {
    const prefs = fs.existsSync(preferencesPath) ? JSON.parse(fs.readFileSync(preferencesPath, 'utf8')) : {};
    return prefs.sound || null;
  } catch (err) {
    console.warn('Could not load sound preference:', err);
    return null;
  }
}

let mainWindow;
let achievementsFilePath; // achievements.json path
let currentConfigPath;
let previousAchievements = {};

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 800,
    frame: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 10, y: 10 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile('index.html');
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.setZoomFactor(1);
  });
}

function getPresetDimensions(presetFolder) {
  const presetIndexPath = path.join(presetFolder, 'index.html');
  try {
    const content = fs.readFileSync(presetIndexPath, 'utf-8');
    const metaRegex = /<meta\s+width\s*=\s*"(\d+)"\s+height\s*=\s*"(\d+)"\s*\/?>/i;
    const match = content.match(metaRegex);
    if (match) {
      return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
    }
  } catch (error) {
    notifyError('Error reading preset: ' + error.message);
  }
  // Default values if not defined
  return { width: 400, height: 200 };
}

function createNotificationWindow(message) {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  const preset = message.preset || 'default';
  const presetFolder = path.join(userPresetsFolder, preset);
  const presetHtml = path.join(presetFolder, 'index.html');
  const position = message.position || 'center-bottom';
  const scale = parseFloat(message.scale || 1);

  const { width: windowWidth, height: windowHeight } = getPresetDimensions(presetFolder);

  const scaledWidth = windowWidth;
  const scaledHeight = windowHeight;

  let x = 0,
    y = 0;

  switch (position) {
    case 'center-top':
      x = Math.floor((width - scaledWidth) / 2);
      y = 5;
      break;
    case 'top-right':
      x = width - scaledWidth - Math.round(20 * scale);
      y = 5;
      break;
    case 'bottom-right':
      x = width - scaledWidth - Math.round(20 * scale);
      y = height - Math.floor(scaledHeight * scale) - 40;
      break;
    case 'top-left':
      x = Math.round(20 * scale);
      y = 5;
      break;
    case 'bottom-left':
      x = Math.round(20 * scale);
      y = height - Math.floor(scaledHeight * scale) - 40;
      break;
    case 'center-bottom':
    default:
      x = Math.floor((width - scaledWidth) / 2);
      y = height - Math.floor(scaledHeight * scale) - 40;
      break;
  }

  const notificationWindow = new BrowserWindow({
    width: scaledWidth,
    height: scaledHeight,
    x,
    y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    type: 'notification',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  notificationWindow.setAlwaysOnTop(true, 'screen-saver');
  notificationWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  notificationWindow.setFullScreenable(false);
  notificationWindow.setFocusable(false);

  notificationWindow.loadFile(presetHtml);

  notificationWindow.webContents.on('did-finish-load', () => {
    notificationWindow.webContents.send('show-notification', {
      displayName: message.displayName,
      description: message.description,
      iconPath: `${message.config_path}\\${message.icon}`,
      scale,
    });
  });

  return notificationWindow;
}

function getSafeLocalizedText(input, lang = 'english') {
  if (input === null || input === undefined) return 'Hidden';

  if (typeof input === 'string') {
    return input.trim() !== '' ? input.trim() : 'Hidden';
  }

  if (typeof input === 'object') {
    return input[lang] || input.english || Object.values(input).find((v) => typeof v === 'string' && v.trim() !== '') || 'Hidden';
  }

  return 'Hidden';
}

ipcMain.on('show-notification', (event, achievement) => {
  const displayName = getSafeLocalizedText(achievement.displayName, selectedLanguage);
  const descriptionText = getSafeLocalizedText(achievement.description, selectedLanguage);

  if (displayName && descriptionText) {
    const notificationData = {
      displayName,
      description: descriptionText,
      icon: achievement.icon,
      icon_gray: achievement.icon_gray || achievement.icongray,
      config_path: achievement.config_path,
      preset: achievement.preset,
      position: achievement.position,
      sound: achievement.sound,
    };

    queueAchievementNotification(notificationData);

    const achName = achievement.name;
    if (achName) {
      if (!previousAchievements) previousAchievements = {};
      previousAchievements[achName] = {
        earned: true,
        progress: achievement.progress || undefined,
        max_progress: achievement.max_progress || undefined,
        earned_time: Date.now(),
      };
      if (selectedConfig) {
        savePreviousAchievements(selectedConfig, previousAchievements);
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('refresh-achievements-table', selectedConfig);
    }
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('load-overlay-data', selectedConfig);
      overlayWindow.webContents.send('set-language', selectedLanguage);
    }
  } else {
    notifyError('Achievement syntax not correct:', achievement);
  }
});

ipcMain.handle('load-presets', async () => {
  if (!fs.existsSync(userPresetsFolder)) return [];

  const presetsJsonPath = path.join(userPresetsFolder, 'presets.json');
  try {
    if (fs.existsSync(presetsJsonPath)) {
      const data = fs.readFileSync(presetsJsonPath, 'utf-8');
      const parsed = JSON.parse(data);
      return parsed.presets;
    } else {
      const dirs = fs
        .readdirSync(userPresetsFolder, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name);
      return dirs;
    }
  } catch (error) {
    notifyError('Error reading presets:' + error.message);
    return [];
  }
});

const earnedNotificationQueue = [];
let isNotificationShowing = false;
let selectedNotificationScale = 1;

function queueAchievementNotification(achievement) {
  const prefs = fs.existsSync(preferencesPath) ? JSON.parse(fs.readFileSync(preferencesPath, 'utf8')) : {};

  achievement.scale = prefs.notificationScale || 1;
  const lang = selectedLanguage || 'english';

  const displayName = getSafeLocalizedText(achievement.displayName, lang);
  const description = getSafeLocalizedText(achievement.description, lang);

  const notificationData = {
    displayName: displayName || '',
    description: description || '',
    icon: achievement.icon,
    icon_gray: achievement.icon_gray || achievement.icongray,
    config_path: achievement.config_path,
    preset: achievement.preset,
    position: achievement.position,
    sound: achievement.sound,
    scale: parseFloat(achievement.scale || 1),
  };

  earnedNotificationQueue.push(notificationData);
  processNextNotification();
}

function processNextNotification() {
  if (isNotificationShowing || earnedNotificationQueue.length === 0) return;

  const achievement = earnedNotificationQueue.shift();
  isNotificationShowing = true;

  const lang = selectedLanguage || 'english';

  const notificationData = {
    displayName: achievement.displayName,
    description: achievement.description,
    icon: achievement.icon,
    icon_gray: achievement.icon_gray,
    config_path: achievement.config_path,
    preset: achievement.preset,
    position: achievement.position,
    sound: achievement.sound,
    scale: parseFloat(achievement.scale || 1),
  };

  const presetFolder = path.join(__dirname, 'presets', achievement.preset || 'default');
  const duration = getPresetAnimationDuration(presetFolder);
  const notificationWindow = createNotificationWindow(notificationData);

  if (mainWindow && !mainWindow.isDestroyed() && achievement.sound && achievement.sound !== 'mute') {
    mainWindow.webContents.send('play-sound', achievement.sound);
  }

  notificationWindow.on('closed', () => {
    isNotificationShowing = false;
    processNextNotification();
  });

  setTimeout(() => {
    if (!notificationWindow.isDestroyed()) {
      notificationWindow.close();
    }
  }, duration);
}

let currentAchievementsFilePath = null;
let achievementsWatcher = null;

if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}

function getCachePath(configName) {
  return path.join(cacheDir, `${configName}_achievements_cache.json`);
}

function loadPreviousAchievements(configName) {
  const cachePath = getCachePath(configName);
  if (fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch (e) {
      notifyError('Error reading achievement cache: ' + e.message);
    }
  }
  return {};
}

function savePreviousAchievements(configName, data) {
  const cachePath = getCachePath(configName);
  try {
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
  } catch (e) {
    notifyError('Error reading achievement cache: ' + e.message);
  }
}

function loadAchievementsFromSaveFile(saveDir) {
  const jsonPath = path.join(saveDir, 'achievements.json');
  const iniPath = path.join(saveDir, 'achievements.ini');
  const binPath = path.join(saveDir, 'stats.bin');
  if (fs.existsSync(jsonPath)) {
    try {
      const raw = fs.readFileSync(jsonPath, 'utf8');
      const data = JSON.parse(raw);

      if (!Array.isArray(data)) {
        return data;
      }

      const converted = {};
      for (const item of data) {
        if (item.name) {
          converted[item.name] = {
            earned: item.achieved === true,
            earned_time: item.UnlockTime || 0,
          };
        }
      }
      return converted;
    } catch (e) {
      notifyError('❌ Error JSON: ' + e.message);
      return {};
    }
  } else if (fs.existsSync(iniPath)) {
    try {
      const iniData = fs.readFileSync(iniPath, 'utf8');
      const parsed = ini.parse(iniData);
      const converted = {};

      for (const key in parsed) {
        const ach = parsed[key];
        converted[key] = {
          earned: ach.Achieved === '1' || ach.Achieved === 1,
          progress: ach.CurProgress ? Number(ach.CurProgress) : undefined,
          max_progress: ach.MaxProgress ? Number(ach.MaxProgress) : undefined,
          earned_time: ach.UnlockTime ? Number(ach.UnlockTime) : 0,
        };
      }

      return converted;
    } catch (e) {
      notifyError('❌ Error INI: ' + e.message);
      return {};
    }
  } else {
    if (fs.existsSync(binPath)) {
      try {
        const parseStatsBin = require('./utils/parseStatsBin');
        const raw = parseStatsBin(binPath);
        const converted = {};
        const configJsonPath = fullAchievementsConfigPath;
        let crcMap = {};
        if (fs.existsSync(configJsonPath)) {
          const configJson = JSON.parse(fs.readFileSync(configJsonPath, 'utf8'));
          crcMap = buildCrcNameMap(configJson);
        }

        for (const [crc, item] of Object.entries(raw)) {
          const configEntry = crcMap[crc.toLowerCase()];
          const key = configEntry?.name || crc.toLowerCase();

          converted[key] = {
            earned: item.earned,
            earned_time: item.earned_time,
          };
        }

        return converted;
      } catch (e) {
        notifyError('❌ Error parsing stats.bin: ' + e.message);
        return {};
      }
    } else {
      return {};
    }
  }
}

function monitorAchievementsFile(filePath) {
  if (!filePath) {
    if (achievementsWatcher && currentAchievementsFilePath) {
      fs.unwatchFile(currentAchievementsFilePath, achievementsWatcher);
      achievementsWatcher = null;
    }
    currentAchievementsFilePath = null;
    return;
  }

  if (currentAchievementsFilePath === filePath && achievementsWatcher) {
    return;
  }

  if (achievementsWatcher && currentAchievementsFilePath) {
    fs.unwatchFile(currentAchievementsFilePath, achievementsWatcher);
    achievementsWatcher = null;
  }

  currentAchievementsFilePath = filePath;

  const configName = selectedConfig;
  let previousAchievements = loadPreviousAchievements(configName);
  let isFirstLoad = true;
  let fullConfig = [];
  let crcMap = {};
  try {
    fullConfig = JSON.parse(fs.readFileSync(fullAchievementsConfigPath, 'utf8'));
    crcMap = buildCrcNameMap(fullConfig);
  } catch (e) {
    notifyError('❌ Error reading achievements: ' + e.message);
  }

  achievementsWatcher = (curr, prev) => {
    let currentAchievements = loadAchievementsFromSaveFile(path.dirname(filePath));

    Object.keys(currentAchievements).forEach((key) => {
      const current = currentAchievements[key];
      const previous = previousAchievements[key];
      const lang = selectedLanguage || 'english';
      const newlyEarned = Boolean(current.earned) && (!previous || !Boolean(previous.earned));

      if (newlyEarned) {
        const isBin = path.basename(filePath).endsWith('.bin');
        const achievementConfig = fullConfig.find((a) => a.name === key);

        if (!achievementConfig) {
          console.warn(`Achievement config not found for key: ${key}`);
          return;
        }
        if (achievementConfig) {
          const notificationData = {
            displayName:
              typeof achievementConfig.displayName === 'object'
                ? achievementConfig.displayName[lang] ||
                  achievementConfig.displayName.english ||
                  Object.values(achievementConfig.displayName)[0]
                : achievementConfig.displayName,

            description:
              typeof achievementConfig.description === 'object'
                ? achievementConfig.description[lang] ||
                  achievementConfig.description.english ||
                  Object.values(achievementConfig.description)[0]
                : achievementConfig.description,
            icon: achievementConfig.icon,
            icon_gray: achievementConfig.icon_gray || achievementConfig.icongray,
            config_path: selectedConfigPath,
            preset: selectedPreset,
            position: selectedPosition,
            sound: getUserPreferredSound() || 'mute',
          };

          queueAchievementNotification(notificationData);

          mainWindow.webContents.send('refresh-achievements-table');
          if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.webContents.send('load-overlay-data', selectedConfig);
            overlayWindow.webContents.send('set-language', selectedLanguage);
          }
        }
      }
      const progressChanged =
        (current.earned === false || current.earned === 0) &&
        current.progress !== undefined &&
        (!previous || current.progress !== previous.progress || current.max_progress !== previous.max_progress);

      if (progressChanged) {
        const isBin = path.basename(filePath).endsWith('.bin');
        const achievementConfig = isBin ? crcMap[key.toLowerCase()] : fullConfig.find((a) => a.name == key || a.name == current?.name);

        if (achievementConfig) {
          if (!global.disableProgress) {
            showProgressNotification({
              displayName: getSafeLocalizedText(achievementConfig.displayName, selectedLanguage),
              icon: achievementConfig.icon,
              progress: current.progress,
              max_progress: current.max_progress,
              config_path: selectedConfigPath,
            });

            mainWindow.webContents.send('refresh-achievements-table');
            if (overlayWindow && !overlayWindow.isDestroyed()) {
              overlayWindow.webContents.send('load-overlay-data', selectedConfig);
              overlayWindow.webContents.send('set-language', selectedLanguage);
            }
          }
        }
      }
    });

    previousAchievements = currentAchievements;
    savePreviousAchievements(configName, previousAchievements);
  };

  const checkFileLoop = () => {
    if (fs.existsSync(filePath)) {
      let currentAchievements = loadAchievementsFromSaveFile(path.dirname(filePath));
      const isFirstTime = Object.keys(previousAchievements).length === 0;

      if (isFirstLoad && isFirstTime) {
        const earnedKeys = Object.keys(currentAchievements).filter(
          (key) => currentAchievements[key].earned === true || currentAchievements[key].earned === 1
        );

        if (earnedKeys.length > 0) {
          earnedKeys.forEach((key) => {
            const current = currentAchievements[key];
            const isBin = path.basename(filePath).endsWith('.bin');
            const achievementConfig = fullConfig.find((a) => a.name === key);

            const lang = selectedLanguage || 'english';
            const selectedSound = getUserPreferredSound();
            const displayName = getSafeLocalizedText(achievementConfig?.displayName, lang);
            const description = getSafeLocalizedText(achievementConfig?.description, lang);

            if (achievementConfig) {
              queueAchievementNotification({
                displayName,
                description,
                icon: achievementConfig.icon,
                icon_gray: achievementConfig.icon_gray,
                config_path: selectedConfigPath,
                preset: selectedPreset,
                position: selectedPosition,
                sound: selectedSound || 'mute',
                soundPath: path.join(app.getAppPath(), 'sounds', selectedSound),
              });
              previousAchievements[key] = {
                earned: true,
                earned_time: current.earned_time || Date.now(),
                progress: current.progress,
                max_progress: current.max_progress,
              };
            }
          });
        }
      }

      previousAchievements = currentAchievements;
      savePreviousAchievements(configName, previousAchievements);
      isFirstLoad = false;

      mainWindow.webContents.send('refresh-achievements-table');
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('load-overlay-data', selectedConfig);
        overlayWindow.webContents.send('set-language', selectedLanguage);
      }

      fs.watchFile(filePath, { interval: 1000 }, achievementsWatcher);
    } else {
      const baseDir = path.dirname(filePath);
      const iniPath = path.join(baseDir, 'achievements.ini');
      const binPath = path.join(baseDir, 'stats.bin');

      if (fs.existsSync(iniPath)) {
        monitorAchievementsFile(iniPath);
        return;
      }

      if (fs.existsSync(binPath)) {
        monitorAchievementsFile(binPath);
        return;
      }

      setTimeout(checkFileLoop, 1000);
    }
  };

  checkFileLoop();
}

let fullAchievementsConfigPath;
let selectedConfig = null;
let selectedSound = 'mute';
ipcMain.on('update-config', (event, { configName, preset, position }) => {
  if (!configName) {
    if (achievementsWatcher && achievementsFilePath) {
      fs.unwatchFile(achievementsFilePath, achievementsWatcher);
      achievementsWatcher = null;
    }

    achievementsFilePath = null;
    selectedConfig = null;

    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('load-overlay-data', selectedConfig);
      overlayWindow.webContents.send('set-language', selectedLanguage);
    }

    return;
  }

  const configPath = path.join(process.env.APPDATA, 'Achievements', 'configs', `${configName}.json`);
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    notifyError('Error reading configPath: ' + err.message);
    return;
  }

  const saveDir = path.join(config.save_path, config.appid);
  const jsonPath = path.join(saveDir, 'achievements.json');
  const iniPath = path.join(saveDir, 'achievements.ini');
  const binPath = path.join(saveDir, 'stats.bin');

  if (fs.existsSync(jsonPath)) {
    achievementsFilePath = jsonPath;
  } else if (fs.existsSync(iniPath)) {
    achievementsFilePath = iniPath;
  } else if (fs.existsSync(binPath)) {
    achievementsFilePath = binPath;
  } else {
    achievementsFilePath = jsonPath; // default fallback
  }

  fullAchievementsConfigPath = path.join(config.config_path, 'achievements.json');
  selectedPreset = preset || 'default';
  selectedPosition = position || 'center-bottom';
  selectedConfigPath = config.config_path;
  selectedConfig = configName;
  if (imageWindow && !imageWindow.isDestroyed() && config?.appid) {
    const imageUrl = `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${config.appid}/library_600x900.jpg`;
    imageWindow.webContents.send('update-image', imageUrl);
  }

  monitorAchievementsFile(achievementsFilePath);
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('load-overlay-data', selectedConfig);
    overlayWindow.webContents.send('set-language', selectedLanguage);
  }
});

ipcMain.handle('get-config-by-name', async (event, name) => {
  try {
    const configPath = path.join(configsDir, `${name}.json`);

    if (!fs.existsSync(configPath)) {
      console.warn(`❌ Config not found: ${configPath}`);
      throw new Error('Config not found');
    }

    const data = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    throw err;
  }
});

ipcMain.handle('renameAndSaveConfig', async (event, oldName, newConfig) => {
  const oldConfigPath = path.join(configsDir, `${oldName}.json`);
  const newConfigPath = path.join(configsDir, `${newConfig.name}.json`);

  const oldCachePath = getCachePath(oldName);
  const newCachePath = getCachePath(newConfig.name);

  try {
    if (oldName !== newConfig.name && fs.existsSync(oldConfigPath)) {
      fs.renameSync(oldConfigPath, newConfigPath);
    }
    fs.writeFileSync(newConfigPath, JSON.stringify(newConfig, null, 2));

    if (fs.existsSync(oldCachePath)) {
      fs.renameSync(oldCachePath, newCachePath);
    } else {
    }

    return { success: true, message: `Config "${oldName}" has been renamed and saved.` };
  } catch (error) {
    return { success: false, message: 'Failed to rename and save config.' };
  }
});

ipcMain.on('close-notification-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);

  setTimeout(() => {
    if (win && !win.isDestroyed()) {
      win.close();
    }
  }, global.animationDuration);
});

let overlayWindow = null;

function createOverlayWindow(selectedConfig) {
  const { width, height } = require('electron').screen.getPrimaryDisplay().workAreaSize;

  overlayWindow = new BrowserWindow({
    width: 450,
    height: 800,
    x: width - 470,
    y: 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setFullScreenable(false);
  overlayWindow.setFocusable(false);
  overlayWindow.blur();

  overlayWindow.loadFile('overlay.html');

  overlayWindow.webContents.on('did-finish-load', () => {
    overlayWindow.webContents.send('load-overlay-data', selectedConfig);
    overlayWindow.webContents.send('set-language', selectedLanguage);
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

const { globalShortcut } = require('electron');

app.whenReady().then(async () => {
  try {
    const prefs = fs.existsSync(preferencesPath) ? JSON.parse(fs.readFileSync(preferencesPath, 'utf-8')) : {};

    if (prefs.language) {
      selectedLanguage = prefs.language;
    }
  } catch (err) {
    notifyError('❌ Failed to load language preference: ' + err.message);
  }

  globalShortcut.register('Control+Shift+O', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.close();
      overlayWindow = null;
    } else {
      if (!selectedConfig) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('notify', {
            message: '⚠️ Select first a config!',
            color: '#ff9800',
          });
        }
        return;
      }

      createOverlayWindow(selectedConfig);
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

ipcMain.handle('selectExecutable', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openFile'] });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('launchExecutable', async (event, exePath, argsString) => {
  try {
    const args = argsString.trim().match(/(?:[^\s"]+|"[^"]*")+/g) || [];

    const child = spawn(exePath, args, {
      cwd: path.dirname(exePath),
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        notifyError('❌ File not found: ' + exePath);
      } else if (err.code === 'EACCES') {
        notifyError('❌ Permission denied. Try running the app as administrator or check file permissions.');
      } else {
        notifyError('❌ Failed to launch executable: ' + err.message);
      }
    });
    child.unref();

    if (selectedConfig) {
      const configPath = path.join(configsDir, `${selectedConfig}.json`);
      if (fs.existsSync(configPath)) {
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        manualLaunchInProgress = true;
        detectedConfigName = configData.name;
        startPlaytimeLogWatcher(configData);
      } else {
        notifyError(`❌ Config file not found for: ${selectedConfig}`);
      }
    } else {
      notifyError(`❌ selectedConfig is null – cannot start playtime log watcher.`);
    }
  } catch (err) {
    notifyError('Failed to launch executable: ' + err.message);
  }
});

let imageWindow = null;

function createGameImageWindow(appid) {
  const imageUrl = `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/library_600x900.jpg`;

  if (imageWindow && !imageWindow.isDestroyed()) {
    if (currentAppId === appid) {
      imageWindow.webContents.send('update-image', imageUrl);
      if (!imageWindow.isVisible()) {
        imageWindow.show();
      }
      return;
    }

    currentAppId = appid;
    imageWindow.webContents.send('update-image', imageUrl);
    return;
  }

  const [mainX, mainY] = mainWindow.getPosition();

  imageWindow = new BrowserWindow({
    width: 500,
    height: 800,
    x: mainX - 500,
    y: mainY,
    frame: false,
    alwaysOnTop: false,
    resizable: false,
    show: false,
    parent: mainWindow,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  imageWindow.setFocusable(false);
  imageWindow.loadFile('gameImage.html');

  imageWindow.once('ready-to-show', () => {
    imageWindow.show();
    imageWindow.webContents.send('update-image', imageUrl);
  });

  const updatePosition = () => {
    if (imageWindow && !imageWindow.isDestroyed()) {
      const [x, y] = mainWindow.getPosition();
      const [, height] = mainWindow.getSize();
      imageWindow.setBounds({ x: x - 500, y, width: 500, height });
    }
  };

  mainWindow.on('move', updatePosition);
  mainWindow.on('resize', updatePosition);
  mainWindow.on('unmaximize', updatePosition);
  mainWindow.on('maximize', updatePosition);

  mainWindow.on('minimize', () => {
    if (imageWindow && !imageWindow.isDestroyed()) imageWindow.hide();
  });

  mainWindow.on('restore', () => {
    if (imageWindow && !imageWindow.isDestroyed()) imageWindow.show();
  });

  imageWindow.on('closed', () => {
    imageWindow = null;
  });

  currentAppId = appid;
}

let currentAppId = null;

ipcMain.handle('toggle-image-window', async (event, appid) => {
  const imageUrl = `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/library_600x900.jpg`;

  if (imageWindow && !imageWindow.isDestroyed()) {
    if (currentAppId === appid) {
      if (!imageWindow.isVisible()) {
        imageWindow.show();
      } else {
        imageWindow.focus();
      }
      return { isVisible: true };
    } else {
      currentAppId = appid;
      imageWindow.webContents.send('update-image', imageUrl);
      return { isVisible: true };
    }
  }

  currentAppId = appid;
  createGameImageWindow(appid);
  return { isVisible: true };
});

ipcMain.on('close-image-window', () => {
  if (imageWindow && !imageWindow.isDestroyed()) {
    imageWindow.close();
    imageWindow = null;
  }
});

// Return path to image if exists locally
ipcMain.handle('checkLocalGameImage', async (event, appid) => {
  const imagePath = path.join(app.getPath('userData'), 'images', `${appid}.jpg`);
  try {
    await fs.promises.access(imagePath, fs.constants.F_OK);
    return imagePath;
  } catch {
    return null;
  }
});

// Save image locally from renderer
ipcMain.handle('saveGameImage', async (event, appid, buffer) => {
  try {
    const imageDir = path.join(app.getPath('userData'), 'images');
    if (!fs.existsSync(imageDir)) fs.mkdirSync(imageDir, { recursive: true });
    const fullPath = path.join(imageDir, `${appid}.jpg`);
    fs.writeFileSync(fullPath, Buffer.from(buffer));
    return { success: true, path: fullPath };
  } catch (err) {
    notifyError('❌ Error saving image: ' + err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.on('notify-from-child', (event, msg) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('notify', msg);
  }
});

ipcMain.on('toggle-overlay', (event, selectedConfig) => {
  if (!selectedConfig) {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('load-overlay-data', selectedConfig);
      overlayWindow.webContents.send('set-language', selectedLanguage);
    }
    return;
  }

  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow(selectedConfig);
  } else {
    overlayWindow.webContents.send('load-overlay-data', selectedConfig);
    overlayWindow.webContents.send('set-language', selectedLanguage);
  }
});

ipcMain.on('refresh-ui-after-language-change', (event, { language, configName }) => {
  selectedLanguage = language;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('refresh-achievements-table', configName);
  }

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('load-overlay-data', selectedConfig);
    overlayWindow.webContents.send('set-language', selectedLanguage);
  }
});

function minimizeWindow() {
  if (mainWindow) mainWindow.minimize();
  if (imageWindow && !imageWindow.isDestroyed()) imageWindow.hide();
}

function maximizeWindow() {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
}

function closeWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.close();
  }

  if (imageWindow && !imageWindow.isDestroyed()) {
    imageWindow.close();
  }

  if (playtimeWindow && !playtimeWindow.isDestroyed()) {
    playtimeWindow.webContents.send('start-close-animation');
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
}

ipcMain.on('minimize-window', minimizeWindow);
ipcMain.on('maximize-window', maximizeWindow);
ipcMain.on('close-window', closeWindow);

app.whenReady().then(async () => {
  // Load saved language
  try {
    const prefs = fs.existsSync(preferencesPath) ? JSON.parse(fs.readFileSync(preferencesPath, 'utf-8')) : {};

    if (prefs.language) {
      selectedLanguage = prefs.language;
    }
    global.disableProgress = prefs.disableProgress === true;
  } catch (err) {
    notifyError('❌ Failed to load language preference: ' + err.message);
  }

  copyFolderOnce(defaultSoundsFolder, userSoundsFolder);
  copyFolderOnce(defaultPresetsFolder, userPresetsFolder);

  createMainWindow();
  setInterval(autoSelectRunningGameConfig, 2000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

function showProgressNotification(data) {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const progressWindow = new BrowserWindow({
    width: 350,
    height: 150,
    x: 20,
    y: height - 140,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  progressWindow.setAlwaysOnTop(true, 'screen-saver');
  progressWindow.setVisibleOnAllWorkspaces(true);
  progressWindow.setFullScreenable(false);
  progressWindow.setFocusable(false);
  progressWindow.loadFile('progress.html');

  progressWindow.once('ready-to-show', () => {
    progressWindow.show();
    progressWindow.webContents.send('show-progress', data);
  });

  setTimeout(() => {
    if (!progressWindow.isDestroyed()) progressWindow.close();
  }, 5000);
}
ipcMain.on('disable-progress-check', (event) => {
  event.returnValue = global.disableProgress || false;
});

ipcMain.on('set-disable-progress', (_, value) => {
  global.disableProgress = value;
});

let playtimeWindow = null;
let playtimeAlreadyClosing = false;

function createPlaytimeWindow(playData) {
  if (playtimeWindow && !playtimeWindow.isDestroyed()) {
    if (!playtimeAlreadyClosing) {
      playtimeWindow.webContents.send('start-close-animation');
      playtimeAlreadyClosing = true;
    }
    return;
  }

  const { width: screenWidth } = require('electron').screen.getPrimaryDisplay().workAreaSize;
  const winWidth = 460;
  const winHeight = 340;
  const x = Math.floor((screenWidth - winWidth) / 2);
  const y = 40;

  playtimeWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x,
    y,
    frame: false,
    type: 'notification',
    alwaysOnTop: true,
    transparent: true,
    resizable: false,
    show: false,
    skipTaskbar: true,
    focusable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  playtimeWindow.setIgnoreMouseEvents(true, { forward: true });
  playtimeWindow.setAlwaysOnTop(true, 'screen-saver');
  playtimeWindow.setVisibleOnAllWorkspaces(true);
  playtimeWindow.setFullScreenable(false);
  playtimeWindow.setFocusable(false);
  playtimeWindow.loadFile('playtime.html');

  playtimeWindow.once('ready-to-show', () => {
    if (playtimeWindow && !playtimeWindow.isDestroyed()) {
      playtimeWindow.show();

      const prefs = fs.existsSync(preferencesPath) ? JSON.parse(fs.readFileSync(preferencesPath, 'utf8')) : {};
      const scale = prefs.notificationScale || 1;

      playtimeWindow.webContents.send('show-playtime', {
        ...playData,
        scale,
      });
    }
  });
  ipcMain.once('close-playtime-window', () => {
    if (playtimeWindow && !playtimeWindow.isDestroyed()) {
      playtimeWindow.close();
      playtimeAlreadyClosing = false;
    }
  });

  playtimeWindow.on('closed', () => {
    playtimeWindow = null;
    playtimeAlreadyClosing = false;
  });
}

let detectedConfigName = null;
const { pathToFileURL } = require('url');

async function autoSelectRunningGameConfig() {
  const unpackedPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'utils', 'pslist-wrapper.mjs');
  const wrapperUrl = pathToFileURL(unpackedPath).href;
  const { getProcesses } = await import(wrapperUrl);

  const processes = await getProcesses();
  const logPath = path.join(app.getPath('userData'), 'process-log.txt');
  fs.writeFileSync(logPath, processes.map((p) => p.name).join('\n'), 'utf8');

  if (manualLaunchInProgress) {
    const configPath = path.join(configsDir, `${detectedConfigName}.json`);
    if (!fs.existsSync(configPath)) {
      manualLaunchInProgress = false;
      detectedConfigName = null;
      return;
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const exeName = path.basename(config.process_name || '').toLowerCase();
    const isRunning = processes.some((p) => p.name.toLowerCase() === exeName);

    if (!isRunning) {
      notifyInfo(`${config.name} closed.`);
      manualLaunchInProgress = false;
      detectedConfigName = null;

      if (playtimeWindow && !playtimeWindow.isDestroyed()) {
        playtimeWindow.webContents.send('start-close-animation');
      }
    }
    return;
  }

  try {
    const configs = listConfigs();

    if (detectedConfigName) {
      const configPath = path.join(configsDir, `${detectedConfigName}.json`);
      if (!fs.existsSync(configPath)) {
        detectedConfigName = null;
        return;
      }

      const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const exeName = path.basename(configData.process_name || '').toLowerCase();
      const isStillRunning = processes.some((p) => p.name.toLowerCase() === exeName);

      if (!isStillRunning) {
        notifyInfo(`${configData.name} closed.`);
        detectedConfigName = null;
        return;
      }

      return;
    }

    for (const configName of configs) {
      const configPath = path.join(configsDir, `${configName}.json`);
      if (!fs.existsSync(configPath)) continue;

      const configData = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (!configData.process_name) continue;

      const exeName = path.basename(configData.process_name).toLowerCase();
      const isRunning = processes.some((p) => p.name.toLowerCase() === exeName);

      if (isRunning) {
        detectedConfigName = configName;
        notifyInfo(`${configData.name} started.`);

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('auto-select-config', configName);
          startPlaytimeLogWatcher(configData);
          createGameImageWindow(configData.appid);
        }
        return;
      }
    }
  } catch (err) {
    notifyError('Error in autoSelectRunningGameConfig: ' + err.message);
  }
}

ipcMain.on('show-playtime', (event, playData) => {
  createPlaytimeWindow(playData);
});

const { generateGameConfigs } = require('./utils/auto-config-generator');

ipcMain.handle('generate-auto-configs', async (event, folderPath) => {
  const outputDir = path.join(process.env.APPDATA, 'Achievements', 'configs');

  try {
    await generateGameConfigs(folderPath, outputDir);
    return { success: true, message: 'Configs generated successfully!' };
  } catch (error) {
    console.error('Error generating configs:', error);
    return { success: false, message: error.message };
  }
});

app.on('before-quit', () => {
  manualLaunchInProgress = false;
  if (playtimeWindow && !playtimeWindow.isDestroyed()) {
    playtimeWindow.destroy();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
