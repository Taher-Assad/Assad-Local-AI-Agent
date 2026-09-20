import fs from 'fs';
import path from 'path';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import type {
  CommandDiagnostics,
  ToolDefinition,
  ToolEffect,
  ToolErrorCode,
  ToolExecutionResult
} from '../../../types/index.ts';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

function isInsideWorkspace(workspacePath: string, targetPath: string): boolean {
  const relative = path.relative(path.resolve(workspacePath), path.resolve(targetPath));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Resolve a path and reject sibling-prefix and parent-traversal escapes.
function sanitizePath(workspacePath: string, targetPath: string): string {
  const absoluteWorkspace = path.resolve(workspacePath);
  const absoluteTarget = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(absoluteWorkspace, targetPath);

  if (!isInsideWorkspace(absoluteWorkspace, absoluteTarget)) {
    throw new Error(`Access Denied: Path "${targetPath}" is outside the workspace "${workspacePath}"`);
  }
  return absoluteTarget;
}

function toRelativePath(workspacePath: string, targetPath: string): string {
  return path.relative(path.resolve(workspacePath), path.resolve(targetPath)).replace(/\\/g, '/') || '.';
}

function success(
  output: string,
  operation: string,
  paths: string[] = [],
  workspaceChanged = false,
  command?: CommandDiagnostics
): ToolExecutionResult {
  const effects: ToolEffect[] = paths.length > 0 || workspaceChanged
    ? [{ operation, paths, workspaceChanged }]
    : [];
  return { ok: true, output, effects, command };
}

function failure(
  code: ToolErrorCode,
  message: string,
  retryable = false,
  details?: Record<string, unknown>,
  command?: CommandDiagnostics
): ToolExecutionResult {
  return {
    ok: false,
    output: message,
    error: { code, message, retryable, details },
    effects: [],
    command
  };
}

function errorCode(error: unknown): ToolErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (/outside the workspace|access denied/i.test(message)) return 'OUTSIDE_WORKSPACE';
  if (/timed out|timeout/i.test(message)) return 'TIMEOUT';
  if (/not found|enoent/i.test(message)) return 'NOT_FOUND';
  if (/already exists|conflict|enotempty/i.test(message)) return 'CONFLICT';
  return 'IO_ERROR';
}

function requireString(args: unknown, key: string): string {
  if (!args || typeof args !== 'object') throw new TypeError(`Argument "${key}" is required.`);
  const value = (args as Record<string, unknown>)[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`Argument "${key}" must be a non-empty string.`);
  }
  return value;
}

function ensureExistingPathInside(workspacePath: string, targetPath: string): string {
  const sanitized = sanitizePath(workspacePath, targetPath);
  const realWorkspace = fs.realpathSync(path.resolve(workspacePath));
  const realTarget = fs.realpathSync(sanitized);
  if (!isInsideWorkspace(realWorkspace, realTarget)) {
    throw new Error(`Access Denied: Path "${targetPath}" resolves outside the workspace.`);
  }
  return sanitized;
}

function ensureDestinationInside(workspacePath: string, targetPath: string): string {
  const sanitized = sanitizePath(workspacePath, targetPath);
  let parent = path.dirname(sanitized);
  while (!fs.existsSync(parent) && parent !== path.dirname(parent)) parent = path.dirname(parent);
  const realWorkspace = fs.realpathSync(path.resolve(workspacePath));
  const realParent = fs.realpathSync(parent);
  if (!isInsideWorkspace(realWorkspace, realParent)) {
    throw new Error(`Access Denied: Destination "${targetPath}" resolves outside the workspace.`);
  }
  return sanitized;
}

