'use strict';

const path = require('path');
const glob = require('fast-glob');
const request = require('request-zero');

let cacheRoot;
let debug;
module.exports.initDebug = ({ isDev, userDataPath }) => {
  this.setUserDataPath(userDataPath);
  debug = new (require('@xan105/log'))({
    console: isDev || false,
    file: path.join(userDataPath, 'logs/parser.log'),
  });
};

module.exports.setUserDataPath = (p) => {
  cacheRoot = p;
};

module.exports.scan = async (dir) => {
  try {
    let data = [];
    for (let dir of await glob(
      path.join(process.env['APPDATA'] || path.join(os.homedir(), 'Library', 'Application Support'), 'NemirtingasGalaxyEmu', '*/*/'),
      { onlyDirectories: true, absolute: true }
    )) {
      let game = {
        appid: path.parse(dir).name,
        source: 'gog',
        data: {
          type: 'file',
          path: dir,
        },
      };
      const url = `https://gamesdb.gog.com/platforms/gog/external_releases/${game.appid}`;
      let gameinfo = await request.getJson(url);
      if (gameinfo) {
        let steamid = gameinfo.game.releases.find((r) => r.platform_id === 'steam').external_id;
        game.appid = steamid || game.appid;
        data.push(game);
      }
    }
    return data;
  } catch (err) {
    throw err;
  }
};
