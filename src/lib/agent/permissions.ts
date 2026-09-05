import type {
  AgentSettings,
  ArtifactReviewPolicy,
  CommandExecutionPolicy,
  ExecutionMode,
  PermissionEvaluation
} from '@/types';

/**
 * Risk classification for every tool the agent can call.
 * - `read`: never mutates the machine, always safe to auto-run.
 * - `write`: mutates files inside the workspace.
 * - `command`: runs an arbitrary shell command.
 */
export type ToolRisk = 'read' | 'write' | 'command';

const TOOL_RISK: Record<string, ToolRisk> = {
  list_directory: 'read',
  read_file: 'read',
  search_files: 'read',
  file_info: 'read',
  view_image: 'read',
  write_file: 'write',
  edit_file: 'write',
  run_command: 'command'
};

/** Unknown tools are treated as the most dangerous class. */
export function classifyTool(toolName: string): ToolRisk {
  return TOOL_RISK[toolName] ?? 'command';
}

export const DEFAULT_ALLOW_LIST: string[] = [
  'npm run lint',
  'npm test',
  'npm run test',
  'npx tsc',
  'node --test',
  'git status',
  'git diff',
  'git log',
  'python --version',
  'node --version',
  'dir',
  'ls',
  'cat',
  'type',
  'echo'
];

/**
 * Commands that are refused under every policy. These are irreversible or
 * affect state well outside the workspace.
 */
export const DEFAULT_DENY_LIST: string[] = [
  'rm -rf /',
  'rm -rf ~',
  'rm -rf *',
  'del /f /s /q c:\\',
  'format ',
  'mkfs',
  'diskpart',
  'shutdown',
  'reboot',
  'git push --force',
  'git push -f',
  'git reset --hard',
  'git clean -f',
  'npm publish',
  'drop database',
  'drop table',
  'truncate table',
  'chmod 777 /',
  'curl | sh',
  'curl | bash',
  'iwr | iex',
  'invoke-expression'
];

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  executionMode: 'fast',
  artifactReviewPolicy: 'always-proceed',
  commandExecutionPolicy: 'always-proceed',
  allowList: DEFAULT_ALLOW_LIST,
  denyList: DEFAULT_DENY_LIST
};

const EXECUTION_MODES: ExecutionMode[] = ['planning', 'fast'];
const ARTIFACT_POLICIES: ArtifactReviewPolicy[] = ['request-review', 'always-proceed'];
const COMMAND_POLICIES: CommandExecutionPolicy[] = [
  'request-review',
  'proceed-in-sandbox',
  'always-proceed'
];

/**
 * Fills in any missing or invalid fields with the defaults so that a partial
 * payload coming from the client can never produce an undefined policy.
 */
export function resolveSettings(partial?: Partial<AgentSettings> | null): AgentSettings {
  const source = partial ?? {};
  return {
    executionMode: EXECUTION_MODES.includes(source.executionMode as ExecutionMode)
      ? (source.executionMode as ExecutionMode)
      : DEFAULT_AGENT_SETTINGS.executionMode,
    artifactReviewPolicy: ARTIFACT_POLICIES.includes(
      source.artifactReviewPolicy as ArtifactReviewPolicy
    )
      ? (source.artifactReviewPolicy as ArtifactReviewPolicy)
      : DEFAULT_AGENT_SETTINGS.artifactReviewPolicy,
    commandExecutionPolicy: COMMAND_POLICIES.includes(
      source.commandExecutionPolicy as CommandExecutionPolicy
    )
      ? (source.commandExecutionPolicy as CommandExecutionPolicy)
      : DEFAULT_AGENT_SETTINGS.commandExecutionPolicy,
    allowList: Array.isArray(source.allowList) ? source.allowList : DEFAULT_ALLOW_LIST,
    denyList: Array.isArray(source.denyList)
      ? [...DEFAULT_DENY_LIST, ...source.denyList]
      : DEFAULT_DENY_LIST
  };
}

