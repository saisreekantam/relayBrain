const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

const WORKSPACE_STORAGE_ROOTS = [
  path.join(HOME, 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage'),
  path.join(HOME, 'AppData', 'Roaming', 'Cursor', 'User', 'workspaceStorage'),
  path.join(HOME, 'AppData', 'Roaming', 'Antigravity IDE', 'User', 'workspaceStorage'),
  path.join(HOME, '.config', 'Code', 'User', 'workspaceStorage'),
  path.join(HOME, '.config', 'Cursor', 'User', 'workspaceStorage'),
];

function normalizeWorkspacePath(p) {
  return String(p || '')
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/\/$/, '');
}

function folderUriToPath(folderUri) {
  if (!folderUri || typeof folderUri !== 'string') return null;
  if (!folderUri.startsWith('file:///')) return null;
  try {
    const decoded = decodeURIComponent(folderUri.replace('file:///', ''));
    return decoded.replace(/\//g, path.sep);
  } catch (_) {
    return null;
  }
}

function discoverWorkspaceStorageDir(workspacePath, roots = WORKSPACE_STORAGE_ROOTS) {
  const target = normalizeWorkspacePath(workspacePath);

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;

    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const workspaceJsonPath = path.join(root, entry.name, 'workspace.json');
      if (!fs.existsSync(workspaceJsonPath)) continue;

      try {
        const { folder } = JSON.parse(fs.readFileSync(workspaceJsonPath, 'utf-8'));
        const folderPath = folderUriToPath(folder);
        if (folderPath && normalizeWorkspacePath(folderPath) === target) {
          return path.join(root, entry.name);
        }
      } catch (_) { }
    }
  }

  return null;
}

function getWorkspacePathFromStorageDir(workspaceStorageDir) {
  if (!workspaceStorageDir) return null;
  const workspaceJsonPath = path.join(workspaceStorageDir, 'workspace.json');
  if (!fs.existsSync(workspaceJsonPath)) return null;

  try {
    const { folder } = JSON.parse(fs.readFileSync(workspaceJsonPath, 'utf-8'));
    return folderUriToPath(folder);
  } catch (_) {
    return null;
  }
}

module.exports = {
  normalizeWorkspacePath,
  folderUriToPath,
  discoverWorkspaceStorageDir,
  getWorkspacePathFromStorageDir,
  WORKSPACE_STORAGE_ROOTS,
};
