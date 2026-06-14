const fs = require('fs');
const path = require('path');
const { normalizeTs } = require('../lib/timeline');

const SOURCE = 'Codex';
const EDIT_TOOL_NAMES = new Set([
  'apply_patch',
  'write',
  'edit_file',
  'create_file',
  'patch_file',
]);

function parseCodex(transcriptPath) {
  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  const events = [];

  for (const line of lines) {
    try {
      const step = JSON.parse(line);
      const ts = normalizeTs(step.timestamp);

      if (step.type === 'event_msg') {
        const p = step.payload;
        if (p.type === 'user_message') {
          events.push({
            ts,
            kind: 'message',
            role: 'user',
            content: (p.message || ''),
            source: SOURCE,
          });
        } else if (p.type === 'agent_message') {
          events.push({
            ts,
            kind: 'message',
            role: 'assistant',
            content: (p.message || ''),
            source: SOURCE,
          });
        }
      } else if (step.type === 'response_item' && step.payload?.type === 'function_call') {
        const payload = step.payload;
        const name = payload.name || '';
        if (!EDIT_TOOL_NAMES.has(name)) continue;

        let args = {};
        try {
          args = JSON.parse(payload.arguments || '{}');
        } catch (_) { }

        const filePath =
          args.path ||
          args.file_path ||
          args.file ||
          extractPathFromPatch(args.patch || args.input || '') ||
          null;

        events.push({
          ts,
          kind: 'code_edit',
          role: 'assistant',
          source: SOURCE,
          file: filePath ? path.basename(filePath) : null,
          path: filePath,
          action: name,
          summary: `${name}${filePath ? `: ${path.basename(filePath)}` : ''}`,
          diff: typeof args.patch === 'string' ? args.patch : null,
          callId: payload.call_id || null,
        });
      }
    } catch (_) { }
  }

  events.sort((a, b) => Date.parse(a.ts || '') - Date.parse(b.ts || ''));
  return events;
}

function extractPathFromPatch(patchText) {
  if (!patchText || typeof patchText !== 'string') return null;
  const match = patchText.match(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

module.exports = { parseCodex };
