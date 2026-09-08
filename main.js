const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, globalShortcut, session, ipcMain } = require("electron");

// ── Resolve a stable .env location ──
// In packaged builds process.cwd() is unstable and frequently read-only
// (NSIS install dir, AppImage mount, .app bundle), so the canonical config
// lives in Electron's userData directory. We still prefer an existing
// project-local .env in development (npm start) so the dev workflow is
// unchanged. Both onboarding (FirstRunManager) and persistEnvUpdates() write
// to this same path so settings survive restarts on every platform.
function resolveEnvPath() {
  try {
    const userDataEnv = path.join(app.getPath("userData"), ".env");
    const projectEnv = path.join(process.cwd(), ".env");
    // Prefer a project .env only when it already exists and userData has none
    // (i.e. a developer running from the repo). Otherwise use userData.
    if (!fs.existsSync(userDataEnv) && fs.existsSync(projectEnv)) {
      return projectEnv;
    }
    return userDataEnv;
  } catch (_) {
    return path.join(process.cwd(), ".env");
  }
}
const ENV_PATH = resolveEnvPath();
require("dotenv").config({ path: ENV_PATH });

// Format a value for a single .env line. Newlines are collapsed to spaces and
// backslashes are kept verbatim (doubling them corrupts Windows paths on the
// next load). Values containing whitespace, a double-quote, or a leading '#'
// are wrapped in single quotes so dotenv parses them as one token — essential
// for Whisper commands like:  "C:\Users\Jane Doe\...\python.exe" -m whisper
function formatEnvValue(raw) {
  const v = String(raw).replace(/[\r\n]+/g, " ").trim();
  if (!/[\s"#]/.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`;
  // Rare: value already contains a single quote — fall back to double quotes.
  return `"${v.replace(/"/g, '\\"')}"`;
}

// ── Linux GPU process crash workaround ──
// On many Linux setups (Wayland, X11 without GPU drivers, Docker, headless,
// or systems with broken Mesa/NVIDIA stacks), Chromium's GPU process crashes
// on startup with:
//   FATAL:gpu_data_manager_impl_private.cc(448)] GPU process isn't usable.
// This kills the entire app and can leave orphan helper processes that
// exhaust the X11 client limit, producing "Maximum number of clients reached".
//
// Disabling hardware acceleration and the GPU subprocess forces Chromium to
// render via the CPU (SwiftShader). OpenCluely's UI is light enough that
// this is imperceptible, and it eliminates the GPU crash entirely.
if (process.platform === "linux") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
  // On X11 only; harmless on Wayland. Prevents Chromium from spawning a
  // compositor process that adds another X11 client.
  app.commandLine.appendSwitch("in-process-gpu");
}

// Keep Chromium network noise out of the terminal; app-level logs still go through Winston.
app.commandLine.appendSwitch("log-level", "3");
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("no-pings");

const logger = require("./src/core/logger").createServiceLogger("MAIN");
const config = require("./src/core/config");
const FirstRunManager = require("./src/core/first-run");

// ── Global crash guard ──
// The speech path spawns external processes (Whisper CLI, and on macOS/Linux
// the sox/rec/arecord recorders via node-record-lpcm16). A missing recorder
// binary makes that library emit an 'error' on its child process with no
// listener, which would otherwise become an uncaughtException and quit the
// entire app the moment the user clicks the mic. We log and stay alive — the
// speech service surfaces a friendly status to the UI instead.
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception (kept alive)", {
    error: err && err.message,
    stack: err && err.stack,
  });
});
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection (kept alive)", {
    reason: String((reason && reason.message) || reason),
  });
});

// Services
// Screen capture (image-based)
const captureService = require("./src/services/capture.service");
const speechService = require("./src/services/speech.service");
const llmService = require("./src/services/llm.service");
const notesService = require("./src/services/notes.service");
const { skillRouterService } = require("./src/services/skill-router.service");
const { promptLoader } = require("./prompt-loader");
const { TurnAggregator } = require("./src/services/turn-aggregator");
const intentGate = require("./src/services/intent-gate");

// Managers
const windowManager = require("./src/managers/window.manager");
const sessionManager = require("./src/managers/session.manager");

class ApplicationController {
  constructor() {
    this.isReady = false;
    this.starting = false;
    this.activeSkill = "dsa";
    // Default to C++ so language is enforced from first run
    this.codingLanguage = "cpp";
    this.interviewPreset = process.env.INTERVIEW_PRESET || "full";
    this.answerStyle = "auto";
    this.lockedSkill = null;
    this.lastInputBuffer = null;
    this.speechAvailable = false;

    // Phase 2 Autopilot state
    this.isAutopilotEnabled = true;
    this.isInterviewMode = false;
    this.autopilotAggressiveness = "balanced";
    this.lastSpokenQuestion = null;
    this._speculativeAbortController = null;

    // Turn Aggregator: coalesces fragments into single turns
    this.turnAggregator = new TurnAggregator(
      (turn) => this.handleAggregatedTurn(turn),
      {
        onSpeculativeStart: (firstFragment) => this.handleSpeculativeStart(firstFragment),
        onSpeculativeCancel: () => this.handleSpeculativeCancel()
      }
    );

    // Utterance coalescing: VAD emits a transcript per natural pause, but a
    // single spoken question can still arrive as a few fragments (mid-thought
    // pauses). We buffer fragments and debounce so one question yields one LLM
    // call instead of several slow, half-answered ones.
    this._utteranceBuffer = "";
    this._utteranceTimer = null;
    this._utteranceDispatchInFlight = false;
    this._utteranceCoalesceMs = 800;

    // First-run onboarding: detects missing .env / API key and triggers
    // a settings-window prompt on first launch so users don't have to
    // dig through docs to figure out they need a Gemini API key.
    this.firstRunManager = new FirstRunManager({
      logger: logger,
      // .env and the sentinel both live in userData so they survive cwd
      // changes and read-only install dirs (the app may be launched from
      // any directory). ENV_PATH is the same file dotenv loaded at startup
      // and that persistEnvUpdates() writes to.
      envPath: ENV_PATH,
      sentinelPath: path.join(app.getPath("userData"), ".opencluely-firstrun-completed"),
    });
    // Lazily-initialised in getWhisperInstaller() so tests can mock
    // the constructor without polluting main-process startup.
    this._whisperInstaller = null;
    this.isFirstRun = false;

    // Window configurations for reference
    this.windowConfigs = {
      main: { title: "OpenCluely" },
      chat: { title: "Chat" },
      llmResponse: { title: "AI Response" },
      settings: { title: "Settings" },
    };

    this.setupStealth();
    this.setupEventHandlers();
  }

  setupStealth() {
    if (config.get("stealth.disguiseProcess")) {
      process.title = config.get("app.processTitle");
    }

    // Set default stealth app name early
    if (app && typeof app.setName === 'function') {
      app.setName("Terminal ");
    }
    process.title = "Terminal ";

    if (
      process.platform === "darwin" &&
      config.get("stealth.noAttachConsole")
    ) {
      process.env.ELECTRON_NO_ATTACH_CONSOLE = "1";
      process.env.ELECTRON_NO_ASAR = "1";
    }
  }

  setupEventHandlers() {
    app.whenReady().then(() => this.onAppReady());
    app.on("window-all-closed", () => this.onWindowAllClosed());
    app.on("activate", () => this.onActivate());
    app.on("will-quit", () => this.onWillQuit());

    this.setupIPCHandlers();
    this.setupServiceEventHandlers();
  }

  handleSecondInstance() {
    logger.info("Second instance launch detected; focusing existing windows");

    const focusExistingWindows = () => {
      try {
        const mainWindow = windowManager.getWindow("main");
        if (mainWindow) {
          if (mainWindow.isMinimized && mainWindow.isMinimized()) {
            mainWindow.restore();
          }
          windowManager.showAllWindows();
          windowManager.showOnCurrentDesktop(mainWindow);
          mainWindow.focus();
          return;
        }

        if (this.isReady) {
          windowManager.showAllWindows();
        }
      } catch (error) {
        logger.error("Failed to focus existing instance", {
          error: error.message,
        });
      }
    };

    if (app.isReady()) {
      focusExistingWindows();
    } else {
      app.whenReady().then(focusExistingWindows);
    }
  }

  async onAppReady() {
    if (this.starting || this.isReady) {
      logger.debug("onAppReady skipped: already starting or ready");
      return;
    }
    this.starting = true;

    // Force stealth mode IMMEDIATELY when app is ready
    app.setName("Terminal ");
    process.title = "Terminal ";

    logger.info("Application starting", {
      version: config.get("app.version"),
      environment: config.get("app.isDevelopment")
        ? "development"
        : "production",
      platform: process.platform,
    });

    try {
      this.setupPermissions();
      this.setupNetworkConfiguration();

      // Small delay to ensure desktop/space detection is accurate
      await new Promise((resolve) => setTimeout(resolve, 200));

      // First-run onboarding: ensure .env exists and read status once
      // so we can decide whether to defer showing the main overlay.
      let status;
      try {
        this.firstRunManager.ensureEnv();
        status = this.firstRunManager.getStatus();
        this.isFirstRun = status.needsOnboarding;
        logger.info("First-run status", status);
      } catch (e) {
        logger.warn("First-run check failed", { error: e.message });
        status = { needsOnboarding: false };
        this.isFirstRun = false;
      }
      const isFirstRun = status.needsOnboarding;

      await windowManager.initializeWindows({ showMainWindow: !isFirstRun });
      this.setupGlobalShortcuts();

      // Initialize default stealth mode with terminal icon
      this.updateAppIcon("terminal");

      this.starting = false;
      this.isReady = true;

      // Launch the onboarding wizard if this is the first run.
      if (this.isFirstRun) {
        // Defer slightly so all windows finish loading before we pop
        // the wizard on top of them.
        setTimeout(() => {
          try {
            windowManager.showOnboarding();
            windowManager.broadcastToAllWindows("first-run", status);
            logger.info("First-run onboarding: wizard opened");
          } catch (e) {
            logger.warn("Could not open first-run onboarding window", {
              error: e.message
            });
            // Fallback to legacy settings prompt
            try { this.showSettings(); } catch (_) { /* ignore */ }
          }
        }, 800);
      } else {
        // Already configured — mark completed so we never nag again.
        this.firstRunManager.markCompleted();
      }

      logger.info("Application initialized successfully", {
        windowCount: Object.keys(windowManager.getWindowStats().windows).length,
        currentDesktop: "detected",
      });

      sessionManager.addEvent("Application started");
      notesService.autoClean().catch((err) => {
        logger.warn("Notes autoClean error on startup", { error: err.message });
      });
    } catch (error) {
      this.starting = false;
      logger.error("Application initialization failed", {
        error: error.message,
      });
      app.quit();
    }
  }

