const path = require('path');
const fs = require('fs');

module.exports.loadEpicData = async (appID, binary = null) => {
  const cache = path.join(process.env['APPDATA'], 'Achievement Watcher/epic_cache/schema', 'english');
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
    throw `Could not load EPIC data for ${appID}: ${err}`;
  }
};
