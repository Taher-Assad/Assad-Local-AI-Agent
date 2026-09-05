import React from 'react';
import { FileItem } from '@/types';
import { Folder, FolderOpen, FileText, Loader2 } from 'lucide-react';

interface FileExplorerProps {
  files: FileItem[];
  loading: boolean;
  onFileSelect: (filePath: string) => void;
  onFolderExpand: (dirPath: string) => void;
}

export function FileExplorer({ files, loading, onFileSelect, onFolderExpand }: FileExplorerProps) {
  
  const renderTree = (items: FileItem[]) => {
    return items.map((item) => {
      const isExpanded = !!item.children;
      
      return (
        <div key={item.path} className="pl-3 font-mono text-xs">
          {item.isDir ? (
            <div>
              <button
                onClick={() => {
                  if (isExpanded) {
                    // Folders can be re-queried or collapsed locally
                    onFolderExpand(item.path);
                  } else {
                    onFolderExpand(item.path);
                  }
                }}
                className="flex items-center space-x-1.5 py-1 px-1.5 rounded hover:bg-zinc-800/60 text-zinc-300 hover:text-zinc-100 w-full text-left transition"
              >
                {isExpanded ? (
                  <FolderOpen size={14} className="text-purple-400/80 shrink-0" />
                ) : (
                  <Folder size={14} className="text-purple-500/80 shrink-0" />
                )}
                <span className="truncate">{item.name}</span>
              </button>
              {isExpanded && item.children && (
                <div className="border-l border-zinc-800/80 ml-2.5">
                  {renderTree(item.children)}
                </div>
              )}
            </div>
          ) : (
            <button
              onClick={() => onFileSelect(item.path)}
              className="flex items-center space-x-1.5 py-1 px-1.5 rounded hover:bg-zinc-800/60 text-zinc-400 hover:text-zinc-200 w-full text-left transition"
            >
              <FileCodeIcon item={item} />
              <span className="truncate">{item.name}</span>
            </button>
          )}
        </div>
      );
    });
  };

  return (
    <div className="flex flex-col h-full bg-zinc-950/20 border-r border-zinc-900/60">
      <div className="flex items-center justify-between p-3 border-b border-zinc-900/60">
        <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Workspace Files</span>
        {loading && <Loader2 size={12} className="text-purple-500 animate-spin" />}
      </div>
      
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {files.length === 0 && !loading ? (
          <div className="text-center py-8 text-zinc-600 text-xs">Empty workspace</div>
        ) : (
          renderTree(files)
        )}
      </div>
    </div>
  );
}

function FileCodeIcon({ item }: { item: FileItem }) {
  return <FileText size={14} className="text-zinc-500 shrink-0" />;
}
