import React, { useState } from 'react';
import { Artifact, ArtifactKind, ArtifactStatus, PlanProgress } from '@/types';
import { marked } from 'marked';
import {
  Camera,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  FileText,
  ListChecks,
  MessageCircle,
  Send,
  ThumbsUp,
  Video
} from 'lucide-react';
import { TaskGroupList } from './TaskGroupList';

interface ArtifactCardProps {
  artifact: Artifact;
  progress?: PlanProgress | null;
  onApprove?: (artifactId: string) => void;
  onRequestChanges?: (artifactId: string, feedback: string) => void;
  onComment?: (artifactId: string, body: string) => void;
  /** Disables the action buttons while a run is in flight. */
  busy?: boolean;
}

const KIND_ICON: Record<ArtifactKind, React.ReactElement> = {
  'implementation-plan': <ClipboardList size={14} className="text-indigo-400" aria-hidden="true" />,
  'task-list': <ListChecks size={14} className="text-indigo-400" aria-hidden="true" />,
  walkthrough: <FileText size={14} className="text-sky-400" aria-hidden="true" />,
  screenshot: <Camera size={14} className="text-cyan-400" aria-hidden="true" />,
  'browser-recording': <Video size={14} className="text-fuchsia-400" aria-hidden="true" />
};

const STATUS_CHIP: Record<ArtifactStatus, string> = {
  draft: 'bg-white/[0.04] text-zinc-400 border-white/10',
  'awaiting-review': 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  approved: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  'changes-requested': 'bg-orange-500/15 text-orange-300 border-orange-500/40',
  final: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/40'
};

const STATUS_LABEL: Record<ArtifactStatus, string> = {
  draft: 'Draft',
  'awaiting-review': 'Awaiting review',
  approved: 'Approved',
  'changes-requested': 'Changes requested',
  final: 'Final'
};

function renderMarkdown(text: string) {
  try {
    return { __html: marked.parse(text) as string };
  } catch {
    return { __html: text };
  }
}

/**
 * One artifact in the review pane: plan, walkthrough, screenshot or recording.
 * Plans awaiting review get Approve / Request changes actions; every artifact
 * accepts an inline comment (Interactive Steering).
 */
