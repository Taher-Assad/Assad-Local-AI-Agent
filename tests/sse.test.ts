import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SseParser } from '../src/lib/sse.ts';

describe('SseParser', () => {
  it('preserves event and data across arbitrary chunks', () => {
    const parser = new SseParser();
    assert.deepEqual(parser.push('event: tool_'), []);
    assert.deepEqual(parser.push('call\ndata: {"type":"tool_call"}\n'), []);
    assert.deepEqual(parser.push('\n'), [
      { event: 'tool_call', data: '{"type":"tool_call"}' }
    ]);
  });

  it('joins multiple data lines and flushes the final event', () => {
    const parser = new SseParser();
    parser.push('event: text\ndata: first\ndata: second');
    assert.deepEqual(parser.finish(), [
      { event: 'text', data: 'first\nsecond' }
    ]);
  });

  it('handles CRLF and more than one event per chunk', () => {
    const parser = new SseParser();
    assert.deepEqual(parser.push(
      'event: thinking\r\ndata: one\r\n\r\nevent: done\r\ndata: two\r\n\r\n'
    ), [
      { event: 'thinking', data: 'one' },
      { event: 'done', data: 'two' }
    ]);
  });
});
