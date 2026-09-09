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

Build for production:
```bash
npm run build
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
