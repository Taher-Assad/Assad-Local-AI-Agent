import React from 'react';
import { Message } from '@/types';
import { marked } from 'marked';

interface ChatMessageProps {
  message: Message;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isTool = message.role === 'tool';

  if (isSystem || isTool) return null;

  // Convert Markdown contents to HTML, routing local relative image paths through /api/files
  const getHtmlContent = (text: string) => {
    try {
      // Replace relative markdown image paths like ![Alt](image.png) with /api/files?mode=raw&path=image.png
      const rewritten = text.replace(/!\[([^\]]*)\]\((?!http|\/|data:)([^)]+)\)/g, (match, alt, src) => {
        return `![${alt}](/api/files?mode=raw&path=${encodeURIComponent(src)})`;
      });
      return { __html: marked.parse(rewritten) };
    } catch {
      return { __html: text };
    }
  };

  // Helper to extract any mentioned image filenames from the text (e.g. enhanced_image.png, output.jpg)
  const extractMentionedImages = (text: string): string[] => {
    if (isUser || !text) return [];
    const imgRegex = /(?:saved\s+as|created|generated|saved\s+to|output:?)\s*[`'"]?([a-zA-Z0-9_\-./\\]+\.(?:png|jpg|jpeg|webp|svg|gif))[`'"]?/gi;
    const matches = new Set<string>();
    let m;
    while ((m = imgRegex.exec(text)) !== null) {
      if (m[1] && !m[1].startsWith('http') && !m[1].startsWith('data:')) {
        matches.add(m[1].trim());
      }
    }
    return Array.from(matches);
  };

  const detectedImages = extractMentionedImages(message.content || '');

  return (
    <div className={`flex w-full my-4 ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`flex max-w-[85%] items-start space-x-3 rounded-2xl p-4 shadow-lg transition-all duration-200 border
        ${isUser
          ? 'bg-indigo-500/12 text-indigo-50 border-indigo-500/30 rounded-br-md'
          : 'ag-glass text-zinc-100 rounded-bl-md'
        }`}
      >
        <div className="flex flex-col space-y-2 w-full">
          {/* Sender Header */}
          <span className={`text-[11px] font-semibold uppercase tracking-wider ${isUser ? 'text-indigo-300 text-right' : 'ag-gradient-text'}`}>
            {isUser ? 'Developer' : 'Antigravity'}
          </span>

          {/* Attached Images (shown for user messages) */}
          {isUser && message.images && message.images.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-1">
              {message.images.map((imgSrc, idx) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={idx}
                  src={imgSrc.startsWith('data:') ? imgSrc : `data:image/png;base64,${imgSrc}`}
                  alt={`Attached image ${idx + 1}`}
                  className="max-w-[240px] max-h-[180px] object-contain rounded-lg border border-indigo-500/30 cursor-pointer hover:opacity-90 transition"
                  onClick={() => window.open(imgSrc.startsWith('data:') ? imgSrc : `data:image/png;base64,${imgSrc}`, '_blank')}
                />
              ))}
            </div>
          )}

          {/* Main Message Content */}
          {message.content && (
            <div 
              className="prose prose-invert max-w-none text-sm leading-relaxed
                prose-pre:bg-black/60 prose-pre:border prose-pre:border-white/10 prose-pre:rounded-lg
                prose-code:text-sky-300 prose-code:bg-sky-500/10 prose-code:px-1 prose-code:py-0.5 prose-code:rounded
                prose-a:text-indigo-300 hover:prose-a:underline"
              dangerouslySetInnerHTML={getHtmlContent(message.content)} 
            />
          )}

          {/* Render Auto-Detected Generated/Modified Images */}
          {!isUser && detectedImages.length > 0 && (
            <div className="mt-3 pt-3 border-t border-zinc-800/60 flex flex-col space-y-2">
              <span className="text-[10px] text-zinc-400 font-semibold uppercase tracking-wider">Generated / Modified Output:</span>
              <div className="flex flex-wrap gap-3">
                {detectedImages.map((imgName, idx) => (
                  <div key={idx} className="flex flex-col bg-zinc-950 border border-zinc-800 rounded-lg p-2 max-w-[320px]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/files?mode=raw&path=${encodeURIComponent(imgName)}`}
                      alt={imgName}
                      className="max-w-full max-h-[240px] object-contain rounded border border-zinc-800/80 cursor-pointer hover:opacity-95 transition bg-black/40"
                      onClick={() => window.open(`/api/files?mode=raw&path=${encodeURIComponent(imgName)}`, '_blank')}
                      onError={(e) => {
                        // Hide if file doesn't exist on disk
                        (e.target as HTMLElement).parentElement!.style.display = 'none';
                      }}
                    />
                    <span className="text-[11px] font-mono text-sky-300 mt-1.5 truncate">
                      {imgName}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
