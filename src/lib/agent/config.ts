export const DEFAULT_MODEL = 'qwen3.5:9b';

/** Versioned contract shared by the chat route and its browser client. */
export const CHAT_STREAM_PROTOCOL = 'antigraphity.chat.v1';
export const CHAT_STREAM_PROTOCOL_HEADER = 'x-antigraphity-chat-protocol';
export const CHAT_STREAM_CONTENT_TYPE = 'text/event-stream';

/**
 * Reads a positive-integer env override, falling back to `fallback` when the
 * variable is unset or not a valid positive integer.
 */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Reads a numeric env override in [0, 2], falling back to `fallback` otherwise.
 * (Sampling temperature has no meaning outside that range.)
 */
export function envTemp(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 2 ? value : fallback;
}

/**
 * Ollama's `num_ctx`. The fixed per-call overhead (system prompt + tool
 * schemas) is ~2.7k tokens; at the old default of 4096 that is 66% of the
 * budget, so a few tool results overflow the window. When the window overflows
 * Ollama shifts it and DROPS the cached prefix, forcing a full re-`prompt_eval`
 * of that ~2.7k-token overhead on every subsequent call — the single biggest
 * slowdown in a multi-step run. 8192 keeps the overhead near a third of the
 * window so the prefix cache survives a normal run. Tune per hardware:
 * larger = more history retained but more KV-cache VRAM; `AGENT_MODEL_NUM_CTX`
 * overrides. Keep it a power of two so Ollama does not round unpredictably.
 */
export const MODEL_CONTEXT_TOKENS = envInt('AGENT_MODEL_NUM_CTX', 8192);
export const MODEL_TEMPERATURE = envTemp('AGENT_MODEL_TEMPERATURE', 0.1);
export const PLANNING_TEMPERATURE = envTemp('AGENT_PLANNING_TEMPERATURE', 0.2);
export const MAX_ACTION_RECOVERY_ATTEMPTS = 2;

/** JSON schema used only for the constrained action-recovery turn. */
export const ACTION_RECOVERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            arguments: { type: 'object' }
          },
          required: ['name', 'arguments']
        },
        { type: 'null' }
      ]
    },
    completed: { type: 'boolean' },
    reason: { type: 'string' }
  },
  required: ['action', 'completed', 'reason']
} as const;
