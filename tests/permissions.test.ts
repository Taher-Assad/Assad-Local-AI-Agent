import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyTool,
  DEFAULT_AGENT_SETTINGS,
  DEFAULT_ALLOW_LIST,
  DEFAULT_DENY_LIST,
  evaluateToolPermission,
  isAllowListedCommand,
  isDeniedCommand,
  isSandboxSafeCommand,
  requiresPlanApproval,
  resolveSettings,
  withApprovedCommands
} from '../src/lib/agent/permissions.ts';
import type { AgentSettings } from '../src/types/index.ts';

function settings(overrides: Partial<AgentSettings> = {}): AgentSettings {
  return { ...DEFAULT_AGENT_SETTINGS, ...overrides };
}

describe('classifyTool', () => {
  it('classifies the built-in tools', () => {
    assert.equal(classifyTool('read_file'), 'read');
    assert.equal(classifyTool('list_directory'), 'read');
    assert.equal(classifyTool('search_files'), 'read');
    assert.equal(classifyTool('file_info'), 'read');
    assert.equal(classifyTool('view_image'), 'read');
    assert.equal(classifyTool('write_file'), 'write');
    assert.equal(classifyTool('edit_file'), 'write');
    assert.equal(classifyTool('copy_file'), 'write');
    assert.equal(classifyTool('move_file'), 'write');
    assert.equal(classifyTool('delete_file'), 'write');
    assert.equal(classifyTool('run_command'), 'command');
  });

  it('treats an unknown tool as the most dangerous class', () => {
    assert.equal(classifyTool('launch_missiles'), 'command');
  });
});

describe('resolveSettings', () => {
  it('falls back to Fast Mode + Always Proceed', () => {
    const resolved = resolveSettings(undefined);
    assert.equal(resolved.executionMode, 'fast');
    assert.equal(resolved.artifactReviewPolicy, 'always-proceed');
    assert.equal(resolved.commandExecutionPolicy, 'always-proceed');
    assert.deepEqual(resolved.allowList, DEFAULT_ALLOW_LIST);
  });

  it('keeps valid values and repairs invalid ones', () => {
    const resolved = resolveSettings({
      executionMode: 'planning',
      // @ts-expect-error deliberately invalid input from an untrusted client
      artifactReviewPolicy: 'whatever',
      commandExecutionPolicy: 'proceed-in-sandbox'
    });
    assert.equal(resolved.executionMode, 'planning');
    assert.equal(resolved.artifactReviewPolicy, 'always-proceed');
    assert.equal(resolved.commandExecutionPolicy, 'proceed-in-sandbox');
  });

  it('always keeps the built-in deny list when a custom one is supplied', () => {
    const resolved = resolveSettings({ denyList: ['my-own-danger'] });
    assert.ok(resolved.denyList.includes('my-own-danger'));
    for (const entry of DEFAULT_DENY_LIST) {
      assert.ok(resolved.denyList.includes(entry), `${entry} must survive`);
    }
  });
});

describe('withApprovedCommands', () => {
  it('allow-lists an approved command so it is not re-reviewed', () => {
    const base = settings({ commandExecutionPolicy: 'request-review' });
    assert.equal(
      evaluateToolPermission('run_command', { command: 'python deploy.py' }, base).decision,
      'request-review'
    );

    const next = withApprovedCommands(base, ['python deploy.py']);
    assert.equal(
      evaluateToolPermission('run_command', { command: 'python deploy.py' }, next).decision,
      'allow'
    );
  });

  it('still refuses a denied command that the user tried to approve', () => {
    const next = withApprovedCommands(settings(), ['rm -rf /']);
    assert.equal(
      evaluateToolPermission('run_command', { command: 'rm -rf /' }, next).decision,
      'deny'
    );
  });

  it('returns the same object when there is nothing to approve', () => {
    const base = settings();
    assert.equal(withApprovedCommands(base, []), base);
    assert.equal(withApprovedCommands(base, undefined), base);
    assert.equal(withApprovedCommands(base, ['  ']), base);
  });
});