function normalizeCommand(command: string): string {
  return command.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** True when the command matches an entry on the deny list. */
export function isDeniedCommand(command: string, denyList: string[]): boolean {
  const normalized = normalizeCommand(command);
  return denyList.some(entry => {
    const needle = normalizeCommand(entry);
    return needle.length > 0 && normalized.includes(needle);
  });
}

/** True when the command starts with an allow-list entry. */
export function isAllowListedCommand(command: string, allowList: string[]): boolean {
  const normalized = normalizeCommand(command);
  return allowList.some(entry => {
    const needle = normalizeCommand(entry);
    return needle.length > 0 && (normalized === needle || normalized.startsWith(`${needle} `));
  });
}

/**
 * Commands that only read state are safe to run even when the user asked to
 * "Proceed in Sandbox", because they cannot mutate anything.
 */
const SANDBOX_SAFE_PREFIXES = [
  'node --test',
  'npx tsc',
  'npm run lint',
  'npm test',
  'npm run test',
  'git status',
  'git diff',
  'git log',
  'ls',
  'dir',
  'cat',
  'type',
  'echo',
  'pwd',
  'whoami',
  'python --version',
  'node --version',
  'npm --version'
];

const MUTATING_PATTERN =
  /[>|]|&&|;|\brm\b|\bdel\b|\bmv\b|\bcp\b|\bmkdir\b|\bcurl\b|\bwget\b|\bgit push\b|\bnpm i\b|\bnpm install\b/;

/** Heuristic: does this command only read state? */
export function isSandboxSafeCommand(command: string): boolean {
  const normalized = normalizeCommand(command);
  if (MUTATING_PATTERN.test(normalized)) {
    return false;
  }
  return SANDBOX_SAFE_PREFIXES.some(
    prefix => normalized === prefix || normalized.startsWith(`${prefix} `)
  );
}

/**
 * Decides whether a tool call may run immediately, needs user approval, or is
 * refused outright. Mirrors Antigravity's two independent review policies:
 * artifact review gates plan approval, command auto-execution gates the shell.
 */
export function evaluateToolPermission(
  toolName: string,
  args: Record<string, unknown> | undefined,
  settings: AgentSettings
): PermissionEvaluation {
  const risk = classifyTool(toolName);

  if (risk === 'read') {
    return {
      decision: 'allow',
      reason: 'Read-only tool; no approval required.',
      toolName
    };
  }

  if (risk === 'write') {
    // File writes are gated earlier by the artifact review policy: under
    // "request-review" the plan must be approved before the run reaches here.
    return {
      decision: 'allow',
      reason: 'Workspace write permitted by the approved plan.',
      toolName
    };
  }

  const command = typeof args?.command === 'string' ? args.command : '';

  if (!command.trim()) {
    return {
      decision: 'deny',
      reason: 'run_command was called without a command string.',
      toolName,
      command
    };
  }

  if (isDeniedCommand(command, settings.denyList)) {
    return {
      decision: 'deny',
      reason: 'Command matches the deny list (irreversible or out-of-workspace effect).',
      toolName,
      command
    };
  }

  if (isAllowListedCommand(command, settings.allowList)) {
    return {
      decision: 'allow',
      reason: 'Command is on the allow list.',
      toolName,
      command
    };
  }

  switch (settings.commandExecutionPolicy) {
    case 'always-proceed':
      return {
        decision: 'allow',
        reason: 'Terminal auto-execution is set to Always Proceed.',
        toolName,
        command
      };
    case 'proceed-in-sandbox':
      if (isSandboxSafeCommand(command)) {
        return {
          decision: 'allow',
          reason: 'Command is read-only, safe to run in the sandbox.',
          toolName,
          command,
          sandboxed: true
        };
      }
      return {
        decision: 'request-review',
        reason: 'Command can mutate state, so it needs review under Proceed in Sandbox.',
        toolName,
        command
      };
    case 'request-review':
    default:
      return {
        decision: 'request-review',
        reason: 'Terminal auto-execution is set to Request Review.',
        toolName,
        command
      };
  }
}

/** True when the run must stop for plan approval before editing files. */
export function requiresPlanApproval(settings: AgentSettings): boolean {
  return (
    settings.executionMode === 'planning' && settings.artifactReviewPolicy === 'request-review'
  );
}

/**
 * Returns a copy of `settings` where the given commands are allow-listed.
 * Used for one-shot approvals: a command the user explicitly OK'd must not be
 * held for review again on the next turn. Denied commands stay denied.
 */
export function withApprovedCommands(
  settings: AgentSettings,
  commands: string[] | undefined
): AgentSettings {
  const approved = (commands ?? []).map(command => command.trim()).filter(Boolean);
  if (approved.length === 0) return settings;
  return { ...settings, allowList: [...settings.allowList, ...approved] };
}
