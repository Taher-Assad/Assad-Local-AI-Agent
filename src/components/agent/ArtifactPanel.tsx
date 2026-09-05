import React from 'react';
import { Artifact, PermissionEvaluation, PlanProgress } from '@/types';
import { Layers, ShieldAlert, Terminal, X } from 'lucide-react';
import { ArtifactCard } from './ArtifactCard';

interface ArtifactPanelProps {
  artifacts: Artifact[];
  progress?: PlanProgress | null;
  pendingCommand?: PermissionEvaluation | null;
  busy?: boolean;
  onApprovePlan?: (artifactId: string) => void;
  onRequestChanges?: (artifactId: string, feedback: string) => void;
  onComment?: (artifactId: string, body: string) => void;
  onApproveCommand?: () => void;
  onRejectCommand?: () => void;
  onClose?: () => void;
}

/** Right-hand review surface listing every artifact produced by the run. */
export function ArtifactPanel({
  artifacts,
  progress,
  pendingCommand,
  busy = false,
  onApprovePlan,
  onRequestChanges,
  onComment,
  onApproveCommand,
  onRejectCommand,
  onClose
}: ArtifactPanelProps) {
  // Newest first so the latest plan revision and walkthrough surface at the top.
  const ordered = [...artifacts].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <aside
      className="w-[420px] border-l border-zinc-900/80 bg-zinc-950/40 flex flex-col shrink-0"
      aria-label="Artifacts"
    >
      <div className="flex items-center justify-between p-3.5 border-b border-zinc-900/60 bg-zinc-950/20">
        <div className="flex items-center gap-2">
          <Layers size={14} className="text-purple-400" aria-hidden="true" />
          <h2 className="text-xs font-bold uppercase tracking-wider text-zinc-200">Artifacts</h2>
          <span className="text-[10px] font-mono text-zinc-500">{artifacts.length}</span>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-zinc-800/80 text-zinc-400 hover:text-zinc-200 transition"
            aria-label="Close artifacts panel"
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {pendingCommand && (
          <div className="rounded-lg border border-amber-800/50 bg-amber-950/20 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <ShieldAlert size={13} className="text-amber-400" aria-hidden="true" />
              <span className="text-[11px] font-semibold text-amber-200">
                Command needs approval
              </span>
            </div>
            <p className="text-[10px] text-amber-200/70 leading-relaxed">
              {pendingCommand.reason}
            </p>
            <pre className="flex items-start gap-2 p-2 rounded bg-black/50 border border-amber-900/40 text-[11px] font-mono text-amber-100 whitespace-pre-wrap break-all">
              <Terminal size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
              <code>{pendingCommand.command}</code>
            </pre>
            <div className="flex items-center gap-2">
              <button
                onClick={onApproveCommand}
                disabled={busy}
                className="px-2.5 py-1 rounded bg-green-900/50 hover:bg-green-800 disabled:opacity-40 disabled:cursor-not-allowed border border-green-800/50 text-[11px] text-green-100 transition"
              >
                Run it
              </button>
              <button
                onClick={onRejectCommand}
                className="px-2.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-[11px] text-zinc-300 transition"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {ordered.length === 0 ? (
          <p className="text-[11px] text-zinc-600 font-mono text-center py-8 leading-relaxed">
            No artifacts yet.
            <br />
            Switch to Planning mode to get an Implementation Plan.
          </p>
        ) : (
          ordered.map(artifact => (
            <ArtifactCard
              key={artifact.id}
              artifact={artifact}
              progress={artifact.kind === 'implementation-plan' ? progress : undefined}
              busy={busy}
              onApprove={onApprovePlan}
              onRequestChanges={onRequestChanges}
              onComment={onComment}
            />
          ))
        )}
      </div>
    </aside>
  );
}
