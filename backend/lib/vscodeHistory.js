const fs = require('fs');
const path = require('path');
const os = require('os');
const { folderUriToPath, normalizeWorkspacePath } = require('./vscodeWorkspace');
const { normalizeTs } = require('./timeline');

const HOME = os.homedir();

const HISTORY_ROOTS = [
  {
    root: path.join(HOME, 'AppData', 'Roaming', 'Code', 'User', 'History'),
    source: 'GitHub Copilot',
  },
  {
    root: path.join(HOME, 'AppData', 'Roaming', 'Cursor', 'User', 'History'),
    source: 'Cursor',
  },
  {
    root: path.join(HOME, 'AppData', 'Roaming', 'Antigravity IDE', 'User', 'History'),
    source: 'Antigravity',
  },
  {
    root: path.join(HOME, '.config', 'Code', 'User', 'History'),
    source: 'GitHub Copilot',
  },
  {
    root: path.join(HOME, '.config', 'Cursor', 'User', 'History'),
    source: 'Cursor',
  },
];

function getCodeHistoryRoots() {
  return HISTORY_ROOTS.filter(({ root, source }) =>
    source === 'GitHub Copilot' && fs.existsSync(root)
  );
}

function getCursorHistoryRoots() {
  return HISTORY_ROOTS.filter(({ root, source }) =>
    source === 'Cursor' && fs.existsSync(root)
  );
}

function editPathKey(event) {
  const filePath = normalizeWorkspacePath(event.path || event.file || '');
  const tsBucket = Math.floor((Date.parse(event.ts || '') || 0) / 1000);
  return `${filePath}|${tsBucket}`;
}

function findClosestHistoryEdit(edit, historyEdits, maxDeltaMs = 120000) {
  const editTs = Date.parse(edit.ts || '') || 0;
  const editPath = normalizeWorkspacePath(edit.path || '');

  let best = null;
  let bestDelta = Infinity;

  for (const candidate of historyEdits) {
    const candidatePath = normalizeWorkspacePath(candidate.path || '');
    if (candidatePath !== editPath) continue;

    const delta = Math.abs((Date.parse(candidate.ts || '') || 0) - editTs);
    if (delta <= maxDeltaMs && delta < bestDelta) {
      best = candidate;
      bestDelta = delta;
    }
  }

  return best;
}

function enrichEditsWithHistory(sessionEdits, historyEdits) {
  return sessionEdits.map(edit => {
    if (edit.diff) return edit;

    const match = findClosestHistoryEdit(edit, historyEdits);
    if (!match) return edit;

    return {
      ...edit,
      diff: match.diff || null,
      summary: match.summary || edit.summary,
      historyId: match.historyId || null,
      editSource: match.editSource || 'localHistory',
    };
  });
}

function mergeCodeEditSources(historyEdits, sessionEdits) {
  const merged = [];
  const seen = new Set();
  const historyPaths = new Set(
    historyEdits.map(edit => normalizeWorkspacePath(edit.path || '')).filter(Boolean)
  );

  for (const edit of historyEdits) {
    const key = editPathKey(edit);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      ...edit,
      editSource: edit.editSource || 'localHistory',
    });
  }

  for (const edit of sessionEdits) {
    const editPath = normalizeWorkspacePath(edit.path || '');
    if (editPath && historyPaths.has(editPath)) continue;

    const nearHistory = historyEdits.some(h =>
      normalizeWorkspacePath(h.path || '') === editPath &&
      Math.abs((Date.parse(h.ts || '') || 0) - (Date.parse(edit.ts || '') || 0)) < 60000
    );

    if (nearHistory && !edit.diff) continue;

    const key = editPathKey(edit);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      ...edit,
      editSource: edit.editSource || 'chatEditingSession',
    });
  }

  merged.sort((a, b) => Date.parse(a.ts || '') - Date.parse(b.ts || ''));
  return merged;
}

function isUnderWorkspace(filePath, workspacePath) {
  if (!filePath || !workspacePath) return false;
  const fileNorm = normalizeWorkspacePath(filePath);
  const wsNorm = normalizeWorkspacePath(workspacePath);
  return fileNorm === wsNorm || fileNorm.startsWith(`${wsNorm}/`);
}

function readSnapshotContent(historyDir, entryId) {
  const snapshotPath = path.join(historyDir, entryId);
  if (!fs.existsSync(snapshotPath)) return null;
  try {
    return fs.readFileSync(snapshotPath, 'utf-8');
  } catch (_) {
    return null;
  }
}

function scanHistoryRoot(historyRoot, workspacePath, source) {
  const events = [];
  if (!fs.existsSync(historyRoot)) return events;

  for (const entry of fs.readdirSync(historyRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const historyDir = path.join(historyRoot, entry.name);
    const entriesPath = path.join(historyDir, 'entries.json');
    if (!fs.existsSync(entriesPath)) continue;

    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(entriesPath, 'utf-8'));
    } catch (_) {
      continue;
    }

    const resourcePath = folderUriToPath(meta.resource);
    if (!isUnderWorkspace(resourcePath, workspacePath)) continue;

    const historyEntries = Array.isArray(meta.entries) ? [...meta.entries] : [];
    historyEntries.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    for (let i = 0; i < historyEntries.length; i++) {
      const item = historyEntries[i];
      const ts = normalizeTs(item.timestamp);
      if (!ts) continue;

      const summary = item.source || 'Local History snapshot';
      const snapshot = readSnapshotContent(historyDir, item.id);
      let diff = null;

      if (snapshot != null && i > 0) {
        const prev = readSnapshotContent(historyDir, historyEntries[i - 1].id);
        if (prev != null && prev !== snapshot) {
          const { makeUnifiedDiff } = require('./timeline');
          diff = makeUnifiedDiff(prev, snapshot, path.basename(resourcePath || ''));
        }
      }

      events.push({
        ts,
        kind: 'code_edit',
        role: 'assistant',
        source,
        file: path.basename(resourcePath || ''),
        path: resourcePath,
        action: 'localHistory',
        editSource: 'localHistory',
        summary,
        diff,
        historyId: item.id,
      });
    }
  }

  return events;
}

function scanHistoryForWorkspace(workspacePath, options = {}) {
  const roots = options.roots || HISTORY_ROOTS;
  const events = [];

  for (const { root, source } of roots) {
    events.push(...scanHistoryRoot(root, workspacePath, source));
  }

  events.sort((a, b) => Date.parse(a.ts || '') - Date.parse(b.ts || ''));
  return events;
}

module.exports = {
  HISTORY_ROOTS,
  getCodeHistoryRoots,
  getCursorHistoryRoots,
  scanHistoryForWorkspace,
  scanHistoryRoot,
  isUnderWorkspace,
  enrichEditsWithHistory,
  mergeCodeEditSources,
};
