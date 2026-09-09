import type {
  AgentConfig,
  AgentRunStatus,
  AgentSettings,
  Artifact,
  Message,
  PermissionEvaluation,
  PlanProgress,
  TaskGroup,
  TaskStatus
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
import { defaultModelClient, type ModelClient } from './model-client.ts';

export interface AgentRuntime {
  modelClient: ModelClient;
  executeTool: typeof executeTool;
}

const DEFAULT_RUNTIME: AgentRuntime = {
  modelClient: defaultModelClient,
  executeTool
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
  args?: any;
  result?: string;
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
function cleanAndParseJson(jsonString: string): any {
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

type NormalizedToolCall = { name: string; args: Record<string, unknown> };

const KNOWN_TOOL_NAMES = new Set(TOOLS.map(tool => tool.function.name));

function normalizeToolCallCandidate(candidate: unknown): NormalizedToolCall[] {
  if (Array.isArray(candidate)) {
    return candidate.flatMap(normalizeToolCallCandidate);
  }
  if (!candidate || typeof candidate !== 'object') return [];

  const record = candidate as Record<string, unknown>;
  if (!record.name) {
    const wrapped = record.function_call ?? record.function ?? record.tool;
    if (wrapped) return normalizeToolCallCandidate(wrapped);
  }

  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!KNOWN_TOOL_NAMES.has(name)) return [];

  let args = record.arguments ?? record.args ?? record.parameters ?? record.input ?? {};
  if (typeof args === 'string') args = cleanAndParseJson(args);
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];

  return [{ name, args: args as Record<string, unknown> }];
}

function extractJsonFragments(text: string): string[] {
  const fragments: string[] = [];
  let start = -1;
  let depth = 0;
  let quote = false;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quote = false;
      continue;
    }
    if (char === '"') quote = true;
    else if (char === '{' || char === '[') {
      if (depth++ === 0) start = index;
    } else if ((char === '}' || char === ']') && depth > 0 && --depth === 0 && start >= 0) {
      fragments.push(text.slice(start, index + 1));
      start = -1;
    }
  }
  return fragments;
}

export function extractToolCallsFromText(content: string): NormalizedToolCall[] {
  if (!content) return [];

  const tagged = [...content.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/gi)]
    .flatMap(match => normalizeToolCallCandidate(cleanAndParseJson(match[1])));
  if (tagged.length > 0) return tagged;

  const blocked = [...content.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)]
    .flatMap(match => normalizeToolCallCandidate(cleanAndParseJson(match[1])));
  if (blocked.length > 0) return blocked;

  return extractJsonFragments(content)
    .flatMap(fragment => normalizeToolCallCandidate(cleanAndParseJson(fragment)));
}

function isActionableRequest(goal: string): boolean {
  const normalized = goal.trim().toLowerCase();
  if (/^(?:what|why|how|when|where|who|explain|describe|tell me about)\b/.test(normalized)) {
    return false;
  }
  return /\b(add|create|write|edit|modify|change|delete|remove|rename|move|copy|run|execute|install|build|test|fix|generate|save|make|update|list|read|open|inspect|search|find|check|convert|start|stop)(?:ed|d|s|ing)?\b/.test(
    normalized
  );
}

function requestsShellExecution(goal: string): boolean {
  return /\b(powershell|terminal|shell|command(?: prompt)?|cmd(?:\.exe)?)\b/i.test(goal);
}

