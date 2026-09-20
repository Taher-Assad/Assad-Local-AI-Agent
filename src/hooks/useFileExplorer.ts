import { useState, useEffect, useCallback } from 'react';
import { FileItem } from '@/types';

export function useFileExplorer(workspacePath: string) {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentFileContent, setCurrentFileContent] = useState<{ path: string; content: string } | null>(null);

  const fetchFiles = useCallback(async (relativePath = '.') => {
    setLoading(true);
    try {
      const res = await fetch(`/api/files?workspace=${encodeURIComponent(workspacePath)}&path=${encodeURIComponent(relativePath)}`);
      if (!res.ok) throw new Error(`Failed to load files (${res.status})`);
      const data = await res.json();
      if (data.items) {
        if (relativePath === '.') {
          setFiles(data.items);
        } else {
          // Drill down nested update
          setFiles(prev => updateNestedFiles(prev, relativePath, data.items));
        }
      }
    } catch (err) {
      console.error('Failed to load files:', err);
    } finally {
      setLoading(false);
    }
  }, [workspacePath]);

  const refreshFiles = useCallback(async () => {
    await fetchFiles('.');
  }, [fetchFiles]);

  const openFile = useCallback(async (filePath: string) => {
    try {
      const res = await fetch(`/api/files?workspace=${encodeURIComponent(workspacePath)}&path=${encodeURIComponent(filePath)}&mode=read`);
      if (!res.ok) throw new Error(`Failed to read file (${res.status})`);
      const data = await res.json();
      if (data.content !== undefined) {
        setCurrentFileContent({ path: filePath, content: data.content });
      }
    } catch (err) {
      console.error('Failed to read file:', err);
    }
  }, [workspacePath]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshFiles();
      setCurrentFileContent(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [workspacePath, refreshFiles]);

  return {
    files,
    loading,
    currentFileContent,
    fetchFiles,
    refreshFiles,
    openFile,
    setCurrentFileContent
  };
}

// Helper to mutably/immutably inject subfolders in state tree
function updateNestedFiles(items: FileItem[], targetPath: string, subItems: FileItem[]): FileItem[] {
  return items.map(item => {
    if (item.path === targetPath) {
      return { ...item, children: subItems };
    } else if (item.children) {
      return { ...item, children: updateNestedFiles(item.children, targetPath, subItems) };
    }
    return item;
  });
}
