import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ToolDefinition } from '@/types';

const execAsync = promisify(exec);

// Helper to sanitize paths and prevent directory traversal
function sanitizePath(workspacePath: string, targetPath: string): string {
  const absoluteWorkspace = path.resolve(workspacePath);
  const absoluteTarget = path.isAbsolute(targetPath) 
    ? path.resolve(targetPath) 
    : path.resolve(workspacePath, targetPath);

  if (!absoluteTarget.startsWith(absoluteWorkspace)) {
    throw new Error(`Access Denied: Path "${targetPath}" is outside the workspace "${workspacePath}"`);
  }
  return absoluteTarget;
}

// 1. Tool Definitions for Ollama
export const TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and directories in the workspace or a specific path.',
      parameters: {
        type: 'object',
        properties: {
          dirPath: { type: 'string', description: 'Relative path to list (defaults to workspace root ".")' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Relative path of the file to read' },
          startLine: { type: 'number', description: 'Optional 1-indexed starting line' },
          endLine: { type: 'number', description: 'Optional 1-indexed ending line' }
        },
        required: ['filePath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write complete content to a file (creates directories if they do not exist).',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Relative path of the file to write' },
          content: { type: 'string', description: 'The text content to write' }
        },
        required: ['filePath', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace a specific block of code in a file with new code (find-and-replace).',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Relative path of the file to edit' },
          targetText: { type: 'string', description: 'The exact block of text to search for' },
          replacementText: { type: 'string', description: 'The new block of text to replace it with' }
        },
        required: ['filePath', 'targetText', 'replacementText']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for text patterns inside files in the workspace (regex search).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'The query or regex pattern to search for' },
          dirPath: { type: 'string', description: 'Relative path to search within (defaults to ".")' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Execute a shell command locally in the workspace (timeouts after 30s).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
          cwd: { type: 'string', description: 'Relative directory to run the command in' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'file_info',
      description: 'Get file or directory metadata (size, last modified, exists).',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Relative path to query' }
        },
        required: ['filePath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'view_image',
      description: 'Read and load a local image from the workspace into base64 format for visual analysis or inspection.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Relative path to the image file (png, jpg, jpeg, webp, svg, gif)' }
        },
        required: ['filePath']
      }
    }
  }
];

