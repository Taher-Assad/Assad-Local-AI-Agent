import type {
  AgentTask,
  Artifact,
  ArtifactComment,
  ArtifactKind,
  ArtifactMedia,
  ArtifactStatus,
  PlanProgress,
  TaskGroup,
  TaskGroupStatus,
  TaskStatus
} from '@/types';

/* ------------------------------------------------------------------ *
 * ID helpers
 * ------------------------------------------------------------------ */

let idCounter = 0;

/**
 * Deterministic-ish unique id that works both in the browser and on the
 * server without pulling in a dependency. `crypto.randomUUID` is preferred
 * when available.
 */
export function createId(prefix: string): string {
  idCounter += 1;
  const rand =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${idCounter}_${rand}`;
}

/** Turns a free-form title into a stable slug used for task ids. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/* ------------------------------------------------------------------ *
 * Plan parsing
 * ------------------------------------------------------------------ */

const GROUP_HEADING = /^(?:#{1,4}\s+|\*\*)\s*(?:task\s*group|group|phase|step)\s*\d*\s*[:.)-]?\s*/i;
const HEADING = /^#{1,6}\s+(.*)$/;
const BOLD_LINE = /^\*\*(.+?)\*\*:?\s*$/;
const BULLET = /^[-*+]\s+(.*)$/;
const NUMBERED = /^\d+[.)]\s+(.*)$/;
const CHECKBOX = /^\[([ xX])\]\s*(.*)$/;

function stripFormatting(value: string): string {
  return value
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^\s*[-*+]\s+/, '')
    .trim();
}

/**
 * Parses an LLM-authored markdown plan into task groups.
 *
 * Recognised shapes (mixed freely):
 *   ## Group title            -> a new task group
 *   **Group title**           -> a new task group
 *   - task                    -> a task inside the current group
 *   1. task                   -> a task inside the current group
 *   - [ ] task                -> an explicitly pending task
 *   - [x] task                -> an explicitly completed task
 *
 * Tasks found before any heading land in a synthetic "Implementation" group so
 * that a flat bullet list still produces a usable plan.
 */
export function parsePlanMarkdown(markdown: string): TaskGroup[] {
  const groups: TaskGroup[] = [];
  let current: TaskGroup | null = null;

  const pushGroup = (title: string) => {
    current = {
      id: createId(`group-${slugify(title) || 'group'}`),
      title,
      status: 'pending',
      tasks: []
    };
    groups.push(current);
  };

  const lines = (markdown || '').split(/\r?\n/);
  let inFence = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Skip fenced code entirely so sample code inside a plan is not read as tasks.
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const headingMatch = line.match(HEADING);
    const isBullet = BULLET.test(line) || NUMBERED.test(line);

    if (headingMatch && !isBullet) {
      const title = stripFormatting(headingMatch[1]).replace(GROUP_HEADING, '');
      if (title) pushGroup(title);
      continue;
    }

    const boldMatch = !isBullet ? line.match(BOLD_LINE) : null;
    if (boldMatch) {
      const title = stripFormatting(boldMatch[1]).replace(GROUP_HEADING, '');
      if (title) pushGroup(title);
      continue;
    }

    const bulletMatch = line.match(BULLET) || line.match(NUMBERED);
    if (bulletMatch) {
      let body = bulletMatch[1].trim();
      let status: TaskStatus = 'pending';

      const checkbox = body.match(CHECKBOX);
      if (checkbox) {
        status = checkbox[1].toLowerCase() === 'x' ? 'done' : 'pending';
        body = checkbox[2].trim();
      }

      const title = stripFormatting(body);
      if (!title) continue;

      if (!current) pushGroup('Implementation');
      const task: AgentTask = {
        id: createId(`task-${slugify(title) || 'task'}`),
        title,
        status
      };
      // Keep the raw markdown when formatting was stripped: backticked command
      // names are needed later by `extractVerificationCommands`.
      if (body !== title) task.detail = body;
      current!.tasks.push(task);
    }
  }

  return groups.filter(group => group.tasks.length > 0).map(recomputeGroupStatus);
}

/* ------------------------------------------------------------------ *
 * Task status state machine
 * ------------------------------------------------------------------ */

const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ['active', 'skipped', 'failed'],
  active: ['done', 'failed', 'skipped'],
  done: [],
  failed: ['active'],
  skipped: ['active']
};

/** True when a task may move from `from` to `to`. */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Derives a group status from the statuses of its tasks. */
export function deriveGroupStatus(tasks: AgentTask[]): TaskGroupStatus {
  if (tasks.length === 0) return 'pending';
  if (tasks.some(task => task.status === 'active')) return 'active';
  if (tasks.some(task => task.status === 'failed')) return 'failed';
  if (tasks.every(task => task.status === 'done' || task.status === 'skipped')) return 'done';
  if (tasks.some(task => task.status === 'done' || task.status === 'skipped')) return 'active';
  return 'pending';
}

function recomputeGroupStatus(group: TaskGroup): TaskGroup {
  return { ...group, status: deriveGroupStatus(group.tasks) };
}

export interface TaskUpdatePatch {
  status: TaskStatus;
  note?: string;
  detail?: string;
}

/**
 * Immutably applies a status change to one task and recomputes the owning
 * group's status. Invalid transitions are ignored so a confused model cannot
 * walk a finished task backwards.
 */
export function updateTaskStatus(
  groups: TaskGroup[],
  taskId: string,
  patch: TaskUpdatePatch
): TaskGroup[] {
  const now = Date.now();
  return groups.map(group => {
    if (!group.tasks.some(task => task.id === taskId)) return group;

    const tasks = group.tasks.map(task => {
      if (task.id !== taskId) return task;
      if (!canTransition(task.status, patch.status)) return task;

      const next: AgentTask = { ...task, status: patch.status };
      if (patch.note !== undefined) next.note = patch.note;
      if (patch.detail !== undefined) next.detail = patch.detail;
      if (patch.status === 'active' && !next.startedAt) next.startedAt = now;
      if (patch.status === 'done' || patch.status === 'failed' || patch.status === 'skipped') {
        next.completedAt = now;
      }
      return next;
    });

    return recomputeGroupStatus({ ...group, tasks });
  });
}

/** Returns the first task that has not been started yet, in plan order. */
export function findNextPendingTask(
  groups: TaskGroup[]
): { group: TaskGroup; task: AgentTask } | null {
  for (const group of groups) {
    for (const task of group.tasks) {
      if (task.status === 'pending') return { group, task };
    }
  }
  return null;
}

/** Flattens the plan into a single ordered task list. */
export function flattenTasks(groups: TaskGroup[]): AgentTask[] {
  return groups.flatMap(group => group.tasks);
}

/** Aggregate counters used by progress bars in the UI. */
export function computeProgress(groups: TaskGroup[]): PlanProgress {
  const tasks = flattenTasks(groups);
  const count = (status: TaskStatus) => tasks.filter(task => task.status === status).length;
  const done = count('done');
  const skipped = count('skipped');
  const total = tasks.length;
  const settled = done + skipped;

  return {
    total,
    done,
    failed: count('failed'),
    active: count('active'),
    pending: count('pending'),
    skipped,
    percent: total === 0 ? 0 : Math.round((settled / total) * 100)
  };
}

/* ------------------------------------------------------------------ *
 * Artifact factories
 * ------------------------------------------------------------------ */

export interface CreateArtifactInput {
  kind: ArtifactKind;
  title: string;
  body: string;
  summary?: string;
  status?: ArtifactStatus;
  taskGroups?: TaskGroup[];
  media?: ArtifactMedia[];
}

export function createArtifact(input: CreateArtifactInput): Artifact {
  const now = Date.now();
  return {
    id: createId(`artifact-${input.kind}`),
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    body: input.body,
    status: input.status ?? 'draft',
    createdAt: now,
    updatedAt: now,
    taskGroups: input.taskGroups,
    media: input.media,
    comments: []
  };
}

/**
 * Builds the Implementation Plan artifact from raw model markdown.
 * `requireReview` reflects the Artifact Review Policy: under Request Review the
 * plan is parked in `awaiting-review` until the user approves it.
 */
export function createImplementationPlan(
  markdown: string,
  options: { requireReview: boolean; title?: string; summary?: string } = { requireReview: false }
): Artifact {
  const taskGroups = parsePlanMarkdown(markdown);
  const progress = computeProgress(taskGroups);

  return createArtifact({
    kind: 'implementation-plan',
    title: options.title ?? 'Implementation Plan',
    summary:
      options.summary ??
      `${taskGroups.length} task group${taskGroups.length === 1 ? '' : 's'}, ${progress.total} task${progress.total === 1 ? '' : 's'}.`,
    body: markdown.trim(),
    status: options.requireReview ? 'awaiting-review' : 'approved',
    taskGroups
  });
}

/** Replaces the task groups on a plan, keeping comments and identity intact. */
export function withTaskGroups(artifact: Artifact, taskGroups: TaskGroup[]): Artifact {
  return {
    ...artifact,
    taskGroups,
    summary: `${computeProgress(taskGroups).percent}% complete`,
    updatedAt: Date.now()
  };
}

/* ------------------------------------------------------------------ *
 * Review transitions (Interactive Steering)
 * ------------------------------------------------------------------ */

const ALLOWED_ARTIFACT_TRANSITIONS: Record<ArtifactStatus, ArtifactStatus[]> = {
  draft: ['awaiting-review', 'approved', 'final'],
  'awaiting-review': ['approved', 'changes-requested'],
  'changes-requested': ['awaiting-review', 'approved', 'draft'],
  approved: ['final', 'changes-requested'],
  final: []
};

export function canTransitionArtifact(from: ArtifactStatus, to: ArtifactStatus): boolean {
  if (from === to) return true;
  return ALLOWED_ARTIFACT_TRANSITIONS[from].includes(to);
}

/** Applies a review status change, ignoring transitions that are not legal. */
export function transitionArtifact(artifact: Artifact, to: ArtifactStatus): Artifact {
  if (!canTransitionArtifact(artifact.status, to)) return artifact;
  return { ...artifact, status: to, updatedAt: Date.now() };
}

export function approveArtifact(artifact: Artifact): Artifact {
  return transitionArtifact(artifact, 'approved');
}

/**
 * Records the user's change request. The comment becomes the steering feedback
 * that gets folded into the next plan revision.
 */
export function requestChangesOnArtifact(artifact: Artifact, feedback?: string): Artifact {
  const next = transitionArtifact(artifact, 'changes-requested');
  if (next === artifact) return artifact;
  return feedback && feedback.trim() ? addComment(next, feedback, 'user') : next;
}

export function addComment(
  artifact: Artifact,
  body: string,
  author: ArtifactComment['author'] = 'user'
): Artifact {
  if (!body.trim()) return artifact;
  const comment: ArtifactComment = {
    id: createId('comment'),
    body: body.trim(),
    author,
    createdAt: Date.now(),
    resolved: false
  };
  return {
    ...artifact,
    comments: [...artifact.comments, comment],
    updatedAt: Date.now()
  };
}

export function resolveComment(artifact: Artifact, commentId: string): Artifact {
  return {
    ...artifact,
    comments: artifact.comments.map(comment =>
      comment.id === commentId ? { ...comment, resolved: true } : comment
    ),
    updatedAt: Date.now()
  };
}

/** Unresolved user comments, oldest first — the steering queue. */
export function pendingFeedback(artifact: Artifact): string[] {
  return artifact.comments
    .filter(comment => comment.author === 'user' && !comment.resolved)
    .map(comment => comment.body);
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const TASK_ICON: Record<TaskStatus, string> = {
  pending: '[ ]',
  active: '[~]',
  done: '[x]',
  failed: '[!]',
  skipped: '[-]'
};

/** Renders task groups back to markdown checklists for the chat transcript. */
export function renderTaskGroupsMarkdown(groups: TaskGroup[]): string {
  return groups
    .map(group => {
      const header = `### ${group.title} _(${group.status})_`;
      const tasks = group.tasks
        .map(task => {
          const note = task.note ? ` — ${task.note}` : '';
          return `- ${TASK_ICON[task.status]} ${task.title}${note}`;
        })
        .join('\n');
      return `${header}\n${tasks}`;
    })
    .join('\n\n');
}

