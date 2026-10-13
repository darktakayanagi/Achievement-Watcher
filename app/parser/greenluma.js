'use strict';

const { listRegistryAllSubkeys, readRegistryInteger, ListRegistryAllValues } = require('../util/reg');

module.exports.scan = async () => {
  try {
    let data = [];

    const keyList = {
      glr: { keyName: 'GLR', name: 'GreenLuma Reborn' },
      gl2020: { keyName: 'GL2020', name: 'GreenLuma 2020' },
      gl2024: { keyName: 'GL2024', name: 'GreenLuma 2024' },
      gl2025: { keyName: 'GL2025', name: 'GreenLuma 2025' },
    };

    for (const k of Object.values(keyList)) {
      const keys = listRegistryAllSubkeys('HKCU', `SOFTWARE/${k.keyName}/AppID`);
      if (!keys) continue;
      for (let key of keys) {
        try {
          let gl_ach_enable = parseInt(readRegistryInteger('HKCU', `SOFTWARE/${k.keyName}/AppID/${key}`, 'SkipStatsAndAchievements'));
          if (gl_ach_enable === 0) {
            data.push({
              appid: key,
              source: k.name,
              data: {
                type: 'reg',
                root: 'HKCU',
                path: `SOFTWARE/${k.keyName}/AppID/${key}/Achievements`,
              },
            });
          }
        } catch {}
      }
    }

    return data;
  } catch (err) {
    throw err;
  }
};

module.exports.getAchievements = async (root, key) => {
  try {
    let achievements = ListRegistryAllValues(root, key);
    if (!achievements) throw 'No achievement found in registry';

    let result = [];

    for (let achievement of achievements) {
      if (!achievement.endsWith('_Time')) {
        result.push({
          id: achievement,
          Achieved: parseInt(readRegistryInteger(root, key, achievement)),
          UnlockTime: parseInt(readRegistryInteger(root, key, achievement + '_Time')),
        });
      }
    }

    return result;
  } catch (err) {
    throw err;
  }
};
