import React, { useState } from 'react';
import { Terminal, FileCode, CheckCircle, Search, Settings, HelpCircle, ChevronDown, ChevronUp, Clock, Image as ImageIcon } from 'lucide-react';

interface ToolCallCardProps {
  tool: {
    name: string;
    args: any;
    status: 'running' | 'done';
    result?: string;
    duration?: number;
  };
}

export function ToolCallCard({ tool }: ToolCallCardProps) {
  const [isOpen, setIsOpen] = useState(false);

  const getToolIcon = (name: string) => {
    switch (name) {
      case 'run_command':
        return <Terminal size={15} className="text-amber-400" />;
      case 'read_file':
      case 'write_file':
      case 'edit_file':
        return <FileCode size={15} className="text-blue-400" />;
      case 'search_files':
        return <Search size={15} className="text-cyan-400" />;
      case 'list_directory':
      case 'file_info':
        return <Settings size={15} className="text-zinc-400" />;
      case 'view_image':
        return <ImageIcon size={15} className="text-pink-400" />;
      default:
        return <HelpCircle size={15} className="text-purple-400" />;
    }
  };

  const formatArgs = (args: any) => {
    if (!args) return '';
    if (typeof args === 'string') return args;
    if (args.filePath) return args.filePath;
    if (args.command) return args.command;
    if (args.pattern) return `"${args.pattern}"`;
    return JSON.stringify(args);
  };

  return (
    <div className="flex flex-col border border-zinc-800/80 bg-zinc-950/40 rounded-lg my-2 overflow-hidden text-xs">
      {/* Header bar */}
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between px-3 py-2 bg-zinc-900/40 hover:bg-zinc-900/70 transition w-full text-left"
      >
        <div className="flex items-center space-x-2 min-w-0">
          {tool.status === 'running' ? (
            <div className="h-3 w-3 border-2 border-purple-500 border-t-transparent rounded-full animate-spin shrink-0" />
          ) : (
            <CheckCircle size={13} className="text-green-500 shrink-0" />
          )}
          <span className="font-semibold font-mono text-zinc-300 shrink-0">{tool.name}</span>
          <span className="text-zinc-500 truncate max-w-[200px] sm:max-w-[350px] font-mono">
            {formatArgs(tool.args)}
          </span>
        </div>

        <div className="flex items-center space-x-2 shrink-0">
          {/* Individual tool execution duration */}
          {tool.duration !== undefined && (
            <span className="flex items-center space-x-1 px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-[10px] font-mono text-zinc-400">
              <Clock size={10} className="text-zinc-500" />
              <span>{(tool.duration / 1000).toFixed(2)}s</span>
            </span>
          )}
          {isOpen ? <ChevronUp size={14} className="text-zinc-500" /> : <ChevronDown size={14} className="text-zinc-500" />}
        </div>
      </button>

      {/* Expanded body (arguments + response) */}
      {isOpen && (
        <div className="p-3 border-t border-zinc-800/40 bg-zinc-950/80 font-mono space-y-2">
          {/* Tool inputs */}
          <div>
            <span className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">Inputs</span>
            <pre className="p-2 bg-zinc-900/60 rounded text-zinc-400 overflow-x-auto whitespace-pre-wrap">
              {JSON.stringify(tool.args, null, 2)}
            </pre>
          </div>

          {/* Tool execution output response */}
          {tool.result !== undefined && (
            <div>
              <span className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">Output</span>
              <pre className="p-2 bg-zinc-900/60 rounded text-zinc-300 overflow-x-auto whitespace-pre-wrap max-h-[300px]">
                {tool.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
