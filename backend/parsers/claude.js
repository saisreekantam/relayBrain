const fs = require('fs');
const path = require('path');
const { normalizeTs, makeUnifiedDiff } = require('../lib/timeline');

const SOURCE = 'Claude Code';
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

function parseClaude(transcriptPath, options = {}) {
  const content = fs.readFileSync(transcriptPath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  const events = [];

  for (const line of lines) {
    try {
      const step = JSON.parse(line);
      const ts = normalizeTs(step.timestamp);

      if (step.type === 'user' && step.message?.role === 'user') {
        const contentArr = step.message.content;
        const text = Array.isArray(contentArr)
          ? contentArr.filter(c => c.type === 'text').map(c => c.text).join(' ')
          : String(contentArr);
        if (text.trim()) {
          events.push({
            ts,
            kind: 'message',
            role: 'user',
            content: text,
            source: SOURCE,
          });
        }
      } else if (step.type === 'assistant' && step.message?.role === 'assistant') {
        const contentArr = step.message.content;
        const parts = Array.isArray(contentArr) ? contentArr : [contentArr];
        const textParts = [];
        const toolUses = [];

        for (const part of parts) {
          if (!part || typeof part !== 'object') continue;
          if (part.type === 'text' && part.text) textParts.push(part.text);
          if (part.type === 'tool_use' && EDIT_TOOLS.has(part.name)) toolUses.push(part);
        }

        const text = textParts.join(' ').trim();
        if (text) {
          events.push({
            ts,
            kind: 'message',
            role: 'assistant',
            content: text,
            source: SOURCE,
          });
        }

        for (const tool of toolUses) {
          const input = tool.input || {};
          const filePath = input.file_path || input.path || null;
          if (!filePath) continue;

          let diff = null;
          let summary = `${tool.name} ${path.basename(filePath)}`;

          if (tool.name === 'Edit' && input.old_string != null && input.new_string != null) {
            diff = makeUnifiedDiff(input.old_string, input.new_string, path.basename(filePath));
            summary = `Edited ${path.basename(filePath)}`;
          } else if (tool.name === 'Write' && input.contents != null) {
            diff = makeUnifiedDiff('', input.contents, path.basename(filePath));
            summary = `Wrote ${path.basename(filePath)}`;
          }

          events.push({
            ts,
            kind: 'code_edit',
            role: 'assistant',
            source: SOURCE,
            file: path.basename(filePath),
            path: filePath,
            action: tool.name.toLowerCase(),
            summary,
            diff,
            toolUseId: tool.id || null,
          });
        }
      }
    } catch (_) { }
  }

  events.sort((a, b) => Date.parse(a.ts || '') - Date.parse(b.ts || ''));
  return events;
}

module.exports = { parseClaude };
