'use client';

import React, { useState } from 'react';
import { ModelSelector } from '@/components/sidebar/ModelSelector';
import { FileExplorer } from '@/components/sidebar/FileExplorer';
import { ChatMessage } from '@/components/chat/ChatMessage';
import { ChatInput } from '@/components/chat/ChatInput';
import { ToolCallCard } from '@/components/chat/ToolCallCard';
import { ThinkingIndicator } from '@/components/chat/ThinkingIndicator';
import { AgentManager } from '@/components/agent/AgentManager';
import { ArtifactPanel } from '@/components/agent/ArtifactPanel';
import { ExecutionModeBar } from '@/components/agent/ExecutionModeBar';
import { TaskGroupList } from '@/components/agent/TaskGroupList';
import { useChat } from '@/hooks/useChat';
import { useFileExplorer } from '@/hooks/useFileExplorer';
import { Terminal, X, Code2, Layers } from 'lucide-react';

export default function Page() {
  const [selectedModel, setSelectedModel] = useState('qwen3.5:9b');
  const [workspacePath, setWorkspacePath] = useState('c:/D/antigraphity-agent'); // Set workspace relative path default
  const [showArtifacts, setShowArtifacts] = useState(true);

  // Custom chat hook
  const {
    sessions,
    activeSessionId,
    messages,
    isLoading,
    thinkingText,
    estimatedTime,
    elapsedSeconds,
    toolCalls,
    sendMessage,
    cancelGeneration,
    createSession,
    selectSession,
    deleteSession,
    settings,
    updateSettings,
    artifacts,
    taskGroups,
    progress,
    runStatus,
    pendingCommand,
    approvePlan,
    requestChanges,
    addArtifactComment,
    approvePendingCommand,
    rejectPendingCommand
  } = useChat(selectedModel, workspacePath);

  // File explorer hook
  const {
    files,
    loading: loadingFiles,
    currentFileContent,
    fetchFiles,
    openFile,
    setCurrentFileContent
  } = useFileExplorer(workspacePath);

  const artifactPanelOpen = showArtifacts && (artifacts.length > 0 || !!pendingCommand);

  return (
    <div className="flex h-screen w-screen bg-[#070709] overflow-hidden text-zinc-200">
      
      {/* 1. LEFT SIDEBAR: Agent Manager + File Tree + Models */}
      <div className="w-[300px] flex flex-col border-r border-zinc-900/80 bg-zinc-950/20 shrink-0">
        <AgentManager
          sessions={sessions}
          activeSessionId={activeSessionId}
          activeRunStatus={runStatus}
          activeProgress={progress}
          activeArtifactCount={artifacts.length}
          onSelectSession={selectSession}
          onCreateSession={createSession}
          onDeleteSession={deleteSession}
        />

        <ModelSelector
          selectedModel={selectedModel}
          onModelSelect={setSelectedModel}
          workspacePath={workspacePath}
          onWorkspaceChange={(path) => {
            setWorkspacePath(path);
            fetchFiles(path);
          }}
        />
        
        <div className="flex-1 overflow-hidden">
          <FileExplorer
            files={files}
            loading={loadingFiles}
            onFileSelect={openFile}
            onFolderExpand={(path) => fetchFiles(path)}
          />
        </div>
      </div>

      {/* 2. CENTER PANEL: Chat Workspace */}
      <div className="flex-1 flex flex-col bg-zinc-950/5 relative min-w-0">
        {/* Header Navigation */}
        <header className="flex flex-col gap-3 px-6 py-3.5 border-b border-zinc-900/60 bg-zinc-950/10">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Code2 className="text-purple-500 animate-pulse" size={20} />
              <h1 className="text-sm font-bold tracking-wider uppercase text-zinc-100">Assad Local AI Agent</h1>
            </div>
            <div className="flex items-center space-x-4">
              <span className="text-[11px] font-mono text-zinc-500">
                Active Workspace: <span className="text-zinc-400">{workspacePath}</span>
              </span>
              <button
                onClick={() => setShowArtifacts(prev => !prev)}
                className={`flex items-center gap-1.5 px-2 py-1 rounded border text-[10px] font-mono transition ${
                  artifactPanelOpen
                    ? 'bg-purple-950/40 border-purple-800/50 text-purple-200'
                    : 'bg-zinc-950/60 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
                aria-pressed={artifactPanelOpen}
              >
                <Layers size={11} aria-hidden="true" />
                Artifacts
                {artifacts.length > 0 && <span>({artifacts.length})</span>}
              </button>
            </div>
          </div>

          <ExecutionModeBar settings={settings} onChange={updateSettings} disabled={isLoading} />
        </header>

        {/* Chat Stream History Area */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto space-y-4">
              <div className="h-12 w-12 rounded-2xl bg-purple-950/30 border border-purple-800/40 flex items-center justify-center text-purple-400">
                <Code2 size={24} />
              </div>
              <h2 className="text-base font-semibold text-zinc-200">Local Coding Agent Workspace</h2>
              <p className="text-xs text-zinc-500 leading-relaxed">
                Antigraphity is powered by your local Ollama LLM. Ask it to inspect directory structures, modify source code, or execute npm test scripts in this sandbox.
              </p>
              <p className="text-[11px] text-zinc-600 leading-relaxed">
                Planning mode drafts an Implementation Plan you can approve before any file changes.
                Fast mode acts immediately.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((msg, idx) => (
                <ChatMessage key={idx} message={msg} />
              ))}
            </div>
          )}

          {/* Live plan progress during a Planning-mode run */}
          {taskGroups.length > 0 && (
            <div className="max-w-[90%] my-3 p-3 rounded-lg border border-zinc-800/80 bg-zinc-950/40">
              <span className="text-[9px] text-zinc-500 uppercase tracking-widest block font-bold mb-2">
                Task Groups
              </span>
              <TaskGroupList groups={taskGroups} progress={progress} />
            </div>
          )}

          {/* Running Tool Status Cards */}
          {toolCalls.length > 0 && (
            <div className="space-y-2 max-w-[90%] my-3">
              <span className="text-[9px] text-zinc-500 uppercase tracking-widest block font-bold">Workspace Agent Actions</span>
              {toolCalls.map((tool, idx) => (
                <ToolCallCard key={idx} tool={tool} />
              ))}
            </div>
          )}

          {/* Agent internal thinking loop status with live timer and estimate */}
          {thinkingText && (
            <ThinkingIndicator 
              text={thinkingText} 
              estimatedTime={estimatedTime} 
              elapsedSeconds={elapsedSeconds} 
            />
          )}
        </div>

        {/* Input box */}
        <div className="p-4 border-t border-zinc-900/60 bg-zinc-950/20">
          <ChatInput
            onSend={sendMessage}
            isLoading={isLoading}
            onCancel={cancelGeneration}
          />
        </div>
      </div>

      {/* 3. RIGHT PANEL: Artifacts (plans, walkthroughs, media) */}
      {artifactPanelOpen && (
        <ArtifactPanel
          artifacts={artifacts}
          progress={progress}
          pendingCommand={pendingCommand}
          busy={isLoading}
          onApprovePlan={approvePlan}
          onRequestChanges={requestChanges}
          onComment={addArtifactComment}
          onApproveCommand={approvePendingCommand}
          onRejectCommand={rejectPendingCommand}
          onClose={() => setShowArtifacts(false)}
        />
      )}

      {/* 4. RIGHT PANEL: Quick Code Viewer */}
      {currentFileContent && (
        <div className="w-[500px] border-l border-zinc-900/80 bg-zinc-950/40 flex flex-col shrink-0 animate-in slide-in-from-right duration-250">
          <div className="flex items-center justify-between p-3.5 border-b border-zinc-900/60 bg-zinc-950/20">
            <div className="flex items-center space-x-2 truncate">
              <Terminal size={14} className="text-purple-400" />
              <span className="text-xs font-mono text-zinc-300 truncate">{currentFileContent.path}</span>
            </div>
            <button 
              onClick={() => setCurrentFileContent(null)}
              className="p-1 rounded hover:bg-zinc-800/80 text-zinc-400 hover:text-zinc-200 transition"
            >
              <X size={14} />
            </button>
          </div>
          
          <pre className="flex-1 overflow-auto p-4 font-mono text-[11px] leading-relaxed text-zinc-300 bg-zinc-950/60">
            <code>{currentFileContent.content}</code>
          </pre>
        </div>
      )}

    </div>
  );
}
