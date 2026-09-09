<div align="center">

# OpenCluely

**The invisible AI interview copilot.**

Real-time AI help on a stealth overlay that screen sharing cannot see. Ask by voice or screenshot, and get clear answers that stream in as you need them.

<p>
  <a href="https://github.com/TechyCSR/OpenCluely/releases/latest"><img src="https://img.shields.io/github/v/release/TechyCSR/OpenCluely?style=for-the-badge&label=Latest&color=111111&labelColor=000000" alt="Latest release" /></a>
  <a href="https://github.com/TechyCSR/OpenCluely/releases"><img src="https://img.shields.io/github/downloads/TechyCSR/OpenCluely/total?style=for-the-badge&color=111111&labelColor=000000" alt="Downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-111111?style=for-the-badge&labelColor=000000" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/Platforms-Windows%20%7C%20macOS%20%7C%20Linux-111111?style=for-the-badge&labelColor=000000" alt="Platforms" />
</p>

<a href="https://opencluely.techycsr.dev"><b>Website</b></a> &nbsp;|&nbsp;
<a href="#download">Download</a> &nbsp;|&nbsp;
<a href="#quick-start">Quick start</a> &nbsp;|&nbsp;
<a href="#how-it-works">How it works</a>

</div>

## Demo

https://github.com/user-attachments/assets/896a7140-1e85-405d-bfbe-e05c9f3a816b

## What it is

OpenCluely is a desktop app for technical interviews and practice. It places a small overlay on your screen that recording and conferencing tools do not capture. You can speak a question or take a screenshot, and the AI answers in real time. The answer streams into a floating window and an optional chat panel, with clean code blocks and syntax highlighting.

It is free and open source. Processing stays on your machine, and the only thing that leaves your device is the request you send to the AI provider.

## Highlights

- **Invisible overlay.** Windows stay out of Zoom, Google Meet, Microsoft Teams, Discord, and OBS captures. You see the answer, the call does not.
- **Hidden during screen share.** When a share starts, the app can hide every window on its own.
- **Real-time voice.** Speech is split on natural pauses instead of a fixed timer, so one spoken question stays one question. Filler phrases that Whisper invents on silence are dropped before they reach the model.
- **Streamed answers.** Replies appear word by word as the model generates them, in both the chat and the floating window.
- **Direct image analysis.** Screenshots go straight to Gemini for visual reasoning, with no slow OCR step in between.
- **Session memory.** The whole conversation is remembered, so follow-ups, edge cases, and optimizations keep their context.
- **Language aware.** Tailored answers for C++, C, Python, Java, and JavaScript.
- **Stealthy by design.** Runs under ordinary system names, ships with no telemetry, and keeps your session local.
- **Cross platform.** Windows, macOS on Apple Silicon and Intel, and Linux through .deb and AppImage builds.

## Download

Pre-built installers are published with every release. These links always point at the newest version.

