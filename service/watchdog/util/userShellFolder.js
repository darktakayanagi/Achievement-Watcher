'use strict';
const os = require('os');
const path = require('path');
if (process.platform === 'win32') {
  const regedit = require('regodit');
}
process.env['USERPROFILE'] = process.env['USERPROFILE'] || os.homedir();

const regedit = null;
const folders = {
  mypictures:
    regedit?.RegQueryStringValueAndExpand('HKCU', 'Software/Microsoft/Windows/CurrentVersion/Explorer/User Shell Folders', 'My Pictures') ||
    path.join(process.env['USERPROFILE'], 'Pictures'),
  myvideo:
    regedit?.RegQueryStringValueAndExpand('HKCU', 'Software/Microsoft/Windows/CurrentVersion/Explorer/User Shell Folders', 'My Video') ||
    path.join(process.env['USERPROFILE'], 'Videos'),
};

module.exports = folders;
