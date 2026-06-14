const { execSync } = require('child_process');
const fs = require('fs');

function queryVscdb(dbPath, sql) {
  if (!fs.existsSync(dbPath)) return null;

  try {
    const out = execSync(`sqlite3 "${dbPath.replace(/"/g, '""')}" "${sql.replace(/"/g, '""')}"`, {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    });
    return out.trim();
  } catch (_) {
    return null;
  }
}

function readVscdbJson(dbPath, key) {
  const raw = queryVscdb(dbPath, `SELECT value FROM ItemTable WHERE key='${key.replace(/'/g, "''")}';`);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function vscodeInternalTimeToIso(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const date = new Date(n);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

module.exports = {
  queryVscdb,
  readVscdbJson,
  vscodeInternalTimeToIso,
};
