export interface ServerSentEvent {
  event: string;
  data: string;
  id?: string;
}

/**
 * Incremental SSE parser. Events are emitted only at a blank line, except that
 * finish() also emits a valid final event when the response ends without one.
 */
export class SseParser {
  private buffer = '';

  push(chunk: string): ServerSentEvent[] {
    this.buffer += chunk;
    return this.drain(false);
  }

  finish(): ServerSentEvent[] {
    return this.drain(true);
  }

  private drain(atEof: boolean): ServerSentEvent[] {
    const blocks = this.buffer.split(/(?:\r\n\r\n|\n\n|\r\r)/);
    this.buffer = blocks.pop() ?? '';

    if (atEof && this.buffer.length > 0) {
      blocks.push(this.buffer);
      this.buffer = '';
    }

    return blocks
      .map(parseEventBlock)
      .filter((event): event is ServerSentEvent => event !== null);
  }
}

function parseEventBlock(block: string): ServerSentEvent | null {
  let event = 'message';
  let id: string | undefined;
  const data: string[] = [];

  for (const line of block.split(/\r\n|\r|\n/)) {
    if (line === '' || line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id' && !value.includes('\0')) id = value;
  }

  if (data.length === 0) return null;
  return { event, data: data.join('\n'), ...(id === undefined ? {} : { id }) };
}
