const path = require('path');
const urlParser = require('url');
const fs = require('fs');
const request = require('request-zero');
const steamLang = require('./steam.json');
const htmlParser = require('node-html-parser');

module.exports.loadGogData = async (appID, binary = null) => {
  const cache = path.join(process.env['APPDATA'], 'Achievement Watcher/gog_cache/schema', 'english');
  function waitForFile(filePath, intervalMs = 100) {
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (fs.existsSync(filePath)) {
          clearInterval(timer);
          resolve();
        }
      }, intervalMs);
    });
  }
  try {
    let filePath = path.join(`${cache}`, `${appID}.db`);
    let result;

    //hacky solution (AW is currently fetching data, lets wait for it to finish and read from cache)
    await waitForFile(filePath);

    if (fs.existsSync(filePath)) {
      result = JSON.parse(fs.readFileSync(filePath));
      return result;
    }
  } catch (err) {
    throw `Could not load GOG data for ${appID}: ${err}`;
  }
};
