import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildSystemPrompt,
  DEFAULT_SYSTEM_PROMPT,
  EXECUTION_PROMPT,
  FAST_EXECUTION_PROMPT,
  PLANNING_PROMPT,
  VERIFICATION_PROMPT
} from '../src/lib/agent/system-prompt.ts';
import { DEFAULT_AGENT_SETTINGS } from '../src/lib/agent/permissions.ts';
import type { AgentSettings } from '../src/types/index.ts';

function settings(overrides: Partial<AgentSettings> = {}): AgentSettings {
  return { ...DEFAULT_AGENT_SETTINGS, ...overrides };
}

describe('buildSystemPrompt', () => {
  it('always keeps the base persona and states the active policies', () => {
    const prompt = buildSystemPrompt({ settings: settings(), workspacePath: 'c:/tmp/ws' });
    assert.ok(prompt.startsWith(DEFAULT_SYSTEM_PROMPT));
    assert.match(prompt, /Fast Mode/);
    assert.match(prompt, /Always Proceed/);
    assert.match(prompt, /Workspace root: c:\/tmp\/ws/);
  });

  it('uses the planning contract and stops there in the plan phase', () => {
    const prompt = buildSystemPrompt({
      settings: settings({ executionMode: 'planning' }),
      phase: 'plan'
    });
    assert.ok(prompt.includes(PLANNING_PROMPT));
    assert.ok(!prompt.includes(EXECUTION_PROMPT));
    assert.ok(!prompt.includes(VERIFICATION_PROMPT));
  });

  it('folds steering feedback into a plan revision', () => {
    const prompt = buildSystemPrompt({
      settings: settings({ executionMode: 'planning' }),
      phase: 'plan',
      planFeedback: 'Split step 2 into two tasks'
    });
    assert.match(prompt, /USER FEEDBACK ON YOUR PREVIOUS PLAN/);
    assert.match(prompt, /Split step 2 into two tasks/);
  });

  it('adds the execution contract and the approved plan body', () => {
    const prompt = buildSystemPrompt({
      settings: settings({ executionMode: 'planning' }),
      phase: 'execute',
      approvedPlanBody: '## Setup\n- Write the parser'
    });
    assert.ok(prompt.includes(EXECUTION_PROMPT));
    assert.match(prompt, /APPROVED IMPLEMENTATION PLAN/);
    assert.match(prompt, /Write the parser/);
  });

  it('uses the Fast Mode contract, not the planning one, in Fast Mode execution', () => {
    const prompt = buildSystemPrompt({ settings: settings(), phase: 'execute' });
    assert.ok(prompt.includes(FAST_EXECUTION_PROMPT));
    assert.ok(!prompt.includes(EXECUTION_PROMPT));
    assert.match(prompt, /CALL A TOOL ON YOUR FIRST RESPONSE/);
  });

  it('does not leak the Fast Mode contract into the planning execute phase', () => {
    const prompt = buildSystemPrompt({
      settings: settings({ executionMode: 'planning' }),
      phase: 'execute',
      approvedPlanBody: '## Setup\n- Write the parser'
    });
    assert.ok(prompt.includes(EXECUTION_PROMPT));
    assert.ok(!prompt.includes(FAST_EXECUTION_PROMPT));
  });

  it('uses the verification contract in the verify phase', () => {
    const prompt = buildSystemPrompt({
      settings: settings({ executionMode: 'planning' }),
      phase: 'verify'
    });
    assert.ok(prompt.includes(VERIFICATION_PROMPT));
    assert.ok(!prompt.includes(EXECUTION_PROMPT));
  });

  it('directs actions to workspace-local dedicated tools', () => {
    const prompt = buildSystemPrompt({ settings: settings(), workspacePath: 'c:/tmp/ws' });
    assert.match(prompt, /Prefer it over shell redirection/i);
    assert.match(prompt, /Do not use it for file operations covered by a dedicated file tool/i);
    assert.match(prompt, /native tool calls/i);
    assert.match(prompt, /Never access paths outside that workspace/);
  });

  it('warns the model when commands may be held for review', () => {
    const held = buildSystemPrompt({
      settings: settings({ commandExecutionPolicy: 'request-review' })
    });
    assert.match(held, /may be held for user approval/);

    const auto = buildSystemPrompt({ settings: settings() });
    assert.ok(!/may be held for user approval/.test(auto));
  });
});
