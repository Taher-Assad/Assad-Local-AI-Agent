import { useState, useRef, useEffect, useCallback } from 'react';
import {
  AgentRunStatus,
  AgentSettings,
  Artifact,
  ChatSession,
  Message,
  PermissionEvaluation,
  PlanProgress,
  TaskGroup
} from '@/types';
import { AgentUpdate } from '@/lib/agent/engine';
import {
  addComment,
  approveArtifact,
  computeProgress,
  pendingFeedback,
  requestChangesOnArtifact,
  upsertArtifact
} from '@/lib/agent/artifacts';
import { DEFAULT_AGENT_SETTINGS, resolveSettings } from '@/lib/agent/permissions';

const SETTINGS_STORAGE_KEY = 'antigraphity_agent_settings';

/** Extra payload accepted by `sendMessage` for plan approval / steering. */
interface SendOptions {
  approvedPlan?: Artifact | null;
  planFeedback?: string;
  /** Commands the user explicitly approved for this turn. */
  approvedCommands?: string[];
  /** The user's original request, carried across an approval round-trip. */
  goal?: string;
  /** Skip appending a user message (used when resuming an approved plan). */
  silent?: boolean;
}

export function useChat(selectedModel: string, workspacePath: string) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [thinkingText, setThinkingText] = useState<string | null>(null);
  const [estimatedTime, setEstimatedTime] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const [toolCalls, setToolCalls] = useState<{name: string, args: any, status: 'running' | 'done', result?: string, duration?: number}[]>([]);
  // --- Antigravity state ---
  const [settings, setSettings] = useState<AgentSettings>(DEFAULT_AGENT_SETTINGS);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [taskGroups, setTaskGroups] = useState<TaskGroup[]>([]);
  const [progress, setProgress] = useState<PlanProgress | null>(null);
  const [runStatus, setRunStatus] = useState<AgentRunStatus>('idle');
  const [pendingCommand, setPendingCommand] = useState<PermissionEvaluation | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const timerIntervalRef = useRef<NodeJS.Timeout | null>(null);
  /** Mirrors `settings` so `sendMessage` never reads a stale closure value. */
  const settingsRef = useRef<AgentSettings>(DEFAULT_AGENT_SETTINGS);

  // Load chat sessions from localStorage on startup
  useEffect(() => {
    const stored = localStorage.getItem('antigraphity_chat_sessions');
    if (stored) {
      try {
        const parsed: ChatSession[] = JSON.parse(stored);
        setSessions(parsed);
        if (parsed.length > 0) {
          // Select newest session by default
          const sorted = [...parsed].sort((a, b) => b.createdAt - a.createdAt);
          setActiveSessionId(sorted[0].id);
          setMessages(sorted[0].messages);
          setArtifacts(sorted[0].artifacts || []);
        }
      } catch (err) {
        console.error('Failed to parse sessions from localStorage', err);
      }
    }

    const storedSettings = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (storedSettings) {
      try {
        const resolved = resolveSettings(JSON.parse(storedSettings));
        setSettings(resolved);
        settingsRef.current = resolved;
      } catch (err) {
        console.error('Failed to parse agent settings from localStorage', err);
      }
    }
  }, []);

  /** Persists a settings patch (execution mode / review policies). */
  const updateSettings = useCallback((patch: Partial<AgentSettings>) => {
    setSettings(prev => {
      const next = resolveSettings({ ...prev, ...patch });
      settingsRef.current = next;
      try {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
      } catch (err) {
        console.warn('Failed to persist agent settings', err);
      }
      return next;
    });
  }, []);

  // Sanitize sessions to prevent LocalStorage QuotaExceededError and base64 corruption
  const sanitizeSessionsForStorage = (sessionsList: ChatSession[]): ChatSession[] => {
    return sessionsList.slice(0, 20).map(s => ({
      ...s,
      // Keep only the most recent artifacts; plans/walkthroughs are markdown but can add up.
      artifacts: s.artifacts ? s.artifacts.slice(-8) : undefined,
      messages: s.messages.slice(-40).map(m => {
        // Do not store heavy base64 strings in localStorage to avoid QuotaExceeded & truncation
        if (m.images) {
          const { images, ...rest } = m;
          return rest as Message;
        }
        return m;
      })
    }));
  };

  // Sync sessions to local storage whenever they change
  const saveSessions = (updatedSessions: ChatSession[]) => {
    setSessions(updatedSessions);
    try {
      const sanitized = sanitizeSessionsForStorage(updatedSessions);
      localStorage.setItem('antigraphity_chat_sessions', JSON.stringify(sanitized));
    } catch (err) {
      console.warn('LocalStorage quota reached, trimming old sessions...', err);
      try {
        // Aggressive fallback: save only the latest 5 sessions without images
        const compact = updatedSessions.slice(0, 5).map(s => ({
          ...s,
          messages: s.messages.slice(-20).map(m => ({
            role: m.role,
            content: m.content
          }))
        }));
        localStorage.setItem('antigraphity_chat_sessions', JSON.stringify(compact));
      } catch (fallbackErr) {
        console.error('Failed to save sessions even after compacting:', fallbackErr);
      }
    }
  };

  /** Clears artifact/task state so a new or switched session starts clean. */
  const resetRunState = useCallback(() => {
    setArtifacts([]);
    setTaskGroups([]);
    setProgress(null);
    setRunStatus('idle');
    setPendingCommand(null);
  }, []);

  const createSession = () => {
    const newSession: ChatSession = {
      id: crypto.randomUUID(),
      title: 'New Chat',
      messages: [],
      createdAt: Date.now(),
      artifacts: [],
      settings: settingsRef.current,
      runStatus: 'idle'
    };
    const updated = [newSession, ...sessions];
    saveSessions(updated);
    setActiveSessionId(newSession.id);
    setMessages([]);
    setToolCalls([]);
    setThinkingText(null);
    resetRunState();
  };

  const selectSession = (id: string) => {
    const found = sessions.find(s => s.id === id);
    if (found) {
      setActiveSessionId(id);
      setMessages(found.messages);
      setToolCalls([]);
      setThinkingText(null);
      resetRunState();
      setArtifacts(found.artifacts || []);
      const plan = (found.artifacts || []).find(a => a.kind === 'implementation-plan');
      if (plan?.taskGroups) {
        setTaskGroups(plan.taskGroups);
        setProgress(computeProgress(plan.taskGroups));
      }
      setRunStatus(found.runStatus || 'idle');
    }
  };

  const deleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const filtered = sessions.filter(s => s.id !== id);
    saveSessions(filtered);
    
    if (activeSessionId === id) {
      resetRunState();
      if (filtered.length > 0) {
        setActiveSessionId(filtered[0].id);
        setMessages(filtered[0].messages);
        setArtifacts(filtered[0].artifacts || []);
      } else {
        setActiveSessionId(null);
        setMessages([]);
      }
    }
  };

  // Clear timer on unmount
  useEffect(() => {
    return () => {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    };
  }, []);

  const sendMessage = async (content: string, images?: string[], options: SendOptions = {}) => {
    if (!content.trim() && (!images || images.length === 0) && !options.approvedPlan) return;
    if (isLoading) return;

    setThinkingText(null);
    setEstimatedTime(null);
    setElapsedSeconds(0);
    setToolCalls([]);
    setPendingCommand(null);
    setIsLoading(true);
    setRunStatus(
      options.approvedPlan || settingsRef.current.executionMode === 'fast' ? 'executing' : 'planning'
    );
    // A brand-new request supersedes any previous plan state.
    if (!options.approvedPlan) {
      setTaskGroups([]);
      setProgress(null);
    }

    // Start live stopwatch timer
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    timerIntervalRef.current = setInterval(() => {
      setElapsedSeconds(prev => prev + 1);
    }, 1000);

    let currentSessionId = activeSessionId;
    let currentSessions = [...sessions];

    // Create session on the fly if none is active
    if (!currentSessionId) {
      const newSession: ChatSession = {
        id: crypto.randomUUID(),
        title: content.substring(0, 30) + (content.length > 30 ? '...' : ''),
        messages: [],
        createdAt: Date.now(),
        artifacts: [],
        settings: settingsRef.current,
        runStatus: 'idle'
      };
      currentSessionId = newSession.id;
      currentSessions = [newSession, ...currentSessions];
      setActiveSessionId(newSession.id);
    }

    // Store the message with image references for display
    const userMsg: Message = { role: 'user', content, images };
    const updatedMessages = options.silent ? [...messages] : [...messages, userMsg];
    setMessages(updatedMessages);

    // Update active session messages
    currentSessions = currentSessions.map(s => 
      s.id === currentSessionId 
        ? { 
            ...s, 
            messages: updatedMessages,
            title: s.title === 'New Chat' ? content.substring(0, 25) + (content.length > 25 ? '...' : '') : s.title 
          } 
        : s
    );
    saveSessions(currentSessions);

    abortControllerRef.current = new AbortController();

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: content,
          history: messages,
          model: selectedModel,
          workspace: workspacePath,
          images: images,  // Forward image base64 data to the API route
          settings: settingsRef.current,
          approvedPlan: options.approvedPlan ?? null,
          planFeedback: options.planFeedback,
          approvedCommands: options.approvedCommands,
          goal: options.goal
        }),
        signal: abortControllerRef.current.signal
      });

      if (!response.body) {
        throw new Error('No readable body in server response');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assistantResponseContent = '';
      // Artifacts accumulate across turns in a session, so start from what the
      // session already has and add whatever this stream produces.
      let streamArtifacts: Artifact[] = [...artifacts];

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let currentEvent = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.substring(7).trim();
          } else if (line.startsWith('data: ') && currentEvent) {
            try {
              const data: AgentUpdate = JSON.parse(line.substring(6));
              
              if (data.estimatedTime) {
                setEstimatedTime(data.estimatedTime);
              }
              if (data.runStatus) {
                setRunStatus(data.runStatus);
              }

              if (data.type === 'thinking') {
                setThinkingText(data.content || 'Thinking...');
              } else if (data.type === 'phase') {
                setThinkingText(data.content || null);
              } else if (data.type === 'artifact' && data.artifact) {
                const incoming = data.artifact;
                // Track artifacts in a plain variable too, so the session sync
                // below stays outside the state updater (no side effects there).
                streamArtifacts = upsertArtifact(streamArtifacts, incoming);
                setArtifacts(streamArtifacts);
                currentSessions = currentSessions.map(s =>
                  s.id === currentSessionId ? { ...s, artifacts: streamArtifacts } : s
                );
                if (incoming.taskGroups) {
                  setTaskGroups(incoming.taskGroups);
                  setProgress(computeProgress(incoming.taskGroups));
                }
              } else if (data.type === 'task_update') {
                if (data.taskGroups) setTaskGroups(data.taskGroups);
                if (data.progress) setProgress(data.progress);
              } else if (data.type === 'awaiting_review') {
                // A plan awaiting review arrives as an `artifact` event too; only
                // a held shell command needs its own approval prompt.
                if (data.permission) setPendingCommand(data.permission);
                setRunStatus('awaiting-review');
              } else if (data.type === 'permission_denied') {
                setToolCalls(prev => [
                  ...prev,
                  {
                    name: data.name || 'run_command',
                    args: data.args,
                    status: 'done',
                    result: `Refused: ${data.content || 'blocked by policy'}`
                  }
                ]);
              } else if (data.type === 'verification' && data.verification) {
                const check = data.verification;
                setToolCalls(prev => [
                  ...prev,
                  {
                    name: `verify: ${check.label}`,
                    args: { command: check.command },
                    status: 'done',
                    result: `${check.passed ? 'PASS' : 'FAIL'}\n${check.output || ''}`
                  }
                ]);
              } else if (data.type === 'tool_call') {
                setToolCalls(prev => [
                  ...prev,
                  { name: data.name || '', args: data.args, status: 'running' }
                ]);
              } else if (data.type === 'tool_result') {
                setToolCalls(prev =>
                  prev.map(t =>
                    t.name === data.name && t.status === 'running'
                      ? { ...t, status: 'done', result: data.result, duration: data.duration }
                      : t
                  )
                );
              } else if (data.type === 'text') {
                assistantResponseContent += data.content || '';
                
                setMessages(prev => {
                  const lastMsg = prev[prev.length - 1];
                  const finalMsgChain: Message[] = lastMsg && lastMsg.role === 'assistant'
                    ? [...prev.slice(0, -1), { role: 'assistant' as const, content: assistantResponseContent }]
                    : [...prev, { role: 'assistant' as const, content: assistantResponseContent }];

                  // Keep session state updated in memory during stream
                  currentSessions = currentSessions.map(s => 
                    s.id === currentSessionId 
                      ? { ...s, messages: finalMsgChain }
                      : s
                  );

                  return finalMsgChain;
                });
              } else if (data.type === 'error') {
                if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
                setThinkingText(null);
                setIsLoading(false);
                setRunStatus('failed');
                setMessages(prev => {
                  const finalMsgChain: Message[] = [...prev, { role: 'assistant' as const, content: `❌ Error: ${data.content}` }];
                  const syncSessions = currentSessions.map(s => 
                    s.id === currentSessionId
                      ? { ...s, messages: finalMsgChain, runStatus: 'failed' as const }
                      : s
                  );
                  saveSessions(syncSessions);
                  return finalMsgChain;
                });
              } else if (data.type === 'done') {
                if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
                setThinkingText(null);
                setIsLoading(false);
                const finalStatus: AgentRunStatus =
                  data.runStatus === 'awaiting-review' ? 'awaiting-review' : 'completed';
                setRunStatus(finalStatus);
                setMessages(prev => {
                  const syncSessions = currentSessions.map(s => 
                    s.id === currentSessionId
                      ? {
                          ...s,
                          messages: prev,
                          updatedAt: Date.now(),
                          model: selectedModel,
                          runStatus: finalStatus,
                          settings: settingsRef.current
                        }
                      : s
                  );
                  saveSessions(syncSessions);
                  return prev;
                });
              }
            } catch (err) {
              console.error('Failed to parse event JSON:', err);
            }
            currentEvent = '';
          }
        }
      }

    } catch (error: any) {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      if (error.name !== 'AbortError') {
        setMessages(prev => {
          const finalMsgChain: Message[] = [...prev, { role: 'assistant' as const, content: `❌ Connection error: ${error.message}` }];
          const syncSessions = currentSessions.map(s => 
            s.id === currentSessionId ? { ...s, messages: finalMsgChain } : s
          );
          saveSessions(syncSessions);
          return finalMsgChain;
        });
      }
    } finally {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      setIsLoading(false);
      setThinkingText(null);
    }
  };

  const cancelGeneration = () => {
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setIsLoading(false);
      setThinkingText(null);
      setRunStatus('cancelled');
      setMessages(prev => {
        const finalMsgChain: Message[] = [...prev, { role: 'assistant' as const, content: 'Generation cancelled by user.' }];
        const syncSessions = sessions.map(s => 
          s.id === activeSessionId ? { ...s, messages: finalMsgChain } : s
        );
        saveSessions(syncSessions);
        return finalMsgChain;
      });
    }
  };

  /* ---------------------------------------------------------------- *
   * Artifact review actions (Interactive Steering)
   * ---------------------------------------------------------------- */

  const findArtifact = (artifactId: string) => artifacts.find(a => a.id === artifactId);

  /** The most recent real user request, used as the goal on resumed runs. */
  const lastUserGoal = () =>
    [...messages].reverse().find(m => m.role === 'user')?.content || '';

  /** Persists an artifact change into state and the active session. */
  const commitArtifact = (updated: Artifact) => {
    // Computed outside the state updater so the localStorage write is not
    // repeated if React invokes the updater twice (StrictMode).
    const nextArtifacts = upsertArtifact(artifacts, updated);
    setArtifacts(nextArtifacts);
    saveSessions(
      sessions.map(s => (s.id === activeSessionId ? { ...s, artifacts: nextArtifacts } : s))
    );
  };

  /** Approves a plan artifact and resumes the run in execution mode. */
  const approvePlan = async (artifactId: string) => {
    const artifact = findArtifact(artifactId);
    if (!artifact) return;

    const approved = approveArtifact(artifact);
    commitArtifact(approved);
    setPendingCommand(null);

    await sendMessage('Proceed with the approved plan.', undefined, {
      approvedPlan: approved,
      goal: lastUserGoal(),
      silent: true
    });
  };

  /** Records change requests and asks the agent to re-draft the plan. */
  const requestChanges = async (artifactId: string, feedback: string) => {
    const artifact = findArtifact(artifactId);
    if (!artifact) return;

    const updated = requestChangesOnArtifact(artifact, feedback);
    commitArtifact(updated);

    const steering = pendingFeedback(updated).join('\n');
    await sendMessage(feedback || 'Please revise the plan.', undefined, {
      planFeedback: steering,
      goal: lastUserGoal(),
      silent: true
    });
  };

  /** Adds a comment to an artifact without resuming the run. */
  const addArtifactComment = (artifactId: string, body: string) => {
    const artifact = findArtifact(artifactId);
    if (!artifact) return;
    commitArtifact(addComment(artifact, body, 'user'));
  };

  /** Runs a command that was held for review, allow-listing it for this turn. */
  const approvePendingCommand = async () => {
    const command = pendingCommand?.command;
    setPendingCommand(null);
    if (!command) return;
    await sendMessage(`Approved. Run this command now: \`${command}\``, undefined, {
      approvedCommands: [command],
      goal: lastUserGoal()
    });
  };

  const rejectPendingCommand = () => setPendingCommand(null);

  return {
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
    // --- Antigravity surface ---
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
  };
}

