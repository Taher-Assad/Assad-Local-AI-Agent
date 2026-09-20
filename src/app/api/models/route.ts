import { NextResponse } from 'next/server';
import ollama from 'ollama';

export async function GET() {
  try {
    // 1. List available models from local Ollama instance
    const response = await ollama.list();
    
    return NextResponse.json({
      connected: true,
      models: response.models.map(m => ({
        name: m.name,
        size: m.size,
        modified: m.modified_at
      }))
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // Ollama is probably not running or connection refused
    return NextResponse.json({
      connected: false,
      models: [],
      error: message
    });
  }
}
