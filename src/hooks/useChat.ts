import { useState, useRef, useEffect, useCallback } from 'react';
import {
  AgentRunStatus,
  AgentSettings,
  AgentUpdate,
  Artifact,
  ChatSession,
  Message,
  PermissionEvaluation,
  PlanProgress,
  TaskGroup,
  ToolCallState
} from '@/types';
import {
  CHAT_STREAM_CONTENT_TYPE,
  CHAT_STREAM_PROTOCOL,
  CHAT_STREAM_PROTOCOL_HEADER
} from '@/lib/agent/config';
import { SseParser } from '@/lib/sse';
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
  const [toolCalls, setToolCalls] = useState<ToolCallState[]>([]);
  const [mutationRevision, setMutationRevision] = useState(0);
  const [affectedFiles, setAffectedFiles] = useState<string[]>([]);
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
          const rest: Message = { ...m };
          delete rest.images;
          return rest;
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
    setAffectedFiles([]);
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

      if (!response.ok) {
        const contentType = response.headers.get('content-type') || '';
        const detail = contentType.includes('application/json')
          ? await response.json().catch(() => null)
          : await response.text().catch(() => '');
        const message =
          detail && typeof detail === 'object' && typeof detail.error === 'string'
            ? detail.error
            : typeof detail === 'string' && detail.trim()
              ? detail.trim()
              : `Chat request failed (${response.status})`;
        throw new Error(message);
      }

      const contentType = response.headers.get('content-type')?.toLowerCase() || '';
      if (!contentType.startsWith(CHAT_STREAM_CONTENT_TYPE)) {
        throw new Error(`Unexpected chat response content type: ${contentType || 'missing'}`);
      }

      const protocol = response.headers.get(CHAT_STREAM_PROTOCOL_HEADER);
      if (protocol !== CHAT_STREAM_PROTOCOL) {
        throw new Error(`Unsupported chat stream protocol: ${protocol || 'missing'}`);
      }

      if (!response.body) {
        throw new Error('No readable body in server response');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      let assistantResponseContent = '';
      let sawRunStarted = false;
      let sawTerminalEvent = false;
      // Artifacts accumulate across turns in a session, so start from what the
      // session already has and add whatever this stream produces.
      let streamArtifacts: Artifact[] = [...artifacts];

      const handleEvent = (eventName: string, payload: string) => {
        let data: AgentUpdate;
        try {
          data = JSON.parse(payload) as AgentUpdate;
        } catch (error) {
          throw new Error(`Invalid JSON in ${eventName || 'message'} event: ${toErrorMessage(error)}`);
        }

        if (data.type !== eventName) {
          throw new Error(`Chat stream event mismatch: event=${eventName}, data.type=${data.type}`);
        }
        if (!sawRunStarted && data.type !== 'run_started') {
          throw new Error('Chat stream did not begin with run_started');
        }
        if (data.type === 'run_started') {
          if (sawRunStarted) throw new Error('Chat stream sent run_started more than once');
          if (data.protocol !== CHAT_STREAM_PROTOCOL) {
            throw new Error(`Unsupported run protocol: ${data.protocol || 'missing'}`);
          }
          sawRunStarted = true;
        }

        if (data.estimatedTime) setEstimatedTime(data.estimatedTime);
        if (data.runStatus) setRunStatus(data.runStatus);
        if (data.mutationRevision !== undefined) setMutationRevision(data.mutationRevision);
        if (data.affectedFiles?.length) {
          setAffectedFiles(previous => Array.from(new Set([...previous, ...data.affectedFiles!])))
        }

        if (data.type === 'thinking') {
          setThinkingText(data.content || 'Thinking...');
        } else if (data.type === 'phase') {
          setThinkingText(data.content || null);
        } else if (data.type === 'artifact' && data.artifact) {
          const incoming = data.artifact;
          streamArtifacts = upsertArtifact(streamArtifacts, incoming);
          setArtifacts(streamArtifacts);
          currentSessions = currentSessions.map(session =>
            session.id === currentSessionId ? { ...session, artifacts: streamArtifacts } : session
          );
          if (incoming.taskGroups) {
            setTaskGroups(incoming.taskGroups);
            setProgress(computeProgress(incoming.taskGroups));
          }
        } else if (data.type === 'task_update') {
          if (data.taskGroups) setTaskGroups(data.taskGroups);
          if (data.progress) setProgress(data.progress);
        } else if (data.type === 'awaiting_review') {
          if (data.permission) setPendingCommand(data.permission);
          setRunStatus('awaiting-review');
        } else if (data.type === 'permission_denied') {
          setToolCalls(previous => [
            ...previous,
            {
              callId: data.callId || crypto.randomUUID(),
              name: data.name || 'run_command',
              args: data.args,
              status: 'refused',
              result: data.content || 'Blocked by policy'
            }
          ]);
        } else if (data.type === 'verification' && data.verification) {
          const check = data.verification;
          setToolCalls(previous => [
            ...previous,
            {
              callId: data.callId || crypto.randomUUID(),
              name: `verify: ${check.label}`,
              args: { command: check.command },
              status: check.passed ? 'succeeded' : 'failed',
              result: `${check.passed ? 'PASS' : 'FAIL'}\n${check.output || ''}`
            }
          ]);
        } else if (data.type === 'tool_call') {
          if (!data.callId) throw new Error('tool_call event is missing callId');
          setToolCalls(previous => [
            ...previous,
            { callId: data.callId!, name: data.name || '', args: data.args, status: 'running' }
          ]);
        } else if (data.type === 'tool_result') {
          if (!data.callId) throw new Error('tool_result event is missing callId');
          setToolCalls(previous => {
            const index = previous.findIndex(tool => tool.callId === data.callId);
            if (index < 0) return previous;
            const next = [...previous];
            next[index] = {
              ...next[index],
              status: data.resultStatus || 'succeeded',
              result: data.result?.output ?? '',
              duration: data.duration
            };
            return next;
          });
        } else if (data.type === 'text') {
          assistantResponseContent += data.content || '';
          setMessages(previous => {
            const lastMessage = previous[previous.length - 1];
            const finalMessages: Message[] = lastMessage?.role === 'assistant'
              ? [...previous.slice(0, -1), { role: 'assistant', content: assistantResponseContent }]
              : [...previous, { role: 'assistant', content: assistantResponseContent }];
            currentSessions = currentSessions.map(session =>
              session.id === currentSessionId ? { ...session, messages: finalMessages } : session
            );
            return finalMessages;
          });
        } else if (data.type === 'error') {
          sawTerminalEvent = true;
          throw new Error(data.content || data.code || 'Agent stream failed');
        } else if (data.type === 'done') {
          sawTerminalEvent = true;
          const finalStatus: AgentRunStatus =
            data.runStatus === 'awaiting-review' ? 'awaiting-review' : 'completed';
          setRunStatus(finalStatus);
          setMessages(previous => {
            const synchronizedSessions = currentSessions.map(session =>
              session.id === currentSessionId
                ? {
                    ...session,
                    messages: previous,
                    updatedAt: Date.now(),
                    model: selectedModel,
                    runStatus: finalStatus,
                    settings: settingsRef.current
                  }
                : session
            );
            saveSessions(synchronizedSessions);
            return previous;
          });
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          handleEvent(event.event, event.data);
        }
      }

      const finalDecoded = decoder.decode();
      const finalEvents = [
        ...parser.push(finalDecoded),
        ...parser.finish()
      ];
      for (const event of finalEvents) handleEvent(event.event, event.data);

      if (!sawRunStarted) throw new Error('Chat stream ended before run_started');
      if (!sawTerminalEvent) throw new Error('Chat stream ended before a terminal event');

    } catch (error: unknown) {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      if (!aborted) {
        setRunStatus('failed');
        setToolCalls(previous => previous.map(tool =>
          tool.status === 'running'
            ? { ...tool, status: 'failed', result: 'The stream ended before this tool returned.' }
            : tool
        ));
        setMessages(previous => {
          const finalMessages: Message[] = [
            ...previous,
            { role: 'assistant', content: `Connection error: ${toErrorMessage(error)}` }
          ];
          const synchronizedSessions = currentSessions.map(session =>
            session.id === currentSessionId
              ? { ...session, messages: finalMessages, runStatus: 'failed' as const }
              : session
          );
          saveSessions(synchronizedSessions);
          return finalMessages;
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
    mutationRevision,
    affectedFiles,
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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

