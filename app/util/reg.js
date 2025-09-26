const { execFile } = require('child_process');
const { HKEY, enumerateValues, enumerateKeys, setValue } = require('registry-js');

function hkeyFromString(hive) {
  const map = {
    hkcr: HKEY.HKEY_CLASSES_ROOT,
    hkcu: HKEY.HKEY_CURRENT_USER,
    hklm: HKEY.HKEY_LOCAL_MACHINE,
    hku: HKEY.HKEY_USERS,
    hkcc: HKEY.HKEY_CURRENT_CONFIG,
  };
  return map[hive.toLowerCase()];
}

function writeRegistryString(hive, keyPath, valueName, value) {
  const hiveEnum = hkeyFromString(hive);
  if (!hiveEnum) throw new Error(`Unsupported hive: ${hive}`);

  const normalizedKey = keyPath.replace(/\//g, '\\');

  // Default value is represented by "" (empty string) not "(default)"
  const name = valueName || '';

  const ok = setValue(hiveEnum, normalizedKey, name, 'REG_SZ', String(value));
  if (!ok) throw new Error(`Failed to set registry value ${hive}\\${keyPath}\\${name}`);
}

function writeRegistryDword(hive, keyPath, valueName, value) {
  const hiveEnum = hkeyFromString(hive);
  if (!hiveEnum) throw new Error(`Unsupported hive: ${hive}`);

  const normalizedKey = keyPath.replace(/\//g, '\\');

  const name = valueName || ''; // "" = (Default) value

  // REG_DWORD expects a string, even though it’s numeric
  const ok = setValue(hiveEnum, normalizedKey, name, 'REG_DWORD', String(value));
  if (!ok) {
    throw new Error(`Failed to set DWORD value ${hive}\\${keyPath}\\${name} = ${value}`);
  }
}

function ListRegistryAllValues(hive, key) {
  const hiveEnum = hkeyFromString(hive);
  if (!hiveEnum) throw new Error(`Unsupported hive: ${hive}`);

  const normalizedKey = key.replace(/\//g, '\\');

  // enumerateValues returns an array of objects: { name, type, data }
  const values = enumerateValues(hiveEnum, normalizedKey);

  // Return just the names
  return values.map((v) => v.name);
}

function listRegistryAllSubkeys(hive, key) {
  const hiveEnum = hkeyFromString(hive);
  if (!hiveEnum) throw new Error(`Unsupported hive: ${hive}`);

  const normalizedKey = key.replace(/\//g, '\\');

  // enumerateKeys returns an array of strings
  return enumerateKeys(hiveEnum, normalizedKey);
}

function readRegistryInteger(hive, key, valueName) {
  const hiveEnum = hkeyFromString(hive);
  if (!hiveEnum) throw new Error(`Unsupported hive: ${hive}`);

  const normalizedKey = key.replace(/\//g, '\\');

  const values = listValues(hiveEnum, normalizedKey);
  const val = values.find((v) => v.name === valueName);

  if (!val || (val.type !== 'REG_DWORD' && val.type !== 'REG_QWORD')) {
    return null;
  }

  return Number(val.data);
}

function readRegistryString(hive, key, valueName) {
  const hiveEnum = hkeyFromString(hive);
  if (!hiveEnum) throw new Error(`Unsupported hive: ${hive}`);

  const normalizedKey = key.replace(/\//g, '\\');

  // Default value in registry-js is ''
  const name = valueName || '';

  const values = enumerateValues(hiveEnum, normalizedKey);
  const val = values.find((v) => v.name === name);

  if (!val || val.type !== 'REG_SZ') return null;

  return val.data;
}

function readRegistryStringAndExpand(hive, key, valueName) {
  const hiveEnum = hkeyFromString(hive);
  if (!hiveEnum) throw new Error(`Unsupported hive: ${hive}`);

  const normalizedKey = key.replace(/\//g, '\\');

  const name = valueName || ''; // default value is empty string

  const values = enumerateValues(hiveEnum, normalizedKey);
  const val = values.find((v) => v.name === name);

  if (!val || (val.type !== 'REG_EXPAND_SZ' && val.type !== 'REG_SZ')) return null;

  // Expand environment variables if REG_EXPAND_SZ
  if (val.type === 'REG_EXPAND_SZ') {
    return expandEnvVariables(val.data);
  } else {
    return val.data;
  }
}

function regKeyExists(hive, key) {
  const hiveEnum = hkeyFromString(hive);
  if (!hiveEnum) throw new Error(`Unsupported hive: ${hive}`);

  const normalizedKey = key.replace(/\//g, '\\');

  const subkeys = enumerateKeys(hiveEnum, normalizedKey);

  // If the key doesn't exist, enumerateKeys returns an empty array
  return subkeys.length > 0 || listValuesSafe(hiveEnum, normalizedKey).length > 0;
}

// Helper to expand %VAR% env vars in a string (Windows style)
function expandEnvVariables(str) {
  return str.replace(/%([^%]+)%/g, (_, n) => process.env[n] || `%${n}%`);
}

module.exports = {
  writeRegistryDword,
  writeRegistryString,
  readRegistryString,
  readRegistryStringAndExpand,
  readRegistryInteger,
  listRegistryAllSubkeys,
  ListRegistryAllValues,
  regKeyExists,
};
