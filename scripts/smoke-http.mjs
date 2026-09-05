/**
 * Streams one run through the live dev server's /api/chat and prints the SSE
 * event types it receives. Planning mode + request-review, so the run halts at
 * the Implementation Plan without writing files or running commands.
 *
 *   node scripts/smoke-http.mjs [model]
 */
const model = process.argv[2] || 'qwen3-vl:8b-instruct-q4_K_M';
const mode = process.argv[3] || 'planning';

import fs from 'fs';
import os from 'os';
import path from 'path';

// Point the agent at a throwaway sandbox so a stray write_file cannot touch the
// real project.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-smoke-'));

const body = {
  message: 'Add a /api/health route that returns the app version.',
  history: [],
  model,
  workspace: sandbox,
  settings: {
    executionMode: mode,
    artifactReviewPolicy: 'request-review',
    commandExecutionPolicy: 'request-review',
    allowList: [],
    denyList: []
  }
};

const res = await fetch('http://localhost:3000/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

console.log(`POST /api/chat -> ${res.status}`);
if (!res.ok) {
  console.log(await res.text());
  process.exit(1);
}

const counts = {};
let artifactKinds = [];
let runStatus = null;
let errorText = null;

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    let data;
    try {
      data = JSON.parse(line.slice(6));
    } catch {
      continue;
    }
    counts[data.type] = (counts[data.type] ?? 0) + 1;
    if (data.type === 'artifact' && data.artifact) {
      artifactKinds.push(`${data.artifact.kind}:${data.artifact.status}`);
    }
    if (data.type === 'done') runStatus = data.runStatus ?? 'completed';
    if (data.type === 'error') errorText = data.content;
    if (data.type === 'phase') console.log(`  [phase] ${data.content}`);
    if (data.type === 'awaiting_review') console.log(`  [awaiting_review] ${data.content}`);
  }
}

console.log('\nevent counts:', counts);
console.log('artifacts:', artifactKinds.length ? artifactKinds.join(', ') : '(none)');
console.log('runStatus:', runStatus);
if (errorText) console.log('error:', errorText);

// Fast mode's contract is "no planning gate", not "runs to completion" — with
// commandExecutionPolicy=request-review it legitimately halts on a command.
const planSeen = artifactKinds.some(a => a.startsWith('implementation-plan'));
const ok =
  !errorText &&
  (mode === 'planning' ? planSeen && runStatus === 'awaiting-review' : !planSeen);
console.log('sandbox:', sandbox);
console.log('sandbox files:', fs.readdirSync(sandbox).join(', ') || '(empty)');
fs.rmSync(sandbox, { recursive: true, force: true });
console.log(ok ? `\nSMOKE OK (${mode})` : `\nSMOKE FAILED (${mode})`);
// Cancel the reader before exiting; calling process.exit() with the SSE stream
// still open trips a libuv handle assertion on Windows.
await reader.cancel().catch(() => {});
process.exitCode = ok ? 0 : 1;
