# Assad-Local-AI-Agent 🚀

An autonomous, multimodal local AI software engineering agent running entirely on your local machine using **Ollama** and **Next.js**.

---

## ✨ Features

- **🧠 100% Local & Private**: Runs completely on your device via Ollama (defaults to `qwen3.5:9b` and supports other Ollama models).
- **👁️ Multimodal Vision**: Inspect, analyze, and generate UI/code from screenshots and images using compatible Vision-Language models.
- **🛠️ Autonomous Local System Tools**:
  - `write_file`: Create complete source files and directories automatically.
  - `edit_file`: Surgical find-and-replace code editing.
  - `read_file`: Inspect code and configuration files.
  - `run_command`: Execute terminal commands (PowerShell/Bash, npm, python, tests, git, etc.).
  - `list_directory`: Explore workspace tree.
  - `search_files`: Fast regex codebase search.
  - `view_image`: Visual inspection of local image files.
- **🎨 Interactive Output Preview**: View modified and generated images (`.png`, `.jpg`, `.svg`) directly inside the chat interface.
- **⏱️ Real-time Diagnostics**: Live stopwatch timer, task duration tracking per tool, and ETA predictions based on model size.
- **🛡️ Antigravity Architecture**:
  - Implementation Planning & Review gates.
  - Verification pass with automated commands execution.
  - Granular permissions and command policies (Fast Mode vs Planning Mode).

---

## 📋 Prerequisites

1. **Node.js**: v18+ (v20+ recommended)
2. **Ollama**: Installed and running locally ([ollama.com](https://ollama.com))
3. **Python** (optional, for image processing/scripts): 3.10+ with `pillow`, `matplotlib`
4. Pull your preferred models in Ollama:
   ```bash
   ollama pull qwen3.5:9b
   ```

---

## 🚀 Quick Start

1. **Clone the repository**:
   ```bash
   git clone <your-repo-url>
   cd antigraphity-agent
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start the development server**:
   ```bash
   npm run dev
   ```
   Or use the one-click Python launcher:
   ```bash
   python start_agent.py
   ```

4. **Open in browser**:
   Navigate to [http://localhost:3000](http://localhost:3000).

---

## 🧪 Testing

Run the full automated test suite:
```bash
npm test
```

Typecheck (note: `npm test` runs `node --test` on `.ts` directly and does **not** typecheck):
```bash
npx tsc --noEmit
```

Build for production:
```bash
npm run build
```

---

## ⚡ Performance tuning

Local inference cost is dominated by how many tokens the model must process on
each call and how many round-trips a run takes. These environment variables tune
that without code changes:

| Variable | Default | Effect |
| --- | --- | --- |
| `AGENT_MODEL_NUM_CTX` | `8192` | Ollama `num_ctx`. The fixed per-call overhead (system prompt + tool schemas) is ~2.7k tokens. If the context window overflows mid-run, Ollama drops its cached prefix and re-processes that overhead on every later call — the biggest slowdown in multi-step runs. Raise it to retain more history (costs more KV-cache VRAM); lower it on tight hardware. |
| `AGENT_TOOL_CALL_MODE` | `native` | How the model is asked for tool calls. `native` = Ollama function-calling. `schema` = the reply is grammar-constrained to a JSON action envelope (one tool call per turn) so small models can't emit a malformed/absent call — far more reliable on 7B–9B models, and it skips the prose-recovery round-trip. `auto` = `schema` for small models, `native` for large. Try `auto` or `schema` if your local model keeps failing to act. |
| `AGENT_MODEL_TEMPERATURE` | `0.1` | Sampling temperature for execution turns (`0`–`2`). |
| `AGENT_PLANNING_TEMPERATURE` | `0.2` | Sampling temperature for the planning turn. |
| `AGENT_OLLAMA_KEEP_ALIVE` | `15m` | How long Ollama keeps the model resident between turns. Staying warm skips the multi-second reload each turn; set `off` to opt out. |

Measure the effect of any change with the built-in benchmark harness (requires a
running dev server and Ollama):
```bash
npm run dev              # in one terminal
npm run benchmark:chat -- --runs 7 --output before.json
# make a change, restart dev, then:
npm run benchmark:chat -- --runs 7 --baseline before.json
```

---

## 📁 Project Structure

```
├── src/
│   ├── app/                # Next.js App Router (UI & API endpoints)
│   │   ├── api/chat/       # SSE streaming agent runner
│   │   ├── api/files/      # Workspace file explorer & raw image server
│   │   └── api/models/     # Local Ollama models detection
│   ├── components/
│   │   ├── agent/          # Plan artifacts, progress & execution controls
│   │   ├── chat/           # Chat input, messages, indicators & tool cards
│   │   └── sidebar/        # Model selector, file explorer & chat history
│   ├── hooks/              # useChat & useFileExplorer state hooks
│   ├── lib/agent/          # Engine, tools, artifacts, permissions & system prompts
│   └── types/              # TypeScript definitions
├── tests/                  # Automated unit test suite
└── start_agent.py          # One-click desktop launcher
```

---

## 📄 License

MIT
