import type {
  AgentConfig,
  AgentRunStatus,
  AgentSettings,
  Artifact,
  Message,
  PermissionEvaluation,
  PlanProgress,
  TaskGroup,
  TaskStatus,
  ToolExecutionResult
} from '../../types/index.ts';
import { TOOLS, executeTool } from './tools/index.ts';
import {
  applyTaskMarkers,
  computeProgress,
  createImplementationPlan,
  createWalkthrough,
  extractVerificationCommands,
  withTaskGroups
} from './artifacts.ts';
import type { VerificationResult } from './artifacts.ts';
import { evaluateToolPermission, resolveSettings, requiresPlanApproval } from './permissions.ts';
import { collectMediaFromFiles } from './capture.ts';
import { buildSystemPrompt, type PromptPhase } from './system-prompt.ts';
import { defaultModelClient, type ModelClient, type NonStreamingChatRequest } from './model-client.ts';
import type { Message as OllamaMessage, ToolCall as OllamaToolCall } from 'ollama';
import {
  ACTION_RECOVERY_SCHEMA,
  MAX_ACTION_RECOVERY_ATTEMPTS,
  MODEL_CONTEXT_TOKENS,
  MODEL_TEMPERATURE,
  PLANNING_TEMPERATURE
} from './config.ts';

export interface AgentRuntime {
  modelClient: ModelClient;
  executeTool(
    name: string,
    args: Record<string, unknown>,
    workspacePath: string
  ): Promise<ToolExecutionResult>;
}

function legacyExecuteTool(
  name: string,
  args: Record<string, unknown>,
  workspacePath: string
): Promise<ToolExecutionResult> {
  return executeTool(name, args, workspacePath);
}

const DEFAULT_RUNTIME: AgentRuntime = {
  modelClient: defaultModelClient,
  executeTool: legacyExecuteTool
};

export interface AgentUpdate {
  type:
    | 'thinking'
    | 'tool_call'
    | 'tool_result'
    | 'text'
    | 'done'
    | 'error'
    // Antigravity additions
    | 'phase'
    | 'artifact'
    | 'task_update'
    | 'awaiting_review'
    | 'verification'
    | 'permission_denied';
  content?: string;
  name?: string;
  callId?: string;
  args?: unknown;
  result?: ToolExecutionResult;
  resultStatus?: 'succeeded' | 'failed' | 'refused';
  mutationRevision?: number;
  affectedFiles?: string[];
  duration?: number;
  estimatedTime?: string;
  /** Set on `artifact` events: the full artifact snapshot. */
  artifact?: Artifact;
  /** Set on `task_update` events: the current plan state. */
  taskGroups?: TaskGroup[];
  taskId?: string;
  taskStatus?: TaskStatus;
  progress?: PlanProgress;
  /** Which phase of the run produced this update. */
  phase?: PromptPhase;
  /** Set on `awaiting_review` / `permission_denied`: why the run paused. */
  permission?: PermissionEvaluation;
  /** Set on `verification` events. */
  verification?: VerificationResult;
  /** Coarse run state for the Agent Manager. */
  runStatus?: AgentRunStatus;
}

