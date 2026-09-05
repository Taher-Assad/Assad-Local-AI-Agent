import React from 'react';
import { AgentRunStatus, AgentRunSummary, ChatSession, PlanProgress } from '@/types';
import { Activity, Gauge, Plus, Trash2 } from 'lucide-react';

interface AgentManagerProps {
  sessions: ChatSession[];
  activeSessionId: string | null;
  /** Live status of the active session's run. */
  activeRunStatus: AgentRunStatus;
  activeProgress?: PlanProgress | null;
  activeArtifactCount: number;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  onDeleteSession: (id: string, e: React.MouseEvent) => void;
}

const STATUS_CHIP: Record<AgentRunStatus, string> = {
  idle: 'bg-zinc-900 text-zinc-500 border-zinc-800',
  planning: 'bg-purple-950/40 text-purple-300 border-purple-800/50',
  'awaiting-review': 'bg-amber-950/40 text-amber-300 border-amber-800/50',
  executing: 'bg-blue-950/40 text-blue-300 border-blue-800/50',
  verifying: 'bg-cyan-950/40 text-cyan-300 border-cyan-800/50',
  completed: 'bg-green-950/30 text-green-400 border-green-900/40',
  failed: 'bg-red-950/30 text-red-400 border-red-900/40',
  cancelled: 'bg-zinc-900 text-zinc-500 border-zinc-800'
};

const STATUS_LABEL: Record<AgentRunStatus, string> = {
  idle: 'Idle',
  planning: 'Planning',
  'awaiting-review': 'Needs review',
  executing: 'Executing',
  verifying: 'Verifying',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled'
};

/**
 * Builds the Agent Manager rows. The active session takes its status from live
 * run state; the rest fall back to whatever was persisted.
 */
export function buildRunSummaries(
  sessions: ChatSession[],
  activeSessionId: string | null,
  activeRunStatus: AgentRunStatus,
  activeProgress: PlanProgress | null | undefined,
  activeArtifactCount: number
): AgentRunSummary[] {
  return sessions.map(session => {
    const isActive = session.id === activeSessionId;
    const plan = (session.artifacts || []).find(a => a.kind === 'implementation-plan');
    return {
      sessionId: session.id,
      title: session.title,
      status: isActive ? activeRunStatus : session.runStatus || 'idle',
      model: session.model,
      executionMode: session.settings?.executionMode || 'fast',
      artifactCount: isActive ? activeArtifactCount : (session.artifacts || []).length,
      progress: isActive ? activeProgress ?? undefined : undefined,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt || session.createdAt,
      awaitingReviewArtifactId: plan && plan.status === 'awaiting-review' ? plan.id : undefined
    };
  });
}

/** A single run row: title, status chips and a progress bar. */
function AgentManagerRow({
  run,
  isActive,
  onSelect,
  onDelete
}: {
  run: AgentRunSummary;
  isActive: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string, e: React.MouseEvent) => void;
}) {
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        aria-current={isActive}
        onClick={() => onSelect(run.sessionId)}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect(run.sessionId);
          }
        }}
        className={`group flex flex-col gap-1 px-2.5 py-2 rounded-lg cursor-pointer transition text-xs font-mono border
          ${
            isActive
              ? 'bg-purple-950/30 text-purple-200 border-purple-900/30'
              : 'text-zinc-400 hover:bg-zinc-900/40 hover:text-zinc-200 border-transparent'
          }`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate">{run.title}</span>
          <button
            onClick={e => onDelete(run.sessionId, e)}
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-0.5 rounded hover:bg-red-950/40 text-zinc-500 hover:text-red-400 transition shrink-0"
            aria-label={`Delete ${run.title}`}
          >
            <Trash2 size={12} aria-hidden="true" />
          </button>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <span
            className={`px-1.5 py-[1px] rounded border text-[9px] uppercase tracking-wide ${STATUS_CHIP[run.status]}`}
          >
            {STATUS_LABEL[run.status]}
          </span>
          <span className="text-[9px] text-zinc-600 uppercase">{run.executionMode}</span>
          {run.artifactCount > 0 && (
            <span className="text-[9px] text-zinc-600">
              {run.artifactCount} artifact{run.artifactCount === 1 ? '' : 's'}
            </span>
          )}
          {run.progress && run.progress.total > 0 && (
            <span className="flex items-center gap-1 text-[9px] text-zinc-500">
              <Gauge size={9} aria-hidden="true" />
              {run.progress.percent}%
            </span>
          )}
        </div>

        {run.progress && run.progress.total > 0 && (
          <div
            className="h-[3px] w-full rounded-full bg-zinc-900 overflow-hidden"
            role="progressbar"
            aria-valuenow={run.progress.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${run.title} progress`}
          >
            <div
              className="h-full bg-purple-600 transition-all duration-500"
              style={{ width: `${run.progress.percent}%` }}
            />
          </div>
        )}
      </div>
    </li>
  );
}

/** Agent Manager: every conversation as a run, with status and progress. */
export function AgentManager({
  sessions,
  activeSessionId,
  activeRunStatus,
  activeProgress,
  activeArtifactCount,
  onSelectSession,
  onCreateSession,
  onDeleteSession
}: AgentManagerProps) {
  const runs = buildRunSummaries(
    sessions,
    activeSessionId,
    activeRunStatus,
    activeProgress,
    activeArtifactCount
  );

  return (
    <div className="flex flex-col bg-zinc-950/30 border-b border-zinc-900/60 max-h-[280px]">
      <div className="flex items-center justify-between p-3 border-b border-zinc-900/60">
        <div className="flex items-center gap-1.5">
          <Activity size={11} className="text-purple-400" aria-hidden="true" />
          <h2 className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
            Agent Manager
          </h2>
        </div>
        <button
          onClick={onCreateSession}
          className="flex items-center space-x-1 px-1.5 py-0.5 rounded bg-purple-900/50 hover:bg-purple-800 text-[10px] text-purple-100 transition font-mono border border-purple-800/40"
        >
          <Plus size={10} aria-hidden="true" />
          <span>New Agent</span>
        </button>
      </div>

      <ul className="overflow-y-auto p-2 space-y-1 flex-1 min-h-[80px]">
        {runs.length === 0 ? (
          <li className="text-center py-4 text-zinc-600 text-[11px] font-mono">
            No agent runs yet
          </li>
        ) : (
          runs.map(run => (
            <AgentManagerRow
              key={run.sessionId}
              run={run}
              isActive={run.sessionId === activeSessionId}
              onSelect={onSelectSession}
              onDelete={onDeleteSession}
            />
          ))
        )}
      </ul>
    </div>
  );
}