export function ArtifactCard({
  artifact,
  progress,
  onApprove,
  onRequestChanges,
  onComment,
  busy = false
}: ArtifactCardProps) {
  const [isOpen, setIsOpen] = useState(artifact.status === 'awaiting-review');
  const [draft, setDraft] = useState('');

  const awaitingReview = artifact.status === 'awaiting-review';
  const isPlan = artifact.kind === 'implementation-plan';
  const bodyId = `artifact-body-${artifact.id}`;

  const submitComment = () => {
    if (!draft.trim()) return;
    onComment?.(artifact.id, draft);
    setDraft('');
  };

  const submitChanges = () => {
    if (!draft.trim()) return;
    onRequestChanges?.(artifact.id, draft);
    setDraft('');
  };

  return (
    <section
      className={`rounded-xl border overflow-hidden ${
        awaitingReview ? 'border-amber-500/40 bg-amber-500/[0.03] ag-glow' : 'ag-glass'
      }`}
    >
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 hover:bg-white/[0.04] transition text-left"
        aria-expanded={isOpen}
        aria-controls={bodyId}
      >
        <span className="flex items-center gap-2 min-w-0">
          {KIND_ICON[artifact.kind]}
          <span className="text-xs font-semibold text-zinc-200 truncate">{artifact.title}</span>
          <span
            className={`px-1.5 py-[1px] rounded border text-[9px] font-mono uppercase tracking-wide shrink-0 ${STATUS_CHIP[artifact.status]}`}
          >
            {STATUS_LABEL[artifact.status]}
          </span>
        </span>
        <span className="flex items-center gap-2 shrink-0">
          {artifact.comments.length > 0 && (
            <span className="flex items-center gap-1 text-[10px] font-mono text-zinc-500">
              <MessageCircle size={10} aria-hidden="true" />
              {artifact.comments.length}
            </span>
          )}
          {isOpen ? (
            <ChevronUp size={14} className="text-zinc-500" aria-hidden="true" />
          ) : (
            <ChevronDown size={14} className="text-zinc-500" aria-hidden="true" />
          )}
        </span>
      </button>

      {artifact.summary && (
        <p className="px-3 pt-2 text-[10px] font-mono text-zinc-500">{artifact.summary}</p>
      )}

      {isOpen && (
        <div id={bodyId} className="px-3 py-3 space-y-3 border-t border-zinc-800/40">
          {artifact.body && (
            <div
              className="prose prose-invert max-w-none text-xs leading-relaxed
                prose-headings:text-zinc-200 prose-headings:text-xs
                prose-code:text-sky-300 prose-code:bg-sky-500/10 prose-code:px-1 prose-code:rounded
                prose-pre:bg-black/60 prose-pre:border prose-pre:border-white/10"
              dangerouslySetInnerHTML={renderMarkdown(artifact.body)}
            />
          )}

          {artifact.taskGroups && artifact.taskGroups.length > 0 && (
            <div className="pt-2 border-t border-zinc-800/40">
              <TaskGroupList groups={artifact.taskGroups} progress={progress} />
            </div>
          )}

          {artifact.media && artifact.media.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-2 border-t border-zinc-800/40">
              {artifact.media.map((item, index) =>
                item.kind === 'image' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={index}
                    src={`/api/files?mode=raw&path=${encodeURIComponent(item.path)}`}
                    alt={item.caption || item.path}
                    className="max-w-[240px] max-h-[160px] object-contain rounded border border-zinc-800 bg-black/40"
                  />
                ) : (
                  <video
                    key={index}
                    src={`/api/files?mode=raw&path=${encodeURIComponent(item.path)}`}
                    controls
                    aria-label={item.caption || item.path}
                    className="max-w-[320px] rounded border border-zinc-800 bg-black/40"
                  />
                )
              )}
            </div>
          )}

          {artifact.comments.length > 0 && (
            <ul className="space-y-1.5 pt-2 border-t border-zinc-800/40">
              {artifact.comments.map(comment => (
                <li
                  key={comment.id}
                  className={`text-[11px] leading-relaxed px-2 py-1.5 rounded border ${
                    comment.resolved
                      ? 'border-zinc-900 bg-zinc-950/60 text-zinc-500'
                      : 'border-zinc-800 bg-zinc-900/40 text-zinc-300'
                  }`}
                >
                  <span className="text-[9px] font-mono uppercase tracking-wide text-zinc-500 block">
                    {comment.author}
                    {comment.resolved && ' · resolved'}
                  </span>
                  {comment.body}
                </li>
              ))}
            </ul>
          )}

          <div className="pt-2 border-t border-zinc-800/40 space-y-2">
            <label htmlFor={`comment-${artifact.id}`} className="sr-only">
              Comment on {artifact.title}
            </label>
            <textarea
              id={`comment-${artifact.id}`}
              value={draft}
              onChange={event => setDraft(event.target.value)}
              rows={2}
              placeholder={
                awaitingReview ? 'Describe the changes you want...' : 'Leave a comment...'
              }
              className="ag-glass w-full resize-none rounded-lg px-2 py-1.5 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-indigo-500/70 focus:outline-none"
            />
            <div className="flex flex-wrap items-center gap-2">
              {isPlan && awaitingReview && (
                <>
                  <button
                    onClick={() => onApprove?.(artifact.id)}
                    disabled={busy}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-green-900/50 hover:bg-green-800 disabled:opacity-40 disabled:cursor-not-allowed border border-green-800/50 text-[11px] text-green-100 transition"
                  >
                    <ThumbsUp size={11} aria-hidden="true" />
                    Approve &amp; run
                  </button>
                  <button
                    onClick={submitChanges}
                    disabled={busy || !draft.trim()}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-orange-950/50 hover:bg-orange-900 disabled:opacity-40 disabled:cursor-not-allowed border border-orange-900/50 text-[11px] text-orange-100 transition"
                  >
                    <Send size={11} aria-hidden="true" />
                    Request changes
                  </button>
                </>
              )}
              <button
                onClick={submitComment}
                disabled={!draft.trim()}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed border border-zinc-800 text-[11px] text-zinc-300 transition"
              >
                <MessageCircle size={11} aria-hidden="true" />
                Comment
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
