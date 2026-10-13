'use strict';

const path = require('path');
const fs = require('fs');
const glob = require('fast-glob');
const ini = require('@xan105/ini');
const request = require('request-zero');

async function findByReadingContentOfKnownConfigfilesIn(dirPath) {
  let currentDir = dirPath;
  try {
    while (true) {
      const infoFiles = glob.sync(currentDir.replace(/\\/g, '/') + '/**/*.info', {
        absolute: true,
        nodir: true,
      });

      for (const infoFile of infoFiles) {
        try {
          const json = JSON.parse(fs.readFileSync(infoFile, 'utf8'));

          if (json?.rootGameId) return json.rootGameId;
        } catch {}
      }

      const parent = path.dirname(currentDir);

      if (parent === currentDir) return null; //system root

      currentDir = parent;
    }
  } catch {
    return null;
  }
}

module.exports = { findByReadingContentOfKnownConfigfilesIn };
