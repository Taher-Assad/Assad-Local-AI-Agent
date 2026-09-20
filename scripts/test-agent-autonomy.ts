import { runAgent } from '../src/lib/agent/engine.js';
import { DEFAULT_SYSTEM_PROMPT } from '../src/lib/agent/system-prompt.js';
import path from 'path';

async function runTest() {
  console.log('🤖 Starting Local Autonomous Agent Unit Test...');
  
  const config = {
    model: 'qwen3.5:9b',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    maxIterations: 5,
    workspacePath: path.resolve(process.cwd())
  };

  const history = [
    { role: 'user' as const, content: 'Search for the system prompt file in this workspace, read its content, and tell me the name of the agent defined in it.' }
  ];

  console.log(`\n💬 User Goal: "${history[0].content}"`);
  console.log('--------------------------------------------------');

  try {
    const stream = runAgent(config, history);
    
    for await (const update of stream) {
      if (update.type === 'thinking') {
        console.log(`[Thinking] 🧠 ${update.content}`);
      } else if (update.type === 'tool_call') {
        console.log(`[Tool Call] 🔧 Invoking: ${update.name} with args:`, update.args);
      } else if (update.type === 'tool_result') {
        console.log(`[Tool Result] ${update.result?.ok ? '✅' : '❌'} ${update.result?.output || ''}`);
      } else if (update.type === 'text') {
        console.log(`\n[Agent Response] 🤖:\n${update.content}`);
      } else if (update.type === 'error') {
        console.error(`[Error] ❌ ${update.content}`);
      } else if (update.type === 'done') {
        console.log('\n🏁 Test complete!');
      }
    }
  } catch (error) {
    console.error('Test execution failed:', error);
  }
}

runTest();