/** Extracts a readable message from an unknown thrown value. */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getActionDescription(toolName: string, toolArgs: any): string {
  switch (toolName) {
    case 'write_file':
      return `Creating / writing file: "${toolArgs?.filePath || 'file'}"...`;
    case 'read_file':
      return `Reading file: "${toolArgs?.filePath || 'file'}"...`;
    case 'edit_file':
      return `Editing code in: "${toolArgs?.filePath || 'file'}"...`;
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
  let executedTool = false;
  let correctionAttempts = 0;

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
        messages: messages.map(m => {
          const msgObj: any = {
            role: m.role,
            content: m.content
          };
          if (m.images && Array.isArray(m.images) && m.images.length > 0) {
            msgObj.images = m.images;
          }
          if (m.tool_calls) {
            msgObj.tool_calls = m.tool_calls;
          }
          if (m.role === 'tool' && m.name) {
            msgObj.tool_name = m.name;
          }
          return msgObj;
        }),
        tools: TOOLS as any,
        options: {
          num_ctx: 4096, // Highly optimized context size for 2x faster local generation
          temperature: 0.1
        }
      }, { phase, iteration });
      const assistantMessage = response.message;
      const rawContent = assistantMessage.content || '';

      // Update our inner messages log
      messages.push({
        role: 'assistant',
        content: rawContent,
        tool_calls: assistantMessage.tool_calls as any
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

      // 2. Identify tool calls (native or extracted from text)
      let callsToExecute: { name: string; args: any }[] = [];

      if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        callsToExecute = assistantMessage.tool_calls.flatMap(tc =>
          normalizeToolCallCandidate(tc.function)
        );
      } else {
        callsToExecute = extractToolCallsFromText(rawContent);
      }

      if (
        phase === 'execute' &&
        callsToExecute.length > 0 &&
        requestsShellExecution(run.goal) &&
        !callsToExecute.some(call => call.name === 'run_command')
      ) {
        if (correctionAttempts === 0 && iteration < maxIterations) {
          correctionAttempts++;
          messages.push({
            role: 'user',
            content:
              'The user explicitly requested shell execution. Call run_command now with a workspace-relative PowerShell command. Do not substitute write_file or edit_file.'
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
          const actionMsg = getActionDescription(toolName, toolArgs);

          // 3a. Permission gate (Terminal Command Auto Execution policy)
          const permission = evaluateToolPermission(toolName, toolArgs, run.settings);

          if (permission.decision === 'deny') {
            yield {
              type: 'permission_denied',
              name: toolName,
              args: toolArgs,
              permission,
              content: permission.reason,
              estimatedTime,
              phase
            };
            messages.push({
              role: 'tool',
              name: toolName,
              content: `REFUSED: ${permission.reason} Choose a safer approach; do not retry this command.`
            });
            continue;
          }

          if (permission.decision === 'request-review') {
            yield {
              type: 'awaiting_review',
              name: toolName,
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
            args: toolArgs,
            estimatedTime: estimatedTime,
            phase
          };

          // Execute tool on disk with duration measurement
          const startTime = Date.now();
          const result = await runtime.executeTool(toolName, toolArgs, workspacePath);
          executedTool = true;
          const duration = Date.now() - startTime;

          recordToolEffect(run, toolName, toolArgs, result);

          yield {
            type: 'tool_result',
            name: toolName,
            result: result,
            duration: duration,
            estimatedTime: estimatedTime,
            phase
          };

          yield {
            type: 'thinking',
            content: `Completed: ${toolName} (${(duration / 1000).toFixed(2)}s). Analyzing output...`,
            estimatedTime: estimatedTime,
            phase
          };

          // Append tool response to the history so LLM can read it
          messages.push({
            role: 'tool',
            name: toolName,
            content: result
          });
        }

        // Loop again to give the tool outputs back to the LLM
        continue;
      }

      // 4. Do not accept a promise to act as successful execution. Give Qwen one
      // bounded correction turn, but never infer a shell command from prose.
      if (phase === 'execute' && !executedTool && isActionableRequest(run.goal)) {
        if (correctionAttempts === 0 && iteration < maxIterations) {
          correctionAttempts++;
          messages.push({
            role: 'user',
            content:
              'Your previous response did not call a tool. Perform the requested action now with exactly one available tool call. Prefer run_command with PowerShell on Windows. Return a structured tool call, not prose.'
          });
          continue;
        }

        yield {
          type: 'error',
          content: `Model ${config.model} did not produce a valid tool call for this action. Nothing was executed.`,
          runStatus: 'failed',
          phase
        };
        return 'error';
      }

      // No action was requested, or tool work has completed: prose is final.
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

/** Records file writes and executed commands so the walkthrough can list them. */
function recordToolEffect(
  run: RunState,
  toolName: string,
  args: Record<string, unknown> | undefined,
  result: string
): void {
  if (toolName === 'write_file' || toolName === 'edit_file') {
    const filePath = typeof args?.filePath === 'string' ? args.filePath : null;
    if (filePath && !run.filesTouched.includes(filePath)) {
      run.filesTouched.push(filePath);
    }
    return;
  }

  if (toolName === 'run_command') {
    const command = typeof args?.command === 'string' ? args.command : null;
    if (command) {
      run.commands.push({ command, ok: !/^error/i.test(result.trim()) });
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
      options: { num_ctx: 4096, temperature: 0.2 }
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

    yield {
      type: 'tool_call',
      name: 'run_command',
      args: { command },
      phase: 'verify',
      estimatedTime: run.estimatedTime
    };

    const startTime = Date.now();
    const output = await runtime.executeTool('run_command', { command }, config.workspacePath);
    const duration = Date.now() - startTime;
    const passed = !/(^|\n)\s*error/i.test(output) && !/exit code [1-9]/i.test(output);

    run.commands.push({ command, ok: passed });
    const result: VerificationResult = { label: command, command, passed, output };
    run.verifications.push(result);

    yield {
      type: 'tool_result',
      name: 'run_command',
      result: output,
      duration,
      phase: 'verify',
      estimatedTime: run.estimatedTime
    };
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
    verifications: []
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



