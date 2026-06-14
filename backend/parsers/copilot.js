const fs = require('fs');
const path = require('path');
const { readVscdbJson, vscodeInternalTimeToIso } = require('../lib/vscdb');
const { getWorkspacePathFromStorageDir } = require('../lib/vscodeWorkspace');
const {
  scanHistoryForWorkspace,
  getCodeHistoryRoots,
  enrichEditsWithHistory,
  mergeCodeEditSources,
} = require('../lib/vscodeHistory');
const { parseCopilotEditingSessions, listEditingSessionDirs } = require('./copilotEditingSessions');

const SOURCE = 'GitHub Copilot';

const extractText = (value) => {
  if (Array.isArray(value)) {
    return value
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (part.type === 'text' && typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
        }
        return '';
      })
      .join(' ')
      .trim();
  }

  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text.trim();
    if (typeof value.content === 'string') return value.content.trim();
  }

  return String(value || '').trim();
};

function extractUserRequest(renderedUserMessage) {
  for (const part of renderedUserMessage || []) {
    if (typeof part?.text !== 'string') continue;
    const match = part.text.match(/<userRequest>\s*([\s\S]*?)\s*<\/userRequest>/i);
    if (match) return match[1].trim();
  }
  return null;
}

function foldChatSessionPatches(lines) {
  let state = null;

  for (const line of lines) {
    let step;
    try {
      step = JSON.parse(line);
    } catch (_) {
      continue;
    }

    if (step.kind === 0) {
      state = step.v;
      continue;
    }

    if (!state || step.kind !== 1 || !Array.isArray(step.k)) continue;

    let current = state;
    for (let i = 0; i < step.k.length - 1; i++) {
      const key = step.k[i];
      if (current[key] === undefined) {
        current[key] = typeof step.k[i + 1] === 'number' ? [] : {};
      }
      current = current[key];
    }
    current[step.k[step.k.length - 1]] = step.v;
  }

  return state;
}

function parseCopilotEventsJsonl(transcriptPath) {
  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  const events = [];
  let sessionStartTs = null;

  for (const line of lines) {
    try {
      const step = JSON.parse(line);

      if (step.type === 'session.start') {
        sessionStartTs = step.timestamp || step.data?.startTime || null;
        continue;
      }

      if (step.type === 'user.message' && step.data?.content) {
        const text = extractText(step.data.content);
        if (text) {
          events.push({
            ts: step.timestamp,
            kind: 'message',
            role: 'user',
            content: text,
            source: SOURCE,
          });
        }
      } else if (step.type === 'assistant.message' && step.data?.content) {
        const text = extractText(step.data.content);
        if (text) {
          events.push({
            ts: step.timestamp,
            kind: 'message',
            role: 'assistant',
            content: text,
            source: SOURCE,
          });
        }
      }
    } catch (_) { }
  }

  return { events, sessionStartTs };
}

