'use strict';

const path = require('path');
const { readRegistryString, writeRegistryString } = require('./reg');
let userDataPath;

module.exports.setUserDataPath = (p) => {
  userDataPath = p;
};

module.exports.getDefault = () => {
  const _default_ = 'Windows Notify System Generic.wav';

  try {
    const filepath = readRegistryString('HKCU', 'AppEvents/Schemes/Apps/.Default/Notification.Default/.Current', '');

    if (filepath) {
      return path.parse(filepath).base;
    } else {
      return _default_;
    }
  } catch {
    return _default_;
  }
};

module.exports.setCustom = async (filename) => {
  try {
    const file = path.join(userDataPath, 'Media', filename);

    await writeRegistryString('HKCU', 'AppEvents/Schemes/Apps/.Default/Notification.Achievement/.Current', '', file);
    await writeRegistryString('HKCU', 'AppEvents/Schemes/Apps/.Default/Notification.Achievement/.Default', '', file);
  } catch {
    /*Do nothing*/
  }
};

module.exports.getCustom = () => {
  try {
    const filepath = readRegistryString('HKCU', 'AppEvents/Schemes/Apps/.Default/Notification.Achievement/.Current', '');

    if (filepath) {
      return filepath;
    } else {
      return '';
    }
  } catch {
    return '';
  }
};
