'use client';

import React, { useEffect, useState } from 'react';
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
import { DEFAULT_MODEL } from '@/lib/agent/config';
import { Terminal, X, Layers, Orbit } from 'lucide-react';

export default function Page() {
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
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
    mutationRevision,
    affectedFiles,
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
    refreshFiles,
    openFile,
    setCurrentFileContent
  } = useFileExplorer(workspacePath);

  useEffect(() => {
    if (mutationRevision === 0) return;
    void refreshFiles();
    if (currentFileContent && affectedFiles.includes(currentFileContent.path)) {
      void openFile(currentFileContent.path);
    }
  }, [mutationRevision, affectedFiles, currentFileContent, openFile, refreshFiles]);

  const artifactPanelOpen = showArtifacts && (artifacts.length > 0 || !!pendingCommand);

  return (
    <div className="ag-app-bg flex h-screen w-screen overflow-hidden text-zinc-200">

      {/* 1. LEFT SIDEBAR: Agent Manager + File Tree + Models */}
      <div className="w-[300px] flex flex-col border-r border-white/[0.06] bg-black/20 backdrop-blur-sm shrink-0">
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
          onWorkspaceChange={setWorkspacePath}
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
      <div className="flex-1 flex flex-col relative min-w-0">
        {/* Header Navigation */}
        <header className="flex flex-col gap-3 px-6 py-3.5 border-b border-white/[0.06] bg-black/10">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2.5">
              <span className="ag-brand-gradient ag-glow-soft ag-float flex h-8 w-8 items-center justify-center rounded-xl text-white shrink-0">
                <Orbit size={17} strokeWidth={2.2} />
              </span>
              <div className="flex flex-col leading-none">
                <h1 className="text-[15px] font-semibold tracking-tight ag-gradient-text">Antigravity</h1>
                <span className="text-[10px] text-zinc-500 tracking-wide">Local agent workspace</span>
              </div>
            </div>
            <div className="flex items-center space-x-4">
              <span className="text-[11px] font-mono text-zinc-500">
                Workspace <span className="text-zinc-300">{workspacePath}</span>
              </span>
              <button
                onClick={() => setShowArtifacts(prev => !prev)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] transition ${
                  artifactPanelOpen
                    ? 'border-indigo-500/50 bg-indigo-500/10 text-indigo-200 ag-glow'
                    : 'ag-glass ag-glass-hover text-zinc-400 hover:text-zinc-200'
                }`}
                aria-pressed={artifactPanelOpen}
              >
                <Layers size={12} aria-hidden="true" />
                Artifacts
                {artifacts.length > 0 && <span className="text-zinc-500">{artifacts.length}</span>}
              </button>
            </div>
          </div>

          <ExecutionModeBar settings={settings} onChange={updateSettings} disabled={isLoading} />
        </header>

        {/* Chat Stream History Area */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto space-y-5">
              <div className="ag-brand-gradient ag-glow ag-float h-14 w-14 rounded-2xl flex items-center justify-center text-white">
                <Orbit size={28} strokeWidth={2.1} />
              </div>
              <div className="space-y-1.5">
                <h2 className="text-lg font-semibold tracking-tight ag-gradient-text">Welcome to Antigravity</h2>
                <p className="text-xs text-zinc-500 leading-relaxed">
                  An agent-first workspace powered by your local Ollama models. Ask it to explore the codebase,
                  edit source, or run commands — and watch its work land as verifiable Artifacts.
                </p>
              </div>
              <p className="text-[11px] text-zinc-600 leading-relaxed max-w-sm">
                <span className="text-indigo-300/80">Planning</span> mode drafts an Implementation Plan you approve before
                any changes. <span className="text-sky-300/80">Fast</span> mode acts immediately.
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
            <div className="ag-glass max-w-[90%] my-3 p-3 rounded-xl">
              <span className="text-[9px] text-indigo-300/70 uppercase tracking-widest block font-semibold mb-2">
                Task Groups
              </span>
              <TaskGroupList groups={taskGroups} progress={progress} />
            </div>
          )}

          {/* Running Tool Status Cards */}
          {toolCalls.length > 0 && (
            <div className="space-y-2 max-w-[90%] my-3">
              <span className="text-[9px] text-indigo-300/70 uppercase tracking-widest block font-semibold">Agent actions</span>
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
        <div className="p-4 border-t border-white/[0.06] bg-black/10">
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
        <div className="w-[500px] border-l border-white/[0.06] bg-black/30 backdrop-blur-sm flex flex-col shrink-0 animate-in slide-in-from-right duration-250">
          <div className="flex items-center justify-between p-3.5 border-b border-white/[0.06] bg-black/20">
            <div className="flex items-center space-x-2 truncate">
              <Terminal size={14} className="text-indigo-400" />
              <span className="text-xs font-mono text-zinc-300 truncate">{currentFileContent.path}</span>
            </div>
            <button
              onClick={() => setCurrentFileContent(null)}
              className="p-1 rounded-lg hover:bg-white/[0.06] text-zinc-400 hover:text-zinc-200 transition"
            >
              <X size={14} />
            </button>
          </div>

          <pre className="flex-1 overflow-auto p-4 font-mono text-[11px] leading-relaxed text-zinc-300 bg-black/40">
            <code>{currentFileContent.content}</code>
          </pre>
        </div>
      )}

    </div>
  );
}
