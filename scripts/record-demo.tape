# VHS Recording Script for pi-sol
# Install VHS: brew install charmbracelet/vhs/vhs
# Run: vhs scripts/record-demo.tape

Output docs/images/demo.gif
Output docs/images/demo.mp4

# Terminal window styling
Set FontSize 14
Set FontFamily "JetBrains Mono, Menlo, Monaco, 'Courier New', monospace"
Set Width 960
Set Height 540
Set Padding 20
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
Set WindowBarSize 36
Set TypingSpeed 60ms

# Launch Pi session
Type "pi"
Enter
Sleep 1.5s

# 1. Ask a deep reasoning question to ChatGPT GPT-5.6 Sol High
Type "/sol Review the caching architecture in @lib/sol/guard.ts and identify top 3 failure modes"
Sleep 500ms
Enter
Sleep 4s

# 2. Demonstrate background job submission
Type "/sol --bg ping"
Sleep 300ms
Enter
Sleep 2s

# 3. Read background job result
Type "/sol-read"
Sleep 300ms
Enter
Sleep 3s
