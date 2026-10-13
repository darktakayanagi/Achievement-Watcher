'use strict';

const path = require('path');
const ini = require('@xan105/ini');
const osLocale = require('os-locale');
const fs = require('@xan105/fs');
const steamLang = require('./steam.json');
const aes = require('./util/aes.js');
const os = require('os');

const optionSchema = {
  general: {
    username: { default: os.userInfo().username || 'User', type: 'string' },
    skippedVersion: { default: 'none', type: 'string' },
  },
  overlay: {
    position: { default: 'right-top' },
    preset: { default: 'default' },
    hotkey: { default: 'Ctrl+Shift+O' },
    scale: { default: '100', type: 'number' },
    duration: { default: '100', type: 'number' },
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

    const expectedType = rule.type || typeof rule.default;

    // Wrong type -> default
    if (typeof val !== expectedType) {
      obj[key] = rule.default;
    }
  }

  return obj;
}

module.exports.load = async (cfg_file) => {
  let options = {};

  try {
    options = ini.parse(await fs.readFile(cfg_file, 'utf8'));
    options = applySchema(options, optionSchema);

    if (!steamLang.some((lang) => lang.api == options.achievement.lang)) {
      try {
        let locale = await osLocale();
        locale = locale.replace('_', '-');

        let lang = steamLang.find((lang) => lang.iso == locale);
        if (!lang) {
          lang = steamLang.find((lang) => lang.webapi.startsWith(locale.slice(0, 2)));
        }

        options.achievement.lang = lang.api;
      } catch (err) {
        options.achievement.lang = 'english';
      }
    }

    //Steam Key

    let steamKey;
    if (options.steam) {
      if (options.steam.apiKey) {
        if (options.steam.apiKey.includes(':')) {
          steamKey = aes.decrypt(options.steam.apiKey);
        }
      }
    } else {
      options.steam = {};
    }

    if (steamKey) options.steam.apiKey = steamKey;
  } catch (err) {
    options = applySchema({}, optionSchema);

    try {
      let locale = await osLocale();
      locale = locale.replace('_', '-');

      let lang = steamLang.find((lang) => lang.iso == locale);
      if (!lang) {
        lang = steamLang.find((lang) => lang.webapi.startsWith(locale.slice(0, 2)));
      }

      options.achievement.lang = lang.api;
    } catch (err) {
      options.achievement.lang = 'english';
    }
  }

  return options;
};
