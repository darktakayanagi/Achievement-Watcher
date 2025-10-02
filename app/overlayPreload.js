const { contextBridge, ipcRenderer, webFrame, desktopCapturer, screen } = require('electron');
const args = process.argv.slice(1);
const isDevArg = args.find((arg) => arg.startsWith('--isDev='));
const userDataArg = args.find((arg) => arg.startsWith('--userDataPath='));

const isDev = isDevArg ? isDevArg.split('=')[1] === 'true' : false;
const userDataPath = userDataArg ? userDataArg.split('=')[1] : null;
const achievementsJS = require('./parser/achievements');
achievementsJS.initDebug({ isDev, userDataPath });

contextBridge.exposeInMainWorld('customApi', {
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  maximizeWindow: () => ipcRenderer.send('maximize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
});

ipcRenderer.on('set-window-scale', (event, scale) => {
  webFrame.setZoomFactor(scale);
});
contextBridge.exposeInMainWorld('api', {
  // Config management
  saveConfig: (config) => ipcRenderer.invoke('saveConfig', config),
  loadConfigs: () => ipcRenderer.invoke('loadConfigs'),
  selectFolder: () => ipcRenderer.invoke('selectFolder'),
  deleteConfig: (configName) => ipcRenderer.invoke('delete-config', configName),

  // Notification
  showNotification: (data) => ipcRenderer.send('show-notification', data),
  onNotification: (callback) => ipcRenderer.on('show-notification', (event, data) => callback(data)),
  onNotify: (callback) => ipcRenderer.on('notify', (_, data) => callback(data)),
  notifyMain: (msg) => ipcRenderer.send('notify-from-child', msg),
  once: (channel, callback) => {
    ipcRenderer.once(channel, (_, data) => callback(data));
  },
  disableProgress: (value) => ipcRenderer.send('set-disable-progress', value),
  onAnimationScale: (callback) => ipcRenderer.on('set-animation-scale', callback),

  // Event for receiving a new monitored achievement
  onNewAchievement: (callback) => ipcRenderer.on('new-achievement', (event, data) => callback(data)),
  onRefreshAchievementsTable: (callback) => ipcRenderer.on('refresh-achievements-table', (event, data) => callback(data)),

  // Update the configuration (now uses the 'update-config' event)
  updateConfig: (configData) => ipcRenderer.send('update-config', configData),
  toggleOverlay: (selectedConfig) => ipcRenderer.send('toggle-overlay', selectedConfig),
  onOverlay: (callback) => ipcRenderer.on('show-overlay', (event, config) => callback(config)),
  onSetLanguage: (callback) => ipcRenderer.on('set-language', (event, lang) => callback(lang)),

  // Other functionalities
  savePreferences: (prefs) => ipcRenderer.invoke('save-preferences', prefs),
  loadPreferences: () => ipcRenderer.invoke('load-preferences'),
  getSounds: () => ipcRenderer.invoke('get-sound-files'),
  getSoundFullPath: (fileName) => ipcRenderer.invoke('get-sound-path', fileName),
  onPlaySound: (callback) => ipcRenderer.on('play-sound', (event, sound) => callback(sound)),
  onProgress: (callback) => ipcRenderer.on('show-progress', (event, info) => callback(info)),

  getAchievementsForAppid: (option, appid) => achievementsJS.getAchievementsForAppid(option, appid),
  onProgressUpdate: (callback) => ipcRenderer.on('show-progress', (event, data) => callback(data)),
  closeNotificationWindow: () => ipcRenderer.send('close-notification-window'),
  parseStatsBin: (filePath) => ipcRenderer.invoke('parse-stats-bin', filePath),
  selectFile: () => ipcRenderer.invoke('select-file'),
  getConfigByName: (name) => ipcRenderer.invoke('get-config-by-name', name),
  renameAndSaveConfig: (oldName, config) => ipcRenderer.invoke('renameAndSaveConfig', oldName, config),
  selectExecutable: () => ipcRenderer.invoke('selectExecutable'),
  launchExecutable: (exe, args) => ipcRenderer.invoke('launchExecutable', exe, args),
  onAchievementsMissing: (callback) => ipcRenderer.on('achievements-missing', (e, configName) => callback(configName)),
  openGameImageWindow: (appid) => ipcRenderer.invoke('toggle-image-window', appid),
  checkLocalGameImage: (appid) => ipcRenderer.invoke('checkLocalGameImage', appid),
  saveGameImage: (appid, buffer) => ipcRenderer.invoke('saveGameImage', appid, buffer),
  closeImageWindow: () => ipcRenderer.send('close-image-window'),
  onImageUpdate: (callback) => ipcRenderer.on('update-image', (_, url) => callback(url)),
  on: (channel, callback) => ipcRenderer.on(channel, (_, data) => callback(data)),
  onImageWindowStatus: (callback) => ipcRenderer.on('image-window-status', (event, status) => callback(status)),
  setZoom: (zoomFactor) => ipcRenderer.send('set-zoom', zoomFactor),
  captureScreen: async () => {
    const { width, height } = window.screen;

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
    });

    // Use the first screen (primary display)
    const screenshot = sources[0].thumbnail.toPNG();
    const base64 = screenshot.toString('base64');
    ipcRenderer.send('capture-screen', { image: base64 });
  },

  // language
  refreshUILanguage: (language) => ipcRenderer.send('refresh-ui-after-language-change', language),
  setLanguage: (lang) => {
    window.currentLang = lang;
  },
  setLanguageAndReload: async (language) => {
    await ipcRenderer.invoke('save-preferences', { language });
    ipcRenderer.send('refresh-ui-after-language-change', language);
  },
});

contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: {
    on: (channel, func) => {
      ipcRenderer.on(channel, (event, ...args) => func(...args));
    },
    send: (channel, data) => {
      ipcRenderer.send(channel, data);
    },
  },
});

contextBridge.exposeInMainWorld('autoConfigApi', {
  generateConfigs: (folderPath) => ipcRenderer.invoke('generate-auto-configs', folderPath),
});
