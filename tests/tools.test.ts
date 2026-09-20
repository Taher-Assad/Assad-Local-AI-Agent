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

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'OUTSIDE_WORKSPACE');
    assert.equal(fs.existsSync(sibling), false);
  });

  it('blocks escapes but permits absolute paths inside the workspace', () => {
    const workspace = path.resolve(os.tmpdir(), 'assad-agent-command');
    const inside = path.join(workspace, 'probe.txt');

    assert.match(validateWorkspaceCommand('Set-Content ..\\probe.txt nope', workspace) ?? '', /outside/);
    assert.match(validateWorkspaceCommand("Set-Content 'C:\\Windows\\probe.txt' nope", workspace) ?? '', /outside/);
    assert.match(validateWorkspaceCommand('Set-Location C:\\Windows', workspace) ?? '', /outside/);
    assert.match(validateWorkspaceCommand('Get-ChildItem Registry::', workspace) ?? '', /outside/);
    assert.equal(validateWorkspaceCommand(`Set-Content '${inside}' OK`, workspace), null);
    assert.equal(validateWorkspaceCommand("Set-Content 'probe.txt' OK", workspace), null);
  });

  it('runs a shell command in the selected workspace', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'assad-agent-shell-'));
    const command = process.platform === 'win32'
      ? "Set-Content -LiteralPath 'probe.txt' -Value 'OK' -NoNewline"
      : "printf OK > probe.txt";

    const result = await executeTool('run_command', { command }, workspace);

    assert.equal(result.ok, true, result.output);
    assert.equal(result.command?.exitCode, 0);
    assert.equal(fs.readFileSync(path.join(workspace, 'probe.txt'), 'utf8'), 'OK');
  });
});

describe('typed workspace operations', () => {
  it('writes, reads, edits, copies, moves, and deletes files', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'assad-agent-files-'));

    const wrote = await executeTool('write_file', { filePath: 'nested/a.txt', content: 'one' }, workspace);
    assert.equal(wrote.ok, true);
    assert.equal(wrote.effects[0]?.workspaceChanged, true);
    assert.deepEqual(wrote.effects[0]?.paths, ['nested/a.txt']);

    const read = await executeTool('read_file', { filePath: 'nested/a.txt' }, workspace);
    assert.equal(read.output, 'one');

    const edited = await executeTool(
      'edit_file',
      { filePath: 'nested/a.txt', targetText: 'one', replacementText: 'two' },
      workspace
    );
    assert.equal(edited.ok, true);

    const copied = await executeTool(
      'copy_file',
      { sourcePath: 'nested/a.txt', destinationPath: 'copy.txt' },
      workspace
    );
    assert.equal(copied.ok, true);
    assert.equal(fs.readFileSync(path.join(workspace, 'copy.txt'), 'utf8'), 'two');

    const moved = await executeTool(
      'move_file',
      { sourcePath: 'copy.txt', destinationPath: 'moved.txt' },
      workspace
    );
    assert.equal(moved.ok, true);
    assert.equal(fs.existsSync(path.join(workspace, 'copy.txt')), false);

    const deleted = await executeTool('delete_file', { filePath: 'moved.txt' }, workspace);
    assert.equal(deleted.ok, true);
    assert.equal(fs.existsSync(path.join(workspace, 'moved.txt')), false);
  });

  it('refuses overwrite and non-recursive deletion of non-empty directories', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'assad-agent-conflict-'));
    fs.mkdirSync(path.join(workspace, 'dir'));
    fs.writeFileSync(path.join(workspace, 'dir', 'a.txt'), 'a');
    fs.writeFileSync(path.join(workspace, 'dest.txt'), 'dest');

    const copy = await executeTool(
      'copy_file',
      { sourcePath: 'dir/a.txt', destinationPath: 'dest.txt' },
      workspace
    );
    assert.equal(copy.ok, false);
    assert.equal(copy.error?.code, 'CONFLICT');

    const nonRecursive = await executeTool('delete_file', { filePath: 'dir' }, workspace);
    assert.equal(nonRecursive.ok, false);
    assert.equal(nonRecursive.error?.code, 'CONFLICT');

    const recursive = await executeTool('delete_file', { filePath: 'dir', recursive: true }, workspace);
    assert.equal(recursive.ok, true);
  });

  it('returns command failure diagnostics', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'assad-agent-command-fail-'));
    const command = process.platform === 'win32'
      ? "[Console]::Error.Write('bad'); exit 7"
      : "printf bad >&2; exit 7";

    const result = await executeTool('run_command', { command }, workspace);

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'COMMAND_FAILED');
    assert.match(result.command?.stderr ?? '', /bad/);
    assert.equal(result.command?.exitCode, 7);
  });
});
