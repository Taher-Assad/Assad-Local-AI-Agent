import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addComment,
  applyTaskMarkers,
  approveArtifact,
  canTransition,
  canTransitionArtifact,
  computeProgress,
  createImplementationPlan,
  createWalkthrough,
  deriveGroupStatus,
  extractVerificationCommands,
  findNextPendingTask,
  flattenTasks,
  matchTask,
  parsePlanMarkdown,
  parseTaskMarkers,
  pendingFeedback,
  renderArtifactMarkdown,
  renderTaskGroupsMarkdown,
  requestChangesOnArtifact,
  resolveComment,
  slugify,
  transitionArtifact,
  updateTaskStatus,
  upsertArtifact,
  withTaskGroups
} from '../src/lib/agent/artifacts.ts';
import type { AgentTask, TaskGroup } from '../src/types/index.ts';

const PLAN = `Add a parser and wire it up.

## Setup
- Create src/lib/parse.ts with the tokenizer
- Export the parser from src/lib/index.ts

## Verification
- Run \`npx tsc --noEmit\`
- Run \`npm test\`
`;

function group(title: string, tasks: Partial<AgentTask>[]): TaskGroup {
  return {
    id: `g-${slugify(title)}`,
    title,
    status: 'pending',
    tasks: tasks.map((task, index) => ({
      id: task.id ?? `t-${index}`,
      title: task.title ?? `task ${index}`,
      status: task.status ?? 'pending',
      ...task
    })) as AgentTask[]
  };
}

