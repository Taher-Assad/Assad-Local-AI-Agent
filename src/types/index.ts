export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[]; // base64-encoded strings or image URLs for multimodal VL models
  name?: string; // required for 'tool' role to associate the tool output
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id?: string;
  type: 'function';
  function: {
    name: string;
    arguments: Record<string, unknown> | string; // Arguments can sometimes be a JSON string from Ollama
  };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
    };
  };
}

export type ToolErrorCode =
  | 'INVALID_ARGUMENT'
  | 'OUTSIDE_WORKSPACE'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'COMMAND_FAILED'
  | 'TIMEOUT'
  | 'UNKNOWN_TOOL'
  | 'IO_ERROR';

export interface ToolExecutionError {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface ToolEffect {
  operation: string;
  paths: string[];
  workspaceChanged: boolean;
}

export interface CommandDiagnostics {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface ToolExecutionResult {
  ok: boolean;
  output: string;
  error?: ToolExecutionError;
  effects: ToolEffect[];
  command?: CommandDiagnostics;
}

export type AgentFailureCode =
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_INVALID_TOOL_CALL'
  | 'MODEL_NO_TOOL_CALL'
  | 'TOOL_FAILED'
  | 'STREAM_PROTOCOL_ERROR'
  | 'INTERNAL_ERROR';

export interface AgentFailure {
  code: AgentFailureCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export type ToolCallStatus = 'running' | 'succeeded' | 'failed' | 'refused';

export interface ToolCallState {
  callId: string;
  name: string;
  args: unknown;
  status: ToolCallStatus;
  result?: string;
  duration?: number;
}

export type AgentUpdateType =
  | 'run_started'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'text'
  | 'done'
  | 'error'
  | 'phase'
  | 'artifact'
  | 'task_update'
  | 'awaiting_review'
  | 'verification'
  | 'permission_denied';

export interface AgentUpdate {
  type: AgentUpdateType;
  content?: string;
  code?: string;
  protocol?: string;
  model?: string;
  name?: string;
  callId?: string;
  args?: unknown;
  result?: ToolExecutionResult;
  resultStatus?: Exclude<ToolCallStatus, 'running'>;
  mutationRevision?: number;
  affectedFiles?: string[];
  duration?: number;
  estimatedTime?: string;
  artifact?: Artifact;
  taskGroups?: TaskGroup[];
  taskId?: string;
  taskStatus?: TaskStatus;
  progress?: PlanProgress;
  phase?: 'plan' | 'execute' | 'verify';
  permission?: PermissionEvaluation;
  verification?: {
    label: string;
    command?: string;
    passed: boolean;
    output?: string;
  };
  runStatus?: AgentRunStatus;
}

export interface AgentConfig {
  model: string;
  systemPrompt: string;
  maxIterations: number;
  workspacePath: string;
  /** Autonomy / review policies applied to this run (defaults are used when omitted). */
  settings?: AgentSettings;
  /** An Implementation Plan the user already approved; when present the agent skips planning. */
  approvedPlan?: Artifact | null;
  /** Inline feedback the user left on a previous plan revision, used to re-draft it. */
  planFeedback?: string;
  /**
   * The user's original request. Supplied when resuming an approved plan, where
   * the last message is a synthetic "proceed" instruction rather than the goal.
   */
  goal?: string;
}

/* ------------------------------------------------------------------ *
 * Autonomy / execution policies
 * ------------------------------------------------------------------ */

/**
 * Execution mode picked when a conversation starts.
 * - `planning`: research first, emit an Implementation Plan artifact, then execute task groups.
 * - `fast`: execute directly, no dedicated planning phase (small localized edits).
 */
export type ExecutionMode = 'planning' | 'fast';

/** Controls whether the agent halts for approval on the plan before touching files. */
export type ArtifactReviewPolicy = 'request-review' | 'always-proceed';

/** Controls how generated shell commands are executed. */
export type CommandExecutionPolicy = 'request-review' | 'proceed-in-sandbox' | 'always-proceed';

export interface AgentSettings {
  executionMode: ExecutionMode;
  artifactReviewPolicy: ArtifactReviewPolicy;
  commandExecutionPolicy: CommandExecutionPolicy;
  /** Command prefixes that always auto-run, even under `request-review`. */
  allowList: string[];
  /** Command fragments that are never run, even under `always-proceed`. */
  denyList: string[];
}

export type PermissionDecision = 'allow' | 'request-review' | 'deny';

export interface PermissionEvaluation {
  decision: PermissionDecision;
  reason: string;
  /** The tool the decision applies to. */
  toolName: string;
  /** Shell command awaiting approval, when the tool is `run_command`. */
  command?: string;
  /** True when the command is allowed only because it is sandbox-safe. */
  sandboxed?: boolean;
}

/* ------------------------------------------------------------------ *
 * Task groups (Planning Mode work breakdown)
 * ------------------------------------------------------------------ */

export type TaskStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped';
export type TaskGroupStatus = 'pending' | 'active' | 'done' | 'failed';

export interface AgentTask {
  id: string;
  title: string;
  status: TaskStatus;
  detail?: string;
  startedAt?: number;
  completedAt?: number;
  /** Short note recorded when the task finished or failed. */
  note?: string;
}

export interface TaskGroup {
  id: string;
  title: string;
  status: TaskGroupStatus;
  tasks: AgentTask[];
}

export interface PlanProgress {
  total: number;
  done: number;
  failed: number;
  active: number;
  pending: number;
  skipped: number;
  percent: number;
}

/* ------------------------------------------------------------------ *
 * Artifacts
 * ------------------------------------------------------------------ */

export type ArtifactKind =
  | 'implementation-plan'
  | 'task-list'
  | 'walkthrough'
  | 'screenshot'
  | 'browser-recording';

export type ArtifactStatus =
  | 'draft'
  | 'awaiting-review'
  | 'approved'
  | 'changes-requested'
  | 'final';

export interface ArtifactComment {
  id: string;
  body: string;
  author: 'user' | 'agent';
  createdAt: number;
  resolved: boolean;
}

export interface ArtifactMedia {
  kind: 'image' | 'video';
  /** Workspace-relative path, served through /api/files?mode=raw. */
  path: string;
  caption?: string;
}

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  title: string;
  summary?: string;
  /** Rich markdown body rendered in the review pane. */
  body: string;
  status: ArtifactStatus;
  createdAt: number;
  updatedAt: number;
  taskGroups?: TaskGroup[];
  media?: ArtifactMedia[];
  comments: ArtifactComment[];
}

/* ------------------------------------------------------------------ *
 * Agent Manager
 * ------------------------------------------------------------------ */

export type AgentRunStatus =
  | 'idle'
  | 'planning'
  | 'awaiting-review'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface FileItem {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
  children?: FileItem[];
}

export interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  /** Artifacts produced during this session (plans, walkthroughs, media). */
  artifacts?: Artifact[];
  /** Per-session override of the global agent settings. */
  settings?: AgentSettings;
  /** Last known run status, surfaced in the Agent Manager list. */
  runStatus?: AgentRunStatus;
  /** Model used for the most recent turn, shown as a badge in Agent Manager. */
  model?: string;
  updatedAt?: number;
}

/** A row in the Agent Manager surface. */
export interface AgentRunSummary {
  sessionId: string;
  title: string;
  status: AgentRunStatus;
  model?: string;
  executionMode: ExecutionMode;
  artifactCount: number;
  progress?: PlanProgress;
  createdAt: number;
  updatedAt: number;
  /** Set when the run is halted waiting on the user. */
  awaitingReviewArtifactId?: string;
}

