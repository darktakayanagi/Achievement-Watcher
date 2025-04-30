'use strict';

const { app, BrowserWindow, dialog, session, shell, ipcMain } = require('electron');
const remote = require('@electron/remote/main');

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const ipc = require(path.join(__dirname, 'ipc.js'));

try {
  if (app.requestSingleInstanceLock() !== true) app.quit();

  const manifest = require('../package.json');

  if (manifest.config['disable-gpu']) app.disableHardwareAcceleration();
  if (manifest.config.appid) app.setAppUserModelId(manifest.config.appid);

  let MainWin = null;

  app
    .on('ready', function () {
      let options = manifest.config.window;
      options.show = false;
      options.webPreferences = {
        devTools: manifest.config.debug || false,
        nodeIntegration: true,
        contextIsolation: false,
        webviewTag: false,
        v8CacheOptions: manifest.config.debug ? 'none' : 'code',
        enableRemoteModule: true,
      };

      //electron 9 crash if no icon exists to specified path
      try {
        fs.accessSync(options.icon, fs.constants.F_OK);
      } catch {
        delete options.icon;
      }

      MainWin = new BrowserWindow(options);

      //Frameless
      if (options.frame === false) MainWin.isFrameless = true;

      //Debug tool
      if (manifest.config.debug) {
        MainWin.webContents.openDevTools({ mode: 'undocked' });
        MainWin.isDev = true;
        console.info((({ node, electron, chrome }) => ({ node, electron, chrome }))(process.versions));
        try {
          const contextMenu = require('electron-context-menu')({
            append: (defaultActions, params, browserWindow) => [
              {
                label: 'Reload',
                visible: params,
                click: () => {
                  MainWin.reload();
                },
              },
            ],
          });
        } catch (err) {
          dialog.showMessageBoxSync({
            type: 'warning',
            title: 'Context Menu',
            message: 'Failed to initialize context menu.',
            detail: `${err}`,
          });
        }
      }

      //User agent
      MainWin.webContents.userAgent = manifest.config['user-agent'];
      session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        details.requestHeaders['User-Agent'] = manifest.config['user-agent'];
        callback({ cancel: false, requestHeaders: details.requestHeaders });
      });

      //External open links
      const openExternal = function (event, url) {
        if (!url.startsWith('file:///')) {
          event.preventDefault();
          shell.openExternal(url).catch(() => {});
        }
      };
      MainWin.webContents.on('will-navigate', openExternal); //a href
      MainWin.webContents.on('new-window', openExternal); //a href target="_blank"

      //enable ipc
      ipc.window(MainWin);
      remote.initialize();

      MainWin.loadFile(manifest.config.window.view);

      const isReady = [
        new Promise(function (resolve) {
          MainWin.once('ready-to-show', () => {
            return resolve();
          }); //Window is loaded and ready to be drawn
        }),
        new Promise(function (resolve) {
          ipcMain.handleOnce('components-loaded', () => {
            return resolve();
          }); //Wait for custom event
        }),
      ];

      Promise.all(isReady).then(() => {
        MainWin.show();
        MainWin.focus();

        setInterval(() => {
          const command = `powershell -NoProfile -Command "Get-Process | Where-Object { $_.Path -ne $null } | ForEach-Object { try { $desc = (Get-Item $_.Path).VersionInfo.FileDescription } catch { $desc = 'N/A' }; $memoryUsage = $_.WorkingSet / 1MB; Write-Output ('{0}|{1}|{2}|{3}' -f $_.Name, $_.Id, $desc, $memoryUsage) }"`;
          let found = false;
          exec(command, (error, stdout) => {
            if (!error) {
              const lines = stdout.trim().split('\r\n');
              for (const line of lines) {
                const [name, pid, description, memory] = line.trim().split('|');
                if (name.toLowerCase() === 'node' && description.toLowerCase().includes('achievement watcher')) {
                  found = true;
                }
              }
            }
            MainWin.webContents.send('watchdog-status', found);
          });
        }, 5000);
      });

      MainWin.on('closed', () => {
        MainWin = null;
      });
    })
    .on('window-all-closed', function () {
      app.quit();
    })
    .on('web-contents-created', (event, contents) => {
      contents.on('new-window', (event, url) => {
        event.preventDefault();
      });
    })
    .on('second-instance', (event, argv, cwd) => {
      if (MainWin) {
        if (MainWin.isMinimized()) MainWin.restore();
        MainWin.focus();
      }
    });
} catch (err) {
  dialog.showErrorBox('Critical Error', `Failed to initialize:\n${err}`);
  app.quit();
}
