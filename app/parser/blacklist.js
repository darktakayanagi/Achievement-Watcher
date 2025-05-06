'use strict';

const path = require('path');
const request = require('request-zero');
const ffs = require('@xan105/fs');

let debug;
let exclusionFile;
module.exports.initDebug = ({ isDev, userDataPath }) => {
  exclusionFile = path.join(userDataPath, 'cfg/exclusion.db');
  debug = new (require('@xan105/log'))({
    console: remote.getCurrentWindow().isDev || false,
    file: path.join(remote.app.getPath('userData'), 'logs/blacklist.log'),
  });
};

module.exports.get = async () => {
  const url = 'https://api.xan105.com/steam/getBogusList';
  //TODO: replace this url with the full apilist of dlc/music/demo/etc

  let exclude = [
    480, //Space War
    753, //Steam Config
    250820, //SteamVR
    228980, //Steamworks Common Redistributables
  ];

  try {
    let srvExclusion = (await request.getJson(url)).data;
    debug.log('blacklist from srv:');
    debug.log(srvExclusion);
    exclude = [...new Set([...exclude, ...srvExclusion])];
  } catch (err) {
    //Do nothing
  }

  try {
    let userExclusion = JSON.parse(await ffs.readFile(exclusionFile, 'utf8'));
    exclude = [...new Set([...exclude, ...userExclusion])];
  } catch (err) {
    //Do nothing
  }

  return exclude;
};

module.exports.reset = async () => {
  await ffs.writeFile(exclusionFile, JSON.stringify([], null, 2), 'utf8');
};

module.exports.add = async (appid) => {
  try {
    debug.log(`Blacklisting ${appid} ...`);

    let userExclusion;

    try {
      userExclusion = JSON.parse(await ffs.readFile(exclusionFile, 'utf8'));
    } catch (e) {
      userExclusion = [];
    }

    if (!userExclusion.includes(appid)) {
      userExclusion.push(appid);
      await ffs.writeFile(exclusionFile, JSON.stringify(userExclusion, null, 2), 'utf8');
      debug.log('Done.');
    } else {
      debug.log('Already blacklisted.');
    }
  } catch (err) {
    throw err;
  }
};
