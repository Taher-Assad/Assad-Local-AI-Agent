import React, { useState } from 'react';
import {
  Terminal,
  FileCode,
  CheckCircle,
  Search,
  Settings,
  HelpCircle,
  ChevronDown,
  ChevronUp,
  Clock,
  Image as ImageIcon,
  XCircle,
  Ban,
  FilePlus,
  Pencil,
  Trash2,
  ArrowRight
} from 'lucide-react';
import { ToolCallState } from '@/types';

interface ToolCallCardProps {
  tool: ToolCallState;
}

/** Tools whose whole point is to change a file — these get the code-review body. */
const FILE_MUTATION_TOOLS = new Set(['write_file', 'edit_file']);

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.replace(/\n$/, '').split('\n').length;
}

/** One scrollable, line-numbered code panel. `variant` tints add/remove diffs. */
function CodePane({ code, variant = 'plain' }: { code: string; variant?: 'plain' | 'added' | 'removed' }) {
  const lines = code.replace(/\n$/, '').split('\n');
  const rowTint =
    variant === 'added' ? 'bg-emerald-500/[0.07]' : variant === 'removed' ? 'bg-red-500/[0.07]' : '';
  const marker = variant === 'added' ? '+' : variant === 'removed' ? '-' : '';
  const markerTint = variant === 'added' ? 'text-emerald-400/80' : 'text-red-400/80';

  return (
    <pre className="overflow-auto max-h-[420px] text-[11px] leading-relaxed font-mono bg-black/50">
      <code className="block py-1">
        {lines.map((line, index) => (
          <div key={index} className={`flex ${rowTint}`}>
            <span className="select-none w-9 shrink-0 pr-2 text-right text-zinc-600 border-r border-white/[0.06]">
              {index + 1}
            </span>
            {marker && <span className={`select-none w-4 text-center ${markerTint}`}>{marker}</span>}
            <span className="px-3 whitespace-pre text-zinc-200">{line || ' '}</span>
          </div>
        ))}
      </code>
    </pre>
  );
}

/** The code-review body for write_file / edit_file. */
function FileChangeBody({ tool }: { tool: ToolCallState }) {
  const args = asRecord(tool.args);

  if (tool.name === 'write_file') {
    return <CodePane code={asString(args.content)} variant="added" />;
  }

  // edit_file: before -> after diff.
  return (
    <div className="space-y-2">
      <div>
        <span className="text-[9px] uppercase tracking-widest text-red-400/70 block mb-1 px-1">Removed</span>
        <div className="rounded-lg border border-red-500/20 overflow-hidden">
          <CodePane code={asString(args.targetText)} variant="removed" />
        </div>
      </div>
      <div>
        <span className="text-[9px] uppercase tracking-widest text-emerald-400/70 block mb-1 px-1">Added</span>
        <div className="rounded-lg border border-emerald-500/20 overflow-hidden">
          <CodePane code={asString(args.replacementText)} variant="added" />
        </div>
      </div>
    </div>
  );
}

