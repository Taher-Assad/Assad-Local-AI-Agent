import React, { useState, useEffect } from 'react';
import { Cpu, RefreshCw } from 'lucide-react';

interface ModelSelectorProps {
  selectedModel: string;
  onModelSelect: (model: string) => void;
  workspacePath: string;
  onWorkspaceChange: (path: string) => void;
}

export function ModelSelector({
  selectedModel,
  onModelSelect,
  workspacePath,
  onWorkspaceChange
}: ModelSelectorProps) {
  const [connected, setConnected] = useState(false);
  const [models, setModels] = useState<{ name: string }[]>([]);
  const [checking, setChecking] = useState(false);

  const checkOllama = async () => {
    setChecking(true);
    try {
      const res = await fetch('/api/models');
      const data = await res.json();
      setConnected(data.connected);
      if (data.models) {
        setModels(data.models);
        // Automatically select first model if none or if qwen coder isn't active
        if (data.models.length > 0 && !selectedModel) {
          const defaultModel = data.models.find((m: any) => m.name.includes('qwen'))?.name || data.models[0].name;
          onModelSelect(defaultModel);
        }
      }
    } catch {
      setConnected(false);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    checkOllama();
  }, []);

  return (
    <div className="flex flex-col bg-zinc-950/40 p-4 border-b border-zinc-900/60 space-y-4">
      {/* Connection Indicator Status */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <div className={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]' : 'bg-red-500 shadow-[0_0_8px_#ef4444]'}`} />
          <span className="text-xs font-semibold text-zinc-300">Ollama Status</span>
        </div>
        <button 
          onClick={checkOllama} 
          disabled={checking}
          className="p-1 rounded hover:bg-zinc-800/80 text-zinc-400 hover:text-zinc-200 transition disabled:opacity-40"
        >
          <RefreshCw size={12} className={checking ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Model Selection Dropdown */}
      <div className="space-y-1.5">
        <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block">Active LLM Model</label>
        <div className="relative flex items-center bg-zinc-900/60 border border-zinc-800/80 rounded-lg px-2.5 py-1.5">
          <Cpu size={14} className="text-purple-400 mr-2 shrink-0" />
          {models.length > 0 ? (
            <select
              value={selectedModel}
              onChange={(e) => onModelSelect(e.target.value)}
              className="w-full bg-transparent border-0 outline-none text-xs text-zinc-200 font-mono focus:ring-0 cursor-pointer"
            >
              {models.map(m => (
                <option key={m.name} value={m.name} className="bg-zinc-950 text-zinc-300">
                  {m.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-xs text-zinc-500 font-mono">No models found</span>
          )}
        </div>
      </div>

      {/* Workspace target input */}
      <div className="space-y-1.5">
        <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block">Target Workspace Path</label>
        <input
          type="text"
          value={workspacePath}
          onChange={(e) => onWorkspaceChange(e.target.value)}
          placeholder="Absolute path on disk..."
          className="w-full bg-zinc-900/60 border border-zinc-800/80 rounded-lg px-2.5 py-1.5 text-xs text-zinc-300 font-mono outline-none focus:border-purple-500 transition"
        />
      </div>
    </div>
  );
}
