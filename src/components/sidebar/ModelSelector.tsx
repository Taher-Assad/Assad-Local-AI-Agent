import React, { useCallback, useEffect, useState } from 'react';
import { Cpu, RefreshCw } from 'lucide-react';
import { DEFAULT_MODEL } from '@/lib/agent/config';

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

  const checkOllama = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch('/api/models');
      if (!res.ok) throw new Error(`Model discovery failed (${res.status})`);

      const data = await res.json();
      const installedModels: { name: string }[] = Array.isArray(data.models)
        ? data.models.filter((model: unknown): model is { name: string } =>
            typeof model === 'object' && model !== null && typeof (model as { name?: unknown }).name === 'string'
          )
        : [];

      setConnected(data.connected === true);
      setModels(installedModels);

      if (installedModels.length > 0 && !installedModels.some(model => model.name === selectedModel)) {
        const fallback = installedModels.find(model => model.name === DEFAULT_MODEL) ?? installedModels[0];
        onModelSelect(fallback.name);
      }
    } catch {
      setConnected(false);
      setModels([]);
    } finally {
      setChecking(false);
    }
  }, [onModelSelect, selectedModel]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void checkOllama(); }, 0);
    return () => window.clearTimeout(timer);
  }, [checkOllama]);

  return (
    <div className="flex flex-col bg-black/10 p-4 border-b border-white/[0.06] space-y-4">
      {/* Connection Indicator Status */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <div className={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]' : 'bg-red-500 shadow-[0_0_8px_#ef4444]'}`} />
          <span className="text-xs font-semibold text-zinc-300">Ollama Status</span>
        </div>
        <button 
          onClick={checkOllama}
          disabled={checking}
          className="p-1 rounded-lg hover:bg-white/[0.06] text-zinc-400 hover:text-zinc-200 transition disabled:opacity-40"
        >
          <RefreshCw size={12} className={checking ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Model Selection Dropdown */}
      <div className="space-y-1.5">
        <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block">Active LLM Model</label>
        <div className="ag-glass relative flex items-center rounded-lg px-2.5 py-1.5">
          <Cpu size={14} className="text-indigo-400 mr-2 shrink-0" />
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
          className="ag-glass w-full rounded-lg px-2.5 py-1.5 text-xs text-zinc-300 font-mono outline-none focus:border-indigo-500/70 transition"
        />
      </div>
    </div>
  );
}
