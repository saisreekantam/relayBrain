const fs = require('fs');
const path = require('path');

const SOURCE = 'GitHub Copilot';

function uriToPath(uri) {
  if (!uri) return null;
  if (typeof uri === 'string') {
    if (uri.startsWith('file:///')) {
      try {
        return decodeURIComponent(uri.replace('file:///', '')).replace(/\//g, path.sep);
      } catch (_) {
        return null;
      }
    }
    return uri;
  }
  if (uri.fsPath) return uri.fsPath;
  if (uri.external?.startsWith('file:///')) return uriToPath(uri.external);
  return null;
}

function listEditingSessionDirs(workspaceStorageDir) {
  const root = path.join(workspaceStorageDir, 'chatEditingSessions');
  if (!fs.existsSync(root)) return [];

  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(root, entry.name));
}

function parseEditingSessionDir(sessionDir, sessionTiming) {
  const statePath = path.join(sessionDir, 'state.json');
  if (!fs.existsSync(statePath)) return [];

  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } catch (_) {
    return [];
  }

  const sessionId = path.basename(sessionDir);
  const events = [];
  const timeline = state.timeline || {};
  const checkpoints = timeline.checkpoints || [];
  const operations = timeline.operations || [];
  const epochToCheckpoint = new Map(checkpoints.map(cp => [cp.epoch, cp]));

  const baseTs = sessionTiming?.lastRequestStarted || sessionTiming?.created || null;

  for (const op of operations) {
    const filePath = uriToPath(op.uri);
    if (!filePath || op.type !== 'textEdit') continue;

    const editPreview = (op.edits || [])
      .map(e => String(e.text || '').trim())
      .filter(Boolean)
      .join(' ')
      .slice(0, 160);

    const checkpoint = epochToCheckpoint.get(op.epoch);
    events.push({
      ts: baseTs,
      kind: 'code_edit',
      role: 'assistant',
      source: SOURCE,
      sessionId,
      file: path.basename(filePath),
      path: filePath,
      action: 'textEdit',
      editSource: 'chatEditingSession',
      epoch: op.epoch,
      requestId: op.requestId || checkpoint?.requestId || null,
      summary: editPreview || checkpoint?.label || 'Copilot chat edit',
      checkpointId: checkpoint?.checkpointId || null,
    });
  }

  for (const cp of checkpoints) {
    if (cp.epoch === 0) continue;
    const fileUri = state.initialFileContents?.[0]?.[0];
    const filePath = uriToPath(fileUri);
    events.push({
      ts: baseTs,
      kind: 'checkpoint',
      role: 'assistant',
      source: SOURCE,
      sessionId,
      file: filePath ? path.basename(filePath) : null,
      path: filePath,
      epoch: cp.epoch,
      requestId: cp.requestId || null,
      summary: cp.label || cp.description || 'Copilot edit checkpoint',
      checkpointId: cp.checkpointId,
    });
  }

  return events;
}

function parseCopilotEditingSessions(workspaceStorageDir, sessionIndex) {
  const dirs = listEditingSessionDirs(workspaceStorageDir);
  const events = [];

  for (const dir of dirs) {
    const sessionId = path.basename(dir);
    const timing = sessionIndex?.entries?.[sessionId]?.timing || null;
    events.push(...parseEditingSessionDir(dir, timing));
  }

  return events;
}

module.exports = {
  parseCopilotEditingSessions,
  listEditingSessionDirs,
};
