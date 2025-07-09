'use strict';

const { readRegistryInteger, writeRegistryDword } = require('../util/reg');

module.exports = async (appID) => {
  const current = +readRegistryInteger('HKCU', 'Software/Achievement Watcher/Playtime/Steam/' + appID, 'total') || 0;
  const last = +readRegistryInteger('HKCU', 'Software/Achievement Watcher/Playtime/Steam/' + appID, 'last') || 0;
  return { playtime: current, lastplayed: last };
};

module.exports.reset = async (appID) => {
  const path = `Software/Achievement Watcher/Playtime/Steam/${appID}`;
  await writeRegistryDword('HKCU', path, 'total', 0);
  await writeRegistryDword('HKCU', path, 'last', 0);
};
