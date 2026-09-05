import os
import subprocess
import webbrowser
import time
import sys

def start_agent():
    print("🚀 Starting Assad Local AI Agent...")
    
    # Get the directory of this python script
    project_dir = os.path.dirname(os.path.abspath(__file__))
    
    # Change to the project directory
    os.chdir(project_dir)
    
    # Check if node_modules exists
    if not os.path.exists("node_modules"):
        print("📦 Installing dependencies...")
        subprocess.run(["npm", "install"], shell=True)

    print("🌐 Starting Next.js Development Server...")
    # Start the Next.js app using subprocess
    process = subprocess.Popen(["npm", "run", "dev"], shell=True)
    
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
