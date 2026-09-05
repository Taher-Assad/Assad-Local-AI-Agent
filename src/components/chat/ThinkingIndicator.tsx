import React from 'react';
import { Brain, FileCode, Terminal, Search, FolderOpen, Settings, Loader2, Clock, Hourglass } from 'lucide-react';

interface ThinkingIndicatorProps {
  text: string;
  estimatedTime?: string | null;
  elapsedSeconds?: number;
}

function getIcon(text: string) {
  const lower = text.toLowerCase();
  if (lower.includes('creating') || lower.includes('writing file'))
    return <FileCode size={14} className="text-blue-400" />;
  if (lower.includes('reading file'))
    return <FileCode size={14} className="text-emerald-400" />;
  if (lower.includes('editing code'))
    return <FileCode size={14} className="text-amber-400" />;
  if (lower.includes('executing command'))
    return <Terminal size={14} className="text-amber-400" />;
  if (lower.includes('exploring') || lower.includes('directory'))
    return <FolderOpen size={14} className="text-cyan-400" />;
  if (lower.includes('searching'))
    return <Search size={14} className="text-cyan-400" />;
  if (lower.includes('checking file'))
    return <Settings size={14} className="text-zinc-400" />;
  if (lower.includes('image') || lower.includes('inspecting image'))
    return <FileCode size={14} className="text-pink-400" />;
  if (lower.includes('completed'))
    return <Loader2 size={14} className="text-green-400 animate-spin" />;
  return <Brain size={14} className="text-purple-400" />;
}

export function ThinkingIndicator({ text, estimatedTime, elapsedSeconds = 0 }: ThinkingIndicatorProps) {
  const icon = getIcon(text);

  const formatSeconds = (sec: number) => {
    const mins = Math.floor(sec / 60);
    const remainingSecs = sec % 60;
    if (mins > 0) {
      return `${mins}m ${remainingSecs}s`;
    }
    return `${remainingSecs}s`;
  };

  return (
    <div className="flex flex-col sm:flex-row sm:items-center space-y-2 sm:space-y-0 sm:space-x-3 bg-zinc-900/60 border border-zinc-800/80 rounded-xl px-4 py-2.5 my-2 w-max max-w-[650px] shadow-lg">
      <div className="flex items-center space-x-2.5 min-w-0">
        <div className="shrink-0">
          {icon}
        </div>
        <span className="text-xs text-zinc-200 font-mono tracking-wide truncate">{text}</span>
        <div className="flex space-x-0.5 shrink-0 ml-1">
          <div className="w-1 h-1 bg-purple-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
          <div className="w-1 h-1 bg-purple-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
          <div className="w-1 h-1 bg-purple-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
      </div>

      {/* Live Timer & Estimated Time Badges */}
      <div className="flex items-center space-x-2 shrink-0 sm:border-l sm:border-zinc-800/80 sm:pl-3">
        {/* Live Elapsed Stopwatch */}
        <div className="flex items-center space-x-1 px-2 py-0.5 bg-zinc-950/60 border border-zinc-800 rounded-md text-[11px] font-mono text-purple-300">
          <Clock size={11} className="text-purple-400 animate-spin" style={{ animationDuration: '4s' }} />
          <span>{formatSeconds(elapsedSeconds)}</span>
        </div>

        {/* Estimated Time Badge */}
        {estimatedTime && (
          <div className="flex items-center space-x-1 px-2 py-0.5 bg-zinc-950/60 border border-zinc-800 rounded-md text-[11px] font-mono text-zinc-400">
            <Hourglass size={11} className="text-amber-400" />
            <span>Est: <span className="text-zinc-300">{estimatedTime}</span></span>
          </div>
        )}
      </div>
    </div>
  );
}