  setupNetworkConfiguration() {
    // Configure session to handle network requests better
    const ses = session.defaultSession;
    
    // Allow HTTPS requests to Google APIs
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      if (details.url.includes('generativelanguage.googleapis.com')) {
        details.requestHeaders['User-Agent'] = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.156 Safari/537.36';
      }
      callback({ requestHeaders: details.requestHeaders });
    });
    
    // Handle certificate errors for Google APIs
    ses.setCertificateVerifyProc((request, callback) => {
      if (request.hostname === 'generativelanguage.googleapis.com') {
        callback(0); // Trust Google's certificates
      } else {
        callback(-2); // Use default verification
      }
    });
    
    logger.debug('Network configuration applied for Gemini API');
  }

  setupPermissions() {
    const allowedPermissions = ["microphone", "camera", "display-capture", "media"];
    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback, details) => {
        const granted = allowedPermissions.includes(permission);
        logger.info("Permission request", { permission, granted, details });
        callback(granted);
      }
    );

    session.defaultSession.setPermissionCheckHandler(
      (webContents, permission, requestingOrigin, details) => {
        const granted = allowedPermissions.includes(permission);
        return granted;
      }
    );
  }

  setupGlobalShortcuts() {
    const shortcuts = {
      "CommandOrControl+Shift+S": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: CommandOrControl+Shift+S (Screenshot)");
        this.triggerScreenshotOCR();
      },
      "CommandOrControl+Shift+V": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: CommandOrControl+Shift+V (Toggle Visibility)");
        windowManager.toggleVisibility();
      },
      "CommandOrControl+Shift+I": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: CommandOrControl+Shift+I (Toggle Interaction)");
        windowManager.toggleInteraction();
      },
      "CommandOrControl+Shift+B": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: CommandOrControl+Shift+B (Toggle Blackout)");
        windowManager.blackout(!windowManager.isBlackout);
      },
      "CommandOrControl+Shift+C": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: CommandOrControl+Shift+C (Switch To Chat)");
        windowManager.switchToWindow("chat");
      },
      "CommandOrControl+Shift+\\": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: CommandOrControl+Shift+\\ (Clear Memory)");
        this.clearSessionMemory();
      },
      "CommandOrControl+,": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: CommandOrControl+, (Settings)");
        windowManager.showSettings();
      },
      "Alt+R": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: Alt+R (Toggle Speech)");
        this.toggleSpeechRecognition();
      },
      "CommandOrControl+Shift+R": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: CommandOrControl+Shift+R (Toggle Speech)");
        this.toggleSpeechRecognition();
      },
      "CommandOrControl+Shift+T": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: CommandOrControl+Shift+T (Force Always On Top)");
        windowManager.forceAlwaysOnTopForAllWindows();
      },
      "CommandOrControl+Shift+Alt+T": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: CommandOrControl+Shift+Alt+T (Test Always On Top)");
        const results = windowManager.testAlwaysOnTopForAllWindows();
        logger.info('Always-on-top test triggered via shortcut', results);
      },
      // Phase 1 Hotkeys
      "CommandOrControl+Shift+A": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: CommandOrControl+Shift+A (Area Screenshot)");
        this.triggerScreenshotOCR({ isArea: true });
      },
      "CommandOrControl+Shift+Tab": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: CommandOrControl+Shift+Tab (Cycle Skill)");
        this.navigateSkill(1);
      },
      "CommandOrControl+Shift+L": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: CommandOrControl+Shift+L (Lock/Unlock Skill)");
        this.toggleSkillLock();
      },
      "CommandOrControl+Shift+Y": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: CommandOrControl+Shift+Y (Cycle Answer Style)");
        this.cycleAnswerStyle();
      },
      "CommandOrControl+Shift+G": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: CommandOrControl+Shift+G (Copy Last Code)");
        this.copyLastCodeBlock();
      },
      "CommandOrControl+Shift+E": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: CommandOrControl+Shift+E (Re-run Last Menu)");
        windowManager.broadcastToAllWindows("show-rerun-menu");
      },
      // Context-sensitive shortcuts based on interaction mode
      "CommandOrControl+Up": () => this.handleUpArrow(),
      "CommandOrControl+Down": () => this.handleDownArrow(),
      "CommandOrControl+Left": () => this.handleLeftArrow(),
      "CommandOrControl+Right": () => this.handleRightArrow(),

      // Phase 2 Left-Hand Autopilot Chords
      "Alt+Space": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: Alt+Space (Panic Hide/Show)");
        windowManager.togglePanic();
      },
      "Alt+A": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: Alt+A (Toggle Autopilot)");
        this.toggleAutopilot();
      },
      "Alt+S": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: Alt+S (Capture Screen -> Answer)");
        this.triggerAutopilotScreenCapture();
      },
      "Alt+D": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: Alt+D (Re-answer Deeper)");
        this.dispatchLastAnswerAction('deep');
      },
      "Alt+F": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: Alt+F (Re-answer Shorter)");
        this.dispatchLastAnswerAction('shorter');
      },
      "Alt+C": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: Alt+C (Copy Code Block)");
        this.copyLastCodeBlock();
      },
      "Alt+Down": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: Alt+Down (Prompter Expand More)");
        windowManager.broadcastToAllWindows("prompter:action", "toggle-more");
      },
      "Alt+Up": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: Alt+Up (Prompter Collapse Summary)");
        windowManager.broadcastToAllWindows("prompter:action", "close-more");
      },
      "Alt+Left": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: Alt+Left (Prompter Prev Answer)");
        windowManager.broadcastToAllWindows("prompter:action", "prev");
      },
      "Alt+Right": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: Alt+Right (Prompter Next Answer)");
        windowManager.broadcastToAllWindows("prompter:action", "next");
      },
      "Alt+B": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: Alt+B (Toggle Blackout)");
        windowManager.blackout(!windowManager.isBlackout);
      },
      "Alt+1": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: Alt+1 (Opacity 30%)");
        windowManager.setGlobalOpacity(0.3);
      },
      "Alt+2": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: Alt+2 (Opacity 60%)");
        windowManager.setGlobalOpacity(0.6);
      },
      "Alt+3": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: Alt+3 (Opacity 100%)");
        windowManager.setGlobalOpacity(1.0);
      },
      "Alt+W": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: Alt+W (Push-to-Ask Whisper)");
        this.handlePushToAsk();
      },
      "Alt+I": () => {
        logger.info("[GLOBAL-HOTKEY] Triggered: Alt+I (Interview Mode Toggle)");
        this.toggleInterviewMode();
      }
    };

    Object.entries(shortcuts).forEach(([accelerator, handler]) => {
      let success = false;
      try {
        success = globalShortcut.register(accelerator, handler);
      } catch (err) {
        logger.warn(`Failed initial registration for ${accelerator}`, { error: err.message });
      }

      // Fallback for Alt+Space -> Alt+Q if system conflict
      if (!success && accelerator === "Alt+Space") {
        try {
          success = globalShortcut.register("Alt+Q", handler);
          if (success) {
            logger.info("Registered fallback Alt+Q for Panic Hide/Show (Alt+Space was occupied)");
          }
        } catch (_) {}
      }

      const isRegistered = globalShortcut.isRegistered(accelerator) || (accelerator === "Alt+Space" && globalShortcut.isRegistered("Alt+Q"));
      logger.info("Global shortcut registered", { accelerator, success, isRegistered });
    });
  }

  setupServiceEventHandlers() {
    speechService.on("recording-started", () => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("recording-started");
      });
    });

    speechService.on("recording-stopped", async () => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("recording-stopped");
      });

      // Auto-generate session note if session contains conversational turns
      try {
        const turns = sessionManager.getRecentTranscript(40);
        if (turns && turns.length >= 2) {
          const transcriptText = turns.map(t => `**[${(t.speaker || t.role).toUpperCase()}]**: ${t.content}`).join('\n\n');
          const autoNote = {
            id: `session-${Date.now()}`,
            title: `Session ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
            createdAt: new Date().toISOString(),
            content: `## Conversation Record\n\n${transcriptText}\n\n### Summary\n- Automatically documented from ${turns.length} conversational turns.\n- Status: Completed.`,
            tags: ['interview', 'auto-generated']
          };
          await notesService.save(autoNote);
          logger.info('Auto-generated note saved for stopped session', { id: autoNote.id });
        }
      } catch (err) {
        logger.warn('Failed to auto-save note on session stop', { error: err.message });
      }
    });

    speechService.on("transcription", (text) => {
      this.handleTranscriptionFragment(text);
    });

    speechService.on("interim-transcription", (text) => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("interim-transcription", { text });
      });
    });

    speechService.on("status", (status) => {
      this.speechAvailable = speechService.isAvailable ? speechService.isAvailable() : false;
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-status", { status, available: this.speechAvailable });
      });
      // Also broadcast availability specifically
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-availability", { available: this.speechAvailable });
      });
    });

    speechService.on("error", (error) => {
      // In error, still compute availability
      this.speechAvailable = speechService.isAvailable ? speechService.isAvailable() : false;
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-error", { error, available: this.speechAvailable });
      });
    });
  }

  setupIPCHandlers() {
  ipcMain.handle("take-screenshot", () => this.triggerScreenshotOCR());
  ipcMain.handle("list-displays", () => captureService.listDisplays());
  ipcMain.handle("capture-area", (event, options) => captureService.captureAndProcess(options));
    
    // Provide reliable clipboard write via main process
    ipcMain.handle("copy-to-clipboard", (event, text) => {
      try {
        const { clipboard } = require("electron");
        clipboard.writeText(String(text ?? ""));
        return true;
      } catch (e) {
        logger.error("Failed to write to clipboard", { error: e.message });
        return false;
      }
    });
    
    ipcMain.handle("get-speech-availability", () => {
      return speechService.isAvailable ? speechService.isAvailable() : false;
    });

    ipcMain.handle("start-speech-recognition", () => {
      speechService.startRecording();
      return speechService.getStatus();
    });

    ipcMain.handle("stop-speech-recognition", () => {
      speechService.stopRecording();
      return speechService.getStatus();
    });

    // Raw PCM audio captured by the renderer's Web Audio API (Windows Whisper path)
    ipcMain.on("audio-chunk", (_event, data) => {
      if (data && data.buffer) {
        speechService.handleAudioChunkFromRenderer(Buffer.from(data.buffer));
      }
    });

    // Also handle direct send events for fallback
    ipcMain.on("start-speech-recognition", () => {
      speechService.startRecording();
    });

    ipcMain.on("stop-speech-recognition", () => {
      speechService.stopRecording();
    });

    ipcMain.on("chat-window-ready", () => {
      // Send a test message to confirm communication
      setTimeout(() => {
        windowManager.broadcastToAllWindows("transcription-received", {
          text: "Test message from main process - chat window communication is working!",
        });
      }, 1000);
    });

    ipcMain.on("main-window-ready", () => {
      // Re-check availability whenever the main overlay finishes loading;
      // this covers first-run where the window was hidden during onboarding.
      this.speechAvailable = speechService.isAvailable
        ? speechService.isAvailable()
        : false;
      const { BrowserWindow } = require("electron");
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send("speech-availability", { available: this.speechAvailable });
        }
      });
    });

    ipcMain.on("test-chat-window", () => {
      windowManager.broadcastToAllWindows("transcription-received", {
        text: "🧪 IMMEDIATE TEST: Chat window IPC communication test successful!",
      });
    });

    ipcMain.handle("show-all-windows", () => {
      windowManager.showAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("hide-all-windows", () => {
      windowManager.hideAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("enable-window-interaction", () => {
      windowManager.setInteractive(true);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("disable-window-interaction", () => {
      windowManager.setInteractive(false);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("switch-to-chat", () => {
      windowManager.switchToWindow("chat");
      return windowManager.getWindowStats();
    });

    ipcMain.handle("switch-to-skills", () => {
      windowManager.switchToWindow("skills");
      return windowManager.getWindowStats();
    });

    ipcMain.handle("resize-window", (event, { width, height }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        // Enforce horizontal constraints: min ~one icon, max original width
        const minW = 60;
        const maxW = windowManager.windowConfigs?.main?.maxWidth || windowManager.windowConfigs?.main?.width || 950;
        const clampedWidth = Math.max(minW, Math.min(maxW, Math.round(width || minW)));
        try {
          // Match content size to the DOM so no extra transparent area remains
          mainWindow.setContentSize(Math.max(1, clampedWidth), Math.max(1, Math.round(height)));
        } catch (e) {
          // Fallback in case setContentSize isn’t available on some platform
          mainWindow.setSize(Math.max(1, clampedWidth), Math.max(1, Math.round(height)));
        }
        logger.debug("Main window resized (content)", { width: clampedWidth, height });
      }
      return { success: true };
    });

    ipcMain.handle("move-window", (event, { deltaX, deltaY }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        const [currentX, currentY] = mainWindow.getPosition();
        const newX = currentX + deltaX;
        const newY = currentY + deltaY;
        mainWindow.setPosition(newX, newY);
        logger.debug("Main window moved", {
          deltaX,
          deltaY,
          from: { x: currentX, y: currentY },
          to: { x: newX, y: newY },
        });
      }
      return { success: true };
    });

    ipcMain.handle("get-session-history", () => {
      return sessionManager.getOptimizedHistory();
    });

    ipcMain.handle("clear-session-memory", () => {
      sessionManager.clear();
      windowManager.broadcastToAllWindows("session-cleared");
      return { success: true };
    });

    ipcMain.handle("force-always-on-top", () => {
      windowManager.forceAlwaysOnTopForAllWindows();
      return { success: true };
    });

    ipcMain.handle("test-always-on-top", () => {
      const results = windowManager.testAlwaysOnTopForAllWindows();
      return { success: true, results };
    });

    ipcMain.handle("set-active-panel", (event, name) => {
      return windowManager.setActivePanel(name);
    });

    ipcMain.handle("get-interview-mode", () => {
      return !!this.isInterviewMode;
    });

    ipcMain.handle("set-interview-mode", async (_event, enabled) => {
      if (enabled) {
        await this.enterInterviewMode();
      } else {
        await this.exitInterviewMode();
      }
      return this.isInterviewMode;
    });

    ipcMain.handle("toggle-autopilot", (_event, enabled) => {
      return this.toggleAutopilot(enabled);
    });

    ipcMain.handle("get-latency-metrics", () => {
      return llmService.getLatencyMetrics();
    });

    ipcMain.handle("detach-panel", (event, name) => {
      windowManager.detachPanel(name);
      return { success: true };
    });

    ipcMain.handle("attach-panel", (event, name) => {
      windowManager.attachPanel(name);
      return { success: true };
    });

    ipcMain.handle("set-blackout", (event, on) => {
      windowManager.blackout(on);
      return { success: true, blackout: windowManager.isBlackout };
    });

    ipcMain.handle("get-transcript", (event, n) => {
      return sessionManager.getRecentTranscript ? sessionManager.getRecentTranscript(n || 20) : [];
    });

    // Notes service IPC
    ipcMain.handle("notes:list", async () => {
      return await notesService.list();
    });

    ipcMain.handle("notes:get", async (event, id) => {
      return await notesService.get(id);
    });

    ipcMain.handle("notes:save", async (event, note) => {
      return await notesService.save(note);
    });

    ipcMain.handle("notes:remove", async (event, id) => {
      return await notesService.remove(id);
    });

    ipcMain.handle("notes:export", async (event, { id, format }) => {
      return await notesService.export(id, format);
    });

    ipcMain.handle("send-chat-message", async (event, text, useListenContext = false) => {
      // Add chat message to session memory
      sessionManager.addUserInput(text, 'chat');
      logger.debug('Chat message added to session memory', { textLength: (text || '').length, useListenContext });

      // Typed messages need the full skill pipeline (with history context),
      // NOT the voice "intelligent filter" pipeline. Voice keeps its filter
      // behaviour; typed chat goes through processWithLLM so it gets real
      // answers using the active skill prompt and recent conversation history.
      setImmediate(async () => {
        try {
          let promptText = text;
          if (useListenContext && sessionManager.getRecentTranscript) {
            const recentTurns = sessionManager.getRecentTranscript(15);
            if (recentTurns && recentTurns.length > 0) {
              const formattedTurns = recentTurns.map(t => `[${(t.speaker || t.role).toUpperCase()}]: ${t.content}`).join('\n');
              promptText = `[Conversation Context from Listen]:\n${formattedTurns}\n\n[User Question]:\n${text}`;
            }
          }
          const sessionHistory = sessionManager.getOptimizedHistory();
          await this.processWithLLM(promptText, sessionHistory);
        } catch (error) {
          logger.error("Failed to process chat message with LLM", {
            error: error.message,
            text: (text || '').substring(0, 100)
          });
          this.broadcastLLMError(error.message);
        }
      });

      return { success: true };
    });

    ipcMain.handle("get-skill-prompt", (event, skillName) => {
      try {
        const { promptLoader } = require('./prompt-loader');
        const skillPrompt = promptLoader.getSkillPrompt(skillName);
        return skillPrompt;
      } catch (error) {
        logger.error('Failed to get skill prompt', { skillName, error: error.message });
        return null;
      }
    });

    ipcMain.handle("set-gemini-api-key", (event, apiKey) => {
      llmService.updateApiKey(apiKey);
      return llmService.getStats();
    });

    ipcMain.handle("get-gemini-status", () => {
      return llmService.getStats();
    });

    // Window binding IPC handlers
    ipcMain.handle("set-window-binding", (event, enabled) => {
      return windowManager.setWindowBinding(enabled);
    });

    ipcMain.handle("toggle-window-binding", () => {
      return windowManager.toggleWindowBinding();
    });

    ipcMain.handle("get-window-binding-status", () => {
      return windowManager.getWindowBindingStatus();
    });

    ipcMain.handle("get-window-stats", () => {
      return windowManager.getWindowStats();
    });

    ipcMain.handle("set-window-gap", (event, gap) => {
      return windowManager.setWindowGap(gap);
    });

    ipcMain.handle("move-bound-windows", (event, { deltaX, deltaY }) => {
      windowManager.moveBoundWindows(deltaX, deltaY);
      return windowManager.getWindowBindingStatus();
    });

    ipcMain.handle("test-gemini-connection", async () => {
      return await llmService.testConnection();
    });

    ipcMain.handle("run-gemini-diagnostics", async () => {
      try {
        const connectivity = await llmService.checkNetworkConnectivity();
        const apiTest = await llmService.testConnection();
        
        return {
          success: true,
          connectivity,
          apiTest,
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        };
      }
    });

    // Settings handlers
    ipcMain.handle("show-settings", () => {
      windowManager.showSettings();

      // Send current settings to the settings window
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) {
        const currentSettings = this.getSettings();
        setTimeout(() => {
          settingsWindow.webContents.send("load-settings", currentSettings);
        }, 100);
      }

      return { success: true };
    });

    ipcMain.handle("get-settings", () => {
      return this.getSettings();
    });

    // First-run onboarding status — renderer can query to know whether
    // to show the welcome banner / prompt for API-key entry.
    ipcMain.handle("get-first-run-status", () => {
      try {
        return this.firstRunManager.getStatus();
      } catch (e) {
        logger.warn("Failed to get first-run status", { error: e.message });
        return { needsOnboarding: false, error: e.message };
      }
    });

    ipcMain.handle("complete-first-run", async () => {
      try {
        this.firstRunManager.markCompleted();
        this.isFirstRun = false;
        // Reinitialize speech service with the latest persisted settings
        // so the mic button reflects the provider/command set during onboarding.
        speechService.initializeClient();
        this.speechAvailable = speechService.isAvailable
          ? speechService.isAvailable()
          : false;
        // Show the main overlay window now that onboarding is done
        // and API keys are configured.
        await windowManager.showMainWindow();
        // Broadcast speech availability so the mic button appears
        const { BrowserWindow } = require("electron");
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) {
            win.webContents.send("speech-availability", { available: this.speechAvailable });
          }
        });
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // Open a URL in the system browser (used by the GitHub star button
    // in onboarding).
    ipcMain.handle("open-external", async (_event, url) => {
      try {
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
          return { ok: false, error: "Invalid URL" };
        }
        const { shell } = require("electron");
        await shell.openExternal(url);
        return { ok: true };
      } catch (e) {
        logger.warn("Failed to open external URL", { url, error: e.message });
        return { ok: false, error: e.message };
      }
    });

    // Close the onboarding wizard window.
    ipcMain.handle("close-onboarding", () => {
      try {
        windowManager.closeOnboarding();
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // Detect an installed Whisper CLI across common locations.
    ipcMain.handle("detect-whisper", async () => {
      try {
        const installer = this.getWhisperInstaller();
        return await installer.detect();
      } catch (e) {
        logger.warn("Whisper detection failed", { error: e.message });
        return { found: false, command: null, version: null, error: e.message };
      }
    });

    // Install Whisper. Streams progress lines back via `webContents.send`
    // so the renderer can paint them as they arrive.
    ipcMain.handle("install-whisper", async (event) => {
      try {
        const installer = this.getWhisperInstaller();
        const sender = event.sender;
        const result = await installer.install({
          onProgress: (line) => {
            try { sender.send("install-progress", line); } catch (_) { /* ignore */ }
          },
        });
        return result;
      } catch (e) {
        logger.error("Whisper install failed", { error: e.message });
        return { ok: false, command: null, message: e.message, logs: "" };
      }
    });

    // Download Whisper model. Streams progress lines back via `webContents.send`
    ipcMain.handle("download-whisper-model", async (event, modelName) => {
      try {
        const installer = this.getWhisperInstaller();
        const sender = event.sender;
        const result = await installer.downloadModel(modelName || 'turbo', {
          onProgress: (line) => {
            try { sender.send("install-progress", line); } catch (_) { /* ignore */ }
          },
        });
        return result;
      } catch (e) {
        logger.error("Whisper model download failed", { error: e.message });
        return { ok: false, message: e.message, path: null };
      }
    });

    ipcMain.handle("save-settings", (event, settings) => {
      return this.saveSettings(settings);
    });

    ipcMain.handle("update-app-icon", (event, iconKey) => {
      return this.updateAppIcon(iconKey);
    });

    ipcMain.handle("update-active-skill", (event, skill) => {
      this.activeSkill = skill;
      windowManager.broadcastToAllWindows("skill-changed", {
        skill,
        locked: !!this.lockedSkill,
        lockedSkill: this.lockedSkill
      });
      return { success: true };
    });

    ipcMain.handle("get-skills", () => {
      return promptLoader.getAvailableSkills();
    });

    ipcMain.handle("set-interview-preset", (event, preset) => {
      this.interviewPreset = preset || "full";
      windowManager.broadcastToAllWindows("preset-changed", { preset: this.interviewPreset });
      return { success: true, preset: this.interviewPreset };
    });

    ipcMain.handle("set-answer-style", (event, style) => {
      this.answerStyle = style || "auto";
      windowManager.broadcastToAllWindows("style-changed", { style: this.answerStyle });
      return { success: true, style: this.answerStyle };
    });

    ipcMain.handle("set-skill-lock", (event, skillId) => {
      this.lockedSkill = skillId || null;
      if (this.lockedSkill) {
        this.activeSkill = this.lockedSkill;
      }
      windowManager.broadcastToAllWindows("skill-changed", {
        skill: this.activeSkill,
        locked: !!this.lockedSkill,
        lockedSkill: this.lockedSkill
      });
      return { success: true, locked: !!this.lockedSkill, lockedSkill: this.lockedSkill };
    });

    ipcMain.handle("rerun-last", async (event, { skill } = {}) => {
      if (!this.lastInputBuffer) {
        return { success: false, error: "No previous input to re-run" };
      }
      const targetSkill = skill || this.lockedSkill || this.activeSkill;
      if (this.lastInputBuffer.kind === 'screenshot' && this.lastInputBuffer.imageBuffer) {
        this.activeSkill = targetSkill;
        windowManager.showLLMLoading();
        const sessionHistory = sessionManager.getOptimizedHistory();
        const needsLang = promptLoader.requiresProgrammingLanguage(targetSkill);
        try {
          const llmResult = await llmService.processImageWithSkillStream(
            this.lastInputBuffer.imageBuffer,
            this.lastInputBuffer.mimeType || 'image/png',
            targetSkill,
            sessionHistory.recent,
            needsLang ? this.codingLanguage : null,
            {
              lockedSkill: targetSkill,
              style: this.answerStyle === 'auto' ? null : this.answerStyle
            },
            (delta) => {
              windowManager.broadcastToAllWindows("llm-response-chunk", { delta, isImage: true });
            }
          );
          this.lastInputBuffer.lastResponse = llmResult.response;
          windowManager.showLLMResponse(llmResult.response, llmResult.metadata);
          this.broadcastLLMSuccess(llmResult);
          return { success: true };
        } catch (err) {
          logger.error("Failed to rerun screenshot", { error: err.message });
          windowManager.hideLLMResponse();
          return { success: false, error: err.message };
        }
      } else if (this.lastInputBuffer.text) {
        this.activeSkill = targetSkill;
        const sessionHistory = sessionManager.getOptimizedHistory();
        await this.processWithLLM(this.lastInputBuffer.text, sessionHistory);
        return { success: true };
      }
      return { success: false, error: "No valid input buffer" };
    });

    ipcMain.handle("dispatch-action", async (event, { actionId }) => {
      if (!actionId) return { success: false, error: "Missing actionId" };
      try {
        const lastContext = this.lastInputBuffer ? (this.lastInputBuffer.lastResponse || this.lastInputBuffer.text || "") : "";
        windowManager.showLLMLoading();
        const targetSkill = this.lockedSkill || this.activeSkill;
        const needsLang = promptLoader.requiresProgrammingLanguage(targetSkill);
        const result = await llmService.dispatchAction({
          actionId,
          lastInput: lastContext,
          sessionHistory: sessionManager.getConversationHistory(10),
          activeSkill: targetSkill,
          codingLanguage: needsLang ? this.codingLanguage : null,
          answerStyle: this.answerStyle === 'auto' ? 'concise' : this.answerStyle,
          onDelta: (delta) => {
            windowManager.broadcastToAllWindows("llm-response-chunk", { delta, isAction: true });
          }
        });
        if (this.lastInputBuffer) {
          this.lastInputBuffer.lastResponse = result.response;
        }
        windowManager.showLLMResponse(result.response, result.metadata);
        this.broadcastLLMSuccess(result);
        return { success: true, result };
      } catch (err) {
        logger.error("dispatch-action failed", { actionId, error: err.message });
        windowManager.hideLLMResponse();
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle("copy-last-code", () => {
      return { success: this.copyLastCodeBlock() };
    });

    ipcMain.handle("restart-app-for-stealth", () => {
      // Force restart the app to ensure stealth name changes take effect
      const { app } = require("electron");
      app.relaunch();
      app.exit();
    });

    ipcMain.handle("close-window", (event) => {
      const webContents = event.sender;
      const window = windowManager.windows.forEach((win, type) => {
        if (win.webContents === webContents) {
          win.hide();
          return true;
        }
      });
      return { success: true };
    });

    // LLM window specific handlers
    ipcMain.handle("expand-llm-window", (event, contentMetrics) => {
      windowManager.expandLLMWindow(contentMetrics);
      return { success: true, contentMetrics };
    });

    ipcMain.handle("resize-llm-window-for-content", (event, contentMetrics) => {
      // Use the same expansion logic for now, can be enhanced later
      windowManager.expandLLMWindow(contentMetrics);
      return { success: true, contentMetrics };
    });

    ipcMain.handle("quit-app", () => {
      logger.info("Quit app requested via IPC");
      try {
        // Force quit the application
        const { app } = require("electron");

        // Close all windows first
        windowManager.destroyAllWindows();

        // Unregister shortcuts
        globalShortcut.unregisterAll();

        // Force quit
        app.quit();

        // If the above doesn't work, force exit
        setTimeout(() => {
          process.exit(0);
        }, 2000);
      } catch (error) {
        logger.error("Error during quit:", error);
        process.exit(1);
      }
    });

    // Handle close settings
    ipcMain.on("close-settings", () => {
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) {
        settingsWindow.hide();
      }
    });

    // Handle save settings (synchronous)
    ipcMain.on("save-settings", (event, settings) => {
      this.saveSettings(settings);
    });

    // Handle update skill
    ipcMain.on("update-skill", (event, skill) => {
      this.activeSkill = skill;
      windowManager.broadcastToAllWindows("skill-updated", { skill });
    });

    // Handle quit app (alternative method)
    ipcMain.on("quit-app", () => {
      logger.info("Quit app requested via IPC (on method)");
      try {
        const { app } = require("electron");
        windowManager.destroyAllWindows();
        globalShortcut.unregisterAll();
        app.quit();
        setTimeout(() => process.exit(0), 1000);
      } catch (error) {
        logger.error("Error during quit (on method):", error);
        process.exit(1);
      }
    });
  }

  toggleSpeechRecognition() {
    const isAvailable = typeof speechService.isAvailable === 'function' ? speechService.isAvailable() : !!speechService.getStatus?.().isInitialized;
    if (!isAvailable) {
      logger.warn("Speech recognition unavailable; toggle ignored");
      try {
        windowManager.broadcastToAllWindows("speech-status", { status: 'Speech recognition unavailable', available: false });
        windowManager.broadcastToAllWindows("speech-availability", { available: false });
      } catch (e) {}
      return;
    }
    const currentStatus = speechService.getStatus();
    if (currentStatus.isRecording) {
      try {
        speechService.stopRecording();
        windowManager.hideChatWindow();
        logger.info("Speech recognition stopped via global shortcut");
      } catch (error) {
        logger.error("Error stopping speech recognition:", error);
      }
    } else {
      try {
        speechService.startRecording();
        windowManager.showChatWindow();
        logger.info("Speech recognition started via global shortcut");
      } catch (error) {
        logger.error("Error starting speech recognition:", error);
      }
    }
  }

  clearSessionMemory() {
    try {
      sessionManager.clear();
      windowManager.broadcastToAllWindows("session-cleared");
      logger.info("Session memory cleared via global shortcut");
    } catch (error) {
      logger.error("Error clearing session memory:", error);
    }
  }

  handleUpArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (isInteractive) {
      // Interactive mode: Navigate to previous skill
      this.navigateSkill(-1);
    } else {
      // Non-interactive mode: Move window up
      windowManager.moveBoundWindows(0, -20);
    }
  }

  handleDownArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (isInteractive) {
      // Interactive mode: Navigate to next skill
      this.navigateSkill(1);
    } else {
      // Non-interactive mode: Move window down
      windowManager.moveBoundWindows(0, 20);
    }
  }

  handleLeftArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (!isInteractive) {
      // Non-interactive mode: Move window left
      windowManager.moveBoundWindows(-20, 0);
    }
    // Interactive mode: Left arrow does nothing
  }

  handleRightArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (!isInteractive) {
      // Non-interactive mode: Move window right
      windowManager.moveBoundWindows(20, 0);
    }
    // Interactive mode: Right arrow does nothing
  }

  navigateSkill(direction) {
    const rawSkills = promptLoader.getAvailableSkills();
    const availableSkills = rawSkills.map(s => (typeof s === 'string' ? s : s.id));
    const currentIndex = availableSkills.indexOf(this.activeSkill);
    let newIndex = 0;
    if (currentIndex !== -1) {
      newIndex = currentIndex + direction;
      if (newIndex >= availableSkills.length) {
        newIndex = 0;
      } else if (newIndex < 0) {
        newIndex = availableSkills.length - 1;
      }
    }

    const newSkill = availableSkills[newIndex];
    this.activeSkill = newSkill;
    if (this.lockedSkill) {
      this.lockedSkill = newSkill;
    }

    sessionManager.setActiveSkill(newSkill);

    logger.info("Skill navigated via global shortcut", {
      from: currentIndex !== -1 ? availableSkills[currentIndex] : 'unknown',
      to: newSkill,
      direction: direction > 0 ? "down" : "up",
    });

    windowManager.broadcastToAllWindows("skill-changed", {
      skill: newSkill,
      locked: !!this.lockedSkill,
      lockedSkill: this.lockedSkill
    });
    windowManager.broadcastToAllWindows("skill-updated", { skill: newSkill });
  }

  toggleSkillLock() {
    if (this.lockedSkill) {
      this.lockedSkill = null;
    } else {
      this.lockedSkill = this.activeSkill;
    }
    logger.info("Skill lock toggled", { locked: !!this.lockedSkill, skill: this.lockedSkill });
    windowManager.broadcastToAllWindows("skill-changed", {
      skill: this.activeSkill,
      locked: !!this.lockedSkill,
      lockedSkill: this.lockedSkill
    });
    windowManager.broadcastToAllWindows("toast-notification", {
      message: this.lockedSkill ? `🔒 Skill locked: ${this.lockedSkill}` : '🔓 Skill unlocked (Auto active)'
    });
  }

  cycleAnswerStyle() {
    const styles = ['auto', 'concise', 'structured', 'spoken', 'deep'];
    const currIdx = styles.indexOf(this.answerStyle);
    const nextIdx = (currIdx + 1) % styles.length;
    this.answerStyle = styles[nextIdx];
    logger.info("Answer style cycled", { style: this.answerStyle });
    windowManager.broadcastToAllWindows("style-changed", { style: this.answerStyle });
    windowManager.broadcastToAllWindows("toast-notification", {
      message: `Style: ${this.answerStyle}`
    });
  }

  copyLastCodeBlock() {
    try {
      const { clipboard } = require("electron");
      const lastResponse = this.lastInputBuffer?.lastResponse || "";
      const codeBlockMatch = lastResponse.match(/```(?:[a-zA-Z0-9_-]*)\n([\s\S]*?)```/);
      const codeToCopy = codeBlockMatch ? codeBlockMatch[1].trim() : (lastResponse ? lastResponse.trim() : "");
      if (codeToCopy) {
        clipboard.writeText(codeToCopy);
        logger.info("Copied code block to clipboard");
        windowManager.broadcastToAllWindows("toast-notification", { message: "Code copied to clipboard!" });
        return true;
      }
    } catch (e) {
      logger.error("Failed to copy code block", { error: e.message });
    }
    return false;
  }

  async triggerScreenshotOCR(options = {}) {
    if (!this.isReady) {
      logger.warn("Screenshot requested before application ready");
      return;
    }

    const startTime = Date.now();

    try {
      windowManager.showLLMLoading();

      const capture = await captureService.captureAndProcess(options);

      if (!capture.imageBuffer || !capture.imageBuffer.length) {
        windowManager.hideLLMResponse();
        this.broadcastOCRError("Failed to capture screenshot image");
        return;
      }

      const sessionHistory = sessionManager.getOptimizedHistory();

      // Resolve skill via Router (considering user lock, preset, activeSkill)
      const resolved = skillRouterService.resolveSkill({
        lockedSkill: this.lockedSkill,
        preset: this.interviewPreset,
        activeSkill: this.activeSkill
      });
      const targetSkill = resolved.skill;
      const needsProgrammingLanguage = promptLoader.requiresProgrammingLanguage(targetSkill);

      // Stream the answer so it renders progressively in the overlay
      this._responseSeq = (this._responseSeq || 0) + 1;
      const messageId = `img-${Date.now()}-${this._responseSeq}`;
      windowManager.broadcastToAllWindows("llm-response-start", {
        messageId,
        skill: targetSkill,
        skillConfidence: resolved.confidence,
        isImage: true
      });

      const llmResult = await llmService.processImageWithSkillStream(
        capture.imageBuffer,
        capture.mimeType || 'image/png',
        targetSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        {
          lockedSkill: this.lockedSkill,
          style: this.answerStyle === 'auto' ? null : this.answerStyle
        },
        (delta) => {
          windowManager.broadcastToAllWindows("llm-response-chunk", {
            messageId,
            delta,
            isImage: true
          });
        }
      );

      llmResult.metadata = {
        ...llmResult.metadata,
        messageId,
        locked: !!this.lockedSkill
      };

      // Store in lastInputBuffer for quick actions / re-run
      this.lastInputBuffer = {
        kind: 'screenshot',
        text: llmResult.response,
        imageBuffer: capture.imageBuffer,
        mimeType: capture.mimeType || 'image/png',
        activeSkill: llmResult.metadata.skill,
        lastResponse: llmResult.response
      };

      // Record model response in session
      sessionManager.addModelResponse(llmResult.response, {
        skill: llmResult.metadata.skill,
        skillConfidence: llmResult.metadata.skillConfidence,
        imageType: llmResult.metadata.imageType,
        answerStyle: llmResult.metadata.answerStyle,
        locked: !!this.lockedSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isImageAnalysis: true
      });

      windowManager.showLLMResponse(llmResult.response, llmResult.metadata);
      this.broadcastLLMSuccess(llmResult);
    } catch (error) {
      logger.error("Screenshot OCR process failed", {
        error: error.message,
        duration: Date.now() - startTime,
      });

      windowManager.hideLLMResponse();
      this.broadcastOCRError(error.message);
      
      sessionManager.addConversationEvent({
        role: 'system',
        content: `Screenshot OCR failed: ${error.message}`,
        action: 'ocr_error',
        metadata: {
          error: error.message
        }
      });
    }
  }

  async processWithLLM(text, sessionHistory) {
    try {
      sessionManager.addUserInput(text, 'llm_input');

      // Resolve skill via Router
      const resolved = skillRouterService.resolveSkill({
        text,
        lockedSkill: this.lockedSkill,
        preset: this.interviewPreset,
        activeSkill: this.activeSkill
      });
      const targetSkill = resolved.skill;
      const needsProgrammingLanguage = promptLoader.requiresProgrammingLanguage(targetSkill);
      
      const llmResult = await llmService.processTextWithSkill(
        text,
        targetSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        {
          style: this.answerStyle === 'auto' ? null : this.answerStyle,
          lockedSkill: this.lockedSkill
        }
      );

      llmResult.metadata = {
        ...llmResult.metadata,
        skill: targetSkill,
        skillConfidence: resolved.confidence,
        locked: !!this.lockedSkill
      };

      this.lastInputBuffer = {
        kind: 'chat',
        text,
        activeSkill: targetSkill,
        lastResponse: llmResult.response
      };

      logger.info("LLM processing completed, showing response", {
        responseLength: llmResult.response.length,
        skill: targetSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        processingTime: llmResult.metadata.processingTime,
        responsePreview: llmResult.response.substring(0, 200) + "...",
      });

      // Add LLM response to session memory
      sessionManager.addModelResponse(llmResult.response, {
        skill: targetSkill,
        skillConfidence: resolved.confidence,
        answerStyle: llmResult.metadata.answerStyle,
        locked: !!this.lockedSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
      });

      windowManager.showLLMResponse(llmResult.response, llmResult.metadata);
      this.broadcastLLMSuccess(llmResult);
    } catch (error) {
      logger.error("LLM processing failed", {
        error: error.message,
        skill: this.activeSkill,
      });

      windowManager.hideLLMResponse();
      sessionManager.addConversationEvent({
        role: 'system',
        content: `LLM processing failed: ${error.message}`,
        action: 'llm_error',
        metadata: {
          error: error.message,
          skill: this.activeSkill
        }
      });

      this.broadcastLLMError(error.message);
    }
  }

  /**
   * Buffer a transcribed fragment and (re)arm the coalesce debounce. Fragments
   * are shown in the UI immediately so speech feels live, but the LLM is only
   * asked once the speaker has actually paused — this is what stops one spoken
   * line from producing two separate, slow answers.
   */
  handleTranscriptionFragment(text, explicitSpeaker = null) {
    const fragment = (text || "").trim();
    if (!fragment) {
      return;
    }

    const speaker = explicitSpeaker || (intentGate.detectSpeaker ? intentGate.detectSpeaker(fragment) : 'them');

    // Show the live transcript right away in all windows.
    sessionManager.addUserInput(fragment, 'speech', { speaker });
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send("transcription-received", { text: fragment, speaker });
    });

    if (this.isAutopilotEnabled) {
      this.turnAggregator.push({
        text: fragment,
        speaker: speaker || 'them',
        at: Date.now()
      });
      return;
    }

    this._utteranceBuffer = this._utteranceBuffer
      ? `${this._utteranceBuffer} ${fragment}`
      : fragment;

    if (this._utteranceTimer) {
      clearTimeout(this._utteranceTimer);
    }
    this._utteranceTimer = setTimeout(() => {
      this._utteranceTimer = null;
      this.dispatchCoalescedUtterance();
    }, this._utteranceCoalesceMs);
  }

  async handleAggregatedTurn(turn) {
    if (!turn || !turn.text) return;
    const intent = intentGate.classify(turn, this.autopilotAggressiveness);
    logger.info('[AUTOPILOT-INTENT]', { text: turn.text, intent });

    if (intent.act === 'ignore') {
      logger.debug('[AUTOPILOT] Ignored turn', { why: intent.why, text: turn.text });
      return;
    }

    if (intent.act === 'brief') {
      sessionManager.addConversationEvent({
        role: 'system',
        content: `Context: ${turn.text}`,
        action: 'context_brief'
      });
      logger.info('[AUTOPILOT] Saved silent context brief', { words: turn.text.split(' ').length });
      return;
    }

    this.lastSpokenQuestion = turn.text;
    await this.processAutopilotAnswer(turn, intent);
  }

  async handleSpeculativeStart(firstFragment) {
    if (!this.isAutopilotEnabled) return;
    const intent = intentGate.classify(firstFragment, this.autopilotAggressiveness);
    if (intent.act !== 'answer') return;

    this._speculativeAbortController = new AbortController();
    const prompterWin = windowManager.windows.get('prompter');
    if (prompterWin && !prompterWin.isDestroyed()) {
      prompterWin.webContents.send('prompter:stream-start', {
        headline: 'Thinking...',
        isSpeculative: true
      });
    }

    try {
      await llmService.processAutopilotTurnStream(
        { text: firstFragment, at: Date.now() },
        this.activeSkill,
        this.codingLanguage,
        { kind: intent.kind, isSpeculative: true },
        (delta) => {
          if (prompterWin && !prompterWin.isDestroyed()) {
            prompterWin.webContents.send('prompter:stream-delta', { delta });
          }
        },
        this._speculativeAbortController.signal
      );
    } catch (err) {
      if (err.message === 'Request aborted') {
        logger.info('[AUTOPILOT] Speculative request aborted due to incoming addition');
      }
    }
  }

  handleSpeculativeCancel() {
    if (this._speculativeAbortController) {
      try {
        this._speculativeAbortController.abort();
      } catch (_) {}
      this._speculativeAbortController = null;
      logger.info('[AUTOPILOT] Cancelled in-flight speculative request');
    }
  }

  async processAutopilotAnswer(turn, intent) {
    this.handleSpeculativeCancel();

    const prompterWin = windowManager.windows.get('prompter');
    if (prompterWin && !prompterWin.isDestroyed()) {
      prompterWin.webContents.send('prompter:stream-start', {
        headline: 'Generating answer...',
        isSpeculative: false
      });
    }

    this._responseSeq = (this._responseSeq || 0) + 1;
    const messageId = `tr-${Date.now()}-${this._responseSeq}`;
    windowManager.broadcastToAllWindows("transcription-llm-response-start", {
      messageId,
      skill: this.activeSkill,
      speaker: 'them',
      question: turn.text
    });
    windowManager.showLLMLoading();

    let capturedImageBuffer = null;
    let mimeType = 'image/png';

    // Auto-capture frame if task or screen-referencing turn
    if (intent.needsScreen) {
      try {
        const captureResult = await captureService.captureAndProcess({ autoROI: true });
        if (captureResult && !captureResult.isDuplicate && captureResult.imageBuffer) {
          capturedImageBuffer = captureResult.imageBuffer;
          mimeType = captureResult.mimeType || 'image/png';
        }
      } catch (err) {
        logger.warn('[AUTOPILOT] Auto screen capture error', { error: err.message });
      }
    }

    const resolved = skillRouterService.resolveSkill({
      text: turn.text,
      lockedSkill: this.lockedSkill,
      preset: this.interviewPreset,
      activeSkill: this.activeSkill
    });
    const targetSkill = resolved.skill;

    try {
      let result;
      if (capturedImageBuffer) {
        result = await this.processVisionTurn(capturedImageBuffer, mimeType, turn.text, targetSkill, messageId);
      } else {
        result = await llmService.processAutopilotTurnStream(
          turn,
          targetSkill,
          this.codingLanguage,
          { kind: intent.kind },
          (delta) => {
            if (prompterWin && !prompterWin.isDestroyed()) {
              prompterWin.webContents.send('prompter:stream-delta', { delta });
            }
            windowManager.broadcastToAllWindows("transcription-llm-response-chunk", {
              messageId,
              delta
            });
          }
        );
      }

      // Format response text for multi-window broadcast
      const responseText = result.fullText || (
        (result.headline ? `HEADLINE: ${result.headline}\n\n` : '') +
        (result.bullets && result.bullets.length ? result.bullets.map(b => `- ${b}`).join('\n') : '') +
        (result.code ? `\n\n\`\`\`${result.language || ''}\n${result.code}\n\`\`\`` : '')
      );

      // Send to prompter window
      if (prompterWin && !prompterWin.isDestroyed()) {
        if (result.fullText && result.fullText.includes('NO_PROBLEM_FOUND')) {
          prompterWin.webContents.send('prompter:no-problem');
        } else {
          prompterWin.webContents.send('prompter:update', result);
        }
      }

      // Broadcast to Listen panel, Chat panel, and Overlay window
      const broadcastPayload = {
        response: responseText,
        text: responseText,
        metadata: {
          messageId,
          headline: result.headline,
          bullets: result.bullets,
          code: result.code,
          language: result.language,
          skill: targetSkill,
          skillConfidence: resolved.confidence,
          question: turn.text,
          isAutopilot: true
        }
      };
      this.broadcastTranscriptionLLMResponse(broadcastPayload);
      windowManager.showLLMResponse(responseText, broadcastPayload.metadata);

      // Also record into session manager
      sessionManager.addModelResponse(responseText, {
        skill: targetSkill,
        skillConfidence: resolved.confidence,
        autopilot: true
      });
    } catch (err) {
      logger.error('[AUTOPILOT] Failed to answer turn', { error: err.message });
    }
  }

  async processVisionTurn(imageBuffer, mimeType, questionText, skill, messageId = null) {
    const prompterWin = windowManager.windows.get('prompter');
    const visionPromptPath = path.join(__dirname, 'prompts', 'vision.md');
    let visionInstruction = fs.existsSync(visionPromptPath)
      ? fs.readFileSync(visionPromptPath, 'utf8')
      : '';

    if (questionText) {
      visionInstruction += `\nInterviewer spoken context: "${questionText}"`;
    }

    const res = await llmService.processImageWithSkillStream(
      imageBuffer,
      mimeType,
      skill,
      [],
      this.codingLanguage,
      { customInstruction: visionInstruction },
      (delta) => {
        if (prompterWin && !prompterWin.isDestroyed()) {
          prompterWin.webContents.send('prompter:stream-delta', { delta });
        }
        if (messageId) {
          windowManager.broadcastToAllWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        }
      }
    );

    const fullResponse = res.response || '';
    const codeMatch = fullResponse.match(/```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/);
    let code = null;
    if (codeMatch) {
      code = codeMatch[1].trim();
      const { clipboard } = require('electron');
      if (clipboard) {
        clipboard.writeText(code);
      }
    }

    const prose = fullResponse.replace(/```(?:[a-zA-Z0-9_-]+)?\s*[\s\S]*?```/g, '').trim();
    const lines = prose.split('\n').map(l => l.trim()).filter(Boolean);
    let headline = '';
    const bullets = [];
    for (const l of lines) {
      if (/^HEADLINE:\s*/i.test(l)) {
        headline = l.replace(/^HEADLINE:\s*/i, '').trim();
      } else if (/^[-*•]\s+/.test(l)) {
        bullets.push(l.replace(/^[-*•]\s+/, '').trim());
      }
    }
    if (!headline && lines.length > 0) {
      headline = lines[0].replace(/^HEADLINE:\s*/i, '');
    }
    if (bullets.length === 0 && lines.length > 1) {
      bullets.push(...lines.slice(1, 4));
    }

    return {
      headline: headline || 'Problem solution',
      bullets: bullets.slice(0, 3),
      code,
      fullText: fullResponse
    };
  }

  async dispatchLastAnswerAction(style) {
    if (!this.lastSpokenQuestion) {
      logger.info('No previous question to re-answer');
      return;
    }
    const prompterWin = windowManager.windows.get('prompter');
    if (prompterWin && !prompterWin.isDestroyed()) {
      prompterWin.webContents.send('prompter:stream-start', {
        headline: style === 'deep' ? 'Re-answering deeper...' : 'Re-answering shorter...',
        isSpeculative: false
      });
    }
    try {
      const result = await llmService.processAutopilotTurnStream(
        { text: this.lastSpokenQuestion, at: Date.now() },
        this.activeSkill,
        this.codingLanguage,
        {
          kind: 'question',
          style: style === 'deep' ? 'deep' : 'concise'
        },
        (delta) => {
          if (prompterWin && !prompterWin.isDestroyed()) {
            prompterWin.webContents.send('prompter:stream-delta', { delta });
          }
        }
      );
      if (prompterWin && !prompterWin.isDestroyed()) {
        prompterWin.webContents.send('prompter:update', result);
      }
    } catch (e) {
      logger.warn('Failed to re-answer question', { error: e.message });
    }
  }

  async triggerAutopilotScreenCapture() {
    logger.info('[AUTOPILOT] Alt+S manual capture triggered');
    const prompterWin = windowManager.windows.get('prompter');
    if (prompterWin && !prompterWin.isDestroyed()) {
      prompterWin.webContents.send('prompter:stream-start', {
        headline: 'Analyzing screen...',
        isSpeculative: false
      });
    }

    try {
      const captureResult = await captureService.captureAndProcess({ autoROI: true });
      if (!captureResult || !captureResult.imageBuffer) return;

      const result = await this.processVisionTurn(
        captureResult.imageBuffer,
        captureResult.mimeType || 'image/png',
        this.lastSpokenQuestion || '',
        this.activeSkill
      );

      if (prompterWin && !prompterWin.isDestroyed()) {
        if (result.fullText && result.fullText.includes('NO_PROBLEM_FOUND')) {
          prompterWin.webContents.send('prompter:no-problem');
        } else {
          prompterWin.webContents.send('prompter:update', result);
        }
      }

      // Also display and broadcast to Vision panel (llmResponse) and chat
      if (result.fullText && !result.fullText.includes('NO_PROBLEM_FOUND')) {
        const visionPayload = {
          response: result.fullText,
          metadata: {
            skill: this.activeSkill,
            skillConfidence: 0.95,
            isImageAnalysis: true,
            code: result.code,
            headline: result.headline
          }
        };
        windowManager.showLLMResponse(result.fullText, visionPayload.metadata);
        this.broadcastLLMSuccess(visionPayload);
      }
    } catch (err) {
      logger.error('[AUTOPILOT] Screen capture analysis failed', { error: err.message });
      this.broadcastLLMError(`Screen capture failed: ${err.message}`);
    }
  }

  toggleAutopilot(enabled) {
    this.isAutopilotEnabled = typeof enabled === 'boolean' ? enabled : !this.isAutopilotEnabled;
    windowManager.broadcastToAllWindows('autopilot-changed', { enabled: this.isAutopilotEnabled });
    logger.info(`[AUTOPILOT] Autopilot mode set to: ${this.isAutopilotEnabled}`);
    return this.isAutopilotEnabled;
  }

  async enterInterviewMode() {
    this.isInterviewMode = true;
    this.isAutopilotEnabled = true;

    // 1. Close all panels
    await windowManager.closeAllPanels();

    // 2. Open prompter
    await windowManager.showPrompter();

    // 3. Set prompter click-through
    windowManager.setPrompterInteractive(false);

    // 4. Set opacity default
    windowManager.setGlobalOpacity(1.0);

    // 5. Start speech service if available
    if (this.speechAvailable && !speechService.isRecording) {
      try {
        await speechService.startRecording();
      } catch (err) {
        logger.warn('Could not auto-start speech recording', { error: err.message });
      }
    }

    // 6. Pre-warm services
    this.prewarmServices();

    // 7. Notify all windows
    windowManager.broadcastToAllWindows('interview-mode-changed', { active: true, autopilot: true });
    logger.info('[INTERVIEW-MODE] Entered Interview Mode');
    return true;
  }

  async exitInterviewMode() {
    this.isInterviewMode = false;
    this.isAutopilotEnabled = false;

    // 1. Stop speech
    if (speechService.isRecording) {
      try {
        await speechService.stopRecording();
      } catch (err) {
        logger.warn('Error stopping speech recording', { error: err.message });
      }
    }

    // 2. Hide prompter
    windowManager.hidePrompter();

    // 3. Restore panels interactivity
    windowManager.setInteractive(true);

    // 4. Open notes panel for post-interview review
    windowManager.setActivePanel('notes');

    // 5. Notify all windows
    windowManager.broadcastToAllWindows('interview-mode-changed', { active: false, autopilot: false });
    logger.info('[INTERVIEW-MODE] Exited Interview Mode');
    return false;
  }

  async toggleInterviewMode() {
    if (this.isInterviewMode) {
      return await this.exitInterviewMode();
    } else {
      return await this.enterInterviewMode();
    }
  }

  async prewarmServices() {
    try {
      if (llmService.client) {
        llmService.client.models.generateContent({
          model: llmService.model,
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 1 }
        }).catch(() => {});
      }
      captureService.captureAndProcess({ autoROI: false }).catch(() => {});
      logger.info('Services pre-warmed successfully');
    } catch (err) {
      logger.warn('Pre-warm non-critical failure', { error: err.message });
    }
  }

  handlePushToAsk() {
    logger.info('[AUTOPILOT] Alt+W Push-to-Ask triggered');
    if (this.speechAvailable && !speechService.isRecording) {
      speechService.startRecording();
    }
  }

  /**
   * Send the coalesced utterance to the LLM. If a previous dispatch is still
   * running, leave the buffer intact and let that dispatch's completion pick it
   * up — so we never pile up overlapping requests for the same person talking.
   */
  async dispatchCoalescedUtterance() {
    if (this._utteranceDispatchInFlight) {
      return;
    }
    const combined = this._utteranceBuffer.trim();
    if (!combined) {
      return;
    }
    this._utteranceBuffer = "";
    this._utteranceDispatchInFlight = true;

    try {
      const sessionHistory = sessionManager.getOptimizedHistory();
      await this.processTranscriptionWithLLM(combined, sessionHistory);
    } catch (error) {
      logger.error("Failed to process transcription with LLM", {
        error: error.message,
        text: combined.substring(0, 100)
      });
    } finally {
      this._utteranceDispatchInFlight = false;
      // Anything that arrived while we were busy gets answered now.
      if (this._utteranceBuffer.trim()) {
        this.dispatchCoalescedUtterance();
      }
    }
  }

  async processTranscriptionWithLLM(text, sessionHistory) {
    try {
      // Validate input text
      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        logger.warn("Skipping LLM processing for empty or invalid transcription", {
          textType: typeof text,
          textLength: text ? text.length : 0
        });
        return;
      }

      const cleanText = text.trim();
      if (cleanText.length < 2) {
        logger.debug("Skipping LLM processing for very short transcription", {
          text: cleanText
        });
        return;
      }

      // Resolve skill via Router
      const resolved = skillRouterService.resolveSkill({
        text: cleanText,
        lockedSkill: this.lockedSkill,
        preset: this.interviewPreset,
        activeSkill: this.activeSkill
      });
      const targetSkill = resolved.skill;
      const needsProgrammingLanguage = promptLoader.requiresProgrammingLanguage(targetSkill);

      logger.info("Processing transcription with intelligent LLM response", {
        skill: targetSkill,
        confidence: resolved.confidence,
        textLength: cleanText.length,
        textPreview: cleanText.substring(0, 100) + "..."
      });

      // Stream the answer so it renders progressively in the chat + overlay.
      this._responseSeq = (this._responseSeq || 0) + 1;
      const messageId = `tr-${Date.now()}-${this._responseSeq}`;
      windowManager.broadcastToAllWindows("transcription-llm-response-start", {
        messageId,
        skill: targetSkill,
        skillConfidence: resolved.confidence,
        speaker: 'you'
      });
      windowManager.showLLMLoading();

      const llmResult = await llmService.processTranscriptionWithIntelligentResponseStream(
        cleanText,
        targetSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        {
          style: this.answerStyle === 'auto' ? null : this.answerStyle,
          lockedSkill: this.lockedSkill,
          skillConfidence: resolved.confidence,
          speaker: 'you'
        },
        (delta) => {
          windowManager.broadcastToAllWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        }
      );
      llmResult.metadata = {
        ...llmResult.metadata,
        messageId,
        skill: targetSkill,
        skillConfidence: resolved.confidence,
        locked: !!this.lockedSkill
      };

      this.lastInputBuffer = {
        kind: 'transcription',
        text: cleanText,
        activeSkill: targetSkill,
        lastResponse: llmResult.response
      };

      // Add LLM response to session memory
      sessionManager.addModelResponse(llmResult.response, {
        skill: targetSkill,
        skillConfidence: resolved.confidence,
        answerStyle: llmResult.metadata.answerStyle,
        locked: !!this.lockedSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isTranscriptionResponse: true
      });

      // Send response to chat windows
      this.broadcastTranscriptionLLMResponse(llmResult);

      // Also display in the overlay window
      windowManager.showLLMResponse(llmResult.response, llmResult.metadata);

      logger.info("Transcription LLM response completed", {
        responseLength: llmResult.response.length,
        skill: targetSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        processingTime: llmResult.metadata.processingTime
      });

    } catch (error) {
      logger.error("Transcription LLM processing failed", {
        error: error.message,
        errorStack: error.stack,
        skill: this.activeSkill,
        text: text ? text.substring(0, 100) : 'undefined'
      });

      // Try to provide a fallback response
      try {
        const fallbackResult = llmService.generateIntelligentFallbackResponse(text, this.activeSkill);

        sessionManager.addModelResponse(fallbackResult.response, {
          skill: this.activeSkill,
          processingTime: fallbackResult.metadata.processingTime,
          usedFallback: true,
          isTranscriptionResponse: true,
          fallbackReason: error.message
        });

        this.broadcastTranscriptionLLMResponse(fallbackResult);
        // Mirror to overlay window for consistency
        windowManager.showLLMResponse(fallbackResult.response, {
          skill: this.activeSkill,
          processingTime: fallbackResult.metadata.processingTime,
          usedFallback: true,
          isTranscriptionResponse: true
        });
        logger.info("Used fallback response for transcription", {
          skill: this.activeSkill,
          fallbackResponse: fallbackResult.response
        });
        
      } catch (fallbackError) {
        logger.error("Fallback response also failed", {
          fallbackError: fallbackError.message
        });

        sessionManager.addConversationEvent({
          role: 'system',
          content: `Transcription LLM processing failed: ${error.message}`,
          action: 'transcription_llm_error',
          metadata: {
            error: error.message,
            skill: this.activeSkill
          }
        });
      }
    }
  }

  broadcastOCRSuccess(ocrResult) {
    windowManager.broadcastToAllWindows("ocr-completed", {
      text: ocrResult.text,
      metadata: ocrResult.metadata,
    });
  }

  broadcastOCRError(errorMessage) {
    windowManager.broadcastToAllWindows("ocr-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastLLMSuccess(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      skill: this.activeSkill, // Add the current active skill to the top level
    };

    logger.info("Broadcasting LLM success to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill,
      dataKeys: Object.keys(broadcastData),
      responsePreview: llmResult.response.substring(0, 100) + "...",
    });

    windowManager.broadcastToAllWindows("llm-response", broadcastData);
  }

  broadcastLLMError(errorMessage) {
    windowManager.broadcastToAllWindows("llm-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastTranscriptionLLMResponse(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      messageId: llmResult.metadata && llmResult.metadata.messageId,
      skill: this.activeSkill,
      isTranscriptionResponse: true
    };

    logger.info("Broadcasting transcription LLM response to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill,
      responsePreview: llmResult.response.substring(0, 100) + "..."
    });

    windowManager.broadcastToAllWindows("transcription-llm-response", broadcastData);
  }

  onWindowAllClosed() {
    if (process.platform !== "darwin") {
      app.quit();
    }
  }

  onActivate() {
    if (!this.isReady && !this.starting) {
      this.onAppReady();
    } else if (this.isReady) {
      // When app is activated, ensure windows appear on current desktop
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow && mainWindow.isVisible()) {
        windowManager.showOnCurrentDesktop(mainWindow);
      }

      // Also handle other visible windows
      windowManager.windows.forEach((window, type) => {
        if (window.isVisible()) {
          windowManager.showOnCurrentDesktop(window);
        }
      });

      logger.debug("App activated - ensured windows appear on current desktop");
    }
  }

  onWillQuit() {
    globalShortcut.unregisterAll();
    windowManager.destroyAllWindows();

    const sessionStats = sessionManager.getMemoryUsage();
    logger.info("Application shutting down", {
      sessionEvents: sessionStats.eventCount,
      sessionSize: sessionStats.approximateSize,
    });
  }

  getWhisperInstaller() {
    if (!this._whisperInstaller) {
      const WhisperInstaller = require("./src/core/whisper-installer");
      const { app } = require("electron");
      this._whisperInstaller = new WhisperInstaller({
        cwd: process.cwd(),
        dataDir: app.getPath("userData"),
        platform: process.platform,
      });
    }
    return this._whisperInstaller;
  }

  getSettings() {
    // Surface every value the settings UI can edit, reading the live source
    // of truth (process.env) so the UI shows exactly what the running app is
    // using. Empty strings are returned rather than skipped so the UI can
    // distinguish "unset" from "stale value from a previous load".
    return {
      codingLanguage: this.codingLanguage || "cpp",
      activeSkill: this.activeSkill || "dsa",
      interviewPreset: this.interviewPreset || "full",
      answerStyle: this.answerStyle || "auto",
      lockedSkill: this.lockedSkill || null,
      appIcon: this.appIcon || "terminal",
      selectedIcon: this.appIcon || "terminal",
      windowGap: windowManager.windowGap,

      speechProvider: speechService.provider || (process.env.SPEECH_PROVIDER || "whisper"),
      groqApiKey: process.env.GROQ_API_KEY || "",
      groqModel: process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo",
      groqLanguage: process.env.GROQ_LANGUAGE || "auto",
      azureKey: process.env.AZURE_SPEECH_KEY || "",
      azureRegion: process.env.AZURE_SPEECH_REGION || "",
      whisperCommand: process.env.WHISPER_COMMAND || "",
      whisperModel: process.env.WHISPER_MODEL || "turbo",
      whisperLanguage: process.env.WHISPER_LANGUAGE || "en",
      whisperSegmentMs: process.env.WHISPER_SEGMENT_MS || "4000",
      geminiKey: process.env.GEMINI_API_KEY || "",
      geminiModel: process.env.GEMINI_MODEL || config.get('llm.gemini.model') || "gemini-3.5-flash-lite",

      azureConfigured: !!process.env.AZURE_SPEECH_KEY && !!process.env.AZURE_SPEECH_REGION,
      groqConfigured: !!process.env.GROQ_API_KEY,
      speechAvailable: this.speechAvailable
    };
  }

  saveSettings(settings) {
    try {
      // ── In-memory updates + window broadcasts ──
      if (settings.codingLanguage) {
        this.codingLanguage = settings.codingLanguage;
        windowManager.broadcastToAllWindows("coding-language-changed", {
          language: settings.codingLanguage,
        });
      }
      if (settings.activeSkill) {
        this.activeSkill = settings.activeSkill;
        windowManager.broadcastToAllWindows("skill-updated", {
          skill: settings.activeSkill,
        });
      }
      if (settings.interviewPreset) {
        this.interviewPreset = settings.interviewPreset;
        windowManager.broadcastToAllWindows("preset-changed", {
          preset: settings.interviewPreset
        });
      }
      if (settings.answerStyle) {
        this.answerStyle = settings.answerStyle;
        windowManager.broadcastToAllWindows("style-changed", {
          style: settings.answerStyle
        });
      }
      if (settings.appIcon) {
        this.appIcon = settings.appIcon;
      }
      if (settings.selectedIcon) {
        this.appIcon = settings.selectedIcon;
        this.updateAppIcon(settings.selectedIcon);
      }
      if (settings.windowGap !== undefined) {
        const gap = Number(settings.windowGap);
        if (Number.isFinite(gap)) windowManager.setWindowGap(gap);
      }

      // ── Persist provider / API-key fields back to .env ──
      const envUpdates = {};
      if (settings.interviewPreset) {
        envUpdates.INTERVIEW_PRESET = settings.interviewPreset;
      }
      if (settings.speechProvider === "azure" || settings.speechProvider === "whisper" || settings.speechProvider === "groq") {
        envUpdates.SPEECH_PROVIDER = settings.speechProvider;
      }
      if (settings.groqApiKey !== undefined) {
        envUpdates.GROQ_API_KEY = settings.groqApiKey;
      }
      if (settings.groqModel !== undefined) {
        envUpdates.GROQ_STT_MODEL = settings.groqModel;
      }
      if (settings.groqLanguage !== undefined) {
        envUpdates.GROQ_LANGUAGE = settings.groqLanguage;
      }
      if (settings.azureKey !== undefined) {
        envUpdates.AZURE_SPEECH_KEY = settings.azureKey;
      }
      if (settings.azureRegion !== undefined) {
        envUpdates.AZURE_SPEECH_REGION = settings.azureRegion;
      }
      if (settings.whisperCommand !== undefined) {
        envUpdates.WHISPER_COMMAND = settings.whisperCommand;
      }
      if (settings.whisperModel !== undefined) {
        envUpdates.WHISPER_MODEL = settings.whisperModel;
      }
      if (settings.whisperLanguage !== undefined) {
        envUpdates.WHISPER_LANGUAGE = settings.whisperLanguage;
      }
      if (settings.whisperSegmentMs !== undefined) {
        envUpdates.WHISPER_SEGMENT_MS = String(settings.whisperSegmentMs);
      }
      if (settings.geminiKey !== undefined) {
        envUpdates.GEMINI_API_KEY = settings.geminiKey;
      }
      if (settings.geminiModel !== undefined) {
        envUpdates.GEMINI_MODEL = settings.geminiModel;
      }

      // Capture the previous whisper command BEFORE persisting — persistEnvUpdates
      // mutates process.env in place, so comparing afterwards would always read
      // equal and skip the speech re-init below (the exact stale-mic-after-install
      // bug the re-init guards against).
      const prevWhisperCommand = process.env.WHISPER_COMMAND || '';

      const persistedKeys = this.persistEnvUpdates(envUpdates);

      // If the Gemini key or model was just saved, reinitialize the LLM service
      // so the new client picks up the new config immediately.
      if ((settings.geminiKey !== undefined && envUpdates.GEMINI_API_KEY !== undefined) ||
          (settings.geminiModel !== undefined && envUpdates.GEMINI_MODEL !== undefined)) {
        try {
          llmService.initializeClient();
          logger.info("LLM service reinitialized after Gemini settings update", {
            model: llmService.model
          });
        } catch (e) {
          logger.warn("Failed to reinitialize LLM service after Gemini settings update", {
            error: e.message
          });
        }
      }

      // Reinitialize speech service when provider, whisper command, or Groq settings change.
      const providerChanged = settings.speechProvider && speechService.provider !== settings.speechProvider;
      const whisperSettingsChanged = whisperCommandChanged ||
        settings.whisperModel !== undefined ||
        settings.whisperLanguage !== undefined ||
        settings.whisperSegmentMs !== undefined;
      const groqChanged = settings.groqApiKey !== undefined || settings.groqModel !== undefined || settings.groqLanguage !== undefined;
      if (providerChanged || whisperSettingsChanged || groqChanged) {
        try {
          speechService.updateSettings(settings);
          this.speechAvailable = speechService.isAvailable
            ? speechService.isAvailable()
            : false;
          // Broadcast so any open window (settings, overlay, chat)
          // can react immediately — especially the main overlay's
          // mic button, which queries availability on load.
          const { BrowserWindow } = require("electron");
          BrowserWindow.getAllWindows().forEach((win) => {
            if (!win.isDestroyed()) {
              win.webContents.send("speech-availability", { available: this.speechAvailable });
            }
          });
          logger.info('Speech service reinitialized after settings change', {
            providerChanged,
            whisperCommandChanged,
            groqChanged,
            speechAvailable: this.speechAvailable,
          });
        } catch (e) {
          logger.warn("Failed to reinitialize speech service after settings change", {
            error: e.message
          });
        }
      }

      logger.info("Settings saved successfully", {
        ...settings,
        persistedEnvKeys: persistedKeys
      });
      return { success: true, persistedEnvKeys: persistedKeys };
    } catch (error) {
      logger.error("Failed to save settings", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  persistSettings(settings) {
    // You can extend this to save to a file or database
    // For now, we'll just keep them in memory
    logger.debug("Settings persisted", settings);
  }

  /**
   * Write key=value pairs to the project's .env file. Existing keys are
   * replaced in-place; new keys are appended. Comments and unrelated lines
   * are preserved. Uses an atomic write (temp file + rename) so a crash
   * mid-write cannot corrupt .env.
   *
   * @param {Object<string, string>} updates - keys to upsert
   * @returns {string[]} keys that were actually persisted
   */
  persistEnvUpdates(updates) {
    if (!updates || typeof updates !== "object") return [];
    const keys = Object.keys(updates);
    if (keys.length === 0) return [];

    const fs = require("fs");
    // Single source of truth — the same file dotenv loaded at startup and that
    // FirstRunManager reads/writes (userData in packaged builds, project .env
    // in dev). Writing to process.cwd() here would silently diverge.
    const envPath = ENV_PATH;

    let existing = "";
    try {
      existing = fs.readFileSync(envPath, "utf8");
    } catch (_) {
      // .env doesn't exist yet — we'll create one from scratch
      existing = "";
    }

    const existingLines = existing.length > 0 ? existing.split(/\r?\n/) : [];
    const updated = new Set();
    const outLines = [];

    for (const line of existingLines) {
      // Match "KEY=" (with optional whitespace) but skip comment lines
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
      if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
        const key = m[1];
        outLines.push(`${key}=${formatEnvValue(updates[key])}`);
        updated.add(key);
      } else {
        outLines.push(line);
      }
    }

    // Append any keys that weren't already present
    for (const key of keys) {
      if (!updated.has(key)) {
        outLines.push(`${key}=${formatEnvValue(updates[key])}`);
        updated.add(key);
      }
    }

    // Update process.env so the running app picks up the new values
    // immediately (and so the settings UI reads the same source of truth).
    for (const key of keys) {
      process.env[key] = String(updates[key]);
    }

    const newContent = outLines.join("\n");
    try {
      const tmpPath = envPath + ".tmp";
      fs.writeFileSync(tmpPath, newContent, "utf8");
      fs.renameSync(tmpPath, envPath);
    } catch (e) {
      logger.error("Failed to persist .env updates", {
        error: e.message,
        keys
      });
      return [];
    }

    logger.info("Persisted .env updates", { keys: Array.from(updated) });
    return Array.from(updated);
  }

  updateAppIcon(iconKey) {
    try {
      const { app } = require("electron");
      const path = require("path");
      const fs = require("fs");

      // Icon mapping for available icons in assests/icons folder
      const iconPaths = {
        terminal: "assests/icons/terminal.png",
        activity: "assests/icons/activity.png",
        settings: "assests/icons/settings.png",
      };

      // App name mapping for stealth mode
      const appNames = {
        terminal: "Terminal ",
        activity: "Activity Monitor ",
        settings: "System Settings ",
      };

      const iconPath = iconPaths[iconKey];
      const appName = appNames[iconKey];

      if (!iconPath) {
        logger.error("Invalid icon key", { iconKey });
        return { success: false, error: "Invalid icon key" };
      }

      const fullIconPath = path.resolve(__dirname, iconPath);

      if (!fs.existsSync(fullIconPath)) {
        logger.error("Icon file not found", {
          iconKey,
          iconPath: fullIconPath,
        });
        return { success: false, error: "Icon file not found" };
      }

      // Set app icon for dock/taskbar
      if (process.platform === "darwin") {
        // macOS - update dock icon
        app.dock.setIcon(fullIconPath);

        // Force dock refresh with multiple attempts
        setTimeout(() => {
          app.dock.setIcon(fullIconPath);
        }, 100);

        setTimeout(() => {
          app.dock.setIcon(fullIconPath);
        }, 500);
      } else {
        // Windows/Linux - update window icons
        windowManager.windows.forEach((window, type) => {
          if (window && !window.isDestroyed()) {
            window.setIcon(fullIconPath);
          }
        });
      }

      // Update app name for stealth mode
      this.updateAppName(appName, iconKey);

      logger.info("App icon and name updated successfully", {
        iconKey,
        appName,
        iconPath: fullIconPath,
        platform: process.platform,
        fileExists: fs.existsSync(fullIconPath),
      });

      this.appIcon = iconKey;
      return { success: true };
    } catch (error) {
      logger.error("Failed to update app icon", {
        error: error.message,
        stack: error.stack,
      });
      return { success: false, error: error.message };
    }
  }

  updateAppName(appName, iconKey) {
    try {
      const { app } = require("electron");

      // Force update process title for Activity Monitor stealth - CRITICAL
      process.title = appName;

      // Set app name in dock (macOS) - this affects the dock and Activity Monitor
      if (process.platform === "darwin") {
        // Multiple attempts to ensure the name sticks
        app.setName(appName);

        // Force update the bundle name for macOS stealth
        const { execSync } = require("child_process");
        try {
          // Update the app's Info.plist CFBundleName in memory
          if (process.mainModule && process.mainModule.filename) {
            const appPath = process.mainModule.filename;
            // Force set the bundle name directly
            process.env.CFBundleName = appName.trim();
          }
        } catch (e) {
          // Silently fail if we can't modify bundle info
        }

        // Clear dock badge and reset
        if (app.dock) {
          app.dock.setBadge("");
          // Force dock refresh
          setTimeout(() => {
            app.dock.setIcon(
              require("path").resolve(__dirname, `assests/icons/${iconKey}.png`)
            );
          }, 50);
        }
      }

      // Set app user model ID for Windows taskbar grouping
      app.setAppUserModelId(`${appName.trim()}-${iconKey}`);

      // Update all window titles to match the new app name
      const windows = windowManager.windows;
      windows.forEach((window, type) => {
        if (window && !window.isDestroyed()) {
          // Use stealth name for all windows
          const stealthTitle = appName.trim();
          window.setTitle(stealthTitle);
        }
      });

      // Multiple force refreshes with increasing delays
      const refreshTimes = [50, 100, 200, 500];
      refreshTimes.forEach((delay) => {
        setTimeout(() => {
          process.title = appName;
          if (process.platform === "darwin") {
            app.setName(appName);
            // Force update bundle display name
            if (app.getName() !== appName) {
              app.setName(appName);
            }
          }
        }, delay);
      });

      logger.info("App name updated for stealth mode", {
        appName,
        processTitle: process.title,
        appGetName: app.getName(),
        iconKey,
        platform: process.platform,
      });
    } catch (error) {
      logger.error("Failed to update app name", { error: error.message });
    }
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  const controller = new ApplicationController();
  app.on("second-instance", () => controller.handleSecondInstance());
}
