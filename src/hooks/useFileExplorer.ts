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

  const openFile = async (filePath: string) => {
    try {
      const res = await fetch(`/api/files?workspace=${encodeURIComponent(workspacePath)}&path=${encodeURIComponent(filePath)}&mode=read`);
      const data = await res.json();
      if (data.content !== undefined) {
        setCurrentFileContent({ path: filePath, content: data.content });
      }
    } catch (err) {
      console.error('Failed to read file:', err);
    }
  };

  useEffect(() => {
    fetchFiles('.');
    setCurrentFileContent(null);
  }, [workspacePath, fetchFiles]);

  return {
    files,
    loading,
    currentFileContent,
    fetchFiles,
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