describe('command matching', () => {
  it('detects denied commands regardless of spacing or case', () => {
    assert.equal(isDeniedCommand('RM -RF /', DEFAULT_DENY_LIST), true);
    assert.equal(isDeniedCommand('git   push --force origin main', DEFAULT_DENY_LIST), true);
    assert.equal(isDeniedCommand('npm test', DEFAULT_DENY_LIST), false);
  });

  it('matches allow-list entries by prefix, not substring', () => {
    assert.equal(isAllowListedCommand('npm test', DEFAULT_ALLOW_LIST), true);
    assert.equal(isAllowListedCommand('npm test -- --watch', DEFAULT_ALLOW_LIST), true);
    assert.equal(isAllowListedCommand('sudo npm test', DEFAULT_ALLOW_LIST), false);
  });

  it('does not let allow-listed echo bypass mutation checks', () => {
    assert.equal(isAllowListedCommand('echo unsafe > ..\\outside.txt', DEFAULT_ALLOW_LIST), false);
    assert.equal(
      isAllowListedCommand("echo safe | Set-Content 'inside.txt'", DEFAULT_ALLOW_LIST),
      false
    );
  });

  it('treats read-only commands as sandbox safe', () => {
    assert.equal(isSandboxSafeCommand('git status'), true);
    assert.equal(isSandboxSafeCommand('npx tsc --noEmit'), true);
    assert.equal(isSandboxSafeCommand('rm -r build'), false);
    assert.equal(isSandboxSafeCommand('echo hi > file.txt'), false);
    assert.equal(isSandboxSafeCommand('npm install left-pad'), false);
    assert.equal(isSandboxSafeCommand('python train.py'), false);
  });
});

describe('evaluateToolPermission', () => {
  it('always allows read-only tools', () => {
    for (const tool of ['read_file', 'list_directory', 'search_files', 'file_info', 'view_image']) {
      const result = evaluateToolPermission(
        tool,
        {},
        settings({ commandExecutionPolicy: 'request-review' })
      );
      assert.equal(result.decision, 'allow', tool);
    }
  });

  it('allows workspace writes; the plan gate happens earlier', () => {
    const result = evaluateToolPermission(
      'write_file',
      { filePath: 'a.ts' },
      settings({ commandExecutionPolicy: 'request-review' })
    );
    assert.equal(result.decision, 'allow');
  });

  it('denies destructive commands even under Always Proceed', () => {
    const result = evaluateToolPermission(
      'run_command',
      { command: 'rm -rf /' },
      settings({ commandExecutionPolicy: 'always-proceed' })
    );
    assert.equal(result.decision, 'deny');
    assert.match(result.reason, /deny list/);
  });

  it('denies a run_command call with no command', () => {
    assert.equal(evaluateToolPermission('run_command', {}, settings()).decision, 'deny');
    assert.equal(
      evaluateToolPermission('run_command', { command: '   ' }, settings()).decision,
      'deny'
    );
  });

  it('allows allow-listed commands even under Request Review', () => {
    const result = evaluateToolPermission(
      'run_command',
      { command: 'npm test' },
      settings({ commandExecutionPolicy: 'request-review' })
    );
    assert.equal(result.decision, 'allow');
    assert.match(result.reason, /allow list/);
  });

  it('holds unknown commands for review under Request Review', () => {
    const result = evaluateToolPermission(
      'run_command',
      { command: 'python deploy.py' },
      settings({ commandExecutionPolicy: 'request-review' })
    );
    assert.equal(result.decision, 'request-review');
    assert.equal(result.command, 'python deploy.py');
  });

  it('splits read-only from mutating commands in sandbox mode', () => {
    const sandbox = settings({ commandExecutionPolicy: 'proceed-in-sandbox' });

    const safe = evaluateToolPermission('run_command', { command: 'pwd' }, sandbox);
    assert.equal(safe.decision, 'allow');
    assert.equal(safe.sandboxed, true);

    const risky = evaluateToolPermission('run_command', { command: 'python deploy.py' }, sandbox);
    assert.equal(risky.decision, 'request-review');
  });

  it('auto-runs anything not denied under Always Proceed', () => {
    const result = evaluateToolPermission(
      'run_command',
      { command: 'python train.py' },
      settings({ commandExecutionPolicy: 'always-proceed' })
    );
    assert.equal(result.decision, 'allow');
  });

  it('routes unknown tools through the command policy', () => {
    const result = evaluateToolPermission(
      'mystery_tool',
      {},
      settings({ commandExecutionPolicy: 'request-review' })
    );
    assert.equal(result.decision, 'deny', 'no command string to review');
  });
});

describe('requiresPlanApproval', () => {
  it('only halts in Planning Mode with Request Review', () => {
    assert.equal(
      requiresPlanApproval(
        settings({ executionMode: 'planning', artifactReviewPolicy: 'request-review' })
      ),
      true
    );
    assert.equal(
      requiresPlanApproval(
        settings({ executionMode: 'planning', artifactReviewPolicy: 'always-proceed' })
      ),
      false
    );
    assert.equal(
      requiresPlanApproval(
        settings({ executionMode: 'fast', artifactReviewPolicy: 'request-review' })
      ),
      false
    );
  });
});
