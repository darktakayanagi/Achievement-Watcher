'use strict';

const appPath = __dirname;
const path = require('path');
const ini = require('@xan105/ini');
const fs = require('fs');
const os = require('os');
const aes = require(path.join(appPath, 'util/aes.js'));
const steamLanguages = require(path.join(appPath, 'locale/steam.json'));

let filename;
module.exports.setUserDataPath = (p) => {
  if (p) filename = path.join(p, 'cfg/options.ini');
};

const optionSchema = {
  general: {
    username: { default: os.userInfo().username || 'User', type: 'string' },
    skippedVersion: { default: 'none', type: 'string' },
    closeToTray: { default: true },
  },
  overlay: {
    position: { default: 'right-top' },
    preset: { default: 'default' },
    hotkey: { default: 'Ctrl+Shift+O' },
    scale: { default: '100', min: '25', max: '200' },
    duration: { default: '100', min: '25', max: '200' },
  },
  achievement: {
    thumbnailPortrait: { default: false },
    showHidden: { default: false },
    mergeDuplicate: { default: true },
    timeMergeRecentFirst: { default: false },
    hideZero: { default: false },
  },
  achievement_source: {
    legitSteam: { default: '0', allowed: ['0', '1', '2'] },
    steamEmu: { default: true },
    greenLuma: { default: true },
    rpcs3: { default: true },
    lumaPlay: { default: true },
    gog: { default: true },
    epic: { default: true },
    importCache: { default: true },
  },
  watchdog: {
    startAtLogin: { default: true },
    keepRunning: { default: true },
  },
  notification: {
    notify: { default: true },
    rumble: { default: true },
    notifyOnProgress: { default: true },
    playtime: { default: false },
  },
  notification_toast: {
    customToastAudio: { default: '1', allowed: ['0', '1', '2'] },
    toastSouvenir: { default: '0', allowed: ['0', '1', '2'] },
    groupToast: { default: false },
  },
  notification_transport: {
    chromium: { default: true },
    toast: { default: true },
    winRT: { default: true },
    balloon: { default: true },
    websocket: { default: true },
    gntp: { default: true },
  },
  notification_advanced: {
    timeTreshold: { default: '10' },
    tick: { default: '600' },
    checkIfProcessIsRunning: { default: true },
    iconPrefetch: { default: true },
  },
  souvenir_screenshot: {
    screenshot: { default: true },
    custom_dir: { default: '' },
    overwrite_image: { default: false },
  },
  souvenir_video: {
    video: { default: '0', allowed: ['0', '1', '2'] },
    codec: { default: '0', allowed: ['0', '1'] },
    colorDepth10bits: { default: false },
    custom_dir: { default: '' },
    overwrite_video: { default: false },
    duration: { default: '20', allowed: ['10', '15', '20', '30', '45'] },
    framerate: { default: '60', allowed: ['30', '60'] },
    cursor: { default: false },
  },
  action: {
    target: { default: '' },
    cwd: { default: '' },
    hide: { default: true },
  },
  steam: {
    main: { default: '0' },
  },
  gog: { useToken: { default: true } },
};

//validate all options and reset invalid options to the default vals
function applySchema(obj, schema) {
  if (!obj || typeof obj !== 'object') obj = {};

  for (const key in schema) {
    const rule = schema[key];

    // Nested object
    if (!('default' in rule)) {
      obj[key] = applySchema(obj[key], rule);
      continue;
    }

    // Missing -> default
    if (!(key in obj)) {
      obj[key] = rule.default;
      continue;
    }

    const val = obj[key];

    // Validate allowed values
    if (rule.allowed && !rule.allowed.includes(val)) {
      obj[key] = rule.default;
      continue;
    }

    // Validate min/max values
    if (rule.min && rule.max && (isNaN(val) || Number(val) < Number(rule.min) || Number(val) > Number(rule.max))) {
      obj[key] = rule.default;
      continue;
    }

    const expectedType = rule.type || typeof rule.default;

    // Wrong type -> default
    if (typeof val !== expectedType) {
      obj[key] = rule.default;
    }
  }

  return obj;
}

module.exports.load = () => {
  let options;
  console.log('Loading settings');
  try {
    options = ini.parse(fs.readFileSync(filename, 'utf8'));
    options = applySchema(options, optionSchema);

    //Language validator

    if (!steamLanguages.some((lang) => lang.api == options.achievement.lang)) {
      try {
        let locale = navigator.language || navigator.userLanguage || 'en';
        options.achievement.lang = steamLanguages.find((lang) => lang.webapi == locale).api;
      } catch (err) {
        options.achievement.lang = 'english';
      }
    }

    //Steam Key

    if (options?.steam?.apiKey) {
      if (options.steam.apiKey.includes(':')) {
        options.steam.apiKey = aes.decrypt(options.steam.apiKey);
      }
    }
  } catch (err) {
    console.log(`failed to load settings: ${err}`);
    options = applySchema({}, optionSchema);

    try {
      let locale = navigator.language || navigator.userLanguage || 'en';
      options.achievement.lang = steamLanguages.find((lang) => lang.webapi == locale).api;
    } catch (err) {
      options.achievement.lang = 'english';
    }
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, ini.stringify(options), 'utf8');
  }

  return options;
};

module.exports.save = (config) => {
  return new Promise((resolve, reject) => {
    let options;
    try {
      options = JSON.parse(JSON.stringify(config)); //deep object copy to prevent modifying reference; We want to encrypt key to file but keep it decrypted in memory.

      if (options?.steam?.apiKey) {
        options.steam.apiKey = aes.encrypt(config.steam.apiKey);
      }
    } catch (err) {
      return reject(err);
    }
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, ini.stringify(options), 'utf8');
    return resolve();
  });
};
