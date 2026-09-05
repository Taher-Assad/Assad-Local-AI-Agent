import React from 'react';
import { ChatSession } from '@/types';
import { MessageSquare, Plus, Trash2 } from 'lucide-react';

interface ChatHistoryProps {
  sessions: ChatSession[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  onDeleteSession: (id: string, e: React.MouseEvent) => void;
}

export function ChatHistory({
  sessions,
  activeSessionId,
  onSelectSession,
  onCreateSession,
  onDeleteSession
}: ChatHistoryProps) {
  return (
    <div className="flex flex-col bg-zinc-950/30 border-b border-zinc-900/60 max-h-[250px]">
      <div className="flex items-center justify-between p-3 border-b border-zinc-900/60">
        <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Chat History</span>
        <button
          onClick={onCreateSession}
          className="flex items-center space-x-1 px-1.5 py-0.5 rounded bg-purple-900/50 hover:bg-purple-800 text-[10px] text-purple-100 transition font-mono border border-purple-800/40"
        >
          <Plus size={10} />
          <span>New Chat</span>
        </button>
      </div>

      <div className="overflow-y-auto p-2 space-y-1 flex-1 min-h-[80px]">
        {sessions.length === 0 ? (
          <div className="text-center py-4 text-zinc-600 text-[11px] font-mono">No previous sessions</div>
        ) : (
          sessions.map((session) => {
            const isActive = session.id === activeSessionId;
            return (
              <div
                key={session.id}
                onClick={() => onSelectSession(session.id)}
                className={`group flex items-center justify-between px-2.5 py-2 rounded-lg cursor-pointer transition text-xs font-mono
                  ${isActive 
                    ? 'bg-purple-950/30 text-purple-200 border border-purple-900/30' 
                    : 'text-zinc-400 hover:bg-zinc-900/40 hover:text-zinc-200 border border-transparent'
                  }`}
              >
                <div className="flex items-center space-x-2 truncate pr-2">
                  <MessageSquare size={13} className={isActive ? 'text-purple-400' : 'text-zinc-500'} />
                  <span className="truncate">{session.title}</span>
                </div>
                <button
                  onClick={(e) => onDeleteSession(session.id, e)}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-950/40 text-zinc-500 hover:text-red-400 transition"
                  title="Delete Chat"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