describe('parsePlanMarkdown', () => {
  it('splits headings into groups and bullets into tasks', () => {
    const groups = parsePlanMarkdown(PLAN);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].title, 'Setup');
    assert.equal(groups[0].tasks.length, 2);
    assert.equal(groups[0].tasks[0].title, 'Create src/lib/parse.ts with the tokenizer');
    assert.equal(groups[1].title, 'Verification');
  });

  it('puts bullets found before any heading into a synthetic group', () => {
    const groups = parsePlanMarkdown('- do a thing\n- do another thing');
    assert.equal(groups.length, 1);
    assert.equal(groups[0].title, 'Implementation');
    assert.equal(groups[0].tasks.length, 2);
  });

  it('accepts numbered lists, bold group titles and checkboxes', () => {
    const groups = parsePlanMarkdown('**Phase 1**\n1. first step\n2. [x] already done');
    assert.equal(groups.length, 1);
    assert.equal(groups[0].title, 'Phase 1');
    assert.equal(groups[0].tasks[0].status, 'pending');
    assert.equal(groups[0].tasks[1].status, 'done');
    assert.equal(groups[0].tasks[1].title, 'already done');
  });

  it('ignores fence markers and empty input', () => {
    assert.deepEqual(parsePlanMarkdown(''), []);
  });

  it('does not read bullets inside fenced code as tasks', () => {
    const groups = parsePlanMarkdown(
      '## Setup\n- real task\n\n```md\n- fake task\n## Fake group\n```\n'
    );
    assert.equal(groups.length, 1);
    assert.equal(groups[0].tasks.length, 1);
    assert.equal(groups[0].tasks[0].title, 'real task');
  });

  it('drops groups that have no tasks', () => {
    const groups = parsePlanMarkdown('## Empty\n\n## Real\n- something');
    assert.equal(groups.length, 1);
    assert.equal(groups[0].title, 'Real');
  });

  it('assigns unique ids', () => {
    const groups = parsePlanMarkdown('## A\n- same title\n## B\n- same title');
    const ids = flattenTasks(groups).map(task => task.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('task status state machine', () => {
  it('allows only forward transitions', () => {
    assert.equal(canTransition('pending', 'active'), true);
    assert.equal(canTransition('active', 'done'), true);
    assert.equal(canTransition('done', 'pending'), false);
    assert.equal(canTransition('done', 'active'), false);
    assert.equal(canTransition('failed', 'active'), true);
    assert.equal(canTransition('done', 'done'), true);
  });

  it('ignores an illegal transition instead of throwing', () => {
    const groups = [group('G', [{ id: 't1', status: 'done' }])];
    const next = updateTaskStatus(groups, 't1', { status: 'pending' });
    assert.equal(next[0].tasks[0].status, 'done');
  });

  it('stamps timings and notes, and recomputes the group status', () => {
    let groups = [group('G', [{ id: 't1' }, { id: 't2' }])];

    groups = updateTaskStatus(groups, 't1', { status: 'active' });
    assert.equal(groups[0].status, 'active');
    assert.ok(groups[0].tasks[0].startedAt);

    groups = updateTaskStatus(groups, 't1', { status: 'done', note: 'shipped' });
    assert.equal(groups[0].tasks[0].note, 'shipped');
    assert.ok(groups[0].tasks[0].completedAt);
    assert.equal(groups[0].status, 'active', 'one task still pending');

    groups = updateTaskStatus(groups, 't2', { status: 'active' });
    groups = updateTaskStatus(groups, 't2', { status: 'done' });
    assert.equal(groups[0].status, 'done');
  });

  it('does not mutate the input array', () => {
    const groups = [group('G', [{ id: 't1' }])];
    const next = updateTaskStatus(groups, 't1', { status: 'active' });
    assert.equal(groups[0].tasks[0].status, 'pending');
    assert.notEqual(next, groups);
  });

  it('derives group status from its tasks', () => {
    assert.equal(deriveGroupStatus([]), 'pending');
    assert.equal(deriveGroupStatus([{ id: 'a', title: 'a', status: 'pending' }]), 'pending');
    assert.equal(deriveGroupStatus([{ id: 'a', title: 'a', status: 'active' }]), 'active');
    assert.equal(deriveGroupStatus([{ id: 'a', title: 'a', status: 'failed' }]), 'failed');
    assert.equal(deriveGroupStatus([{ id: 'a', title: 'a', status: 'done' }]), 'done');
    assert.equal(deriveGroupStatus([{ id: 'a', title: 'a', status: 'skipped' }]), 'done');
  });

  it('finds the next pending task in plan order', () => {
    const groups = [
      group('A', [{ id: 't1', status: 'done' }]),
      group('B', [{ id: 't2' }, { id: 't3' }])
    ];
    assert.equal(findNextPendingTask(groups)?.task.id, 't2');
    assert.equal(findNextPendingTask([group('A', [{ id: 'x', status: 'done' }])]), null);
  });
});

describe('computeProgress', () => {
  it('counts each status and computes a percentage', () => {
    const groups = [
      group('A', [{ status: 'done' }, { status: 'skipped' }]),
      group('B', [{ status: 'active' }, { status: 'failed' }])
    ];
    const progress = computeProgress(groups);
    assert.equal(progress.total, 4);
    assert.equal(progress.done, 1);
    assert.equal(progress.skipped, 1);
    assert.equal(progress.active, 1);
    assert.equal(progress.failed, 1);
    assert.equal(progress.percent, 50);
  });

  it('reports 0% for an empty plan without dividing by zero', () => {
    assert.equal(computeProgress([]).percent, 0);
  });
});

describe('createImplementationPlan', () => {
  it('parks the plan for review under Request Review', () => {
    const plan = createImplementationPlan(PLAN, { requireReview: true });
    assert.equal(plan.kind, 'implementation-plan');
    assert.equal(plan.status, 'awaiting-review');
    assert.equal(plan.taskGroups?.length, 2);
    assert.deepEqual(plan.comments, []);
  });

  it('pre-approves the plan under Always Proceed', () => {
    assert.equal(createImplementationPlan(PLAN, { requireReview: false }).status, 'approved');
  });

  it('summarises the group and task counts', () => {
    const plan = createImplementationPlan(PLAN, { requireReview: false });
    assert.match(plan.summary ?? '', /2 task groups, 4 tasks/);
  });

  it('replaces task groups while keeping identity', () => {
    const plan = createImplementationPlan(PLAN, { requireReview: false });
    const groups = updateTaskStatus(plan.taskGroups!, plan.taskGroups![0].tasks[0].id, {
      status: 'active'
    });
    const next = withTaskGroups(plan, groups);
    assert.equal(next.id, plan.id);
    assert.equal(next.taskGroups?.[0].status, 'active');
  });
});

describe('artifact review transitions', () => {
  it('permits only legal status moves', () => {
    assert.equal(canTransitionArtifact('awaiting-review', 'approved'), true);
    assert.equal(canTransitionArtifact('awaiting-review', 'changes-requested'), true);
    assert.equal(canTransitionArtifact('final', 'draft'), false);
    assert.equal(canTransitionArtifact('draft', 'changes-requested'), false);
  });

  it('approves a plan that is awaiting review', () => {
    const plan = approveArtifact(createImplementationPlan(PLAN, { requireReview: true }));
    assert.equal(plan.status, 'approved');
  });

  it('records change requests as user comments', () => {
    const plan = requestChangesOnArtifact(
      createImplementationPlan(PLAN, { requireReview: true }),
      'Use a different parser'
    );
    assert.equal(plan.status, 'changes-requested');
    assert.deepEqual(pendingFeedback(plan), ['Use a different parser']);
  });

  it('leaves the artifact untouched on an illegal transition', () => {
    const plan = createImplementationPlan(PLAN, { requireReview: false });
    const final = transitionArtifact(plan, 'final');
    assert.equal(transitionArtifact(final, 'draft'), final);
  });

  it('ignores blank comments and can resolve one', () => {
    let plan = createImplementationPlan(PLAN, { requireReview: true });
    plan = addComment(plan, '   ');
    assert.equal(plan.comments.length, 0);

    plan = addComment(plan, 'looks good', 'user');
    assert.equal(plan.comments.length, 1);
    plan = resolveComment(plan, plan.comments[0].id);
    assert.equal(plan.comments[0].resolved, true);
    assert.deepEqual(pendingFeedback(plan), []);
  });
});

describe('parseTaskMarkers / applyTaskMarkers', () => {
  it('reads TASK, DONE and BLOCKED markers', () => {
    const markers = parseTaskMarkers(
      'TASK: Create the parser\nsome prose\nDONE: Create the parser\nBLOCKED: Ship it — no credentials'
    );
    assert.equal(markers.length, 3);
    assert.deepEqual(markers[0], { kind: 'start', title: 'Create the parser', note: undefined });
    assert.equal(markers[2].kind, 'blocked');
    assert.equal(markers[2].title, 'Ship it');
    assert.equal(markers[2].note, 'no credentials');
  });

  it('tolerates markdown emphasis around the marker', () => {
    assert.equal(parseTaskMarkers('**TASK: Do the thing**')[0].title, 'Do the thing');
  });

  it('matches a paraphrased title to the planned task', () => {
    const groups = parsePlanMarkdown('## Setup\n- Create src/lib/parse.ts with the tokenizer');
    assert.ok(matchTask(groups, 'Create src/lib/parse.ts with the tokenizer'));
    assert.ok(matchTask(groups, 'create src/lib/parse ts with the tokenizer'));
    assert.equal(matchTask(groups, 'totally unrelated'), null);
  });

  it('applies markers to the plan and reports what changed', () => {
    const groups = parsePlanMarkdown('## Setup\n- Write the parser\n- Wire it up');
    const result = applyTaskMarkers(groups, 'TASK: Write the parser\nDONE: Write the parser');
    assert.equal(result.applied.length, 2);
    assert.equal(result.groups[0].tasks[0].status, 'done');
    assert.equal(result.groups[0].tasks[1].status, 'pending');
  });

  it('promotes a pending task straight to done when only DONE is seen', () => {
    const groups = parsePlanMarkdown('## Setup\n- Write the parser');
    const result = applyTaskMarkers(groups, 'DONE: Write the parser');
    assert.equal(result.groups[0].tasks[0].status, 'done');
  });

  it('returns the input unchanged when no marker matches', () => {
    const groups = parsePlanMarkdown('## Setup\n- Write the parser');
    const result = applyTaskMarkers(groups, 'just some prose');
    assert.equal(result.applied.length, 0);
    assert.equal(result.groups, groups);
  });
});

describe('extractVerificationCommands', () => {
  it('pulls backticked commands out of the verification group', () => {
    const groups = parsePlanMarkdown(PLAN);
    assert.deepEqual(extractVerificationCommands(groups), ['npx tsc --noEmit', 'npm test']);
  });

  it('falls back to "run <command>" phrasing', () => {
    const groups = parsePlanMarkdown('## Verification\n- Run npm run lint');
    assert.deepEqual(extractVerificationCommands(groups), ['npm run lint']);
  });

  it('ignores non-verification groups and de-duplicates', () => {
    const groups = parsePlanMarkdown(
      '## Setup\n- Run `rm -rf node_modules`\n## Verification\n- Run `npm test`\n- Run `npm test`'
    );
    assert.deepEqual(extractVerificationCommands(groups), ['npm test']);
  });

  it('returns an empty list when there is no verification group', () => {
    assert.deepEqual(extractVerificationCommands(parsePlanMarkdown('## Setup\n- do it')), []);
  });
});

describe('createWalkthrough', () => {
  it('reports files, commands and verification outcomes', () => {
    const plan = createImplementationPlan(PLAN, { requireReview: false });
    const walkthrough = createWalkthrough({
      goal: 'Add a parser',
      plan,
      filesTouched: ['src/lib/parse.ts'],
      commands: [{ command: 'npm test', ok: true }],
      verifications: [{ label: 'typecheck', command: 'npx tsc --noEmit', passed: true }]
    });

    assert.equal(walkthrough.kind, 'walkthrough');
    assert.equal(walkthrough.status, 'final');
    assert.match(walkthrough.body, /Add a parser/);
    assert.match(walkthrough.body, /src\/lib\/parse\.ts/);
    assert.match(walkthrough.body, /PASS — typecheck/);
    assert.match(walkthrough.summary ?? '', /verification passed/);
  });

  it('marks the summary as failed when any check fails', () => {
    const walkthrough = createWalkthrough({
      goal: 'x',
      verifications: [
        { label: 'a', passed: true },
        { label: 'b', passed: false }
      ]
    });
    assert.match(walkthrough.summary ?? '', /verification failed/);
    assert.match(walkthrough.body, /FAIL — b/);
  });

  it('says "not verified" when nothing was run and lists unfinished tasks', () => {
    const plan = createImplementationPlan('## Setup\n- Write it\n- Ship it', {
      requireReview: false
    });
    const walkthrough = createWalkthrough({ goal: 'x', plan });
    assert.match(walkthrough.summary ?? '', /not verified/);
    assert.match(walkthrough.body, /Not finished/);
    assert.match(walkthrough.body, /- _None_/, 'no files touched');
  });

  it('summarises concrete work (not plan %) when there is no plan (Fast Mode)', () => {
    const walkthrough = createWalkthrough({
      goal: 'Make a page',
      filesTouched: ['index.html', 'style.css'],
      commands: [{ command: 'npm run build', ok: true }]
    });
    // Fast-Mode runs have no plan, so the summary must not claim plan progress.
    assert.doesNotMatch(walkthrough.summary ?? '', /of the plan complete/);
    assert.match(walkthrough.summary ?? '', /2 files changed/);
    assert.match(walkthrough.summary ?? '', /1 command run/);
  });
});

describe('rendering helpers', () => {
  it('renders task groups as a status checklist', () => {
    const groups = [group('Setup', [{ title: 'a', status: 'done' }, { title: 'b' }])];
    const markdown = renderTaskGroupsMarkdown(groups);
    assert.match(markdown, /### Setup/);
    assert.match(markdown, /- \[x\] a/);
    assert.match(markdown, /- \[ \] b/);
  });

  it('renders an artifact with its media', () => {
    const plan = createImplementationPlan(PLAN, { requireReview: false });
    const markdown = renderArtifactMarkdown({
      ...plan,
      media: [{ kind: 'image', path: 'shot.png', caption: 'Result' }]
    });
    assert.match(markdown, /## Implementation Plan/);
    assert.match(markdown, /!\[Result\]\(shot\.png\)/);
  });
});

describe('upsertArtifact', () => {
  it('appends a new artifact and replaces an existing one', () => {
    const first = createImplementationPlan(PLAN, { requireReview: false });
    const list = upsertArtifact([], first);
    assert.equal(list.length, 1);

    const updated = approveArtifact({ ...first, status: 'awaiting-review' });
    const replaced = upsertArtifact(list, updated);
    assert.equal(replaced.length, 1);
    assert.equal(replaced[0].status, 'approved');
  });
});
