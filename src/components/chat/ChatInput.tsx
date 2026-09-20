'use client';
import React, { useState, useRef, useEffect } from 'react';
import { Send, Square, ImagePlus, X } from 'lucide-react';

interface ChatInputProps {
  onSend: (message: string, images?: string[]) => void;
  isLoading: boolean;
  onCancel: () => void;
}

export function ChatInput({ onSend, isLoading, onCancel }: ChatInputProps) {
  const [input, setInput] = useState('');
  const [attachedImages, setAttachedImages] = useState<{ dataUrl: string; name: string }[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if ((!input.trim() && attachedImages.length === 0) || isLoading) return;
    onSend(input, attachedImages.map(img => img.dataUrl));
    setInput('');
    setAttachedImages([]);
  };

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if ((input.trim() || attachedImages.length > 0) && !isLoading) {
        onSend(input, attachedImages.map(img => img.dataUrl));
        setInput('');
        setAttachedImages([]);
      }
    }
  };

  // Compress image before saving/sending to prevent exceeding LocalStorage quota
  const compressImage = (file: File): Promise<string> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const maxDim = 1024; // Limit max dimension to 1024px
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            if (width > height) {
              height = Math.round((height * maxDim) / width);
              width = maxDim;
            } else {
              width = Math.round((width * maxDim) / height);
              height = maxDim;
            }
          }
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0, width, height);
            // Compress to JPEG with 0.7 quality to keep payload small
            resolve(canvas.toDataURL('image/jpeg', 0.7));
          } else {
            resolve(ev.target?.result as string);
          }
        };
        img.onerror = () => resolve(ev.target?.result as string);
        img.src = ev.target?.result as string;
      };
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    });
  };

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      const dataUrl = await compressImage(file);
      if (dataUrl) {
        setAttachedImages(prev => [...prev, { dataUrl, name: file.name }]);
      }
    }
    // Reset so same file can be attached again
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeImage = (index: number) => {
    setAttachedImages(prev => prev.filter((_, i) => i !== index));
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) continue;
        const dataUrl = await compressImage(file);
        if (dataUrl) {
          setAttachedImages(prev => [...prev, { dataUrl, name: 'pasted-image.jpg' }]);
        }
      }
    }
  };

  const canSend = (input.trim() || attachedImages.length > 0) && !isLoading;

  return (
    <div className="flex flex-col space-y-2">
      {/* Image Previews */}
      {attachedImages.length > 0 && (
        <div className="flex flex-wrap gap-2 px-1">
          {attachedImages.map((img, idx) => (
            <div key={idx} className="relative group">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.dataUrl}
                alt={img.name}
                className="w-20 h-20 object-cover rounded-lg border border-zinc-700/60"
              />
              <button
                onClick={() => removeImage(idx)}
                className="absolute -top-1.5 -right-1.5 bg-zinc-900 border border-zinc-700 rounded-full p-0.5 text-zinc-400 hover:text-red-400 opacity-0 group-hover:opacity-100 transition"
                type="button"
              >
                <X size={12} />
              </button>
              <span className="absolute bottom-0 left-0 right-0 bg-zinc-950/70 text-[9px] text-zinc-400 text-center truncate px-1 rounded-b-lg">
                {img.name}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Input Row */}
      <form onSubmit={handleSubmit} className="ag-glass ag-ring-focus relative flex items-end space-x-2 rounded-2xl p-2.5 transition">
        {/* Hidden file input */}
        <input
          type="file"
          ref={fileInputRef}
          accept="image/*"
          multiple
          onChange={handleImageSelect}
          className="hidden"
        />

        {/* Image Attach Button */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="self-end pb-1 p-2 rounded-lg text-zinc-400 hover:text-indigo-300 hover:bg-white/[0.06] transition shrink-0"
          title="Attach image (or paste from clipboard)"
        >
          <ImagePlus size={17} />
        </button>

        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={attachedImages.length > 0
            ? 'Describe what to do with the image(s)...'
            : 'Ask the agent to write code, analyze images, or execute commands...'}
          className="flex-1 max-h-[200px] resize-none bg-transparent border-0 outline-none text-zinc-100 placeholder-zinc-500 text-sm px-2 py-1 scrollbar-none focus:ring-0"
          style={{ minHeight: '36px' }}
        />

        <div className="flex items-center space-x-1 self-end pb-1 pr-1">
          {isLoading ? (
            <button
              type="button"
              onClick={onCancel}
              className="flex items-center justify-center p-2 rounded-lg bg-red-950/40 text-red-400 hover:bg-red-900/40 border border-red-900/30 transition duration-150"
              title="Stop Generating"
            >
              <Square size={16} fill="currentColor" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              className="ag-brand-gradient ag-brand-gradient-hover ag-glow-soft flex items-center justify-center p-2 rounded-lg text-white disabled:opacity-30 disabled:cursor-not-allowed disabled:shadow-none transition duration-150"
            >
              <Send size={16} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
