import { NextRequest } from 'next/server';
import ollama from 'ollama';
import { runAgent } from '@/lib/agent/engine';
import {
  CHAT_STREAM_CONTENT_TYPE,
  CHAT_STREAM_PROTOCOL,
  CHAT_STREAM_PROTOCOL_HEADER,
  DEFAULT_MODEL
} from '@/lib/agent/config';
import { DEFAULT_SYSTEM_PROMPT } from '@/lib/agent/system-prompt';
import { resolveSettings, withApprovedCommands } from '@/lib/agent/permissions';
import { AgentConfig, AgentUpdate, Artifact, Message } from '@/types';
import path from 'path';
import fs from 'fs';

export const dynamic = 'force-dynamic';

/**
 * The installed-model list rarely changes within a session, but validating it
 * used to cost an `ollama.list()` round-trip on every single message. Cache it
 * briefly so repeated turns start without that latency; a cache miss on the
 * requested model forces one refresh so a freshly-pulled model is still found.
 */
const MODEL_LIST_TTL_MS = 30_000;
let modelListCache: { names: string[]; at: number } | null = null;

async function listInstalledModels(force = false): Promise<string[]> {
  const now = Date.now();
  if (!force && modelListCache && now - modelListCache.at < MODEL_LIST_TTL_MS) {
    return modelListCache.names;
  }
  const response = await ollama.list();
  const names = response.models.map(installed => installed.name);
  modelListCache = { names, at: now };
  return names;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      message,
      history,
      model,
      workspace,
      images,
      settings,
      approvedPlan,
      planFeedback,
      approvedCommands,
      goal
    } = body;

    if (!message) {
      return new Response(JSON.stringify({ error: 'Message is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const requestedModel = typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_MODEL;
    let installedModels: string[];
    try {
      installedModels = await listInstalledModels();
    } catch (error) {
      return Response.json(
        { error: `Unable to list installed models: ${toErrorMessage(error)}` },
        { status: 503 }
      );
    }

    if (!installedModels.includes(requestedModel)) {
      // Miss may just be a stale cache (model pulled since last check) — refresh once.
      try {
        installedModels = await listInstalledModels(true);
      } catch {
        /* keep the cached list; the error below reports what we know */
      }
      if (!installedModels.includes(requestedModel)) {
        return Response.json(
          {
            error: `Model "${requestedModel}" is not installed.`,
            requestedModel,
            installedModels
          },
          { status: 400 }
        );
      }
    }

    const workspacePath = workspace || path.resolve(process.cwd());
    // One-shot approvals are folded into the allow list so the same command is
    // not held for review again; the deny list still wins.
    const resolvedSettings = withApprovedCommands(
      resolveSettings(settings),
      Array.isArray(approvedCommands) ? approvedCommands : undefined
    );

    const config: AgentConfig = {
      model: requestedModel,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      maxIterations: 8,
      workspacePath: workspacePath,
      settings: resolvedSettings,
      approvedPlan: (approvedPlan as Artifact | undefined) ?? null,
      planFeedback: typeof planFeedback === 'string' ? planFeedback : undefined,
      goal: typeof goal === 'string' ? goal : undefined
    };

    const sanitizedHistory: Message[] = (history || [])
      .filter((m: Message) => {
        if (m.role === 'assistant' && typeof m.content === 'string') {
          if (m.content.includes("can't create files on your laptop directly") || 
              m.content.includes("cannot create files") ||
              m.content.includes("text editor like Notepad")) {
            return false;
          }
        }
        return true;
      });

    // Clean and validate base64 image strings for Ollama
    const cleanBase64 = (str: string): string | null => {
      if (!str || typeof str !== 'string') return null;
      let cleaned = str.trim();
      if (cleaned.startsWith('data:')) {
        const commaIdx = cleaned.indexOf(',');
        if (commaIdx !== -1) {
          cleaned = cleaned.substring(commaIdx + 1).trim();
        }
      }
      // Remove any whitespace, newlines, carriage returns
      cleaned = cleaned.replace(/\s+/g, '');
      // Pad to valid base64 length multiple of 4 if needed
      while (cleaned.length % 4 !== 0) {
        cleaned += '=';
      }
      // Basic base64 character check
      if (!/^[A-Za-z0-9+/=]+$/.test(cleaned)) {
        return null;
      }
      return cleaned;
    };

    // Sanitize any previous images in history to avoid sending corrupted/truncated data
    for (const histMsg of sanitizedHistory) {
      if (histMsg.images && Array.isArray(histMsg.images)) {
        histMsg.images = histMsg.images
          .map(cleanBase64)
          .filter((img): img is string => img !== null && img.length > 100);
        if (histMsg.images.length === 0) {
          delete histMsg.images;
        }
      }
    }

    // Attach images to user message if provided (for VL multimodal models)
    let extraPromptContext = '';
    const validImages: string[] = [];

    if (images && Array.isArray(images) && images.length > 0) {
      const savedNames: string[] = [];
      images.forEach((img: string, index: number) => {
        const cleaned = cleanBase64(img);
        if (cleaned && cleaned.length > 100) {
          validImages.push(cleaned);
          // Automatically save the image into workspace so Python/scripts can access it directly!
          try {
            const fileName = `uploaded_image_${Date.now()}_${index + 1}.png`;
            const filePath = path.join(workspacePath, fileName);
            const buffer = Buffer.from(cleaned, 'base64');
            fs.writeFileSync(filePath, buffer);
            savedNames.push(fileName);
          } catch (e) {
            console.error('Failed to save uploaded image to disk:', e);
          }
        }
      });

      if (savedNames.length > 0) {
        extraPromptContext = `\n\n[System Note: The uploaded image(s) have been saved to your workspace as: ${savedNames.map(n => `"${n}"`).join(', ')}. When writing scripts to modify or enhance these images, use these filenames as the input image.]`;
      }
    }

    const userMsg: Message = { 
      role: 'user', 
      content: message + extraPromptContext 
    };
    if (validImages.length > 0) {
      userMsg.images = validImages;
    }
    sanitizedHistory.push(userMsg);


    // Establish Server-Sent Events (SSE) Stream
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        
        function sendEvent(update: AgentUpdate) {
          const formatted = `event: ${update.type}\ndata: ${JSON.stringify(update)}\n\n`;
          controller.enqueue(encoder.encode(formatted));
        }

        try {
          sendEvent({
            type: 'run_started',
            protocol: CHAT_STREAM_PROTOCOL,
            model: requestedModel,
            runStatus: resolvedSettings.executionMode === 'planning' ? 'planning' : 'executing'
          });

          const agentStream = runAgent(config, sanitizedHistory);

          for await (const update of agentStream) {
            sendEvent(update);
          }
        } catch (error) {
          sendEvent({
            type: 'error',
            content: toErrorMessage(error),
            code: 'stream_error',
            runStatus: 'failed'
          });
        } finally {
          controller.close();
        }
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': `${CHAT_STREAM_CONTENT_TYPE}; charset=utf-8`,
        [CHAT_STREAM_PROTOCOL_HEADER]: CHAT_STREAM_PROTOCOL,
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      }
    });

  } catch (error) {
    return Response.json({ error: toErrorMessage(error) }, { status: 500 });
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
