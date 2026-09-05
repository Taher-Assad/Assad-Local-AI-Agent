import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

function sanitizePath(workspacePath: string, targetPath: string): string {
  const absoluteWorkspace = path.resolve(workspacePath);
  const absoluteTarget = path.isAbsolute(targetPath) 
    ? path.resolve(targetPath) 
    : path.resolve(workspacePath, targetPath);

  if (!absoluteTarget.startsWith(absoluteWorkspace)) {
    throw new Error('Access Denied');
  }
  return absoluteTarget;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const mode = searchParams.get('mode'); // 'list' or 'read'
    const relativePath = searchParams.get('path') || '.';
    const workspaceParam = searchParams.get('workspace') || process.cwd();

    const workspacePath = path.resolve(workspaceParam);
    const targetPath = sanitizePath(workspacePath, relativePath);

    if (!fs.existsSync(targetPath)) {
      return NextResponse.json({ error: 'Path not found' }, { status: 404 });
    }

    if (mode === 'read' || mode === 'raw') {
      const stats = fs.statSync(targetPath);
      if (!stats.isFile()) {
        return NextResponse.json({ error: 'Path is not a file' }, { status: 400 });
      }

      const ext = path.extname(targetPath).toLowerCase();
      const imageMimeTypes: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp',
        '.ico': 'image/x-icon'
      };

      if (imageMimeTypes[ext]) {
        const fileBuffer = fs.readFileSync(targetPath);
        return new Response(fileBuffer, {
          headers: {
            'Content-Type': imageMimeTypes[ext],
            'Cache-Control': 'no-cache'
          }
        });
      }

      const content = fs.readFileSync(targetPath, 'utf-8');
      return NextResponse.json({ content });
    }

    // Default to 'list'
    const stats = fs.statSync(targetPath);
    if (!stats.isDirectory()) {
      return NextResponse.json({ error: 'Path is not a directory' }, { status: 400 });
    }

    const items = fs.readdirSync(targetPath);
    const results = items
      .filter(item => item !== 'node_modules' && item !== '.git' && item !== '.next')
      .map(item => {
        const fullPath = path.join(targetPath, item);
        const itemStats = fs.statSync(fullPath);
        return {
          name: item,
          path: path.relative(workspacePath, fullPath).replace(/\\/g, '/'),
          isDir: itemStats.isDirectory(),
          size: itemStats.isFile() ? itemStats.size : undefined
        };
      })
      .sort((a, b) => {
        // Directories first, then alphabetical
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        return a.name.localeCompare(b.name);
      });

    return NextResponse.json({ items: results });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