// 2. Tool Implementation Handler
export async function executeTool(
  name: string,
  args: any,
  workspacePath: string
): Promise<string> {
  try {
    switch (name) {
      case 'list_directory': {
        const dirPath = args.dirPath || '.';
        const targetPath = sanitizePath(workspacePath, dirPath);
        if (!fs.existsSync(targetPath)) return `Error: Directory does not exist at ${dirPath}`;
        const stats = fs.statSync(targetPath);
        if (!stats.isDirectory()) return `Error: Path ${dirPath} is a file, not a directory`;

        const items = fs.readdirSync(targetPath);
        const results = items.map(item => {
          const fullPath = path.join(targetPath, item);
          const itemStats = fs.statSync(fullPath);
          return {
            name: item,
            isDir: itemStats.isDirectory(),
            size: itemStats.isFile() ? itemStats.size : undefined
          };
        });
        return JSON.stringify(results, null, 2);
      }

      case 'read_file': {
        const filePath = args.filePath;
        const targetPath = sanitizePath(workspacePath, filePath);
        if (!fs.existsSync(targetPath)) return `Error: File not found at ${filePath}`;
        
        let content = fs.readFileSync(targetPath, 'utf8');
        
        if (args.startLine !== undefined || args.endLine !== undefined) {
          const lines = content.split('\n');
          const start = args.startLine !== undefined ? Math.max(1, args.startLine) - 1 : 0;
          const end = args.endLine !== undefined ? Math.min(lines.length, args.endLine) : lines.length;
          content = lines.slice(start, end).join('\n');
        }
        return content;
      }

      case 'write_file': {
        const filePath = args.filePath;
        const targetPath = sanitizePath(workspacePath, filePath);
        const content = args.content;
        
        // Ensure parent directory exists
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, content, 'utf8');
        return `Successfully wrote file to ${filePath}`;
      }

      case 'edit_file': {
        const filePath = args.filePath;
        const targetPath = sanitizePath(workspacePath, filePath);
        const targetText = args.targetText;
        const replacementText = args.replacementText;

        if (!fs.existsSync(targetPath)) return `Error: File not found at ${filePath}`;
        
        const content = fs.readFileSync(targetPath, 'utf8');
        if (!content.includes(targetText)) {
          return `Error: Could not find exact text match in ${filePath}. Check your targetText and try again.`;
        }

        const updatedContent = content.replace(targetText, replacementText);
        fs.writeFileSync(targetPath, updatedContent, 'utf8');
        return `Successfully edited ${filePath}`;
      }

      case 'search_files': {
        const pattern = args.pattern;
        const dirPath = args.dirPath || '.';
        const targetPath = sanitizePath(workspacePath, dirPath);
        
        if (!fs.existsSync(targetPath)) return `Error: Directory ${dirPath} does not exist`;
        
        const regex = new RegExp(pattern, 'i');
        const results: { file: string; line: number; match: string }[] = [];

        function walk(currentDir: string) {
          const items = fs.readdirSync(currentDir);
          for (const item of items) {
            // Ignore node_modules and .git
            if (item === 'node_modules' || item === '.git' || item === '.next') continue;
            
            const fullPath = path.join(currentDir, item);
            const stats = fs.statSync(fullPath);
            if (stats.isDirectory()) {
              walk(fullPath);
            } else if (stats.isFile()) {
              try {
                const text = fs.readFileSync(fullPath, 'utf8');
                const lines = text.split('\n');
                lines.forEach((line, idx) => {
                  if (regex.test(line)) {
                    results.push({
                      file: path.relative(targetPath, fullPath),
                      line: idx + 1,
                      match: line.trim()
                    });
                  }
                });
              } catch {
                // Skip binary or unreadable files
              }
            }
          }
        }

        walk(targetPath);
        return JSON.stringify(results.slice(0, 100), null, 2); // Cap at 100 results
      }

      case 'run_command': {
        const command = args.command;
        const cwdPath = args.cwd || '.';
        const targetCwd = sanitizePath(workspacePath, cwdPath);
        
        // Basic safety check for dangerous patterns
        const dangerousPatterns = ['rm -rf /', 'mkfs', 'dd if', 'format ', 'del /f /s /q c:'];
        if (dangerousPatterns.some(p => command.toLowerCase().includes(p))) {
          return `Error: Execution blocked. Command contains dangerous patterns.`;
        }

        const { stdout, stderr } = await execAsync(command, {
          cwd: targetCwd,
          timeout: 30000 // 30 second timeout
        });
        
        return JSON.stringify({
          stdout: stdout.trim(),
          stderr: stderr.trim()
        }, null, 2);
      }

      case 'file_info': {
        const filePath = args.filePath;
        const targetPath = sanitizePath(workspacePath, filePath);
        
        if (!fs.existsSync(targetPath)) {
          return JSON.stringify({ exists: false });
        }
        
        const stats = fs.statSync(targetPath);
        return JSON.stringify({
          exists: true,
          isDir: stats.isDirectory(),
          isFile: stats.isFile(),
          size: stats.size,
          mtime: stats.mtime
        }, null, 2);
      }

      case 'view_image': {
        const filePath = args.filePath;
        const targetPath = sanitizePath(workspacePath, filePath);

        if (!fs.existsSync(targetPath)) {
          return `Error: Image file not found at "${filePath}"`;
        }

        const ext = path.extname(targetPath).toLowerCase();
        const validExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif', '.bmp', '.ico'];
        if (!validExtensions.includes(ext)) {
          return `Error: File "${filePath}" is not a recognized image format (${validExtensions.join(', ')})`;
        }

        const fileBuffer = fs.readFileSync(targetPath);
        const base64Data = fileBuffer.toString('base64');
        const stats = fs.statSync(targetPath);

        return JSON.stringify({
          filePath: filePath,
          sizeBytes: stats.size,
          format: ext.replace('.', ''),
          base64DataLength: base64Data.length,
          previewUrl: `data:image/${ext === '.svg' ? 'svg+xml' : ext.replace('.', '')};base64,${base64Data}`,
          message: `Successfully loaded image "${filePath}" (${(stats.size / 1024).toFixed(1)} KB). Visual data is now available.`
        }, null, 2);
      }

      default:
        return `Error: Tool "${name}" is not implemented.`;
    }
  } catch (error: any) {
    return `Error executing tool "${name}": ${error.message}`;
  }
}
