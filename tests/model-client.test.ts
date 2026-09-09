import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createModelClient } from '../src/lib/agent/model-client.ts';
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
});