function parseCopilotChatSession(chatSessionPath) {
  const content = fs.readFileSync(chatSessionPath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  if (!lines.length) return { events: [], sessionId: null, sessionStartTs: null };

  let firstStep;
  try {
    firstStep = JSON.parse(lines[0]);
  } catch (_) {
    return { events: [], sessionId: null, sessionStartTs: null };
  }

  if (firstStep.kind !== 0) {
    return parseCopilotEventsJsonl(chatSessionPath);
  }

  const state = foldChatSessionPatches(lines);
  if (!state) return { events: [], sessionId: null, sessionStartTs: null };

  const sessionId = state.sessionId || path.basename(chatSessionPath, '.jsonl');
  const sessionStartTs = state.creationDate
    ? new Date(state.creationDate).toISOString()
    : null;

  const events = [];
  const requests = Array.isArray(state.requests) ? state.requests : [];

  for (let i = 0; i < requests.length; i++) {
    const request = requests[i];
    const userText =
      extractUserRequest(request?.result?.metadata?.renderedUserMessage) ||
      (i === 0 && state.customTitle ? String(state.customTitle).trim() : null);

    if (userText) {
      events.push({
        ts: sessionStartTs,
        kind: 'message',
        role: 'user',
        content: userText,
        source: SOURCE,
        sessionId,
        requestIndex: i,
      });
    }
  }

  return { events, sessionId, sessionStartTs };
}

function findSiblingTranscript(chatSessionPath, sessionId) {
  const workspaceDir = path.dirname(path.dirname(chatSessionPath));
  const transcriptPath = path.join(
    workspaceDir,
    'GitHub.copilot-chat',
    'transcripts',
    `${sessionId}.jsonl`
  );
  return fs.existsSync(transcriptPath) ? transcriptPath : null;
}

function mergeCopilotEvents(userEvents, transcriptEvents, sessionStartTs) {
  const merged = userEvents.map(event => ({
    ...event,
    ts: sessionStartTs || event.ts,
  }));

  for (const event of transcriptEvents) {
    merged.push(event);
  }

  merged.sort((a, b) => {
    const ta = Date.parse(a.ts || '') || 0;
    const tb = Date.parse(b.ts || '') || 0;
    if (ta !== tb) return ta - tb;
    if (a.role === 'user' && b.role !== 'user') return -1;
    if (a.role !== 'user' && b.role === 'user') return 1;
    return 0;
  });

  if (sessionStartTs && merged.length) {
    const hasUser = merged.some(e => e.role === 'user');
    if (!hasUser) {
      merged.unshift({
        ts: sessionStartTs,
        kind: 'message',
        role: 'user',
        content: '(session started)',
        source: SOURCE,
      });
    }
  }

  return merged;
}

function parseSingleChatSession(chatSessionPath) {
  const { events: userEvents, sessionId, sessionStartTs } = parseCopilotChatSession(chatSessionPath);
  const transcriptFile = sessionId ? findSiblingTranscript(chatSessionPath, sessionId) : null;

  if (transcriptFile) {
    const { events: transcriptEvents, sessionStartTs: transcriptStartTs } =
      parseCopilotEventsJsonl(transcriptFile);
    return mergeCopilotEvents(
      userEvents,
      transcriptEvents,
      transcriptStartTs || sessionStartTs
    );
  }

  return userEvents;
}

function getWorkspaceStorageDir(inputPath) {
  if (!inputPath) return null;
  if (!fs.existsSync(inputPath)) return null;

  const stat = fs.statSync(inputPath);
  if (stat.isDirectory()) return inputPath;

  let dir = path.dirname(inputPath);
  while (dir && path.basename(dir) !== 'workspaceStorage') {
    const base = path.basename(dir);
    if (base === 'chatSessions' || base === 'transcripts' || base === 'GitHub.copilot-chat') {
      return path.dirname(path.dirname(dir));
    }
    if (fs.existsSync(path.join(dir, 'workspace.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

function listChatSessionFiles(workspaceStorageDir) {
  const dir = path.join(workspaceStorageDir, 'chatSessions');
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => path.join(dir, entry.name));
}

function assignEditTimestamps(codeEdits, sessionIndex) {
  return codeEdits.map(event => {
    const timing = sessionIndex?.entries?.[event.sessionId]?.timing;
    if (!timing) {
      return { ...event, ts: event.ts || null };
    }

    const start = Number(timing.lastRequestStarted || timing.created) || 0;
    const end = Number(timing.lastRequestEnded || timing.lastRequestStarted || start) || start;
    const span = Math.max(end - start, 1);
    const epoch = Number(event.epoch) || 0;
    const maxEpoch = 10;
    const ts = vscodeInternalTimeToIso(start + Math.floor((span * epoch) / maxEpoch));

    return { ...event, ts: ts || event.ts };
  }).filter(event => event.ts);
}

function parseCopilotWorkspace(workspaceStorageDir, options = {}) {
  const sessionIndex = readVscdbJson(
    path.join(workspaceStorageDir, 'state.vscdb'),
    'chat.ChatSessionStore.index'
  );

  const chatEvents = [];
  for (const chatSessionPath of listChatSessionFiles(workspaceStorageDir)) {
    chatEvents.push(...parseSingleChatSession(chatSessionPath));
  }

  const workspacePath =
    options.workspacePath || getWorkspacePathFromStorageDir(workspaceStorageDir);

  const sessionEdits = assignEditTimestamps(
    parseCopilotEditingSessions(workspaceStorageDir, sessionIndex),
    sessionIndex
  );

  const checkpoints = sessionEdits.filter(event => event.kind === 'checkpoint');
  const chatEditingEdits = sessionEdits.filter(event => event.kind === 'code_edit');

  const historyEdits = workspacePath
    ? scanHistoryForWorkspace(workspacePath, { roots: getCodeHistoryRoots() })
    : [];

  const enrichedSessionEdits = enrichEditsWithHistory(chatEditingEdits, historyEdits);
  const codeEdits = mergeCodeEditSources(historyEdits, enrichedSessionEdits);

  const events = [...chatEvents, ...codeEdits, ...checkpoints];
  events.sort((a, b) => {
    const ta = Date.parse(a.ts || '') || 0;
    const tb = Date.parse(b.ts || '') || 0;
    if (ta !== tb) return ta - tb;
    const kindOrder = { message: 0, code_edit: 1, artifact: 2, checkpoint: 3 };
    return (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9);
  });

  return {
    events,
    workspaceStorageDir,
    workspacePath,
    sessionIndex,
    sources: {
      chatSessions: listChatSessionFiles(workspaceStorageDir),
      editingSessions: listEditingSessionDirs(workspaceStorageDir).length,
      vscdb: fs.existsSync(path.join(workspaceStorageDir, 'state.vscdb')),
      localHistory: historyEdits.length,
    },
  };
}

// Reads Copilot chat + code edits from workspaceStorage (chatSessions, transcripts,
// chatEditingSessions, state.vscdb index, Code/User/History snapshots), or legacy paths.
function parseCopilot(transcriptPath, options = {}) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];

  const workspaceDir = getWorkspaceStorageDir(transcriptPath);
  if (workspaceDir && fs.statSync(transcriptPath).isDirectory()) {
    return parseCopilotWorkspace(workspaceDir, options).events;
  }

  if (workspaceDir && path.basename(path.dirname(transcriptPath)) === 'chatSessions') {
    return parseCopilotWorkspace(workspaceDir, options).events;
  }

  let firstLine;
  try {
    firstLine = fs.readFileSync(transcriptPath, 'utf-8').split('\n')[0];
  } catch (_) {
    return [];
  }

  let firstStep;
  try {
    firstStep = JSON.parse(firstLine);
  } catch (_) {
    return [];
  }

  if (firstStep.kind === 0) {
    return parseSingleChatSession(transcriptPath);
  }

  return parseCopilotEventsJsonl(transcriptPath).events;
}

module.exports = {
  parseCopilot,
  parseCopilotWorkspace,
  parseCopilotChatSession,
  parseCopilotEventsJsonl,
  foldChatSessionPatches,
  getWorkspaceStorageDir,
};
