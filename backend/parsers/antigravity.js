const fs = require('fs');
const path = require('path');
const { normalizeTs } = require('../lib/timeline');

const SOURCE = 'Antigravity';

function safeRead(filePath) {
  try { return fs.readFileSync(filePath, 'utf-8'); }
  catch (_) { return ''; }
}

function getBrainDir(transcriptPath) {
  return path.resolve(path.dirname(transcriptPath), '../..');
}

function extractFileUriFromContent(content) {
  if (!content) return null;
  const patterns = [
    /(?:Created|Modified|Deleted|Updated|Wrote)\s+(?:file\s+)?(file:\/\/\/[^\s\n]+)/i,
    /File Path:\s*`?(file:\/\/\/[^\s`\n]+)`?/i,
  ];
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function uriToPath(uri) {
  if (!uri || !uri.startsWith('file:///')) return null;
  try {
    return decodeURIComponent(uri.replace('file:///', '')).replace(/\//g, path.sep);
  } catch (_) {
    return null;
  }
}

function parseCodeActionStep(step) {
  const fileUri = extractFileUriFromContent(step.content);
  const filePath = uriToPath(fileUri);
  const summary = String(step.content || '')
    .split('\n')
    .find(line => /Created|Modified|Deleted|Updated|Wrote/i.test(line)) || 'Agent code action';

  return {
    ts: normalizeTs(step.created_at),
    kind: 'code_edit',
    role: 'assistant',
    source: SOURCE,
    file: filePath ? path.basename(filePath) : null,
    path: filePath,
    action: step.type === 'VIEW_FILE' ? 'view' : 'edit',
    summary: summary.slice(0, 240),
    stepIndex: step.step_index,
  };
}

function collectMarkdownArtifacts(brainDir) {
  const artifacts = [];
  const seen = new Set();

  function addMdFile(mdPath) {
    if (seen.has(mdPath)) return;
    seen.add(mdPath);

    const name = path.basename(mdPath);
    const metaPath = `${mdPath}.metadata.json`;
    const metaRaw = safeRead(metaPath);
    let metadata = metaRaw;
    let artifactTs = null;

    if (metaRaw) {
      try {
        const meta = JSON.parse(metaRaw);
        metadata = metaRaw;
        artifactTs = normalizeTs(meta.updatedAt || meta.createdAt || meta.timestamp);
      } catch (_) { }
    }

    if (!artifactTs) {
      try {
        artifactTs = normalizeTs(fs.statSync(mdPath).mtimeMs);
      } catch (_) { }
    }

    artifacts.push({
      name,
      path: mdPath,
      content: safeRead(mdPath),
      metadata,
      ts: artifactTs,
    });
  }

  if (!fs.existsSync(brainDir)) return artifacts;

  for (const entry of fs.readdirSync(brainDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.endsWith('.metadata.json')) {
      addMdFile(path.join(brainDir, entry.name));
    }
  }

  const nestedDirs = ['artifacts', 'browser'];
  for (const sub of nestedDirs) {
    const subDir = path.join(brainDir, sub);
    if (!fs.existsSync(subDir)) continue;
    for (const entry of fs.readdirSync(subDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        addMdFile(path.join(subDir, entry.name));
      }
    }
  }

  return artifacts;
}

function artifactTimelineEvents(artifacts) {
  return artifacts
    .filter(a => a.ts)
    .map(a => ({
      ts: a.ts,
      kind: 'artifact',
      role: 'assistant',
      source: SOURCE,
      file: a.name,
      path: a.path,
      summary: `Artifact updated: ${a.name}`,
      content: a.content.slice(0, 500),
    }));
}

function parseAntigravity(transcriptPath, options = {}) {
  const content = safeRead(transcriptPath);
  const lines = content.trim().split('\n').filter(Boolean);
  const events = [];

  for (const line of lines) {
    try {
      const step = JSON.parse(line);

      if (step.type === 'USER_INPUT' && step.content) {
        const match = step.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
        const text = match ? match[1].trim() : step.content;
        events.push({
          ts: normalizeTs(step.created_at),
          kind: 'message',
          role: 'user',
          content: text,
          source: SOURCE,
          stepIndex: step.step_index,
        });
      } else if (step.type === 'PLANNER_RESPONSE' && step.content) {
        events.push({
          ts: normalizeTs(step.created_at),
          kind: 'message',
          role: 'assistant',
          content: step.content,
          source: SOURCE,
          stepIndex: step.step_index,
        });
      } else if (step.type === 'CODE_ACTION' || step.type === 'VIEW_FILE') {
        const edit = parseCodeActionStep(step);
        if (edit.ts) events.push(edit);
      }
    } catch (_) { }
  }

  const brainDir = options.brainDir || getBrainDir(transcriptPath);

  const artifacts = collectMarkdownArtifacts(brainDir);
  events.push(...artifactTimelineEvents(artifacts));

  const tasksDir = path.join(brainDir, '.system_generated', 'tasks');
  const tasks = fs.existsSync(tasksDir)
    ? fs.readdirSync(tasksDir)
      .filter(f => f.endsWith('.log'))
      .map(f => {
        const raw = safeRead(path.join(tasksDir, f));
        return {
          id: path.basename(f, '.log'),
          preview: raw.length > 500 ? raw.substring(raw.length - 500) : raw,
        };
      })
    : [];

  const msgsDir = path.join(brainDir, '.system_generated', 'messages');
  const messages = fs.existsSync(msgsDir)
    ? fs.readdirSync(msgsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(safeRead(path.join(msgsDir, f))); }
        catch (_) { return null; }
      })
      .filter(Boolean)
    : [];

  events.sort((a, b) => {
    const ta = Date.parse(a.ts || '') || 0;
    const tb = Date.parse(b.ts || '') || 0;
    return ta - tb;
  });

  return { events, artifacts, tasks, messages, brainDir };
}

module.exports = { parseAntigravity, getBrainDir, collectMarkdownArtifacts };
