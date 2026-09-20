import ollama, { type ChatRequest, type ChatResponse } from 'ollama';

export const DEFAULT_KEEP_ALIVE = '15m';
export const MODEL_METRICS_PREFIX = 'AGENT_MODEL_METRIC ';

export interface ModelCallMetadata {
  phase: 'plan' | 'execute' | 'verify';
  iteration: number;
}

export interface ModelCallMetric {
  model: string;
  phase: ModelCallMetadata['phase'];
  iteration: number;
  wallTimeMs: number;
  messageCount: number;
  toolCount: number;
  responseToolCallCount: number;
  keepAlive: string | number | null;
  success: boolean;
  errorType?: string;
  totalDuration?: number;
  loadDuration?: number;
  promptEvalDuration?: number;
  evalDuration?: number;
  promptEvalCount?: number;
  evalCount?: number;
}

export type NonStreamingChatRequest = Omit<ChatRequest, 'stream'> & { stream?: false };
export type ChatTransport = (request: NonStreamingChatRequest) => Promise<ChatResponse>;
export type MetricsSink = (metric: ModelCallMetric) => void;

export interface ModelClientOptions {
  chat?: ChatTransport;
  keepAlive?: string | number | null;
  metricsSink?: MetricsSink;
}

export interface ModelClient {
  chat(request: NonStreamingChatRequest, metadata: ModelCallMetadata): Promise<ChatResponse>;
  recoverAction(
    request: NonStreamingChatRequest,
    metadata: ModelCallMetadata,
    format: Record<string, unknown>
  ): Promise<ChatResponse>;
}

function isDuration(value: string): boolean {
  return /^(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/i.test(value);
}

/**
 * Resolves the Ollama `keep_alive` window. Keeping the model resident between
 * turns is the single biggest execution speedup on local hardware: it skips the
 * multi-second reload (`load_duration`) that Ollama otherwise pays each time the
 * model is evicted. So an unset or unparseable value now defaults to
 * DEFAULT_KEEP_ALIVE (warm) rather than null; `off` still opts out explicitly.
 */
export function resolveKeepAlive(value = process.env.AGENT_OLLAMA_KEEP_ALIVE): string | null {
  const normalized = value?.trim();
  if (!normalized) return DEFAULT_KEEP_ALIVE;
  if (normalized.toLowerCase() === 'off') return null;
  return isDuration(normalized) ? normalized : DEFAULT_KEEP_ALIVE;
}

function defaultMetricsSink(metric: ModelCallMetric): void {
  if (process.env.AGENT_MODEL_METRICS === '1') {
    console.info(`${MODEL_METRICS_PREFIX}${JSON.stringify(metric)}`);
  }
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The Ollama endpoint, for use in diagnostics. */
function ollamaHost(): string {
  return process.env.OLLAMA_HOST?.trim() || 'http://127.0.0.1:11434';
}

/**
 * Recognises a failure to reach the Ollama daemon. `fetch failed` is what
 * undici throws when the connection can't be opened; the underlying cause code
 * (ECONNREFUSED, etc.) is more specific when present.
 */
function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (
    message.includes('fetch failed') ||
    message.includes('econnrefused') ||
    message.includes('other side closed') ||
    message.includes('terminated') ||
    message.includes('timeout')
  ) {
    return true;
  }
  const code = (error as { cause?: { code?: string } }).cause?.code;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT'
  );
}

/**
 * Folds the parts of a streamed chat response back into a single ChatResponse:
 * content deltas are concatenated, tool calls are collected in order, and the
 * timing/`done` fields are taken from the final part. Pure and synchronous so
 * it can be unit-tested without a live model.
 */
export function aggregateChatStream(parts: Iterable<ChatResponse>): ChatResponse {
  let content = '';
  let role = 'assistant';
  const toolCalls: NonNullable<ChatResponse['message']['tool_calls']> = [];
  let last: ChatResponse | undefined;

  for (const part of parts) {
    last = part;
    const message = part.message;
    if (!message) continue;
    if (typeof message.content === 'string') content += message.content;
    if (message.role) role = message.role;
    if (message.tool_calls?.length) toolCalls.push(...message.tool_calls);
  }

  const base = last ?? ({} as ChatResponse);
  const message = { role, content } as ChatResponse['message'];
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return { ...base, message };
}

/**
 * Default transport. Streaming makes Ollama send headers right away and emit
 * tokens as they are produced, so a slow or cold-loading model no longer trips
 * the client's response timeout mid-generation (the "fetch failed" the engine
 * used to surface). The stream is reassembled into one ChatResponse, so nothing
 * downstream of the model client changes.
 */
async function streamingChat(request: NonStreamingChatRequest): Promise<ChatResponse> {
  const stream = await ollama.chat({ ...request, stream: true });
  const parts: ChatResponse[] = [];
  for await (const part of stream) parts.push(part);
  return aggregateChatStream(parts);
}

export function createModelClient(options: ModelClientOptions = {}): ModelClient {
  const chat = options.chat ?? streamingChat;
  const keepAlive = options.keepAlive === undefined
    ? resolveKeepAlive()
    : options.keepAlive;
  const metricsSink = options.metricsSink ?? defaultMetricsSink;

  async function invoke(
    request: NonStreamingChatRequest,
    metadata: ModelCallMetadata
  ): Promise<ChatResponse> {
    const forwarded: NonStreamingChatRequest = keepAlive === null
      ? request
      : { ...request, keep_alive: keepAlive };
    const startedAt = performance.now();

    try {
      const response = await chat(forwarded);
      metricsSink({
        model: request.model,
        phase: metadata.phase,
        iteration: metadata.iteration,
        wallTimeMs: performance.now() - startedAt,
        messageCount: request.messages?.length ?? 0,
        toolCount: request.tools?.length ?? 0,
        responseToolCallCount: response.message?.tool_calls?.length ?? 0,
        keepAlive: keepAlive ?? null,
        success: true,
        totalDuration: optionalNumber(response.total_duration),
        loadDuration: optionalNumber(response.load_duration),
        promptEvalDuration: optionalNumber(response.prompt_eval_duration),
        evalDuration: optionalNumber(response.eval_duration),
        promptEvalCount: optionalNumber(response.prompt_eval_count),
        evalCount: optionalNumber(response.eval_count)
      });
      return response;
    } catch (error) {
      metricsSink({
        model: request.model,
        phase: metadata.phase,
        iteration: metadata.iteration,
        wallTimeMs: performance.now() - startedAt,
        messageCount: request.messages?.length ?? 0,
        toolCount: request.tools?.length ?? 0,
        responseToolCallCount: 0,
        keepAlive: keepAlive ?? null,
        success: false,
        errorType: error instanceof Error ? error.name : typeof error
      });
      if (isConnectionError(error)) {
        throw new Error(
          `Could not reach the Ollama server at ${ollamaHost()} for model "${request.model}". ` +
            'This usually means Ollama is not running, or a large model is still loading and the ' +
            'request timed out. Confirm `ollama serve` is up; the first call to a big model can be ' +
            'slow, so it often succeeds on retry once the model is warm.'
        );
      }
      throw error;
    }
  }

  return {
    chat: invoke,
    recoverAction(request, metadata, format) {
      return invoke({ ...request, tools: undefined, format }, metadata);
    }
  };
}

export const defaultModelClient = createModelClient();
