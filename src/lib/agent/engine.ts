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
} from '@/types';
import { TOOLS, executeTool } from './tools';
import {
  applyTaskMarkers,
  computeProgress,
  createImplementationPlan,
  createWalkthrough,
  extractVerificationCommands,
  VerificationResult,
  withTaskGroups
} from './artifacts';
import { evaluateToolPermission, resolveSettings, requiresPlanApproval } from './permissions';
import { collectMediaFromFiles } from './capture';
import { buildSystemPrompt, type PromptPhase } from './system-prompt';
import { defaultModelClient, type ModelClient } from './model-client';

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
      // Fix unescaped backslashes that are not valid JSON escape sequences (e.g. \., \_, \U, windows paths like C:\...)
      const sanitized = trimmed.replace(/\\([^"\\/bfnrtu])/g, '$1');
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

// Helper to extract tool calls from text if native tool_calls is empty
function extractToolCallsFromText(content: string): { name: string; args: any }[] {
  const extracted: { name: string; args: any }[] = [];
  if (!content) return extracted;

  // 1. Check for <tool_call>...</tool_call> tags (Qwen / DeepSeek style)
  const tagRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let match;
  while ((match = tagRegex.exec(content)) !== null) {
    const parsed = cleanAndParseJson(match[1]);
    if (parsed && parsed.name && (parsed.arguments || parsed.args || parsed.parameters)) {
      extracted.push({
        name: parsed.name,
        args: parsed.arguments || parsed.args || parsed.parameters || {}
      });
    }
  }
  if (extracted.length > 0) return extracted;

  // 2. Check for markdown code blocks ```json ... ``` or ``` ... ```
  const blockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/g;
  while ((match = blockRegex.exec(content)) !== null) {
    const parsed = cleanAndParseJson(match[1]);
    if (parsed && parsed.name && (parsed.arguments || parsed.args || parsed.parameters)) {
      extracted.push({
        name: parsed.name,
        args: parsed.arguments || parsed.args || parsed.parameters || {}
      });
    }
  }
  if (extracted.length > 0) return extracted;

  // 3. Check for raw JSON object in content
  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const jsonCandidate = content.substring(firstBrace, lastBrace + 1);
    const parsed = cleanAndParseJson(jsonCandidate);
    if (parsed && parsed.name && (parsed.arguments || parsed.args || parsed.parameters)) {
      extracted.push({
        name: parsed.name,
        args: parsed.arguments || parsed.args || parsed.parameters || {}
      });
    }
  }

  return extracted;
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
  maxIterations: number
): AsyncGenerator<AgentUpdate, 'ok' | 'error' | 'halted', unknown> {

  const workspacePath = config.workspacePath;
  const estimatedTime = run.estimatedTime;

  // The caller already prefixed the phase-specific system prompt.
  const messages: Message[] = [...history];

  let iteration = 0;

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
      const response = await defaultModelClient.chat({
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
          return msgObj;
        }),
        tools: TOOLS as any,
        options: {
          num_ctx: 4096, // Highly optimized context size for 2x faster local generation
          temperature: 0.1
        }
      });

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
        for (const tc of assistantMessage.tool_calls) {
          let toolArgs = tc.function.arguments;
          if (typeof toolArgs === 'string') {
            toolArgs = cleanAndParseJson(toolArgs) || {};
          }
          callsToExecute.push({ name: tc.function.name, args: toolArgs || {} });
        }
      } else {
        // Try fallback extraction
        const fallbackCalls = extractToolCallsFromText(rawContent);
        if (fallbackCalls.length > 0) {
          callsToExecute = fallbackCalls;
        }
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
          const result = await executeTool(toolName, toolArgs, workspacePath);
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

      // 4. No tools called. This is the final response.
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
  run: RunState
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
    const response = await defaultModelClient.chat({
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
  run: RunState
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
    const output = await executeTool('run_command', { command }, config.workspacePath);
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
  history: Message[]
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
      const outcome = yield* runPlanningPhase(config, history, run);
      if (outcome !== 'continue') return;
    }

    // PHASE 2 — Execution
    const executionMessages = buildPhaseMessages(config, history, run, 'execute');
    const executionOutcome = yield* runToolLoop(
      config,
      executionMessages,
      run,
      'execute',
      maxIterations
    );
    // `halted` means a command is waiting on the user; the `done` event was
    // already emitted, so stop here without a walkthrough.
    if (executionOutcome !== 'ok') return;

    // PHASE 3 — Verification (Planning Mode only; needs a plan to know what to run)
    if (settings.executionMode === 'planning' && run.taskGroups.length > 0) {
      yield* runVerificationPhase(config, run);
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



