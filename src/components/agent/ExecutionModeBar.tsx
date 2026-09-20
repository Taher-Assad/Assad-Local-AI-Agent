import React from 'react';
import { AgentSettings, ArtifactReviewPolicy, CommandExecutionPolicy, ExecutionMode } from '@/types';
import { ClipboardList, Shield, Terminal, Zap } from 'lucide-react';

interface ExecutionModeBarProps {
  settings: AgentSettings;
  onChange: (patch: Partial<AgentSettings>) => void;
  /** Policies are locked while a run is in flight. */
  disabled?: boolean;
}

const MODE_OPTIONS: { value: ExecutionMode; label: string; hint: string }[] = [
  { value: 'planning', label: 'Planning', hint: 'Research, plan, then execute task groups' },
  { value: 'fast', label: 'Fast', hint: 'Act immediately with minimal planning' }
];

const ARTIFACT_OPTIONS: { value: ArtifactReviewPolicy; label: string }[] = [
  { value: 'request-review', label: 'Request Review' },
  { value: 'always-proceed', label: 'Always Proceed' }
];

const COMMAND_OPTIONS: { value: CommandExecutionPolicy; label: string }[] = [
  { value: 'request-review', label: 'Request Review' },
  { value: 'proceed-in-sandbox', label: 'Proceed in Sandbox' },
  { value: 'always-proceed', label: 'Always Proceed' }
];

/** Toolbar for the execution mode and the two review policies. */
export function ExecutionModeBar({ settings, onChange, disabled = false }: ExecutionModeBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div
        className="flex items-center gap-1"
        role="radiogroup"
        aria-label="Execution mode"
      >
        {MODE_OPTIONS.map(option => {
          const active = settings.executionMode === option.value;
          return (
            <button
              key={option.value}
              role="radio"
              aria-checked={active}
              title={option.hint}
              disabled={disabled}
              onClick={() => onChange({ executionMode: option.value })}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] transition disabled:opacity-50 disabled:cursor-not-allowed ${
                active
                  ? 'border-indigo-500/50 bg-indigo-500/15 text-indigo-100 ag-glow'
                  : 'ag-glass ag-glass-hover text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {option.value === 'planning' ? (
                <ClipboardList size={11} aria-hidden="true" />
              ) : (
                <Zap size={11} aria-hidden="true" />
              )}
              {option.label}
            </button>
          );
        })}
      </div>

      <label className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-500">
        <Shield size={11} className="text-zinc-500" aria-hidden="true" />
        <span className="sr-only">Artifact review policy</span>
        <select
          value={settings.artifactReviewPolicy}
          disabled={disabled}
          onChange={event =>
            onChange({ artifactReviewPolicy: event.target.value as ArtifactReviewPolicy })
          }
          className="ag-glass rounded-lg px-1.5 py-1 text-[10px] text-zinc-300 focus:border-indigo-500/70 focus:outline-none disabled:opacity-50"
          aria-label="Artifact review policy"
        >
          {ARTIFACT_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>
              Artifacts: {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-500">
        <Terminal size={11} className="text-zinc-500" aria-hidden="true" />
        <span className="sr-only">Terminal command auto execution</span>
        <select
          value={settings.commandExecutionPolicy}
          disabled={disabled}
          onChange={event =>
            onChange({ commandExecutionPolicy: event.target.value as CommandExecutionPolicy })
          }
          className="ag-glass rounded-lg px-1.5 py-1 text-[10px] text-zinc-300 focus:border-indigo-500/70 focus:outline-none disabled:opacity-50"
          aria-label="Terminal command auto execution policy"
        >
          {COMMAND_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>
              Terminal: {option.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
