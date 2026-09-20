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
  idle: 'bg-white/[0.04] text-zinc-500 border-white/10',
  planning: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/40',
  'awaiting-review': 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  executing: 'bg-sky-500/15 text-sky-300 border-sky-500/40',
  verifying: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40',
  completed: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  failed: 'bg-red-500/15 text-red-400 border-red-500/30',
  cancelled: 'bg-white/[0.04] text-zinc-500 border-white/10'
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
        className={`group flex flex-col gap-1 pl-3 pr-2.5 py-2 rounded-xl cursor-pointer transition text-xs border
          ${
            isActive
              ? 'ag-active-rail bg-indigo-500/10 text-indigo-100 border-indigo-500/30 ag-glow'
              : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200 border-transparent'
          }`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-medium">{run.title}</span>
          <button
            onClick={e => onDelete(run.sessionId, e)}
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-0.5 rounded-md hover:bg-red-500/15 text-zinc-500 hover:text-red-400 transition shrink-0"
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
            className="h-[3px] w-full rounded-full bg-white/[0.06] overflow-hidden"
            role="progressbar"
            aria-valuenow={run.progress.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${run.title} progress`}
          >
            <div
              className="ag-brand-gradient h-full transition-all duration-500"
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
    <div className="flex flex-col bg-black/10 border-b border-white/[0.06] max-h-[280px]">
      <div className="flex items-center justify-between p-3 border-b border-white/[0.06]">
        <div className="flex items-center gap-1.5">
          <Activity size={12} className="text-indigo-400" aria-hidden="true" />
          <h2 className="text-[10px] font-semibold text-zinc-300 uppercase tracking-widest">
            Agent Manager
          </h2>
        </div>
        <button
          onClick={onCreateSession}
          className="ag-brand-gradient ag-brand-gradient-hover flex items-center space-x-1 px-2 py-1 rounded-lg text-[10px] font-medium text-white transition ag-glow-soft"
        >
          <Plus size={11} aria-hidden="true" />
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
