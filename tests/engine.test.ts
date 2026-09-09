import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractToolCallsFromText, runAgent } from '../src/lib/agent/engine.ts';
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
  goal: string
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
    }
  };
  const runtime: AgentRuntime = {
    modelClient,
    async executeTool(name, args) {
      executions.push({ name, args });
      return 'tool succeeded';
    }
  };
  const history: Message[] = [{ role: 'user', content: goal }];
  const updates: AgentUpdate[] = [];
  for await (const update of runAgent(config(), history, runtime)) updates.push(update);
  return { updates, requests, metadata, executions };
}

describe('Qwen tool-call parsing', () => {
  it('accepts tagged, wrapped, array, and string-argument calls', () => {
    assert.deepEqual(
      extractToolCallsFromText(
        '<tool_call>{"function":{"name":"run_command","arguments":"{\\"command\\":\\"npm test\\"}"}}</tool_call>'
      ),
      [{ name: 'run_command', args: { command: 'npm test' } }]
    );
    assert.deepEqual(
      extractToolCallsFromText(
        '[{"name":"list_directory","arguments":{}},{"function_call":{"name":"read_file","arguments":{"filePath":"a.ts"}}}]'
      ),
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

  it('retries prose-only action responses instead of claiming success', async () => {
    const result = await runWith(
      [
        response('I will create that file now.'),
        response('<tool_call>{"name":"run_command","arguments":{"command":"New-Item probe.txt"}}</tool_call>'),
        response('Done.')
      ],
      'Create probe.txt'
    );

    assert.equal(result.executions.length, 1);
    assert.match(
      String(result.requests[1].messages?.at(-1)?.content),
      /did not call a tool/
    );
    assert.ok(!result.updates.some(update =>
      update.type === 'text' && update.content?.includes('I will create')
    ));
  });

  it('fails explicitly after the bounded correction when Qwen still returns prose', async () => {
    const result = await runWith(
      [response('I will do it.'), response('Creating it now.')],
      'Create probe.txt'
    );

    assert.equal(result.executions.length, 0);
    assert.ok(result.updates.some(update =>
      update.type === 'error' && update.content?.includes('Nothing was executed')
    ));
    assert.ok(!result.updates.some(update => update.type === 'text'));
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
});