const POWERSHELL_FORBIDDEN_PATTERN =
  /(?:^|[\s'"`])\.\.(?:[\\/]|$)|\b(?:set-location|cd|chdir|push-location|new-psdrive|subst)\b|(?:registry|certificate|env):|\\\\/i;
const WINDOWS_ABSOLUTE_PATH = /[a-zA-Z]:[\\/][^\s'"`|;&)]+/g;
const POSIX_ABSOLUTE_PATH = /(?:^|[\s;|&('"`])(\/(?!\/)[^\s'"`|;&)]*)/g;

export function validateWorkspaceCommand(command: string, workspacePath = process.cwd()): string | null {
  if (typeof command !== 'string' || !command.trim()) return 'Command must be a non-empty string.';
  if (POWERSHELL_FORBIDDEN_PATTERN.test(command)) {
    return 'Command may reference a location outside the selected workspace.';
  }
  for (const match of command.matchAll(WINDOWS_ABSOLUTE_PATH)) {
    if (!isInsideWorkspace(workspacePath, match[0])) {
      return `Command references a path outside the selected workspace: ${match[0]}`;
    }
  }
  for (const match of command.matchAll(POSIX_ABSOLUTE_PATH)) {
    if (!isInsideWorkspace(workspacePath, match[1])) {
      return `Command references a path outside the selected workspace: ${match[1]}`;
    }
  }
  return null;
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
      name: 'copy_file',
      description: 'Copy a file or directory within the workspace. Existing destinations are never overwritten.',
      parameters: {
        type: 'object',
        properties: {
          sourcePath: { type: 'string', description: 'Workspace-relative source path' },
          destinationPath: { type: 'string', description: 'Workspace-relative destination path' }
        },
        required: ['sourcePath', 'destinationPath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'move_file',
      description: 'Move or rename a file or directory within the workspace. Existing destinations are never overwritten.',
      parameters: {
        type: 'object',
        properties: {
          sourcePath: { type: 'string', description: 'Workspace-relative source path' },
          destinationPath: { type: 'string', description: 'Workspace-relative destination path' }
        },
        required: ['sourcePath', 'destinationPath']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file or directory inside the workspace. Non-empty directories require recursive=true.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Workspace-relative path to delete' },
          recursive: { type: 'boolean', description: 'Allow deletion of a non-empty directory (defaults to false)' }
        },
        required: ['filePath']
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
  args: unknown,
  workspacePath: string
): Promise<ToolExecutionResult> {
  try {
    const input = args && typeof args === 'object' ? args as Record<string, unknown> : {};
    switch (name) {
      case 'list_directory': {
        const dirPath = typeof input.dirPath === 'string' ? input.dirPath : '.';
        const targetPath = ensureExistingPathInside(workspacePath, dirPath);
        const stats = fs.statSync(targetPath);
        if (!stats.isDirectory()) return failure('INVALID_ARGUMENT', `Path ${dirPath} is a file, not a directory.`);

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
        return success(JSON.stringify(results, null, 2), name);
      }

      case 'read_file': {
        const filePath = requireString(input, 'filePath');
        const targetPath = ensureExistingPathInside(workspacePath, filePath);
        if (!fs.statSync(targetPath).isFile()) {
          return failure('INVALID_ARGUMENT', `Path ${filePath} is not a file.`);
        }

        let content = fs.readFileSync(targetPath, 'utf8');
        if (input.startLine !== undefined || input.endLine !== undefined) {
          const lines = content.split('\n');
          const startLine = typeof input.startLine === 'number' ? input.startLine : 1;
          const endLine = typeof input.endLine === 'number' ? input.endLine : lines.length;
          const start = Math.max(1, startLine) - 1;
          const end = Math.min(lines.length, endLine);
          content = lines.slice(start, end).join('\n');
        }
        return success(content, name);
      }

      case 'write_file': {
        const filePath = requireString(input, 'filePath');
        if (typeof input.content !== 'string') return failure('INVALID_ARGUMENT', 'Argument "content" must be a string.');
        const targetPath = ensureDestinationInside(workspacePath, filePath);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, input.content, 'utf8');
        const relative = toRelativePath(workspacePath, targetPath);
        return success(`Successfully wrote file to ${relative}`, name, [relative], true);
      }

      case 'edit_file': {
        const filePath = requireString(input, 'filePath');
        if (typeof input.targetText !== 'string' || typeof input.replacementText !== 'string') {
          return failure('INVALID_ARGUMENT', 'Arguments "targetText" and "replacementText" must be strings.');
        }
        const targetPath = ensureExistingPathInside(workspacePath, filePath);
        const content = fs.readFileSync(targetPath, 'utf8');
        if (!content.includes(input.targetText)) {
          return failure('NOT_FOUND', `Could not find exact text match in ${filePath}.`, true);
        }
        fs.writeFileSync(targetPath, content.replace(input.targetText, input.replacementText), 'utf8');
        const relative = toRelativePath(workspacePath, targetPath);
        return success(`Successfully edited ${relative}`, name, [relative], true);
      }

      case 'copy_file':
      case 'move_file': {
        const sourcePath = requireString(input, 'sourcePath');
        const destinationPath = requireString(input, 'destinationPath');
        const source = ensureExistingPathInside(workspacePath, sourcePath);
        const destination = ensureDestinationInside(workspacePath, destinationPath);
        if (fs.existsSync(destination)) return failure('CONFLICT', `Destination already exists at ${destinationPath}.`);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        if (name === 'copy_file') {
          fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
        } else {
          try {
            fs.renameSync(source, destination);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
            fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
            fs.rmSync(source, { recursive: true, force: false });
          }
        }
        const sourceRelative = toRelativePath(workspacePath, source);
        const destinationRelative = toRelativePath(workspacePath, destination);
        const paths = name === 'move_file' ? [sourceRelative, destinationRelative] : [destinationRelative];
        return success(
          `Successfully ${name === 'copy_file' ? 'copied' : 'moved'} ${sourceRelative} to ${destinationRelative}`,
          name,
          paths,
          true
        );
      }

      case 'delete_file': {
        const filePath = requireString(input, 'filePath');
        const targetPath = ensureExistingPathInside(workspacePath, filePath);
        if (path.resolve(targetPath) === path.resolve(workspacePath)) {
          return failure('OUTSIDE_WORKSPACE', 'Deleting the workspace root is not allowed.');
        }
        const stats = fs.statSync(targetPath);
        const recursive = input.recursive === true;
        if (stats.isDirectory() && !recursive && fs.readdirSync(targetPath).length > 0) {
          return failure('CONFLICT', `Directory ${filePath} is not empty; set recursive=true to delete it.`);
        }
        const relative = toRelativePath(workspacePath, targetPath);
        fs.rmSync(targetPath, { recursive, force: false });
        return success(`Successfully deleted ${relative}`, name, [relative], true);
      }

      case 'search_files': {
        const pattern = requireString(input, 'pattern');
        const dirPath = typeof input.dirPath === 'string' ? input.dirPath : '.';
        const targetPath = ensureExistingPathInside(workspacePath, dirPath);
        if (!fs.statSync(targetPath).isDirectory()) return failure('INVALID_ARGUMENT', `Path ${dirPath} is not a directory.`);
        const regex = new RegExp(pattern, 'i');
        const results: { file: string; line: number; match: string }[] = [];
        // The result set is capped anyway, so stop walking once it is full
        // instead of reading the rest of the tree. Skip files that are too big
        // or clearly binary — decoding them as UTF-8 is the main cost and never
        // yields a useful text match.
        const MAX_RESULTS = 100;
        const MAX_FILE_BYTES = 2 * 1024 * 1024;
        const SKIP_EXTENSIONS = new Set([
          '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.pdf',
          '.zip', '.gz', '.tar', '.rar', '.7z', '.mp4', '.webm', '.mov', '.mp3',
          '.wav', '.woff', '.woff2', '.ttf', '.eot', '.exe', '.dll', '.so',
          '.dylib', '.class', '.jar', '.wasm'
        ]);

        // Returns false to signal "result cap reached; unwind and stop".
        function walk(currentDir: string): boolean {
          for (const item of fs.readdirSync(currentDir)) {
            if (results.length >= MAX_RESULTS) return false;
            if (item === 'node_modules' || item === '.git' || item === '.next') continue;
            const fullPath = path.join(currentDir, item);
            const stats = fs.statSync(fullPath);
            if (stats.isDirectory()) {
              if (!walk(fullPath)) return false;
            } else if (stats.isFile()) {
              if (stats.size > MAX_FILE_BYTES) continue;
              if (SKIP_EXTENSIONS.has(path.extname(item).toLowerCase())) continue;
              try {
                const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
                for (let index = 0; index < lines.length; index++) {
                  if (regex.test(lines[index])) {
                    results.push({
                      file: toRelativePath(workspacePath, fullPath),
                      line: index + 1,
                      match: lines[index].trim()
                    });
                    if (results.length >= MAX_RESULTS) return false;
                  }
                }
              } catch { /* skip unreadable files */ }
            }
          }
          return true;
        }
        walk(targetPath);
        return success(JSON.stringify(results, null, 2), name);
      }

      case 'run_command': {
        const command = requireString(input, 'command');
        const cwdPath = typeof input.cwd === 'string' ? input.cwd : '.';
        const targetCwd = ensureExistingPathInside(workspacePath, cwdPath);
        if (!fs.statSync(targetCwd).isDirectory()) return failure('INVALID_ARGUMENT', `cwd ${cwdPath} is not a directory.`);
        const workspaceError = validateWorkspaceCommand(command, workspacePath);
        if (workspaceError) return failure('OUTSIDE_WORKSPACE', `Execution blocked. ${workspaceError}`);

        const dangerousPatterns = ['rm -rf /', 'mkfs', 'dd if', 'format ', 'del /f /s /q c:'];
        if (dangerousPatterns.some(pattern => command.toLowerCase().includes(pattern))) {
          return failure('OUTSIDE_WORKSPACE', 'Execution blocked. Command contains dangerous patterns.');
        }

        try {
          const execution = process.platform === 'win32'
            ? await execFileAsync(
                'powershell.exe',
                ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
                { cwd: targetCwd, timeout: 30000, windowsHide: true }
              )
            : await execAsync(command, { cwd: targetCwd, timeout: 30000 });
          const diagnostics: CommandDiagnostics = {
            stdout: execution.stdout.trim(),
            stderr: execution.stderr.trim(),
            exitCode: 0,
            timedOut: false
          };
          const mutation = /(?:^|\s)(?:>|>>|set-content|add-content|new-item|remove-item|move-item|copy-item|rename-item|mkdir|rm|del|mv|cp)(?:\s|$)/i.test(command);
          return success(
            JSON.stringify(diagnostics, null, 2),
            name,
            [],
            mutation,
            diagnostics
          );
        } catch (error) {
          const commandError = error as NodeJS.ErrnoException & {
            stdout?: string;
            stderr?: string;
            code?: string | number;
            killed?: boolean;
          };
          const timedOut = commandError.killed === true || commandError.code === 'ETIMEDOUT';
          const diagnostics: CommandDiagnostics = {
            stdout: String(commandError.stdout ?? '').trim(),
            stderr: String(commandError.stderr ?? '').trim(),
            exitCode: typeof commandError.code === 'number' ? commandError.code : null,
            timedOut
          };
          return failure(
            timedOut ? 'TIMEOUT' : 'COMMAND_FAILED',
            timedOut ? 'Command timed out after 30 seconds.' : `Command failed: ${commandError.message}`,
            !timedOut,
            { cwd: toRelativePath(workspacePath, targetCwd) },
            diagnostics
          );
        }
      }

      case 'file_info': {
        const filePath = requireString(input, 'filePath');
        const targetPath = sanitizePath(workspacePath, filePath);
        if (!fs.existsSync(targetPath)) return success(JSON.stringify({ exists: false }), name);
        const existing = ensureExistingPathInside(workspacePath, filePath);
        const stats = fs.statSync(existing);
        return success(JSON.stringify({
          exists: true,
          isDir: stats.isDirectory(),
          isFile: stats.isFile(),
          size: stats.size,
          mtime: stats.mtime
        }, null, 2), name);
      }

      case 'view_image': {
        const filePath = requireString(input, 'filePath');
        const targetPath = ensureExistingPathInside(workspacePath, filePath);
        const ext = path.extname(targetPath).toLowerCase();
        const validExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif', '.bmp', '.ico'];
        if (!validExtensions.includes(ext)) {
          return failure('INVALID_ARGUMENT', `File "${filePath}" is not a recognized image format.`);
        }
        const fileBuffer = fs.readFileSync(targetPath);
        const base64Data = fileBuffer.toString('base64');
        const stats = fs.statSync(targetPath);
        return success(JSON.stringify({
          filePath,
          sizeBytes: stats.size,
          format: ext.replace('.', ''),
          base64DataLength: base64Data.length,
          previewUrl: `data:image/${ext === '.svg' ? 'svg+xml' : ext.replace('.', '')};base64,${base64Data}`,
          message: `Successfully loaded image "${filePath}" (${(stats.size / 1024).toFixed(1)} KB).`
        }, null, 2), name);
      }

      default:
        return failure('UNKNOWN_TOOL', `Tool "${name}" is not implemented.`);
    }
  } catch (error) {
    if (error instanceof TypeError) return failure('INVALID_ARGUMENT', error.message);
    const message = error instanceof Error ? error.message : String(error);
    const code = errorCode(error);
    return failure(code, `Error executing tool "${name}": ${message}`, code === 'NOT_FOUND');
  }
}
