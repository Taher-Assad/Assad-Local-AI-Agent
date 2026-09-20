import os
import shutil
import subprocess
import sys
import time
import webbrowser


def start_agent():
    # Invoke npm's JavaScript entrypoint through node directly. This avoids the
    # Windows npm.cmd shim losing node.exe when launched from Git Bash/Python.
    node_command = shutil.which("node.exe") or shutil.which("node")
    npm_shim = shutil.which("npm.cmd") or shutil.which("npm")
    if node_command is None or npm_shim is None:
        raise SystemExit("Could not find Node.js/npm. Install Node.js and add it to PATH.")

    npm_cli = os.path.join(os.path.dirname(npm_shim), "node_modules", "npm", "bin", "npm-cli.js")
    if not os.path.exists(npm_cli):
        raise SystemExit(f"Could not find npm CLI at {npm_cli}")
    npm_command = [node_command, npm_cli]

    # The launcher uses a few Unicode status symbols; keep it usable on legacy
    # Windows consoles that default to cp1252.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    print("🚀 Starting Assad Local AI Agent...")
    
    # Get the directory of this python script
    project_dir = os.path.dirname(os.path.abspath(__file__))
    
    # Change to the project directory
    os.chdir(project_dir)
    
    # Check if node_modules exists
    if not os.path.exists("node_modules"):
        print("📦 Installing dependencies...")
        install_result = subprocess.run([*npm_command, "install"], check=False)
        if install_result.returncode != 0:
            raise SystemExit(f"Dependency installation failed with exit code {install_result.returncode}")

    print("🌐 Starting Next.js Development Server...")
    # Start the Next.js app using subprocess. Use the executable directly so
    # Windows does not need shell command parsing to locate npm.
    process = subprocess.Popen([*npm_command, "run", "dev"])
    
    # Wait for the server to compile and start (give it ~8 seconds)
    print("⏳ Waiting for server to initialize...")
    time.sleep(8)
    
    # Open the browser
    url = "http://localhost:3000"
    print(f"🔗 Opening {url} in your default browser...")
    webbrowser.open(url)
    
    print("\n✅ Agent is running! Press Ctrl+C in this window to stop it.")
    
    try:
        # Keep script running while the server runs
        process.wait()
    except KeyboardInterrupt:
        print("\n🛑 Stopping server...")
        process.terminate()
        sys.exit(0)

if __name__ == "__main__":
    start_agent()
