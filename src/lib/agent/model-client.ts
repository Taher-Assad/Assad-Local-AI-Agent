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
}

function isDuration(value: string): boolean {
  return /^(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/i.test(value);
}

export function resolveKeepAlive(value = process.env.AGENT_OLLAMA_KEEP_ALIVE): string | null {
  const normalized = value?.trim();
  if (!normalized || normalized.toLowerCase() === 'off') return null;
  return isDuration(normalized) ? normalized : null;
}

function defaultMetricsSink(metric: ModelCallMetric): void {
  if (process.env.AGENT_MODEL_METRICS === '1') {
    console.info(`${MODEL_METRICS_PREFIX}${JSON.stringify(metric)}`);
  }
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function createModelClient(options: ModelClientOptions = {}): ModelClient {
  const chat = options.chat ?? (request => ollama.chat({ ...request, stream: false }));
  const keepAlive = options.keepAlive === undefined
    ? resolveKeepAlive()
    : options.keepAlive;
  const metricsSink = options.metricsSink ?? defaultMetricsSink;

  return {
    async chat(request, metadata) {
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
        throw error;
      }
    }
  };
}

export const defaultModelClient = createModelClient();