// Helper to safely parse JSON and fix unescaped backslashes / invalid escape codes from LLMs
function cleanAndParseJson(jsonString: string): unknown {
  if (!jsonString) return null;
  const trimmed = jsonString.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    try {
      // Repair invalid JSON escapes without deleting Windows path separators.
      const sanitized = trimmed.replace(/\\([^"\\/bfnrtu])/g, '\\\\$1');
      return JSON.parse(sanitized);
    } catch {
      try {
        // Double-escape backslashes if standard sanitization fails
        const sanitizedDouble = trimmed.replace(/\\/g, '\\\\');
        return JSON.parse(sanitizedDouble);
      } catch {
        return null;
      }
    }
  }
}

interface NormalizedToolCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolCallDecodeResult {
  calls: NormalizedToolCall[];
  hadCandidates: boolean;
  errors: string[];
}

const TOOL_DEFINITIONS = new Map(TOOLS.map(tool => [tool.function.name, tool]));
let generatedCallId = 0;

function nextCallId(): string {
  generatedCallId += 1;
  return `call-${generatedCallId}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

interface SchemaShape {
  type?: string;
  properties?: Record<string, SchemaShape>;
  required?: string[];
}

function validateSchemaValue(value: unknown, schema: SchemaShape, path: string): string[] {
  if (schema.type === 'string' && typeof value !== 'string') return [`${path} must be a string`];
  if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    return [`${path} must be a finite number`];
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') return [`${path} must be a boolean`];
  if (schema.type === 'object') {
    if (!isPlainRecord(value)) return [`${path} must be an object`];
    const properties = schema.properties ?? {};
    const errors: string[] = [];
    for (const required of schema.required ?? []) {
      if (!(required in value)) errors.push(`${path}.${required} is required`);
    }
    for (const key of Object.keys(value)) {
      if (!(key in properties)) errors.push(`${path}.${key} is not allowed`);
      else errors.push(...validateSchemaValue(value[key], properties[key], `${path}.${key}`));
    }
    return errors;
  }
  return [];
}

function decodeCandidate(candidate: unknown, idHint?: string): ToolCallDecodeResult {
  if (Array.isArray(candidate)) {
    const decoded = candidate.map(item => decodeCandidate(item));
    return {
      calls: decoded.flatMap(item => item.calls),
      hadCandidates: candidate.length > 0,
      errors: decoded.flatMap(item => item.errors)
    };
  }
  if (!isPlainRecord(candidate)) {
    return { calls: [], hadCandidates: true, errors: ['tool call must be an object'] };
  }

  const wrapped = !candidate.name
    ? candidate.function_call ?? candidate.function ?? candidate.tool
    : null;
  if (wrapped) return decodeCandidate(wrapped, typeof candidate.id === 'string' ? candidate.id : idHint);

  const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  const definition = TOOL_DEFINITIONS.get(name);
  if (!definition) {
    return { calls: [], hadCandidates: true, errors: [`unknown tool: ${name || '<missing>'}`] };
  }

  let args: unknown = candidate.arguments ?? candidate.args ?? candidate.parameters ?? candidate.input ?? {};
  if (typeof args === 'string') args = cleanAndParseJson(args);
  const errors = validateSchemaValue(
    args,
    definition.function.parameters as SchemaShape,
    'arguments'
  );
  if (errors.length > 0) return { calls: [], hadCandidates: true, errors };

  return {
    calls: [{
      callId: idHint || (typeof candidate.id === 'string' && candidate.id.trim()) || nextCallId(),
      name,
      args: args as Record<string, unknown>
    }],
    hadCandidates: true,
    errors: []
  };
}

export function decodeNativeToolCalls(toolCalls: unknown): ToolCallDecodeResult {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return { calls: [], hadCandidates: false, errors: [] };
  }
  const decoded = toolCalls.map((toolCall, index) => {
    if (!isPlainRecord(toolCall)) return decodeCandidate(toolCall);
    const callId = typeof toolCall.id === 'string' && toolCall.id.trim()
      ? toolCall.id
      : `native-${index + 1}-${nextCallId()}`;
    return decodeCandidate(toolCall.function ?? toolCall, callId);
  });
  return {
    calls: decoded.flatMap(item => item.calls),
    hadCandidates: true,
    errors: decoded.flatMap(item => item.errors)
  };
}

function decodeJsonSource(source: string): ToolCallDecodeResult {
  const parsed = cleanAndParseJson(source);
  return parsed === null
    ? { calls: [], hadCandidates: true, errors: ['invalid JSON tool call'] }
    : decodeCandidate(parsed);
}

/** Only explicit tool tags, a dedicated tool-call fence, or whole-response JSON are executable. */
export function decodeToolCallsFromText(content: string): ToolCallDecodeResult {
  const trimmed = content.trim();
  if (!trimmed) return { calls: [], hadCandidates: false, errors: [] };

  const taggedMatches = [...trimmed.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/gi)];
  if (taggedMatches.length > 0) {
    const decoded = taggedMatches.map(match => decodeJsonSource(match[1]));
    return {
      calls: decoded.flatMap(item => item.calls),
      hadCandidates: true,
      errors: decoded.flatMap(item => item.errors)
    };
  }

  const fenced = trimmed.match(/^```(?:tool_call|tool-call|json-tool-call)\s*([\s\S]*?)\s*```$/i);
  if (fenced) return decodeJsonSource(fenced[1]);

  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return decodeJsonSource(trimmed);
  }
  return { calls: [], hadCandidates: false, errors: [] };
}

/** Compatibility helper retained for callers that only need valid decoded calls. */
export function extractToolCallsFromText(content: string): NormalizedToolCall[] {
  return decodeToolCallsFromText(content).calls;
}

interface RecoveryEnvelope {
  action: NormalizedToolCall | null;
  completed: boolean;
  reason: string;
}

function decodeRecoveryEnvelope(content: string): RecoveryEnvelope | null {
  const parsed = cleanAndParseJson(content);
  if (!isPlainRecord(parsed) || typeof parsed.completed !== 'boolean' ||
      typeof parsed.reason !== 'string' || !('action' in parsed)) return null;
  if (parsed.action === null) return { action: null, completed: parsed.completed, reason: parsed.reason };
  const decoded = decodeCandidate(parsed.action);
  if (decoded.calls.length !== 1 || decoded.errors.length > 0) return null;
  return { action: decoded.calls[0], completed: parsed.completed, reason: parsed.reason };
}

function toolSchemasForRecovery(): string {
  return JSON.stringify(TOOLS.map(tool => ({
    name: tool.function.name,
    parameters: tool.function.parameters
  })));
}

/**
 * Goal-classification signals. These MUST stay language-aware: the app is used
 * in Arabic as well as English (see `estimateTaskTime`). An English-only verb
 * list silently classifies every Arabic request as non-actionable, which
 * disables the prose→tool-call recovery net and lets the model "answer" an
 * action request with a plan while executing nothing.
 */
const QUESTION_PREFIX =
  /^(?:what|why|how|when|where|who|which|whom|explain|describe|tell me about|ما|ماذا|لماذا|كيف|متى|أين|اين|مَن|من|هل|اشرح|اشرحي|صف|عرّف|عرف)\b/i;
const ENGLISH_ACTION_VERB =
  /\b(add|create|write|edit|modify|change|delete|remove|rename|move|copy|run|execute|install|build|test|fix|generate|save|make|update|list|read|open|inspect|search|find|check|convert|start|stop)(?:ed|d|s|ing)?\b/;
const ARABIC_ACTION_VERB =
  /(?:اصنع|أنشئ|انشئ|أنشِئ|اكتب|أكتب|عدّل|عدل|احذف|امسح|شغّل|شغل|نفّذ|نفذ|ابنِ|ابن|ابني|أضف|اضف|أضِف|غيّر|غير|انقل|انسخ|ثبّت|ثبت|ولّد|ولد|احفظ|اعمل|كوّن|كون|صمّم|صمم|طبّق|طبق|أصلح|اصلح|حدّث|حدث|حوّل|حول|جهّز|اقرأ|ابحث|افتح|اعرض|حلّل|حلل)/;
/** Anything beyond Latin (Basic + Latin-1 + Latin Extended-A/B) — Arabic, CJK, etc. */
const NON_LATIN_SCRIPT = /[^ -ɏ]/;

function isActionableRequest(goal: string): boolean {
  const normalized = goal.trim().toLowerCase();
  if (!normalized) return false;
  if (QUESTION_PREFIX.test(normalized) || normalized.endsWith('؟')) return false;
  if (ENGLISH_ACTION_VERB.test(normalized) || ARABIC_ACTION_VERB.test(normalized)) return true;
  // A non-Latin request that is not a question can't be judged by the English
  // verb list, so default to actionable rather than accepting prose and doing
  // nothing. Recovery attempts are bounded, so a rare false positive is cheap.
  return NON_LATIN_SCRIPT.test(normalized);
}

const ENGLISH_MUTATION_VERB =
  /\b(add|create|write|edit|modify|change|delete|remove|rename|move|copy|install|fix|generate|save|make|update|convert)\b/i;
const ARABIC_MUTATION_VERB =
  /(?:اصنع|أنشئ|انشئ|أنشِئ|اكتب|أكتب|عدّل|عدل|احذف|امسح|أضف|اضف|أضِف|غيّر|غير|انقل|انسخ|ثبّت|ثبت|ولّد|ولد|احفظ|اعمل|كوّن|كون|صمّم|صمم|طبّق|طبق|أصلح|اصلح|حدّث|حدث|حوّل|حول|ابنِ|ابن|ابني|جهّز)/;

/** True when the goal asks for a change on disk (create/edit/delete/...), in
 * either language. Used to require a real mutation before declaring success. */
function isMutationRequest(goal: string): boolean {
  return ENGLISH_MUTATION_VERB.test(goal) || ARABIC_MUTATION_VERB.test(goal);
}

/**
 * True when the user explicitly asked to run something in a shell, so a
 * file-tool substitution should be rejected in favour of `run_command`.
 *
 * The bare word "command" is deliberately NOT a trigger: "create a
 * command-line parser" or "add a command handler" are build requests, not
 * shell requests, and matching "command" there wrongly discarded a valid
 * write_file. We require an explicit shell/terminal name, or a "run/execute …
 * command" phrasing. Arabic shell terms are included since the app is bilingual.
 */
function requestsShellExecution(goal: string): boolean {
  return (
    /\b(powershell|command prompt|cmd(?:\.exe)?|bash|terminal|shell|طرفية|سطر الأوامر|الطرفية)\b/i.test(goal) ||
    /\b(run|execute|نفّذ|نفذ|شغّل|شغل)\b[\s\S]{0,24}\b(command|script|أمر|الأمر|سكربت)\b/i.test(goal)
  );
}

/** Extracts a readable message from an unknown thrown value. */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getActionDescription(toolName: string, toolArgs: Record<string, unknown>): string {
  switch (toolName) {
    case 'write_file':
      return `Creating / writing file: "${toolArgs?.filePath || 'file'}"...`;
    case 'read_file':
      return `Reading file: "${toolArgs?.filePath || 'file'}"...`;
    case 'edit_file':
      return `Editing code in: "${toolArgs?.filePath || 'file'}"...`;
    case 'copy_file':
      return `Copying "${toolArgs?.sourcePath || 'source'}" to "${toolArgs?.destinationPath || 'destination'}"...`;
    case 'move_file':
      return `Moving "${toolArgs?.sourcePath || 'source'}" to "${toolArgs?.destinationPath || 'destination'}"...`;
    case 'delete_file':
      return `Deleting: "${toolArgs?.filePath || 'file'}"...`;
    case 'run_command':
      return `Executing command: \`${toolArgs?.command || ''}\`...`;
    case 'list_directory':
      return `Exploring workspace directory: "${toolArgs?.dirPath || '.'}"...`;
    case 'search_files':
      return `Searching workspace files for: "${toolArgs?.pattern || ''}"...`;
    case 'file_info':
      return `Checking file metadata: "${toolArgs?.filePath || ''}"...`;
    case 'view_image':
      return `Loading image for visual analysis: "${toolArgs?.filePath || ''}"...`;
    default:
      return `Executing ${toolName}...`;
  }
}

function estimateTaskTime(model: string, userMessage?: string): string {
  const isSmall = model.includes('7b') || model.includes('8b');
  const isLarge = model.includes('14b') || model.includes('30b') || model.includes('32b');
  const msgLower = (userMessage || '').toLowerCase();
  const isComplex = msgLower.includes('project') || msgLower.includes('مشروع') || msgLower.includes('game') || msgLower.includes('لعبة');

  if (isSmall) {
    return isComplex ? '~15-25s' : '~5-12s';
  } else if (isLarge) {
    return isComplex ? '~25-45s' : '~10-20s';
  }
  return '~10-20s';
}

/* ------------------------------------------------------------------ *
 * Phase helpers
 * ------------------------------------------------------------------ */

interface RunState {
  settings: AgentSettings;
  estimatedTime: string;
  goal: string;
  plan: Artifact | null;
  taskGroups: TaskGroup[];
  filesTouched: string[];
  commands: { command: string; ok: boolean }[];
  verifications: VerificationResult[];
  successfulMutations: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  pendingAction: NormalizedToolCall | null;
  /** Last free-text answer from the model, reused as walkthrough notes. */
  finalText?: string;
}

/** Assembles the message list for a phase with the right system prompt. */
function buildPhaseMessages(
  config: AgentConfig,
  history: Message[],
  run: RunState,
  phase: PromptPhase
): Message[] {
  const systemPrompt = buildSystemPrompt({
    settings: run.settings,
    phase,
    approvedPlanBody: run.plan?.body,
    planFeedback: config.planFeedback,
    workspacePath: config.workspacePath
  });
  return [
    { role: 'system', content: systemPrompt },
    ...history.filter(m => m.role !== 'system')
  ];
}

function toModelMessages(messages: Message[]): NonStreamingChatRequest['messages'] {
  return messages.map(message => {
    const modelMessage: OllamaMessage = { role: message.role, content: message.content };
    if (message.images?.length) modelMessage.images = message.images;
    // Our ToolCall allows `arguments` to be a JSON string (Ollama sometimes
    // returns it that way); Ollama's type wants an object. The value is passed
    // straight back to the model, so cast at this boundary rather than reshape.
    if (message.tool_calls) modelMessage.tool_calls = message.tool_calls as unknown as OllamaToolCall[];
    if (message.role === 'tool' && message.name) modelMessage.tool_name = message.name;
    return modelMessage;
  });
}

async function recoverActionFromProse(
  config: AgentConfig,
  messages: Message[],
  run: RunState,
  phase: PromptPhase,
  iteration: number,
  runtime: AgentRuntime,
  rawContent: string,
  decodeErrors: string[]
): Promise<RecoveryEnvelope | null> {
  const diagnostic = decodeErrors.length > 0
    ? `The previous action candidate was invalid: ${decodeErrors.join('; ')}.`
    : 'The previous response was actionable prose but contained no valid explicit tool call.';
  const recoveryPrompt = [
    diagnostic,
    `Goal: ${run.goal}`,
    `Previous response: ${rawContent}`,
    `Available tool schemas: ${toolSchemasForRecovery()}`,
    'Return one schema-conforming JSON object. Set action to exactly one validated next tool call, or null.',
    'Set completed=true only when the user request is already satisfied by successful tool results.',
    'Never translate incidental JSON quoted in prose into an action.'
  ].join('\n');
  const response = await runtime.modelClient.recoverAction({
    model: config.model,
    messages: toModelMessages([...messages, { role: 'user', content: recoveryPrompt }]),
    options: { num_ctx: MODEL_CONTEXT_TOKENS, temperature: 0 }
  }, { phase, iteration }, ACTION_RECOVERY_SCHEMA as unknown as Record<string, unknown>);
  return decodeRecoveryEnvelope(response.message?.content ?? '');
}

/**
 * The tool-calling loop. Used for both the execution and verification phases;
 * `phase` only changes which system prompt was baked into `history`.
 */
async function* runToolLoop(
  config: AgentConfig,
  history: Message[],
  run: RunState,
  phase: PromptPhase,
  maxIterations: number,
  runtime: AgentRuntime
): AsyncGenerator<AgentUpdate, 'ok' | 'error' | 'halted', unknown> {

  const workspacePath = config.workspacePath;
  const estimatedTime = run.estimatedTime;

  // The caller already prefixed the phase-specific system prompt.
  const messages: Message[] = [...history];

  let iteration = 0;
  let recoveryAttempts = 0;

  while (iteration < maxIterations) {
    iteration++;

    if (iteration === 1) {
      yield {
        type: 'thinking',
        content:
          phase === 'verify'
            ? 'Verifying the work against the plan...'
            : 'Analyzing your goal and planning steps...',
        estimatedTime: estimatedTime,
        phase
      };
    } else {
      yield {
        type: 'thinking',
        content: `Evaluating previous step results (Step ${iteration}/${maxIterations})...`,
        estimatedTime: estimatedTime,
        phase
      };
    }

    try {
      // 1. Call Ollama Chat Completions (with multimodal images support)
      const response = await runtime.modelClient.chat({
        model: config.model,
        messages: toModelMessages(messages),
        tools: TOOLS,
        options: {
          num_ctx: MODEL_CONTEXT_TOKENS,
          temperature: MODEL_TEMPERATURE
        }
      }, { phase, iteration });
      const assistantMessage = response.message;
      const rawContent = assistantMessage.content || '';

      // Update our inner messages log
      messages.push({
        role: 'assistant',
        content: rawContent,
        tool_calls: assistantMessage.tool_calls as Message['tool_calls']
      });

      // 1b. Track plan progress from TASK:/DONE:/BLOCKED: markers in the reply
      if (run.taskGroups.length > 0 && rawContent) {
        const { groups, applied } = applyTaskMarkers(run.taskGroups, rawContent);
        if (applied.length > 0) {
          run.taskGroups = groups;
          for (const update of applied) {
            yield {
              type: 'task_update',
              taskId: update.taskId,
              taskStatus: update.status,
              content: update.note,
              taskGroups: run.taskGroups,
              progress: computeProgress(run.taskGroups),
              estimatedTime,
              phase
            };
          }
          if (run.plan) {
            run.plan = withTaskGroups(run.plan, run.taskGroups);
            yield { type: 'artifact', artifact: run.plan, estimatedTime, phase };
          }
        }
      }

      // 2. Decode native calls first. Invalid native calls may fall back only to
      // explicit text containers, then to one constrained recovery request.
      const nativeDecoded = decodeNativeToolCalls(assistantMessage.tool_calls);
      const textDecoded = nativeDecoded.calls.length > 0
        ? { calls: [], hadCandidates: false, errors: [] }
        : decodeToolCallsFromText(rawContent);
      let callsToExecute = nativeDecoded.calls.length > 0
        ? nativeDecoded.calls
        : textDecoded.calls;
      let recoveryCompleted = false;
      const decodeErrors = [...nativeDecoded.errors, ...textDecoded.errors];
      // A drafted or approved plan means real work is expected, even when the
      // original goal reads as a noun phrase ("a tic-tac-toe game") with no
      // action verb. Without this, the model can answer the execution turn with
      // plan prose and the run would end having executed nothing.
      const actionableGoal =
        phase === 'execute' && (isActionableRequest(run.goal) || run.taskGroups.length > 0);
      const nativePathNeedsRecovery = callsToExecute.length === 0 && (
        decodeErrors.length > 0 ||
        (actionableGoal && run.successfulToolCalls === 0) ||
        run.pendingAction !== null
      );
      const shouldRecover = phase === 'execute' && (nativePathNeedsRecovery || (
        actionableGoal &&
        run.successfulToolCalls > 0 &&
        callsToExecute.length === 0 &&
        rawContent.length > 0
      ));

      if (shouldRecover && recoveryAttempts < MAX_ACTION_RECOVERY_ATTEMPTS) {
        recoveryAttempts += 1;
        const recovery = await recoverActionFromProse(
          config,
          messages,
          run,
          phase,
          iteration,
          runtime,
          rawContent,
          decodeErrors
        );
        if (recovery?.action) {
          callsToExecute = [recovery.action];
          run.pendingAction = recovery.action;
        } else if (recovery?.completed && run.successfulToolCalls > 0 && run.failedToolCalls === 0) {
          recoveryCompleted = true;
          run.pendingAction = null;
        }
      }

      if (
        phase === 'execute' &&
        callsToExecute.length > 0 &&
        requestsShellExecution(run.goal) &&
        !callsToExecute.some(call => call.name === 'run_command')
      ) {
        if (recoveryAttempts < MAX_ACTION_RECOVERY_ATTEMPTS && iteration < maxIterations) {
          recoveryAttempts += 1;
          run.pendingAction = callsToExecute[0];
          messages.push({
            role: 'user',
            content:
              'The user explicitly requested shell execution. Call run_command now with a workspace-relative PowerShell command. Do not substitute a file tool.'
          });
          continue;
        }
        yield {
          type: 'error',
          content: `Model ${config.model} did not produce the requested run_command tool call. Nothing was executed.`,
          runStatus: 'failed',
          phase
        };
        return 'error';
      }

      // 3. Execute detected tool calls
      if (callsToExecute.length > 0) {
        for (const toolCall of callsToExecute) {
          const toolName = toolCall.name;
          const toolArgs = toolCall.args;
          const callId = toolCall.callId;
          run.pendingAction = toolCall;
          const actionMsg = getActionDescription(toolName, toolArgs);

          // 3a. Permission gate (Terminal Command Auto Execution policy)
          const permission = evaluateToolPermission(toolName, toolArgs, run.settings);

          if (permission.decision === 'deny') {
            yield {
              type: 'permission_denied',
              name: toolName,
              callId,
              args: toolArgs,
              permission,
              content: permission.reason,
              estimatedTime,
              phase
            };
            messages.push({
              role: 'tool',
              name: toolName,
              content: `REFUSED [${callId}]: ${permission.reason} Choose a safer approach; do not retry this command.`
            });
            run.failedToolCalls += 1;
            run.pendingAction = null;
            continue;
          }

          if (permission.decision === 'request-review') {
            yield {
              type: 'awaiting_review',
              name: toolName,
              callId,
              args: toolArgs,
              permission,
              content: permission.reason,
              runStatus: 'awaiting-review',
              estimatedTime,
              phase
            };
            yield {
              type: 'text',
              content: `⏸️ Waiting for approval to run:\n\n\`\`\`\n${permission.command}\n\`\`\`\n\n_${permission.reason}_`,
              estimatedTime,
              phase
            };
            yield { type: 'done', estimatedTime, runStatus: 'awaiting-review' };
            return 'halted';
          }

          yield {
            type: 'thinking',
            content: actionMsg,
            estimatedTime: estimatedTime,
            phase
          };

          yield {
            type: 'tool_call',
            name: toolName,
            callId,
            args: toolArgs,
            estimatedTime: estimatedTime,
            phase
          };

          // Execute tool on disk with duration measurement
          const startTime = Date.now();
          const result = await runtime.executeTool(toolName, toolArgs, workspacePath);
          const duration = Date.now() - startTime;

          if (result.ok) {
            run.successfulToolCalls += 1;
            run.pendingAction = null;
          } else {
            run.failedToolCalls += 1;
          }
          recordToolEffect(run, toolName, toolArgs, result);

          yield {
            type: 'tool_result',
            name: toolName,
            callId,
            result,
            resultStatus: result.ok ? 'succeeded' : 'failed',
            mutationRevision: result.effects.some(effect => effect.workspaceChanged)
              ? run.successfulMutations
              : undefined,
            affectedFiles: result.effects.flatMap(effect => effect.paths),
            duration: duration,
            estimatedTime: estimatedTime,
            phase
          };

          yield {
            type: 'thinking',
            content: `${result.ok ? 'Completed' : 'Failed'}: ${toolName} (${(duration / 1000).toFixed(2)}s). Analyzing output...`,
            estimatedTime: estimatedTime,
            phase
          };

          // Append tool response to the history so LLM can read it
          messages.push({
            role: 'tool',
            name: toolName,
            content: JSON.stringify({
              callId,
              ok: result.ok,
              output: result.output,
              error: result.error ?? null,
              effects: result.effects
            })
          });
        }

        // Loop again to give the tool outputs back to the LLM
        continue;
      }

      // 4. Completion is valid only after successful tool work, or when no action
      // was requested. Recovery state survives iterations until that is true.
      if (phase === 'execute' && (isActionableRequest(run.goal) || run.taskGroups.length > 0)) {
        const mutationGoal = isMutationRequest(run.goal);
        const completionSatisfied = run.successfulToolCalls > 0 &&
          (!mutationGoal || run.successfulMutations > 0) &&
          run.pendingAction === null;
        if (!completionSatisfied && !recoveryCompleted) {
          if (recoveryAttempts < MAX_ACTION_RECOVERY_ATTEMPTS && iteration < maxIterations) {
            messages.push({
              role: 'user',
              content: 'The request is not complete. Continue with one validated tool call; do not claim success from prose or a failed tool result.'
            });
            continue;
          }
          yield {
            type: 'error',
            content: `Model ${config.model} did not complete the requested action with a successful tool result.`,
            runStatus: 'failed',
            phase
          };
          return 'error';
        }
      }

      if (rawContent) {
        run.finalText = rawContent;
        yield { type: 'text', content: rawContent, estimatedTime: estimatedTime, phase };
      }

      return 'ok';

    } catch (error) {
      yield {
        type: 'error',
        content: `Agent Engine error: ${toErrorMessage(error)}`,
        runStatus: 'failed',
        phase
      };
      return 'error';
    }
  }

  yield {
    type: 'error',
    content: `Reached max iteration limit (${maxIterations}).`,
    runStatus: 'failed',
    phase
  };
  return 'error';
}

/** Records only executor-confirmed effects; failures never advance completion state. */
function recordToolEffect(
  run: RunState,
  toolName: string,
  args: Record<string, unknown> | undefined,
  result: ToolExecutionResult
): void {
  if (!result.ok) return;

  for (const effect of result.effects) {
    if (effect.workspaceChanged) {
      for (const filePath of effect.paths) {
        if (filePath && !run.filesTouched.includes(filePath)) run.filesTouched.push(filePath);
      }
      run.successfulMutations += 1;
    }
  }

  if (toolName === 'run_command') {
    const command = typeof args?.command === 'string' ? args.command : null;
    if (command && !run.commands.some(item => item.command === command)) {
      run.commands.push({ command, ok: true });
    }
  }
}

/* ------------------------------------------------------------------ *
 * Planning phase
 * ------------------------------------------------------------------ */

/**
 * Runs a single planning turn (no tools), turns the reply into an
 * Implementation Plan artifact, and either halts for review or continues.
 */
async function* runPlanningPhase(
  config: AgentConfig,
  history: Message[],
  run: RunState,
  runtime: AgentRuntime
): AsyncGenerator<AgentUpdate, 'continue' | 'awaiting-review' | 'failed', unknown> {
  const { estimatedTime } = run;

  yield {
    type: 'phase',
    phase: 'plan',
    content: 'Researching the request and drafting an Implementation Plan...',
    runStatus: 'planning',
    estimatedTime
  };
  yield {
    type: 'thinking',
    content: 'Drafting an Implementation Plan...',
    phase: 'plan',
    estimatedTime
  };

  const messages = buildPhaseMessages(config, history, run, 'plan');

  let planMarkdown = '';
  try {
    // No `tools` here on purpose: the planning turn must return prose only.
    const response = await runtime.modelClient.chat({
      model: config.model,
      messages: messages.map(m => ({ role: m.role, content: m.content, images: m.images })),
      options: { num_ctx: MODEL_CONTEXT_TOKENS, temperature: PLANNING_TEMPERATURE }
    }, { phase: 'plan', iteration: 0 });
    planMarkdown = response.message?.content?.trim() || '';
  } catch (error) {
    yield {
      type: 'error',
      content: `Planning failed: ${toErrorMessage(error)}`,
      phase: 'plan',
      runStatus: 'failed'
    };
    return 'failed';
  }

  if (!planMarkdown) {
    // Nothing usable came back; fall through to plain execution rather than stall.
    yield {
      type: 'thinking',
      content: 'No plan was produced; continuing without one.',
      phase: 'plan',
      estimatedTime
    };
    return 'continue';
  }

  const needsApproval = requiresPlanApproval(run.settings);
  const plan = createImplementationPlan(planMarkdown, { requireReview: needsApproval });

  run.plan = plan;
  run.taskGroups = plan.taskGroups ?? [];

  yield {
    type: 'artifact',
    artifact: plan,
    phase: 'plan',
    progress: computeProgress(run.taskGroups),
    runStatus: needsApproval ? 'awaiting-review' : 'executing',
    estimatedTime
  };

  if (needsApproval) {
    yield {
      type: 'awaiting_review',
      artifact: plan,
      content: 'Review the Implementation Plan and approve it to start execution.',
      phase: 'plan',
      runStatus: 'awaiting-review',
      estimatedTime
    };
    yield {
      type: 'text',
      content: `## Implementation Plan\n\n${plan.body}\n\n---\n_Approve this plan to start execution, or request changes._`,
      phase: 'plan',
      estimatedTime
    };
    yield { type: 'done', estimatedTime, runStatus: 'awaiting-review' };
    return 'awaiting-review';
  }

  yield {
    type: 'text',
    content: `## Implementation Plan\n\n${plan.body}`,
    phase: 'plan',
    estimatedTime
  };
  return 'continue';
}

/* ------------------------------------------------------------------ *
 * Verification phase
 * ------------------------------------------------------------------ */

/**
 * Runs the verification commands named in the plan's Verification group.
 * Commands are still subject to the command execution policy; anything that
 * needs review is reported as unverified rather than silently run.
 */
async function* runVerificationPhase(
  config: AgentConfig,
  run: RunState,
  runtime: AgentRuntime
): AsyncGenerator<AgentUpdate, void, unknown> {
  const commands = extractVerificationCommands(run.taskGroups);
  if (commands.length === 0) return;

  yield {
    type: 'phase',
    phase: 'verify',
    content: `Verifying the work (${commands.length} check${commands.length === 1 ? '' : 's'})...`,
    runStatus: 'verifying',
    estimatedTime: run.estimatedTime
  };

  for (const command of commands.slice(0, 5)) {
    const permission = evaluateToolPermission('run_command', { command }, run.settings);

    if (permission.decision !== 'allow') {
      const result: VerificationResult = {
        label: `Skipped: ${command}`,
        command,
        passed: false,
        output: permission.reason
      };
      run.verifications.push(result);
      yield {
        type: 'verification',
        verification: result,
        permission,
        content: `Skipped \`${command}\`: ${permission.reason}`,
        phase: 'verify',
        estimatedTime: run.estimatedTime
      };
      continue;
    }

    const executionResult = await runtime.executeTool(
      'run_command',
      { command },
      config.workspacePath
    );
    const passed = executionResult.ok;

    if (passed) recordToolEffect(run, 'run_command', { command }, executionResult);
    const result: VerificationResult = {
      label: command,
      command,
      passed,
      output: executionResult.output
    };
    run.verifications.push(result);

    // Emit ONLY the dedicated `verification` event. A `tool_call`/`tool_result`
    // pair here would be redundant with it (the client renders the verify card
    // from `verification`), and — because these verify-phase events carry no
    // callId — the client's `tool_call` handler throws "missing callId",
    // failing an otherwise-successful run. See useChat handleEvent.
    yield {
      type: 'verification',
      verification: result,
      phase: 'verify',
      estimatedTime: run.estimatedTime
    };
  }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Runs one agent turn.
 *
 * Fast Mode keeps the original single-loop behaviour. Planning Mode adds a
 * plan → (optional approval) → execute → verify → walkthrough pipeline.
 * With no `settings` supplied the defaults are Fast Mode + Always Proceed, so
 * existing callers behave exactly as before.
 */
export async function* runAgent(
  config: AgentConfig,
  history: Message[],
  runtime: AgentRuntime = DEFAULT_RUNTIME
): AsyncGenerator<AgentUpdate, void, unknown> {
  const maxIterations = config.maxIterations || 8;
  const settings = resolveSettings(config.settings);

  const lastUserMsg = [...history].reverse().find(m => m.role === 'user')?.content || '';
  const estimatedTime = estimateTaskTime(config.model, lastUserMsg);

  const run: RunState = {
    settings,
    estimatedTime,
    // On a resumed run the last message is "proceed with the plan", so prefer
    // the goal the caller carried over.
    goal: config.goal?.trim() || lastUserMsg,
    plan: config.approvedPlan ?? null,
    taskGroups: config.approvedPlan?.taskGroups ?? [],
    filesTouched: [],
    commands: [],
    verifications: [],
    successfulMutations: 0,
    successfulToolCalls: 0,
    failedToolCalls: 0,
    pendingAction: null
  };

  try {
    // PHASE 1 — Planning (skipped in Fast Mode or when a plan is already approved)
    if (settings.executionMode === 'planning' && !config.approvedPlan) {
      const outcome = yield* runPlanningPhase(config, history, run, runtime);
      if (outcome !== 'continue') return;
    }

    // PHASE 2 — Execution
    const executionMessages = buildPhaseMessages(config, history, run, 'execute');
    const executionOutcome = yield* runToolLoop(
      config,
      executionMessages,
      run,
      'execute',
      maxIterations,
      runtime
    );
    // `halted` means a command is waiting on the user; the `done` event was
    // already emitted, so stop here without a walkthrough.
    if (executionOutcome !== 'ok') return;

    // PHASE 3 — Verification (Planning Mode only; needs a plan to know what to run)
    if (settings.executionMode === 'planning' && run.taskGroups.length > 0) {
      yield* runVerificationPhase(config, run, runtime);
    }

    // PHASE 4 — Walkthrough
    // Antigravity closes every run that actually changed something with a
    // verifiable Walkthrough. Planning Mode always leaves one (it has a plan to
    // summarise); Fast Mode leaves one too, but only when the agent did real
    // work — a plain answer to a question needs no walkthrough.
    const didWork = run.filesTouched.length > 0 || run.commands.length > 0;
    if (settings.executionMode === 'planning' && run.plan) {
      // Any image or video the agent generated becomes walkthrough media.
      const media = collectMediaFromFiles(run.filesTouched);
      const walkthrough = createWalkthrough({
        goal: run.goal,
        plan: run.plan,
        taskGroups: run.taskGroups,
        filesTouched: run.filesTouched,
        commands: run.commands,
        verifications: run.verifications,
        media: media.length > 0 ? media : undefined,
        notes: run.finalText
      });
      yield {
        type: 'artifact',
        artifact: walkthrough,
        phase: 'verify',
        progress: computeProgress(run.taskGroups),
        runStatus: 'completed',
        estimatedTime
      };
    } else if (didWork) {
      // Fast Mode: no plan and no verification phase, so the walkthrough is a
      // straight record of what changed and what ran. `createWalkthrough`
      // renders an honest "not verified" summary when no checks were run.
      const media = collectMediaFromFiles(run.filesTouched);
      const walkthrough = createWalkthrough({
        goal: run.goal,
        filesTouched: run.filesTouched,
        commands: run.commands,
        verifications: run.verifications,
        media: media.length > 0 ? media : undefined,
        notes: run.finalText
      });
      yield {
        type: 'artifact',
        artifact: walkthrough,
        phase: 'execute',
        runStatus: 'completed',
        estimatedTime
      };
    }

    yield { type: 'done', estimatedTime, runStatus: 'completed' };
  } catch (error) {
    yield {
      type: 'error',
      content: `Agent Engine error: ${toErrorMessage(error)}`,
      runStatus: 'failed'
    };
  }
}



