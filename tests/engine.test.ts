import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodeNativeToolCalls, extractToolCallsFromText, runAgent } from '../src/lib/agent/engine.ts';
import type { AgentRuntime, AgentUpdate } from '../src/lib/agent/engine.ts';
import type {
  ModelCallMetadata,
  ModelClient,
  NonStreamingChatRequest
} from '../src/lib/agent/model-client.ts';
import type { AgentConfig, Message } from '../src/types/index.ts';
import type { ChatResponse, ToolCall } from 'ollama';

function response(content: string, toolCalls?: ToolCall[]): ChatResponse {
  return { message: { role: 'assistant', content, tool_calls: toolCalls } } as ChatResponse;
}

function config(maxIterations = 5): AgentConfig {
  return {
    model: 'qwen3:8b',
    systemPrompt: 'test',
    maxIterations,
    workspacePath: 'C:\\workspace',
    settings: {
      executionMode: 'fast',
      artifactReviewPolicy: 'always-proceed',
      commandExecutionPolicy: 'always-proceed',
      allowList: [],
      denyList: []
    }
  };
}

async function runWith(
  replies: ChatResponse[],
  goal: string,
  configOverride: Partial<AgentConfig> = {}
): Promise<{
  updates: AgentUpdate[];
  requests: NonStreamingChatRequest[];
  metadata: ModelCallMetadata[];
  executions: Array<{ name: string; args: unknown }>;
}> {
  const requests: NonStreamingChatRequest[] = [];
  const metadata: ModelCallMetadata[] = [];
  const executions: Array<{ name: string; args: unknown }> = [];
  const modelClient: ModelClient = {
    async chat(request, callMetadata) {
      requests.push(request);
      metadata.push(callMetadata);
      const next = replies.shift();
      assert.ok(next, 'unexpected model call');
      return next;
    },
    async recoverAction(request, callMetadata) {
      requests.push(request);
      metadata.push(callMetadata);
      const next = replies.shift();
      assert.ok(next, 'unexpected model recovery call');
      return next;
    }
  };
  const runtime: AgentRuntime = {
    modelClient,
    async executeTool(name, args) {
      executions.push({ name, args });
      const workspaceChanged = ['write_file', 'edit_file', 'copy_file', 'move_file', 'delete_file'].includes(name) ||
        (name === 'run_command' && typeof (args as { command?: unknown }).command === 'string' &&
          /set-content|new-item|remove-item|move-item|copy-item|>|mkdir|rm|del|mv|cp/i.test((args as { command: string }).command));
      return {
        ok: true,
        output: 'tool succeeded',
        effects: workspaceChanged
          ? [{ operation: name, paths: ['probe.txt'], workspaceChanged: true }]
          : []
      };
    }
  };
  const history: Message[] = [{ role: 'user', content: goal }];
  const updates: AgentUpdate[] = [];
  for await (const update of runAgent({ ...config(), ...configOverride }, history, runtime)) {
    updates.push(update);
  }
  return { updates, requests, metadata, executions };
}

describe('Qwen tool-call parsing', () => {
  it('accepts tagged, wrapped, array, and string-argument calls', () => {
    assert.deepEqual(
      extractToolCallsFromText(
        '<tool_call>{"function":{"name":"run_command","arguments":"{\\"command\\":\\"npm test\\"}"}}</tool_call>'
      ).map(({ name, args }) => ({ name, args })),
      [{ name: 'run_command', args: { command: 'npm test' } }]
    );
    assert.deepEqual(
      extractToolCallsFromText(
        '[{"name":"list_directory","arguments":{}},{"function_call":{"name":"read_file","arguments":{"filePath":"a.ts"}}}]'
      ).map(({ name, args }) => ({ name, args })),
      [
        { name: 'list_directory', args: {} },
        { name: 'read_file', args: { filePath: 'a.ts' } }
      ]
    );
  });

  it('rejects unknown tools instead of treating prose as executable', () => {
    assert.deepEqual(
      extractToolCallsFromText('{"name":"invent_shell","arguments":{"command":"whoami"}}'),
      []
    );
  });

  it('does not execute JSON examples embedded in prose', () => {
    assert.deepEqual(
      extractToolCallsFromText('For example, use {"name":"read_file","arguments":{"filePath":"secret.txt"}}.'),
      []
    );
  });

  it('validates required arguments and types', () => {
    const missing = decodeNativeToolCalls([
      { function: { name: 'write_file', arguments: { filePath: 'a.txt' } } }
    ]);
    assert.equal(missing.calls.length, 0);
    assert.match(missing.errors.join(' '), /content is required/);

    const wrongType = decodeNativeToolCalls([
      { function: { name: 'delete_file', arguments: { filePath: 'a.txt', recursive: 'yes' } } }
    ]);
    assert.equal(wrongType.calls.length, 0);
    assert.match(wrongType.errors.join(' '), /recursive must be a boolean/);
  });
});

