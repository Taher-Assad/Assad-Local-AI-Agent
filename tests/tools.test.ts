import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { executeTool, validateWorkspaceCommand } from '../src/lib/agent/tools/index.ts';

describe('workspace tool containment', () => {
  it('rejects sibling-prefix paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assad-agent-'));
    const workspace = path.join(root, 'workspace');
    const sibling = path.join(root, 'workspace-other', 'probe.txt');
    fs.mkdirSync(workspace);

    const result = await executeTool(
      'write_file',
      { filePath: sibling, content: 'outside' },
      workspace
    );

    assert.match(result, /outside the workspace/);
    assert.equal(fs.existsSync(sibling), false);
  });

  it('blocks PowerShell location and parent traversal escapes', () => {
    assert.match(validateWorkspaceCommand('Set-Content ..\\probe.txt nope') ?? '', /outside/);
    assert.match(validateWorkspaceCommand("Set-Content 'C:\\Windows\\probe.txt' nope") ?? '', /outside/);
    assert.match(validateWorkspaceCommand('Set-Location C:\\Windows') ?? '', /outside/);
    assert.match(validateWorkspaceCommand('Get-ChildItem Registry::') ?? '', /outside/);
    assert.equal(validateWorkspaceCommand("Set-Content 'probe.txt' OK"), null);
  });

  it('runs a shell command in the selected workspace', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'assad-agent-shell-'));
    const command = process.platform === 'win32'
      ? "Set-Content -LiteralPath 'probe.txt' -Value 'OK' -NoNewline"
      : "printf OK > probe.txt";

    const result = await executeTool('run_command', { command }, workspace);

    assert.doesNotMatch(result, /^Error/);
    assert.equal(fs.readFileSync(path.join(workspace, 'probe.txt'), 'utf8'), 'OK');
  });
});