/** Renders any artifact as markdown, used for the chat transcript fallback. */
export function renderArtifactMarkdown(artifact: Artifact): string {
  const parts: string[] = [`## ${artifact.title}`];
  if (artifact.summary) parts.push(`_${artifact.summary}_`);
  if (artifact.body) parts.push(artifact.body);
  if (artifact.taskGroups && artifact.taskGroups.length > 0) {
    parts.push(renderTaskGroupsMarkdown(artifact.taskGroups));
  }
  if (artifact.media && artifact.media.length > 0) {
    parts.push(
      artifact.media
        .map(item =>
          item.kind === 'image'
            ? `![${item.caption ?? item.path}](${item.path})`
            : `[${item.caption ?? 'Recording'}](${item.path})`
        )
        .join('\n')
    );
  }
  return parts.join('\n\n');
}

/* ------------------------------------------------------------------ *
 * Walkthrough
 * ------------------------------------------------------------------ */

export interface VerificationResult {
  label: string;
  command?: string;
  passed: boolean;
  output?: string;
}

export interface WalkthroughInput {
  goal: string;
  plan?: Artifact | null;
  taskGroups?: TaskGroup[];
  /** Files created or modified during the run. */
  filesTouched?: string[];
  /** Commands the agent ran, in order. */
  commands?: { command: string; ok: boolean }[];
  /** Verification results (build/lint/test). */
  verifications?: VerificationResult[];
  media?: ArtifactMedia[];
  /** Free-form closing notes from the model. */
  notes?: string;
}

