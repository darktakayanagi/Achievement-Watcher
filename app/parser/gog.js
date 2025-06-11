'use strict';

const path = require('path');
const glob = require('fast-glob');

let debug;
module.exports.initDebug = ({ isDev, userDataPath }) => {
  this.setUserDataPath(userDataPath);
  debug = new (require('@xan105/log'))({
    console: isDev || false,
    file: path.join(userDataPath, 'logs/parser.log'),
  });
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
      data.push(game);
    }
    return data;
  } catch (err) {
    throw err;
  }
};