export function ToolCallCard({ tool }: ToolCallCardProps) {
  const isFileChange = FILE_MUTATION_TOOLS.has(tool.name);
  // File writes/edits open by default so you watch the code land without a click.
  const [isOpen, setIsOpen] = useState(isFileChange);

  const getToolIcon = (name: string) => {
    switch (name) {
      case 'run_command':
        return <Terminal size={15} className="text-amber-400" />;
      case 'write_file':
        return <FilePlus size={15} className="text-emerald-400" />;
      case 'edit_file':
        return <Pencil size={15} className="text-sky-400" />;
      case 'delete_file':
        return <Trash2 size={15} className="text-red-400" />;
      case 'read_file':
      case 'copy_file':
      case 'move_file':
        return <FileCode size={15} className="text-blue-400" />;
      case 'search_files':
        return <Search size={15} className="text-cyan-400" />;
      case 'list_directory':
      case 'file_info':
        return <Settings size={15} className="text-zinc-400" />;
      case 'view_image':
        return <ImageIcon size={15} className="text-pink-400" />;
      default:
        return <HelpCircle size={15} className="text-indigo-400" />;
    }
  };

  // The path/label shown in the header for each tool.
  const headerLabel = (): React.ReactNode => {
    const args = asRecord(tool.args);
    if (tool.name === 'copy_file' || tool.name === 'move_file') {
      return (
        <span className="flex items-center gap-1 min-w-0 font-mono text-zinc-400">
          <span className="truncate">{asString(args.sourcePath)}</span>
          <ArrowRight size={11} className="shrink-0 text-zinc-600" />
          <span className="truncate">{asString(args.destinationPath)}</span>
        </span>
      );
    }
    const path = asString(args.filePath) || asString(args.dirPath);
    if (path) return <span className="truncate font-mono text-zinc-400">{path}</span>;
    if (typeof args.command === 'string') return <span className="truncate font-mono text-zinc-400">{args.command}</span>;
    if (typeof args.pattern === 'string') return <span className="truncate font-mono text-zinc-400">&quot;{args.pattern}&quot;</span>;
    return null;
  };

  // Small "+N lines" / diff badge for file changes.
  const changeBadge = (): React.ReactNode => {
    const args = asRecord(tool.args);
    if (tool.name === 'write_file') {
      const n = lineCount(asString(args.content));
      return (
        <span className="px-1.5 py-[1px] rounded-full text-[9px] font-mono bg-emerald-500/10 border border-emerald-500/25 text-emerald-300">
          +{n} {n === 1 ? 'line' : 'lines'}
        </span>
      );
    }
    if (tool.name === 'edit_file') {
      const removed = lineCount(asString(args.targetText));
      const added = lineCount(asString(args.replacementText));
      return (
        <span className="px-1.5 py-[1px] rounded-full text-[9px] font-mono bg-white/[0.05] border border-white/10">
          <span className="text-red-400/80">-{removed}</span>{' '}
          <span className="text-emerald-400/80">+{added}</span>
        </span>
      );
    }
    return null;
  };

  return (
    <div className="ag-glass flex flex-col rounded-xl my-2 overflow-hidden text-xs">
      {/* Header bar */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between px-3 py-2 hover:bg-white/[0.04] transition w-full text-left"
      >
        <div className="flex items-center space-x-2 min-w-0">
          {tool.status === 'running' ? (
            <div className="h-3 w-3 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin shrink-0" />
          ) : tool.status === 'succeeded' ? (
            <CheckCircle size={13} className="text-green-500 shrink-0" />
          ) : tool.status === 'refused' ? (
            <Ban size={13} className="text-amber-500 shrink-0" />
          ) : (
            <XCircle size={13} className="text-red-500 shrink-0" />
          )}
          <span className="text-zinc-500 shrink-0">{getToolIcon(tool.name)}</span>
          <span className="font-semibold font-mono text-zinc-300 shrink-0">{tool.name}</span>
          <span className={`text-[9px] uppercase tracking-wider shrink-0 ${
            tool.status === 'failed'
              ? 'text-red-400'
              : tool.status === 'refused'
                ? 'text-amber-400'
                : tool.status === 'succeeded'
                  ? 'text-green-400'
                  : 'text-indigo-300'
          }`}>
            {tool.status}
          </span>
          <span className="truncate max-w-[180px] sm:max-w-[300px] min-w-0">{headerLabel()}</span>
        </div>

        <div className="flex items-center space-x-2 shrink-0">
          {changeBadge()}
          {/* Individual tool execution duration */}
          {tool.duration !== undefined && (
            <span className="flex items-center space-x-1 px-1.5 py-0.5 rounded bg-white/[0.05] border border-white/10 text-[10px] font-mono text-zinc-400">
              <Clock size={10} className="text-zinc-500" />
              <span>{(tool.duration / 1000).toFixed(2)}s</span>
            </span>
          )}
          {isOpen ? <ChevronUp size={14} className="text-zinc-500" /> : <ChevronDown size={14} className="text-zinc-500" />}
        </div>
      </button>

      {/* Expanded body */}
      {isOpen && (
        <div className="border-t border-white/[0.06]">
          {isFileChange ? (
            // Code-review view: the actual code being written / the diff.
            <div className="p-3">
              <FileChangeBody tool={tool} />
              {tool.status === 'failed' && tool.result && (
                <pre className="mt-2 p-2 rounded bg-red-500/[0.08] border border-red-500/20 text-red-300 text-[11px] font-mono whitespace-pre-wrap">
                  {tool.result}
                </pre>
              )}
            </div>
          ) : (
            // Default view for reads, commands, searches: raw inputs + output.
            <div className="p-3 bg-black/30 font-mono space-y-2">
              <div>
                <span className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">Inputs</span>
                <pre className="p-2 bg-black/40 rounded text-zinc-400 overflow-x-auto whitespace-pre-wrap">
                  {JSON.stringify(tool.args, null, 2)}
                </pre>
              </div>

              {tool.result !== undefined && (
                <div>
                  <span className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">Output</span>
                  <pre className="p-2 bg-black/40 rounded text-zinc-300 overflow-x-auto whitespace-pre-wrap max-h-[300px]">
                    {tool.result}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
