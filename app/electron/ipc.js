'use strict';

const { ipcMain } = require('electron');

let overlayWindow = null;

module.exports = {
  getOverlayWindow: () => overlayWindow,
  setOverlayWindow: (win) => {
    overlayWindow = win;
  },
};

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