describe('agent tool execution', () => {
  it('executes a native Ollama call and returns the tool result to Qwen', async () => {
    const native: ToolCall = {
      function: { name: 'run_command', arguments: { command: 'Set-Content probe.txt OK' } }
    };
    const result = await runWith(
      [response('', [native]), response('Created probe.txt.')],
      'Create probe.txt containing OK'
    );

    assert.deepEqual(result.executions, [
      { name: 'run_command', args: { command: 'Set-Content probe.txt OK' } }
    ]);
    assert.deepEqual(result.metadata, [
      { phase: 'execute', iteration: 1 },
      { phase: 'execute', iteration: 2 },
      { phase: 'execute', iteration: 2 }
    ]);
    assert.equal(result.requests[1].messages?.at(-1)?.tool_name, 'run_command');
    assert.ok(result.updates.some(update => update.type === 'tool_call'));
    assert.ok(result.updates.some(update => update.type === 'tool_result'));
  });

  it('corrects a non-shell tool when the user explicitly requests PowerShell', async () => {
    const writeFile: ToolCall = {
      function: { name: 'write_file', arguments: { filePath: 'probe.txt', content: 'OK' } }
    };
    const runCommand: ToolCall = {
      function: { name: 'run_command', arguments: { command: "Set-Content 'probe.txt' OK" } }
    };
    const result = await runWith(
      [response('', [writeFile]), response('', [runCommand]), response('Done.')],
      'Create probe.txt using PowerShell'
    );

    assert.deepEqual(result.executions, [
      { name: 'run_command', args: { command: "Set-Content 'probe.txt' OK" } }
    ]);
    assert.match(String(result.requests[1].messages?.at(-1)?.content), /explicitly requested shell/);
  });

  it('does not force run_command when "command" only appears as a noun (e.g. command-line parser)', async () => {
    // Regression: requestsShellExecution matched the bare word "command", so a
    // build request that merely mentions "command-line" wrongly discarded a
    // valid write_file and failed the run demanding a shell call.
    const writeFile: ToolCall = {
      function: { name: 'write_file', arguments: { filePath: 'parser.js', content: '// cli' } }
    };
    const result = await runWith(
      [response('', [writeFile]), response('Done.')],
      'Create a command-line argument parser in parser.js'
    );

    assert.deepEqual(result.executions, [
      { name: 'write_file', args: { filePath: 'parser.js', content: '// cli' } }
    ]);
    assert.ok(!result.updates.some(update =>
      update.type === 'error' && update.content?.includes('run_command')
    ));
  });

  it('retries prose-only action responses instead of claiming success', async () => {
    const result = await runWith(
      [
        response('I will create that file now.'),
        response(JSON.stringify({
          action: { name: 'run_command', arguments: { command: 'New-Item probe.txt' } },
          completed: false,
          reason: 'Create the requested file.'
        })),
        response('Done.')
      ],
      'Create probe.txt'
    );

    assert.equal(result.executions.length, 1);
    assert.match(
      String(result.requests[1].messages?.at(-1)?.content),
      /contained no valid explicit tool call/
    );
    assert.equal(result.requests[1].tools, undefined);
    assert.ok(!result.updates.some(update =>
      update.type === 'text' && update.content?.includes('I will create')
    ));
  });

  it('fails explicitly after the bounded correction when Qwen still returns prose', async () => {
    const result = await runWith(
      [
        response('I will do it.'),
        response('not valid recovery JSON'),
        response('Creating it now.'),
        response('still not valid recovery JSON')
      ],
      'Create probe.txt'
    );

    assert.equal(result.executions.length, 0);
    assert.ok(result.updates.some(update =>
      update.type === 'error' && update.content?.includes('did not complete the requested action')
    ));
    assert.ok(!result.updates.some(update => update.type === 'text'));
  });

  it('falls back to an explicit text call when all native calls are invalid', async () => {
    const malformed: ToolCall = {
      function: { name: 'unknown_write', arguments: {} }
    };
    const result = await runWith(
      [
        response(
          '<tool_call>{"name":"write_file","arguments":{"filePath":"probe.txt","content":"OK"}}</tool_call>',
          [malformed]
        ),
        response(JSON.stringify({ action: null, completed: true, reason: 'The file was created.' }))
      ],
      'Create probe.txt containing OK'
    );

    assert.deepEqual(result.executions, [
      { name: 'write_file', args: { filePath: 'probe.txt', content: 'OK' } }
    ]);
  });

  it('executes via the schema-constrained envelope in schema mode', async () => {
    // Schema mode: every model turn is the constrained {action, completed,
    // reason} envelope decoded directly — one tool call per turn, then a
    // completion. The user-facing text is the envelope's `reason`, never the
    // raw JSON.
    const result = await runWith(
      [
        response(JSON.stringify({
          action: { name: 'run_command', arguments: { command: 'New-Item probe.txt' } },
          completed: false,
          reason: 'Creating the file.'
        })),
        response(JSON.stringify({
          action: null,
          completed: true,
          reason: 'Created probe.txt.'
        }))
      ],
      'Create probe.txt',
      { toolCallMode: 'schema' }
    );

    assert.deepEqual(result.executions, [
      { name: 'run_command', args: { command: 'New-Item probe.txt' } }
    ]);
    // Final text is the human-readable reason, not the JSON envelope.
    const texts = result.updates.filter(u => u.type === 'text').map(u => u.content);
    assert.ok(texts.includes('Created probe.txt.'));
    assert.ok(!texts.some(t => t?.includes('"completed"')), 'raw envelope JSON leaked to text');
  });

  it('allows direct answers for informational questions', async () => {
    const result = await runWith(
      [response('A file is a named collection of data.')],
      'What is a file?'
    );

    assert.equal(result.executions.length, 0);
    assert.ok(result.updates.some(update =>
      update.type === 'text' && update.content?.includes('named collection')
    ));
  });

  it('recovers a prose-only response to an Arabic action request', async () => {
    // Regression: an Arabic goal used to be classified as non-actionable, so
    // the model could answer with a plan (prose) and the run would end having
    // executed nothing instead of recovering into a real tool call.
    const result = await runWith(
      [
        response('سأقوم بإنشاء الملف الآن.'),
        response(JSON.stringify({
          action: { name: 'run_command', arguments: { command: 'New-Item probe.txt' } },
          completed: false,
          reason: 'Create the requested file.'
        })),
        response('تم.')
      ],
      'أنشئ ملف probe.txt'
    );

    assert.equal(result.executions.length, 1);
    assert.match(
      String(result.requests[1].messages?.at(-1)?.content),
      /contained no valid explicit tool call/
    );
    assert.ok(!result.updates.some(update =>
      update.type === 'text' && update.content?.includes('سأقوم بإنشاء')
    ));
  });

  it('answers an Arabic informational question directly without tools', async () => {
    const result = await runWith(
      [response('الملف هو مجموعة من البيانات لها اسم.')],
      'ما هو الملف؟'
    );

    assert.equal(result.executions.length, 0);
    assert.ok(result.updates.some(update =>
      update.type === 'text' && update.content?.includes('مجموعة من البيانات')
    ));
  });
});