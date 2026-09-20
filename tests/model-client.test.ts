import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { aggregateChatStream, createModelClient } from '../src/lib/agent/model-client.ts';
import type { ModelCallMetric, NonStreamingChatRequest } from '../src/lib/agent/model-client.ts';
import type { ChatResponse } from 'ollama';

describe('createModelClient', () => {
  it('forwards non-streaming requests and records call metadata', async () => {
    let forwarded: NonStreamingChatRequest | undefined;
    let metric: ModelCallMetric | undefined;
    const client = createModelClient({
      keepAlive: '5m',
      chat: async request => {
        forwarded = request;
        return {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 'list_directory', arguments: {} } }]
          }
        } as ChatResponse;
      },
      metricsSink: value => {
        metric = value;
      }
    });

    await client.chat(
      { model: 'qwen3:8b', messages: [{ role: 'user', content: 'list files' }], tools: [] },
      { phase: 'execute', iteration: 3 }
    );

    assert.equal(forwarded?.stream, undefined);
    assert.equal(forwarded?.keep_alive, '5m');
    assert.equal(metric?.phase, 'execute');
    assert.equal(metric?.iteration, 3);
    assert.equal(metric?.responseToolCallCount, 1);
    assert.equal(metric?.success, true);
  });

  it('forwards a JSON schema for constrained action recovery without tools', async () => {
    let forwarded: NonStreamingChatRequest | undefined;
    const client = createModelClient({
      keepAlive: null,
      chat: async request => {
        forwarded = request;
        return { message: { role: 'assistant', content: '{}' } } as ChatResponse;
      }
    });
    const format = { type: 'object', properties: { completed: { type: 'boolean' } } };

    await client.recoverAction(
      { model: 'qwen3.5:9b', messages: [{ role: 'user', content: 'act' }], tools: [] },
      { phase: 'execute', iteration: 2 },
      format
    );

    assert.deepEqual(forwarded?.format, format);
    assert.equal(forwarded?.tools, undefined);
  });
});

describe('aggregateChatStream', () => {
  const part = (content: string, extra: Partial<ChatResponse> = {}): ChatResponse =>
    ({ message: { role: 'assistant', content }, ...extra } as ChatResponse);

  it('concatenates content deltas and keeps the final timing fields', () => {
    const result = aggregateChatStream([
      part('Hel'),
      part('lo, '),
      part('world', { done: true, total_duration: 1234, eval_count: 42 } as Partial<ChatResponse>)
    ]);

    assert.equal(result.message.content, 'Hello, world');
    assert.equal(result.message.role, 'assistant');
    assert.equal(result.total_duration, 1234);
    assert.equal(result.eval_count, 42);
  });

  it('collects tool calls emitted across parts', () => {
    const result = aggregateChatStream([
      part(''),
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'write_file', arguments: { filePath: 'a.ts', content: 'x' } } }]
        }
      } as unknown as ChatResponse,
      part('', { done: true } as Partial<ChatResponse>)
    ]);

    assert.equal(result.message.tool_calls?.length, 1);
    assert.equal(result.message.tool_calls?.[0].function.name, 'write_file');
  });

  it('returns an empty assistant message for an empty stream', () => {
    const result = aggregateChatStream([]);
    assert.equal(result.message.role, 'assistant');
    assert.equal(result.message.content, '');
    assert.equal(result.message.tool_calls, undefined);
  });
});