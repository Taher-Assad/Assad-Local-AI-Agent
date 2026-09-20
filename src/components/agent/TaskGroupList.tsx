import React from 'react';
import { AgentTask, PlanProgress, TaskGroup, TaskStatus } from '@/types';
import { Check, CircleDot, Circle, SkipForward, XCircle } from 'lucide-react';

interface TaskGroupListProps {
  groups: TaskGroup[];
  progress?: PlanProgress | null;
  /** Compact mode drops the progress bar and group status chips. */
  compact?: boolean;
}

const STATUS_ICON: Record<TaskStatus, React.ReactElement> = {
  pending: <Circle size={12} className="text-zinc-600 shrink-0" aria-hidden="true" />,
  active: (
    <CircleDot size={12} className="text-indigo-400 animate-pulse shrink-0" aria-hidden="true" />
  ),
  done: <Check size={12} className="text-green-500 shrink-0" aria-hidden="true" />,
  failed: <XCircle size={12} className="text-red-400 shrink-0" aria-hidden="true" />,
  skipped: <SkipForward size={12} className="text-zinc-500 shrink-0" aria-hidden="true" />
};

const STATUS_TEXT: Record<TaskStatus, string> = {
  pending: 'text-zinc-400',
  active: 'text-indigo-200 font-medium',
  done: 'text-zinc-300 line-through decoration-zinc-700',
  failed: 'text-red-300',
  skipped: 'text-zinc-500 line-through decoration-zinc-800'
};

const GROUP_CHIP: Record<TaskGroup['status'], string> = {
  pending: 'bg-white/[0.04] text-zinc-500 border-white/10',
  active: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/40',
  done: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  failed: 'bg-red-500/15 text-red-400 border-red-500/30'
};

function TaskRow({ task }: { task: AgentTask }) {
  return (
    <li className="flex items-start gap-2 py-0.5">
      <span className="mt-[3px]">{STATUS_ICON[task.status]}</span>
      <span className={`text-[11px] leading-relaxed ${STATUS_TEXT[task.status]}`}>
        {task.title}
        {task.note && <span className="text-zinc-500 italic"> — {task.note}</span>}
      </span>
    </li>
  );
}

/** Renders an Implementation Plan's task groups with live status. */
export function TaskGroupList({ groups, progress, compact = false }: TaskGroupListProps) {
  if (groups.length === 0) return null;

  return (
    <div className="space-y-3">
      {!compact && progress && progress.total > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500">
            <span>
              {progress.done}/{progress.total} tasks
              {progress.failed > 0 && (
                <span className="text-red-400"> · {progress.failed} failed</span>
              )}
            </span>
            <span>{progress.percent}%</span>
          </div>
          <div
            className="h-1 w-full rounded-full bg-white/[0.06] overflow-hidden"
            role="progressbar"
            aria-valuenow={progress.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Plan progress"
          >
            <div
              className="ag-brand-gradient h-full transition-all duration-500"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </div>
      )}

      {groups.map(group => (
        <div key={group.id} className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold text-zinc-300">{group.title}</span>
            {!compact && (
              <span
                className={`px-1.5 py-[1px] rounded border text-[9px] font-mono uppercase tracking-wide ${GROUP_CHIP[group.status]}`}
              >
                {group.status}
              </span>
            )}
          </div>
          <ul className="pl-1 space-y-0">
            {group.tasks.map(task => (
              <TaskRow key={task.id} task={task} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