function bulletList(items: string[]): string {
  return items.length > 0 ? items.map(item => `- ${item}`).join('\n') : '- _None_';
}

/**
 * Produces the Walkthrough artifact: what changed, how it was verified, and
 * what is left. This is the run's closing summary in Antigravity.
 */
export function createWalkthrough(input: WalkthroughInput): Artifact {
  const groups = input.taskGroups ?? input.plan?.taskGroups ?? [];
  const progress = computeProgress(groups);
  const sections: string[] = [];

  sections.push(`**Goal**\n\n${input.goal.trim() || '_Not specified_'}`);

  if (groups.length > 0) {
    sections.push(
      `**What was done** (${progress.done}/${progress.total} tasks complete)\n\n${renderTaskGroupsMarkdown(groups)}`
    );
  }

  sections.push(`**Files changed**\n\n${bulletList(input.filesTouched ?? [])}`);

  if (input.commands && input.commands.length > 0) {
    sections.push(
      `**Commands run**\n\n${bulletList(
        input.commands.map(entry => `\`${entry.command}\` — ${entry.ok ? 'ok' : 'failed'}`)
      )}`
    );
  }

  const verifications = input.verifications ?? [];
  sections.push(
    `**Verification**\n\n${bulletList(
      verifications.map(
        result =>
          `${result.passed ? 'PASS' : 'FAIL'} — ${result.label}${result.command ? ` (\`${result.command}\`)` : ''}`
      )
    )}`
  );

  const remaining = flattenTasks(groups).filter(
    task => task.status === 'pending' || task.status === 'failed'
  );
  if (remaining.length > 0) {
    sections.push(
      `**Not finished**\n\n${bulletList(remaining.map(task => `${task.title} (${task.status})`))}`
    );
  }

  if (input.notes && input.notes.trim()) {
    sections.push(`**Notes**\n\n${input.notes.trim()}`);
  }

  const allPassed = verifications.length > 0 && verifications.every(result => result.passed);

  return createArtifact({
    kind: 'walkthrough',
    title: 'Walkthrough',
    summary:
      verifications.length === 0
        ? `${progress.percent}% of the plan complete; not verified.`
        : `${progress.percent}% of the plan complete; verification ${allPassed ? 'passed' : 'failed'}.`,
    body: sections.join('\n\n'),
    status: 'final',
    taskGroups: groups.length > 0 ? groups : undefined,
    media: input.media
  });
}

/* ------------------------------------------------------------------ *
 * Media artifacts (screenshots / browser recordings)
 * ------------------------------------------------------------------ */

/**
 * Wraps already-captured media in an artifact. Capture itself needs a headless
 * browser, which this project deliberately does not depend on; the agent
 * records the intended path so the UI can render it once a file exists.
 */
export function createMediaArtifact(
  kind: 'screenshot' | 'browser-recording',
  media: ArtifactMedia[],
  options: { title?: string; note?: string } = {}
): Artifact {
  const isShot = kind === 'screenshot';
  return createArtifact({
    kind,
    title: options.title ?? (isShot ? 'Screenshot' : 'Browser Recording'),
    summary: `${media.length} ${isShot ? 'image' : 'recording'}${media.length === 1 ? '' : 's'}`,
    body: options.note ?? '',
    status: 'final',
    media
  });
}

/** Replaces an artifact in a list by id, appending when it is new. */
export function upsertArtifact(artifacts: Artifact[], artifact: Artifact): Artifact[] {
  const index = artifacts.findIndex(item => item.id === artifact.id);
  if (index === -1) return [...artifacts, artifact];
  const next = [...artifacts];
  next[index] = artifact;
  return next;
}

/* ------------------------------------------------------------------ *
 * Task markers emitted by the model during execution
 * ------------------------------------------------------------------ */

export interface TaskMarker {
  kind: 'start' | 'done' | 'blocked';
  title: string;
  note?: string;
}

const MARKER_LINE = /^(TASK|DONE|BLOCKED)\s*:\s*(.+)$/i;

/**
 * Extracts `TASK:` / `DONE:` / `BLOCKED:` progress markers from a model turn.
 * The execution prompt asks for these so plan progress can be tracked without
 * a separate tool round-trip.
 */
export function parseTaskMarkers(text: string): TaskMarker[] {
  const markers: TaskMarker[] = [];
  for (const rawLine of (text || '').split(/\r?\n/)) {
    const line = stripFormatting(rawLine.trim());
    const match = line.match(MARKER_LINE);
    if (!match) continue;

    const keyword = match[1].toUpperCase();
    let body = match[2].trim();
    let note: string | undefined;

    if (keyword === 'BLOCKED') {
      // "title — reason" or "title - reason"
      const split = body.split(/\s+[—–-]\s+/);
      if (split.length > 1) {
        body = split[0].trim();
        note = split.slice(1).join(' - ').trim();
      }
    }

    if (!body) continue;
    markers.push({
      kind: keyword === 'TASK' ? 'start' : keyword === 'DONE' ? 'done' : 'blocked',
      title: body,
      note
    });
  }
  return markers;
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Resolves a marker title to a planned task. Exact normalized match wins;
 * otherwise the longest containment match is used, since models paraphrase.
 */
export function matchTask(groups: TaskGroup[], title: string): AgentTask | null {
  const target = normalizeTitle(title);
  if (!target) return null;

  const tasks = flattenTasks(groups);
  const exact = tasks.find(task => normalizeTitle(task.title) === target);
  if (exact) return exact;

  let best: AgentTask | null = null;
  let bestScore = 0;
  for (const task of tasks) {
    const candidate = normalizeTitle(task.title);
    if (!candidate) continue;
    const contains = candidate.includes(target) || target.includes(candidate);
    if (!contains) continue;
    const score = Math.min(candidate.length, target.length);
    if (score > bestScore) {
      best = task;
      bestScore = score;
    }
  }
  return best;
}

export interface AppliedTaskUpdate {
  taskId: string;
  status: TaskStatus;
  note?: string;
}

const MARKER_STATUS: Record<TaskMarker['kind'], TaskStatus> = {
  start: 'active',
  done: 'done',
  blocked: 'failed'
};

/**
 * Applies every marker found in a model turn to the plan, returning the new
 * groups plus the list of updates that actually took effect.
 */
export function applyTaskMarkers(
  groups: TaskGroup[],
  text: string
): { groups: TaskGroup[]; applied: AppliedTaskUpdate[] } {
  let next = groups;
  const applied: AppliedTaskUpdate[] = [];

  for (const marker of parseTaskMarkers(text)) {
    const task = matchTask(next, marker.title);
    if (!task) continue;

    const status = MARKER_STATUS[marker.kind];
    // A `done` marker for a task never marked active still needs to land.
    if (status === 'done' && task.status === 'pending') {
      next = updateTaskStatus(next, task.id, { status: 'active' });
    }
    const before = next;
    next = updateTaskStatus(next, task.id, { status, note: marker.note });
    if (next !== before) {
      applied.push({ taskId: task.id, status, note: marker.note });
    }
  }

  return { groups: next, applied };
}

/* ------------------------------------------------------------------ *
 * Verification commands
 * ------------------------------------------------------------------ */

const BACKTICKED = /`([^`]+)`/g;
const VERIFY_GROUP = /verif|validat|test|check/i;

/**
 * Pulls the commands out of the plan's verification group. Backticked spans win;
 * otherwise a bullet that reads like a command ("run npm test") is used.
 */
export function extractVerificationCommands(groups: TaskGroup[]): string[] {
  const commands: string[] = [];

  for (const group of groups) {
    if (!VERIFY_GROUP.test(group.title)) continue;
    for (const task of group.tasks) {
      // `detail` keeps the raw markdown (backticks intact); `title` is stripped.
      const source = task.detail ?? task.title;
      const matches = [...source.matchAll(BACKTICKED)].map(match => match[1].trim());
      if (matches.length > 0) {
        commands.push(...matches);
        continue;
      }
      const runMatch = task.title.match(/\b(?:run|execute)\s+(.+)$/i);
      if (runMatch) commands.push(runMatch[1].trim());
    }
  }

  return [...new Set(commands.filter(command => command.length > 0))];
}
