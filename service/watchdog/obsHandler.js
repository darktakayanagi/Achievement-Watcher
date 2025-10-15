const { execSync, spawn } = require('child_process');
const OBSWebSocket = require('obs-websocket-js').OBSWebSocket;
const obs = new OBSWebSocket();
const fs = require('fs');
const path = require('path');
const os = require('os');
const debug = require('./util/log.js');

const obs_path = path.join(process.env.APPDATA, 'obs-studio');
const crash_file = path.join(obs_path, 'safe_mode');
const settings_file = path.join(obs_path, 'plugin_config/obs-websocket', 'config.json');
let config;
let latestReplay;
let saveDir;
let obsCheckInterval = null;
let isEnabled = false;

obs.on('ConnectionOpened', () => {
  obs.connected = true;
});

obs.on('ConnectionClosed', () => {
  obs.connected = false;
});

obs.on('ReplayBufferSaved', async () => {
  await moveLatestReplay();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function switchProfileAndSceneCollection() {
  await startObs();
  const p = await obs.call('GetProfileList');
  if (p.currentProfileName !== 'AW') await obs.call('SetCurrentProfile', { profileName: 'AW' });
  const s = await obs.call('GetSceneCollectionList');
  if (s.currentSceneCollectionName !== 'AW') await obs.call('SetCurrentSceneCollection', { sceneCollectionName: 'AW' });
}

function watchObs() {
  if (obsCheckInterval !== null) return;
  obsCheckInterval = setInterval(() => {
    if (isRunning()) {
      connectToObs();
      return;
    }
    startObs();
  }, 30000);
}

async function connectToObs() {
  const maxRetries = 6;
  let attempt = 0;
  if (obs.connected) return;

  while (attempt < maxRetries) {
    try {
      if (!obs.connected) {
        const address = 'ws://127.0.0.1:' + config.server_port;
        const password = config.server_password;

        if (config.auth_required) {
          await obs.connect(address, password);
        } else {
          await obs.connect(address);
        }
      }

      await sleep(5000); // wait a bit after connecting
      await switchProfileAndSceneCollection();
      const { outputActive } = await obs.call('GetReplayBufferStatus');
      if (!outputActive) await obs.call('StartReplayBuffer');

      debug.log('Connected to OBS');
      return; // success! exit the function
    } catch (e) {
      attempt++;
      if (e.code === 'ECONNREFUSED') {
        debug.log(`Attempt ${attempt}/${maxRetries}: OBS not ready or connection refused.`);
      } else {
        debug.error(`Attempt ${attempt}/${maxRetries}:`, e);
      }

      if (attempt < maxRetries) {
        await sleep(5000); // wait before retrying
      } else {
        debug.error('Failed to connect to OBS after 6 attempts. Restarting OBS');
        startObs(true);
      }
    }
  }
}

function deleteCrashFile() {
  if (fs.existsSync(crash_file)) {
    fs.unlinkSync(crash_file);
  }
}

function checkSettings() {
  // Read the simpler file
  try {
    config = JSON.parse(fs.readFileSync(settings_file, 'utf-8'));
    if (config.server_enabled && !config.first_load) return;
    if (!config.server_enabled) config.server_enabled = true;
    if (config.first_load) config.first_load = false;
    fs.writeFileSync(settings_file, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('Error reading the JSON file:', err);
    config = {
      alerts_enabled: false,
      auth_required: false,
      first_load: false,
      server_enabled: true,
      server_password: '1YaL7BmRn9Ec9lLZ',
      server_port: 4455,
    };
    fs.writeFileSync(settings_file, JSON.stringify(config, null, 2), 'utf8');
  }
}

function isRunning() {
  try {
    const output = execSync('tasklist');
    return output.toString().toLowerCase().includes('obs64.exe');
  } catch (err) {
    debug.error('Error checking running processes:', err);
    obs.connected = false;
    return false;
  }
}

async function recordGame(game) {
  await startObs();

  let window = '' + game.name.replace(/:/g, '') + ':AWwatchdog:' + game.binary; //title:something:exe;
  await obs.call('SetInputSettings', {
    inputName: 'AW game capture', // your source name in OBS
    inputSettings: {
      window,
    },
    overlay: true,
  });
  await sleep(500);

  const { windowManager } = require('node-window-manager');
  const primary = windowManager.getPrimaryMonitor();
  const width = primary.getBounds().width;
  const height = primary.getBounds().height;
  const t = { sceneItemTransform: {} };
  t.sceneItemTransform = {};
  t.sceneItemTransform.positionX = 0;
  t.sceneItemTransform.positionY = 0;
  t.sceneItemTransform.boundsType = 'OBS_BOUNDS_STRETCH';
  t.sceneItemTransform.width = width;
  t.sceneItemTransform.height = height;
  t.sceneItemTransform.sourceHeight = height;
  t.sceneItemTransform.sourceWidth = width;
  t.sceneItemTransform.scaleX = 1;
  t.sceneItemTransform.scaleY = 1;
  t.sceneItemTransform.boundsWidth = width;
  t.sceneItemTransform.boundsHeight = height;
  await sleep(5000);
  const gameDisplayID = await obs.call('GetSceneItemId', { sceneName: 'AW', sourceName: 'AW game capture' });
  const a = await obs.call('GetSceneItemTransform', { sceneName: 'AW', sceneItemId: gameDisplayID.sceneItemId });
  await obs.call('SetSceneItemTransform', { sceneName: 'AW', sceneItemId: gameDisplayID.sceneItemId, sceneItemTransform: t.sceneItemTransform });
  //debug.log(`attached OBS to ${game.name}'s window (${png.width}x${png.height})`);
}

function enableObs(state = true) {
  isEnabled = state;
}

async function startObs(kill = false) {
  if (!isEnabled) return;
  checkSettings();

  while (true) {
    if (isRunning()) {
      if (!kill) break;
      try {
        execSync('taskkill /IM obs64.exe /F');
      } catch (e) {
        execSync('wmic process where "name=\'obs64.exe\'" delete');
      }
    }
    deleteCrashFile();

    const obs = spawn(path.join(__dirname, '../nw/nw.exe'), ['-config', 'obs.json'], {
      cwd: path.join(__dirname, '../nw/'),
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    obs.unref(); // Let it run independently
    debug.log('Started OBS minimized.');
    break;
  }
  await sleep(2000);
  await connectToObs();
  watchObs();
}

async function setRecordPath(dir) {
  if (!isEnabled) return;
  await sleep(1000);
  if (!obs.connected) await connectToObs();
  const r = await obs.call('SetRecordDirectory', { recordDirectory: dir });
}

async function setRecordResolution() {
  if (!isEnabled) return;
  await startObs();
  try {
    const { windowManager } = require('node-window-manager');
    const displays = windowManager.getMonitors();
    const primary = windowManager.getPrimaryMonitor();
    const width = primary.getBounds().width;
    const height = primary.getBounds().height;
    const displayID = await obs.call('GetSceneItemId', { sceneName: 'AW', sourceName: 'AW display capture' });
    const outputActive = await obs.call('GetReplayBufferStatus');
    if (outputActive) {
      await obs.call('StopReplayBuffer');
    }
    while (true) {
      const s = await obs.call('GetOutputList');
      if (!s.outputs[0].outputActive && !s.outputs[1].outputActive && !s.outputs[2].outputActive) break;
      await sleep(500);
    }
    await obs.call('SetVideoSettings', { baseWidth: width, baseHeight: height, outputHeight: height, outputWidth: width });
    await obs.call('SetInputSettings', {
      inputName: 'AW display capture',
      inputSettings: { monitor: displays.findIndex((d) => d.id === primary.id) },
    });
    let t = {};
    t.positionX = 0;
    t.positionY = 0;
    t.boundsType = 'OBS_BOUNDS_NONE';
    t.width = width;
    t.height = height;
    t.sourceHeight = height;
    t.sourceWidth = width;
    t.scaleX = 1;
    t.scaleY = 1;

    await obs.call('SetSceneItemTransform', { sceneName: 'AW', sceneItemId: displayID.sceneItemId, sceneItemTransform: t });
    await obs.call('StartReplayBuffer');
    debug.log('OBS settings initialized');
  } catch (e) {
    debug.warn(e);
    await obs.call('StartReplayBuffer');
  }
}

// Save the replay buffer
async function saveReplay() {
  if (!isEnabled) return;
  try {
    if (!(await obs.call('GetReplayBufferStatus'))) await obs.call('StartReplayBuffer');
    await obs.call('SaveReplayBuffer');
  } catch (e) {
    debug.error(e);
  }
}

async function moveLatestReplay() {
  if (!isEnabled) return;
  const result = await obs.call('GetLastReplayBufferReplay');
  latestReplay = result.savedReplayPath;
  if (!fs.existsSync(latestReplay)) return console.log('❌ No replay file found');
  fs.mkdirSync(path.dirname(saveDir), { recursive: true });
  fs.renameSync(latestReplay, saveDir);
  debug.log(`📁 Replay moved to: ${saveDir}`);
}

async function takeScreenshot(dir, overwrite = false, delay = 0) {
  if (!isEnabled) return;
  try {
    if (fs.existsSync(dir)) {
      if (!overwrite) return true;
      fs.unlinkSync(dir);
    }
    if (!fs.existsSync(dir)) fs.mkdirSync(path.dirname(dir), { recursive: true });
    await sleep(delay);
    await obs.call('SaveSourceScreenshot', {
      sourceName: 'AW',
      imageFormat: 'png',
      imageFilePath: dir,
    });
    return true;
  } catch (err) {
    debug.log(err);
    return false;
  }
}

module.exports = {
  enableObs,
  startObs,
  connectToObs,
  recordGame,
  setRecordPath,
  setRecordResolution,
  takeScreenshot,
  saveAndMoveReplay: async function (dir) {
    await sleep(2000);
    await saveReplay();
    saveDir = dir;
    //await sleep(10000);
    //await moveLatestReplay(dir);
  },
};