| Platform | File | Notes |
|---|---|---|
| Windows | [Setup .exe](https://github.com/TechyCSR/OpenCluely/releases/latest) | NSIS installer. Adds a Start Menu shortcut. |
| macOS (Apple Silicon) | [arm64 .dmg](https://github.com/TechyCSR/OpenCluely/releases/latest) | For M1, M2, M3, and M4 Macs. |
| macOS (Intel) | [x64 .dmg](https://github.com/TechyCSR/OpenCluely/releases/latest) | For older Intel based Macs. |
| Linux (Debian or Ubuntu) | [.deb](https://github.com/TechyCSR/OpenCluely/releases/latest) | Pulls system deps automatically (Python, ffmpeg, GTK). |
| Linux (universal) | [.AppImage](https://github.com/TechyCSR/OpenCluely/releases/latest) | No install. Run `chmod +x` then launch. |

Every build is produced automatically on GitHub Actions across all three platforms and ships with SHA-256 checksums. Each release also lists the full set of commits it includes.

The website at [opencluely.techycsr.dev](https://opencluely.techycsr.dev) detects your operating system and offers the right installer directly.

## Quick start

If you would rather build from source, three steps are all it takes.

1. Clone the repository.

   ```bash
   git clone https://github.com/TechyCSR/OpenCluely.git
   cd OpenCluely
   ```

2. Run the setup script.

   ```bash
   ./setup.sh
   ```

   The script installs Node dependencies, creates your `.env` from the example, sets up a local Whisper virtual environment, points the config at it, and launches the app.

3. Add your Gemini key.

   On first launch the Settings window opens automatically. Get a free key from [Google AI Studio](https://aistudio.google.com/) and paste it in, or edit `.env` directly. Both work, and changes are picked up without a restart.

### Platform notes

- On Windows, use Git Bash (included with Git for Windows) or WSL to run `setup.sh`.
- On macOS and Linux, your normal terminal works.
- No manual `npm` commands are needed. The script handles everything.

### Setup script options

```bash
./setup.sh --build                # Build a distributable for your OS
./setup.sh --ci                   # Use npm ci instead of npm install
./setup.sh --no-run               # Set up only, do not launch
./setup.sh --install-system-deps  # Install sox for the microphone (optional)
./setup.sh --skip-whisper         # Skip the local Whisper bootstrap
```

## Configuration

The setup script writes sensible defaults. The only required value is a Gemini API key.

```bash
# Required
GEMINI_API_KEY=your_gemini_api_key_here

# Optional speech provider. Pick one.
SPEECH_PROVIDER=whisper

# Azure option
AZURE_SPEECH_KEY=your_azure_speech_key
AZURE_SPEECH_REGION=your_region

# Local Whisper option
WHISPER_COMMAND=whisper
WHISPER_MODEL_DIR=.whisper-models
WHISPER_MODEL=turbo
WHISPER_LANGUAGE=en
```

Speech is optional. If no provider is configured, the microphone button hides itself across the app.

## Optional voice setup

You can use local Whisper for offline transcription or Azure Speech for a cloud option.

For local Whisper, `./setup.sh` handles the full setup. It creates `.venv-whisper`, installs `openai-whisper`, points `.env` at the virtual environment, creates `.whisper-models`, and runs a quick speech test. You only need Python 3.10 or newer and ffmpeg on your system. Install those with `./setup.sh --install-system-deps`, or add `ffmpeg` and `sox` yourself.

For Azure Speech, create a Speech resource in the [Azure Portal](https://portal.azure.com/), then add the key and region to `.env` with `SPEECH_PROVIDER=azure`.

## Global Interview Doctrine

OpenCluely operates under the **Global Interview Doctrine**:
> **Always answer, never ask questions back, lead with the solution first, and keep output glanceable (<120 words for speech, key idea and code above the fold).** Ambiguous inputs result in a 1-line assumption and an immediate, best-effort solution.

## Skills & Presets

OpenCluely adapts its responses to the specific interview round via intelligent routing or manual presets:

| Skill | Focus & Format | Default Style |
|---|---|---|
| `dsa` | LeetCode / Data Structures & Algorithms with complexity analysis | `concise` |
| `system-design` | HLD, APIs, Data Model, Components, Scaling, Trade-offs | `structured` |
| `behavioral` | First-person speakable teleprompter scripts (STAR stories, Why Us) | `spoken` |
| `tech-qa` | Concepts, language trivia, and rapid debug workflows | `concise` |
| `general` | Direct fallback for mixed questions | `concise` |

**Presets:**
- `full` (Default): Auto-detects between all skills using screen and speech context.
- `coding`: Biased toward DSA and Tech Q&A.
- `system-design`: Biased toward System Design and Architecture.
- `hr`: Biased toward Behavioral and General.

## Keyboard shortcuts

| Action | Shortcut | Description |
|---|---|---|
| Screenshot capture | `Cmd/Ctrl + Shift + S` | Capture entire screen and analyze with Gemini |
| Area screenshot | `Cmd/Ctrl + Shift + A` | Capture selected screen area and analyze |
| Cycle skill (incl. Auto) | `Cmd/Ctrl + Shift + Tab` | Switch active skill mode or auto-detect |
| Lock / unlock skill | `Cmd/Ctrl + Shift + L` | Lock current skill to prevent auto-switching |
| Cycle answer style | `Cmd/Ctrl + Shift + Y` | Switch style (concise, structured, spoken, deep) |
| Copy last code block | `Cmd/Ctrl + Shift + G` | Copy first/largest code block to clipboard |
| Re-run last as... | `Cmd/Ctrl + Shift + E` | Open overlay menu to re-run last input with another skill |
| Toggle speech | `Ctrl + Alt + R` | Start or stop push-to-talk voice recognition |
| Toggle visibility | `Cmd/Ctrl + Shift + V` | Show or hide all windows |
| Toggle interaction | `Cmd/Ctrl + Shift + I` | Enable or disable click through |
| Interview mode | `Ctrl + Alt + I` | Open the prompter strip and start listening |
| Panic hide | `Ctrl + Alt + Space` | Hide every overlay immediately |
| Capture screen (live) | `Ctrl + Alt + S` | Capture and auto-crop the problem region |
| Copy last code | `Ctrl + Alt + C` | Copy the last code block (never automatic) |
| Push-to-ask | `Ctrl + Alt + W` | Whisper a question that bypasses the aggregator |
| Open chat | `Cmd/Ctrl + Shift + C` | Open the interactive chat window |
| Settings | `Cmd/Ctrl + ,` | Open the settings panel |

## Project status

OpenCluely is under active development. The core is stable and improvements ship regularly.

### Done

- Stealth overlay with a draggable command bar and a click through toggle
- Hidden during screen share, with automatic hiding when a share begins
- Screenshot capture with direct Gemini analysis, no OCR step
- Real-time voice input that segments on natural pauses, not a blind timer
- Utterance coalescing so one spoken question becomes one answer
- Streamed answers that render word by word in the chat and the overlay
- Whisper hallucination filter that drops phantom phrases on silence
- AI response window with markdown and syntax highlighting
- Global shortcuts for capture, visibility, interaction, chat, and settings
- Session memory and a full chat UI
- Language picker and a DSA skill prompt
- Optional Azure Speech and local Whisper, with an auto hiding mic button
- Multi-monitor and area capture support
- Window binding and positioning
- Settings management with disguise and stealth modes

### Planned

- Multiple model backends alongside Gemini (OpenAI, Anthropic, local)
- Auto typing of code snippets into editors and IDEs
- Export of conversation history to markdown or PDF
- Deeper stealth, including process name randomization

## Troubleshooting

<details>
<summary>Setup issues</summary>

- **setup.sh will not run.** Make sure you are in the project folder (`cd OpenCluely`) and that the script is executable (`chmod +x setup.sh`). On Windows, use Git Bash.
- **Setup stops with exit code 130.** That means Ctrl+C was pressed. Run `./setup.sh` again.
- **Node or npm not found.** Install Node.js 18 or newer from [nodejs.org](https://nodejs.org/), restart the terminal, and retry.

</details>

<details>
<summary>App issues</summary>

- **Electron will not start or shows a blank window on Linux.** Try `npm run dev`, and make sure X11 or XWayland is available in headless setups.
- **macOS screen capture does not work.** Grant Screen Recording permission under System Settings, Privacy and Security, then relaunch the app.
- **Windows SmartScreen blocks the app.** Click More info, then Run anyway, or use `npm start` during development.
- **Microphone or voice not working.** Voice is optional. For Azure, add valid keys to `.env`. For Whisper, install `openai-whisper`, `ffmpeg`, and `sox`, then set `SPEECH_PROVIDER=whisper`.

</details>

## Privacy and ethics

OpenCluely collects no data and sends no telemetry. Processing happens locally, and your session stays on your device. Requests to the AI provider are encrypted in transit.

The app is built for learning and practice. You are responsible for following the rules of any interview you take and the policies of the companies involved.

## License

Released under the MIT License. See [LICENSE](LICENSE) for details.

## Acknowledgments

- Google Gemini for the AI reasoning
- Azure Speech and OpenAI Whisper for optional voice input
- Electron for the cross platform desktop runtime
- [Vysper by varun-singhh](https://github.com/varun-singhh/Vysper) for UI and structure inspiration

<div align="center">

Built by [TechyCSR](https://techycsr.dev). If OpenCluely helped you, consider starring the repo.

</div>
