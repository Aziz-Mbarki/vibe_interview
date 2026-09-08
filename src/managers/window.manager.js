const { BrowserWindow, screen, desktopCapturer, powerMonitor } = require('electron');
const path = require('path');
const logger = require('../core/logger').createServiceLogger('WINDOW');
const config = require('../core/config');

class WindowManager {
  constructor() {
    this.windows = new Map();
    this.activeWindow = 'main';
    this.isInteractive = true; // default to interactive so windows are clickable/drag-able
    this.isVisible = false;
    this.currentDisplay = null;
    this.screenWatcher = null;
    this.desktopWatcher = null;
    this.lastActiveSpace = null;
    this.screenCaptureAvailabilityWatcher = null;
    this.isScreenBeingShared = false;
    this.wasVisibleBeforeSharing = false;
    this.screenCaptureStatus = {
      available: null,
      lastError: null,
      lastCheckedAt: null
    };
    this.isCheckingScreenCaptureStatus = false;
    this.isInitialized = false;
    this.isInitializing = false;
    this.isRecording = false;
    
    // Add debouncing to prevent excessive operations
    this.lastEnforceTime = 0;
    this.enforceDebounceMs = 1000; // Only enforce once per second
    this.focusLocked = false; // Prevent focus loops
    
    // Window binding properties
    this.bindWindows = true; // Enable window binding by default
    this.windowGap = 10; // Small gap between windows
    this.boundWindowsPosition = { x: 0, y: 0 }; // Track position of bound windows
    this.detached = new Set();
    this.activePanel = null;
    this.isBlackout = false;
    this.isPanicHidden = false;
    this._prePanicVisible = null;
    this.currentOpacity = 1.0;
    
    const PANEL_BASE = {
      frame: false,
      transparent: true,
      hasShadow: false,
      skipTaskbar: true,
      resizable: true,
      alwaysOnTop: true,
      visibleOnAllWorkspaces: true,
      fullscreenable: false,
      backgroundColor: '#00000000'
    };

    this.windowConfigs = {
      main: {
        width: 760,
        height: 44,
        useContentSize: true,
        file: 'index.html',
        title: 'OpenCluely'
      },
      listen: {
        ...PANEL_BASE,
        width: 420,
        height: 560,
        file: 'panels/listen.html',
        title: 'Listen'
      },
      vision: {
        ...PANEL_BASE,
        width: 840,
        height: 520,
        file: 'llm-response.html',
        title: 'Vision'
      },
      ask: {
        ...PANEL_BASE,
        width: 460,
        height: 640,
        file: 'chat.html',
        title: 'Ask'
      },
      notes: {
        ...PANEL_BASE,
        width: 820,
        height: 600,
        file: 'panels/notes.html',
        title: 'Notes'
      },
      params: {
        ...PANEL_BASE,
        width: 720,
        height: 560,
        file: 'settings.html',
        title: 'Params'
      },
      prompter: {
        ...PANEL_BASE,
        width: 720,
        height: 150,
        file: 'panels/prompter.html',
        title: 'Prompter',
        focusable: false,
        resizable: false,
        movable: true
      },
      // Backward compatibility aliases
      chat: {
        ...PANEL_BASE,
        width: 460,
        height: 640,
        file: 'chat.html',
        title: 'Ask'
      },
      llmResponse: {
        ...PANEL_BASE,
        width: 840,
        height: 520,
        file: 'llm-response.html',
        title: 'Vision'
      },
      settings: {
        ...PANEL_BASE,
        width: 720,
        height: 560,
        file: 'settings.html',
        title: 'Params'
      },
      onboarding: {
        width: 560,
        height: 680,
        file: 'onboarding.html',
        title: 'Welcome to OpenCluely',
        frame: false,
        titleBarStyle: 'hidden',
        transparent: true,
        skipTaskbar: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        closable: true,
        alwaysOnTop: true,
        visibleOnAllWorkspaces: true,
        fullscreenable: false
      }
    };

    this.init();
  }

  init() {
    // ... existing initialization code ...
  }

  async initializeWindows(options = {}) {
    const { showMainWindow = true } = options;
    if (this.isInitialized || this.isInitializing) {
      logger.warn('Windows already initialized or initializing');
      return;
    }

    this.isInitializing = true;
    logger.info('Initializing application windows', { showMainWindow });
    
    try {
      // Pass autoShow: false so all windows are created and bound-positioned before showing
      await this.createMainWindow({ autoShow: false });
      await this.createChatWindow();
      await this.createLLMResponseWindow();
      await this.createSettingsWindow();
      await this.createListenWindow();
      await this.createNotesWindow();
      await this.createPrompterWindow();

      if (this.bindWindows) {
        this.positionBoundWindows();
      }
      
      this.setupWindowEventHandlers();
      this.setupScreenTracking();
      this.setupScreenCaptureAvailabilityWatcher();

      // Make windows interactive by default so they are not click-through
      this.setInteractive(true);
      
      // Optionally show the main window (deferred during onboarding)
      if (showMainWindow) {
        await this.showMainWindow();
      }
      
      this.isInitialized = true;
      this.isInitializing = false;
      logger.info('All windows initialized successfully');
    } catch (error) {
      this.isInitializing = false;
      logger.error('Failed to initialize windows', { error: error.message });
      throw error;
    }
  }

  async showMainWindow() {
    const mainWindow = this.windows.get('main');
    if (!mainWindow) return;

    if (this.bindWindows) {
      this.positionBoundWindows();
    }
    this.isVisible = true;
    
    // Immediate always-on-top enforcement for main window
    if (process.platform === 'darwin') {
      try {
        mainWindow.setAlwaysOnTop(true, 'screen-saver', 2);
      } catch (error) {
        mainWindow.setAlwaysOnTop(true, 'floating', 2);
      }
    } else {
      mainWindow.setAlwaysOnTop(true);
    }
    
    // Wait for app to fully initialize and detect current desktop
    await new Promise((resolve) => setTimeout(resolve, 100));
    this.showOnCurrentDesktop(mainWindow);
    
    // Additional enforcement after showing
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!mainWindow.isDestroyed()) {
      if (process.platform === 'darwin') {
        try {
          mainWindow.setAlwaysOnTop(true, 'screen-saver', 2);
        } catch (error) {
          mainWindow.setAlwaysOnTop(true, 'floating', 2);
        }
      } else {
        mainWindow.setAlwaysOnTop(true);
      }
    }
    
    this.isVisible = true;
    logger.info('Main window displayed');
    // Notify renderer to refresh speech availability
    mainWindow.webContents.send('main-window-shown', {});
  }

  async createMainWindow(options = {}) {
    const { autoShow = true } = options;
    if (this.windows.has('main')) {
      return this.windows.get('main');
    }
    const window = await this.createWindow('main', false); // Don't show during creation
    this.windows.set('main', window);

    window.webContents.on('console-message', (event, level, message, line, sourceId) => {
      logger.info(`[MAIN-CONSOLE] ${message} (line: ${line})`);
    });

    // Always-on-top must be set even when we're deferring the visual
    // show — it persists into the future showOnCurrentDesktop call.
    if (process.platform === 'darwin') {
      try {
        window.setAlwaysOnTop(true, 'screen-saver', 2);
      } catch (error) {
        window.setAlwaysOnTop(true, 'floating', 2);
      }
    } else {
      window.setAlwaysOnTop(true);
    }

    // Only auto-show when explicitly allowed (e.g. not during first-run
    // onboarding). The single entry point for showing the overlay is
    // `showMainWindow()` — callers control timing via the flag below.
    if (autoShow) {
      // Wait for app to fully initialize and detect current desktop
      setTimeout(() => {
        this.showOnCurrentDesktop(window);
        // Additional enforcement after showing
        setTimeout(() => {
          if (!window.isDestroyed()) {
            if (process.platform === 'darwin') {
              try {
                window.setAlwaysOnTop(true, 'screen-saver', 2);
              } catch (error) {
                window.setAlwaysOnTop(true, 'floating', 2);
              }
            } else {
              window.setAlwaysOnTop(true);
            }
          }
        }, 200);
      }, 100);
    }

    return window;
  }

  async createChatWindow() {
    if (this.windows.has('ask')) {
      return this.windows.get('ask');
    }
    const window = await this.createWindow('ask', false);
    this.windows.set('chat', window);
    this.windows.set('ask', window);

    window.webContents.on('console-message', (event, level, message, line, sourceId) => {
      logger.info(`[CHAT-CONSOLE] ${message} (line: ${line})`);
    });

    window.hide();
    return window;
  }

  async createLLMResponseWindow() {
    if (this.windows.has('vision')) {
      return this.windows.get('vision');
    }
    const window = await this.createWindow('vision', false);
    this.windows.set('llmResponse', window);
    this.windows.set('vision', window);
    
    window.webContents.on('console-message', (event, level, message, line, sourceId) => {
      if (message.includes('LLM-RESPONSE')) {
        logger.info(`[RENDERER] ${message}`);
      }
    });
    
    window.hide();
    return window;
  }

  async createSettingsWindow() {
    if (this.windows.has('params')) {
      return this.windows.get('params');
    }
    const window = await this.createWindow('params', false);
    this.windows.set('settings', window);
    this.windows.set('params', window);
    window.hide();
    return window;
  }

  async createListenWindow() {
    if (this.windows.has('listen')) {
      return this.windows.get('listen');
    }
    const window = await this.createWindow('listen', false);
    this.windows.set('listen', window);
    window.hide();
    return window;
  }

  async createNotesWindow() {
    if (this.windows.has('notes')) {
      return this.windows.get('notes');
    }
    const window = await this.createWindow('notes', false);
    this.windows.set('notes', window);
    window.hide();
    return window;
  }

  async createPrompterWindow() {
    if (this.windows.has('prompter')) {
      return this.windows.get('prompter');
    }
    const window = await this.createWindow('prompter', false);
    this.windows.set('prompter', window);
    window.setIgnoreMouseEvents(true, { forward: true });
    window.hide();
    return window;
  }

  async createWindow(type, showOnCreate = false) {
    const windowConfig = this.windowConfigs[type];
    if (!windowConfig) {
      throw new Error(`Unknown window type: ${type}`);
    }

    // Base options
    const baseOptions = {
      width: windowConfig.width,
      height: windowConfig.height,
      webPreferences: {
        ...config.get('window.webPreferences'),
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
        devTools: true, // Enable DevTools for debugging
      },
      show: false, // Never show during creation, use showOnCurrentDesktop instead
      title: windowConfig.title,
      skipTaskbar: true,
      alwaysOnTop: true,
      visibleOnAllWorkspaces: true,
      fullscreenable: false,
      // Platform-specific always-on-top settings
      ...(process.platform === 'darwin' && {
        level: 'floating' // Start with floating level for macOS
      })
    };

    // Type-specific window configurations
    let browserWindowOptions;
    
    if (['listen', 'vision', 'ask', 'notes', 'params', 'prompter', 'llmResponse', 'settings', 'chat'].includes(type)) {
      // Smog-grade frameless translucent panel
      browserWindowOptions = {
        ...baseOptions,
        frame: false,
        titleBarStyle: 'hidden',
        transparent: true,
        backgroundColor: '#00000000',
        resizable: windowConfig.resizable !== undefined ? windowConfig.resizable : true,
        focusable: windowConfig.focusable !== undefined ? windowConfig.focusable : true,
        minimizable: false,
        maximizable: false,
        closable: false,
        hasShadow: false,
        thickFrame: false,
        ...(process.platform === 'darwin' && {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: -100, y: -100 },
          type: 'panel',
          acceptFirstMouse: true,
          disableAutoHideCursor: true
        }),
        level: process.platform === 'darwin' ? 'floating' : undefined,
      };
    } else if (type === 'onboarding') {
      // First-run onboarding wizard
      browserWindowOptions = {
        ...baseOptions,
        frame: false,
        titleBarStyle: 'hidden',
        transparent: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        closable: true,
        hasShadow: true,
        backgroundColor: '#00000000',
        level: process.platform === 'darwin' ? 'floating' : undefined,
        ...(process.platform === 'darwin' && {
          type: 'panel',
          acceptFirstMouse: true,
          disableAutoHideCursor: true
        })
      };
    } else if (type === 'main') {
      // Main window configuration - fit to content, completely frameless
      browserWindowOptions = {
        ...baseOptions,
        frame: false,
        titleBarStyle: 'hidden',
        titleBarOverlay: false,
        transparent: true,
        backgroundColor: '#00000000',
        resizable: true,
        minWidth: 60,
        maxWidth: 900,
        minimizable: false,
        maximizable: false,
        closable: false,
        hasShadow: false,
        useContentSize: windowConfig.useContentSize || false,
        thickFrame: false,
        focusable: true,
        ...(process.platform === 'darwin' && {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: -100, y: -100 },
          acceptFirstMouse: true,
          disableAutoHideCursor: true,
          type: 'panel'
        }),
        level: process.platform === 'darwin' ? 'floating' : undefined,
      };
    } else {
      // Other windows (skills)
      browserWindowOptions = {
        ...baseOptions,
        minWidth: config.get('window.minWidth'),
        minHeight: config.get('window.minHeight'),
        maxWidth: config.get('window.maxWidth'),
        maxHeight: config.get('window.maxHeight'),
        frame: true,
        titleBarStyle: 'default',
        transparent: false,
        resizable: true,
        minimizable: false,
        maximizable: true,
        closable: true,
        hasShadow: true,
        level: process.platform === 'darwin' ? 'floating' : undefined,
      };
    }

    // Windows-specific settings
    if (process.platform === 'win32') {
      browserWindowOptions = {
        ...browserWindowOptions,
        parent: null,
        modal: false,
        thickFrame: false,
      };
    }

    browserWindowOptions.kiosk = false;
    browserWindowOptions.simpleFullscreen = false;

  const window = new BrowserWindow(browserWindowOptions);
    
  // Attach diagnostic webContents listeners before loadFile
  window.webContents.on('did-finish-load', () => {
    logger.info(`[${type.toUpperCase()}-WEBCONTENTS] did-finish-load successfully fired for: ${windowConfig.file}`);
  });
  window.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    logger.error(`[${type.toUpperCase()}-WEBCONTENTS] did-fail-load: ${errorDescription} (${errorCode}) for URL: ${validatedURL}`);
  });
  window.webContents.on('render-process-gone', (event, details) => {
    logger.error(`[${type.toUpperCase()}-WEBCONTENTS] render-process-gone:`, details);
  });
  window.webContents.on('unresponsive', () => {
    logger.error(`[${type.toUpperCase()}-WEBCONTENTS] Window became unresponsive`);
  });
  window.webContents.on('responsive', () => {
    logger.info(`[${type.toUpperCase()}-WEBCONTENTS] Window became responsive`);
  });

  // Load the HTML file
    await window.loadFile(windowConfig.file);
    
  // Position the window
    this.positionWindow(window, type);
    
  // Apply simplified stealth measures
    this.applyStealthMeasures(window, type);
    
  // Initialize interaction mode based on current state for ALL windows
    if (type === 'prompter') {
      window.setIgnoreMouseEvents(true, { forward: true });
    } else if (this.isInteractive) {
      window.setIgnoreMouseEvents(false);
    } else {
      window.setIgnoreMouseEvents(true, { forward: true });
    }

    // Horizontal-only resize behavior for main overlay window
    if (type === 'main') {
      try {
        // Small practical minimum width so it can collapse to roughly one icon width
        // Height is managed dynamically; don't lock here to allow programmatic changes
        if (typeof window.setMinimumSize === 'function') {
          // Set a conservative minimum width; height will be adjusted via IPC as needed
          window.setMinimumSize(60, windowConfig.height);
        }

        // Intercept user-initiated resizes to lock height and allow width changes only
        window.on('will-resize', (event, newBounds) => {
          try {
            // Keep current content height; only apply the new width
            const [_, currentContentHeight] = window.getContentSize();
            event.preventDefault();
            // Enforce width within min/max bounds
            const minW = 60;
            const maxW = this.windowConfigs.main.width;
            const desiredW = Math.max(minW, Math.min(maxW, Math.round(newBounds.width || minW)));
            window.setContentSize(desiredW, Math.max(1, currentContentHeight));
          } catch (e) {
            // Fallback: lock window height using window size
            try {
              const [__w, currentWindowHeight] = window.getSize();
              event.preventDefault();
              const minW = 60;
              const maxW = this.windowConfigs.main.width;
              const desiredW = Math.max(minW, Math.min(maxW, Math.round(newBounds.width || minW)));
              window.setSize(desiredW, Math.max(1, currentWindowHeight));
            } catch { /* noop */ }
          }
        });

        // When resized (by user or programmatically), keep bound windows aligned at top
        window.on('resize', () => {
          if (this.bindWindows) {
            this.positionBoundWindows();
          }
        });
      } catch { /* ignore */ }
    }
    
    // Show window on current desktop if requested
    if (showOnCreate) {
      this.showOnCurrentDesktop(window);
    }

    logger.debug('Window created successfully', {
      type,
      title: windowConfig.title,
      dimensions: `${windowConfig.width}x${windowConfig.height}`,
      showOnCreate: showOnCreate
    });

    return window;
  }

  applyStealthMeasures(window, type) {
    // Enhanced always-on-top enforcement for all platforms
    if (process.platform === 'darwin') {
      // macOS: Use native window level constants for maximum effectiveness
      try {
        // Try the most aggressive levels first
        const levels = [
          'screen-saver',    // Highest level
          'pop-up-menu',     // Menu level
          'modal-panel',     // Modal panel level
          'floating',        // Floating level
          'normal'           // Fallback to normal with alwaysOnTop
        ];
        
        let levelSet = false;
        for (const level of levels) {
          try {
            window.setAlwaysOnTop(true, level, 1);
            levelSet = true;
            logger.debug(`Successfully set always-on-top with level: ${level}`, { type });
            break;
          } catch (levelError) {
            logger.debug(`Failed to set level: ${level}`, { error: levelError.message });
          }
        }
        
        if (!levelSet) {
          // Final fallback
          window.setAlwaysOnTop(true);
        }
        
        // Additional macOS-specific enforcement
        setTimeout(() => {
          if (!window.isDestroyed()) {
            try {
              // Force re-application of always-on-top
              window.setAlwaysOnTop(false);
              setTimeout(() => {
                if (!window.isDestroyed()) {
                  window.setAlwaysOnTop(true, 'floating', 1);
                }
              }, 50);
            } catch (error) {
              logger.warn('Error in macOS re-enforcement', { error: error.message });
            }
          }
        }, 200);
        
      } catch (error) {
        logger.warn('Error setting always-on-top for macOS', { error: error.message });
        // Absolute fallback
        window.setAlwaysOnTop(true);
      }
    } else if (process.platform === 'win32') {
      // Windows: Multiple enforcement attempts
      window.setAlwaysOnTop(true);
      
      setTimeout(() => {
        if (!window.isDestroyed()) {
          window.setAlwaysOnTop(true);
        }
      }, 100);
      
      setTimeout(() => {
        if (!window.isDestroyed()) {
          window.setAlwaysOnTop(true);
        }
      }, 500);
      
    } else {
      // Linux and other platforms
      window.setAlwaysOnTop(true);
      
      setTimeout(() => {
        if (!window.isDestroyed()) {
          window.setAlwaysOnTop(true);
        }
      }, 100);
    }

    // Ensure window appears on all workspaces/desktops initially
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    
    // Hide from taskbar to maintain stealth
    window.setSkipTaskbar(true);
    
    // Make window undetectable by screen capture
    try {
      window.setContentProtection(true);
    } catch (error) {
      logger.debug('Content protection not supported on this platform');
    }
    
    // More aggressive event listeners to maintain always-on-top behavior
    const enforceAlwaysOnTop = () => {
      if (!window.isDestroyed()) {
        try {
          if (process.platform === 'darwin') {
            // Try multiple levels on macOS
            window.setAlwaysOnTop(true, 'floating', 1);
            setTimeout(() => {
              if (!window.isDestroyed()) {
                window.setAlwaysOnTop(true, 'screen-saver', 1);
              }
            }, 50);
          } else {
            window.setAlwaysOnTop(true);
          }
        } catch (error) {
          logger.debug('Error in enforceAlwaysOnTop', { error: error.message });
        }
      }
    };
    
    // Event-based enforcement
    window.on('blur', () => {
      setTimeout(enforceAlwaysOnTop, 50);
      setTimeout(enforceAlwaysOnTop, 200);
      setTimeout(enforceAlwaysOnTop, 500);
    });
    
    window.on('show', () => {
      setTimeout(enforceAlwaysOnTop, 50);
      setTimeout(enforceAlwaysOnTop, 200);
    });
    
    window.on('focus', () => {
      setTimeout(enforceAlwaysOnTop, 50);
    });
    
    window.on('restore', () => {
      setTimeout(enforceAlwaysOnTop, 50);
    });
    
    // Periodic enforcement every 3 seconds (more frequent)
    const periodicEnforcement = setInterval(() => {
      if (window.isDestroyed()) {
        clearInterval(periodicEnforcement);
        return;
      }
      enforceAlwaysOnTop();
    }, 3000);
    
    logger.debug('Applied enhanced stealth measures with aggressive always-on-top', {
      type,
      platform: process.platform,
      alwaysOnTop: true,
      visibleOnAllWorkspaces: true,
      skipTaskbar: true
    });
  }

  positionWindow(window, type) {
    const display = this.currentDisplay || screen.getPrimaryDisplay();
    const { x: displayX, y: displayY, width: screenWidth, height: screenHeight } = display.workArea || display.workAreaSize;
    
    if (this.bindWindows && (type === 'main' || type === 'llmResponse')) {
      // Position bound windows together
      this.positionBoundWindows();
      return;
    }
    
    // All windows positioned at top of screen with small margin
    const topMargin = 20;
    const [windowWidth] = window.getSize();
    
    const positions = {
      main: { x: displayX + 50, y: displayY + topMargin },
      chat: { x: displayX + screenWidth - windowWidth - 50, y: displayY + topMargin },
      llmResponse: { x: displayX + (screenWidth - windowWidth) / 2, y: displayY + topMargin },
      settings: { x: displayX + (screenWidth - windowWidth) / 2, y: displayY + topMargin },
      prompter: { x: displayX + Math.round((screenWidth - windowWidth) / 2), y: displayY + 12 }
    };

    const position = positions[type] || { x: displayX + 100, y: displayY + topMargin };
    window.setPosition(position.x, position.y);
    
    logger.debug('Positioned window at top', {
      type,
      position: `${position.x},${position.y}`,
      topMargin,
      display: display.id || 'primary'
    });
  }

  // Position bound windows (hub + active docked panel directly below)
  positionBoundWindows() {
    const mainWindow = this.windows.get('main');
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const display = this.currentDisplay || screen.getPrimaryDisplay();
    const { x: displayX, y: displayY, width: screenWidth, height: screenHeight } = display.workArea;

    const [mainWidth, mainHeight] = mainWindow.getSize();
    const topMargin = 20;
    const startY = displayY + topMargin;

    // Center main window horizontally if bound position not set
    let mainX = this.boundWindowsPosition?.x || (displayX + Math.round((screenWidth - mainWidth) / 2));
    let mainY = this.boundWindowsPosition?.y || startY;

    // Constrain main window
    mainX = Math.max(displayX, Math.min(displayX + screenWidth - mainWidth, mainX));
    mainY = Math.max(displayY, Math.min(displayY + screenHeight - mainHeight, mainY));
    mainWindow.setPosition(mainX, mainY);
    this.boundWindowsPosition = { x: mainX, y: mainY };

    // Docked panel directly below hub bar if active and not detached
    const dockedPanelKey = this.activePanel && !this.detached.has(this.activePanel) ? this.activePanel : null;
    if (dockedPanelKey) {
      const panelWin = this.windows.get(dockedPanelKey);
      if (panelWin && !panelWin.isDestroyed()) {
        const [panelWidth, panelHeight] = panelWin.getSize();
        let panelX = Math.round(mainX + (mainWidth - panelWidth) / 2);
        panelX = Math.max(displayX, Math.min(displayX + screenWidth - panelWidth, panelX));
        const panelY = mainY + mainHeight + this.windowGap;
        panelWin.setPosition(panelX, panelY);
      }
    }

    logger.debug('Positioned bound windows under hub', {
      mainPosition: `${mainX},${mainY}`,
      dockedPanel: dockedPanelKey,
      gap: this.windowGap
    });
  }

  // Move bound windows (maintaining active docked panel docked beneath hub)
  moveBoundWindows(deltaX, deltaY) {
    if (!this.bindWindows) return;

    const mainWindow = this.windows.get('main');
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const display = this.currentDisplay || screen.getPrimaryDisplay();
    const { x: displayX, y: displayY, width: screenWidth, height: screenHeight } = display.workArea;

    const [mainX, mainY] = mainWindow.getPosition();
    const [mainWidth, mainHeight] = mainWindow.getSize();
    const topMargin = 20;
    const minY = displayY + topMargin;

    const newMainX = Math.max(displayX, Math.min(displayX + screenWidth - mainWidth, mainX + deltaX));
    const newMainY = Math.max(minY, Math.min(displayY + screenHeight - mainHeight - 50, mainY + deltaY));

    mainWindow.setPosition(newMainX, newMainY);
    this.boundWindowsPosition = { x: newMainX, y: newMainY };

    const dockedPanelKey = this.activePanel && !this.detached.has(this.activePanel) ? this.activePanel : null;
    if (dockedPanelKey) {
      const panelWin = this.windows.get(dockedPanelKey);
      if (panelWin && !panelWin.isDestroyed()) {
        const [panelWidth, panelHeight] = panelWin.getSize();
        let panelX = Math.round(newMainX + (mainWidth - panelWidth) / 2);
        panelX = Math.max(displayX, Math.min(displayX + screenWidth - panelWidth, panelX));
        const panelY = newMainY + mainHeight + this.windowGap;
        panelWin.setPosition(panelX, panelY);
      }
    }

    logger.debug('Moved bound windows with hub', {
      delta: `${deltaX},${deltaY}`,
      newMainPosition: `${newMainX},${newMainY}`,
      dockedPanel: dockedPanelKey
    });
  }

  setActivePanel(name) {
    logger.info(`[WINDOW] setActivePanel requested: "${name}"`, {
      currentActive: this.activePanel,
      detached: Array.from(this.detached)
    });

    let panelName = name;
    if (panelName === 'chat') panelName = 'ask';
    if (panelName === 'llmResponse') panelName = 'vision';
    if (panelName === 'settings') panelName = 'params';

    // If clicking currently active docked panel, toggle it closed
    if (panelName && panelName === this.activePanel) {
      if (!this.detached.has(panelName)) {
        const win = this.windows.get(panelName);
        if (win && !win.isDestroyed()) {
          win.hide();
        }
      }
      this.activePanel = null;
      this.notifyActivePanel();
      return null;
    }

    // Hide previous docked panel (if not detached)
    if (this.activePanel && !this.detached.has(this.activePanel)) {
      const prevWin = this.windows.get(this.activePanel);
      if (prevWin && !prevWin.isDestroyed()) {
        prevWin.hide();
      }
    }

    this.activePanel = panelName || null;

    if (this.activePanel) {
      const targetWin = this.windows.get(this.activePanel);
      if (targetWin && !targetWin.isDestroyed()) {
        if (!this.detached.has(this.activePanel)) {
          this.positionBoundWindows();
        }
        this.showOnCurrentDesktop(targetWin);
      }
    }

    this.notifyActivePanel();
    return this.activePanel;
  }

  detachPanel(name) {
    let panelName = name;
    if (panelName === 'chat') panelName = 'ask';
    if (panelName === 'llmResponse') panelName = 'vision';
    if (panelName === 'settings') panelName = 'params';

    if (!panelName) return;
    this.detached.add(panelName);

    if (this.activePanel === panelName) {
      this.activePanel = null;
    }

    const win = this.windows.get(panelName);
    if (win && !win.isDestroyed()) {
      win.webContents.send('panel-detached', { detached: true, panel: panelName });
    }

    this.notifyActivePanel();
    logger.info(`[WINDOW] Panel detached: ${panelName}`);
  }

  attachPanel(name) {
    let panelName = name;
    if (panelName === 'chat') panelName = 'ask';
    if (panelName === 'llmResponse') panelName = 'vision';
    if (panelName === 'settings') panelName = 'params';

    if (!panelName) return;
    this.detached.delete(panelName);

    this.setActivePanel(panelName);

    const win = this.windows.get(panelName);
    if (win && !win.isDestroyed()) {
      win.webContents.send('panel-detached', { detached: false, panel: panelName });
    }

    this.notifyActivePanel();
    logger.info(`[WINDOW] Panel re-attached: ${panelName}`);
  }

  notifyActivePanel() {
    const mainWindow = this.windows.get('main');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('active-panel-changed', {
        activePanel: this.activePanel,
        detached: Array.from(this.detached)
      });
    }
  }

  blackout(on) {
    this.isBlackout = Boolean(on);
    this.windows.forEach((win) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('ui:blackout', this.isBlackout);
      }
    });
    logger.info(`[WINDOW] Blackout mode set to: ${this.isBlackout}`);
  }

  setPrompterInteractive(on) {
    const w = this.windows.get('prompter');
    if (w && !w.isDestroyed()) {
      w.setIgnoreMouseEvents(!on, { forward: true });
      logger.info(`[WINDOW] Prompter interactivity set to: ${on}`);
    }
  }

  async showPrompter() {
    let w = this.windows.get('prompter');
    if (!w || w.isDestroyed()) {
      w = await this.createPrompterWindow();
    }
    this.positionWindow(w, 'prompter');
    this.showOnCurrentDesktop(w);
    return w;
  }

  hidePrompter() {
    const w = this.windows.get('prompter');
    if (w && !w.isDestroyed()) {
      w.hide();
    }
  }

  async closeAllPanels() {
    for (const name of ['listen', 'vision', 'ask', 'notes', 'params', 'chat', 'llmResponse', 'settings']) {
      const w = this.windows.get(name);
      if (w && !w.isDestroyed()) {
        w.hide();
      }
    }
    this.activePanel = null;
    this.notifyActivePanel();
  }

  panicHide() {
    this._prePanicVisible = [];
    for (const [key, win] of this.windows) {
      if (win && !win.isDestroyed() && win.isVisible()) {
        this._prePanicVisible.push(key);
        win.hide();
      }
    }
    this.isPanicHidden = true;
    this.isVisible = false;
  }

  panicShow() {
    const toRestore = this._prePanicVisible && this._prePanicVisible.length > 0
      ? this._prePanicVisible
      : ['main'];
    for (const key of toRestore) {
      const win = this.windows.get(key);
      if (win && !win.isDestroyed()) {
        win.showInactive();
      }
    }
    this._prePanicVisible = null;
    this.isPanicHidden = false;
    this.isVisible = true;
  }

  togglePanic() {
    if (this.isPanicHidden) {
      this.panicShow();
    } else {
      this.panicHide();
    }
    return this.isPanicHidden;
  }

  setGlobalOpacity(level) {
    const validLevel = Math.max(0.1, Math.min(1.0, Number(level) || 1.0));
    this.currentOpacity = validLevel;
    for (const win of this.windows.values()) {
      if (win && !win.isDestroyed()) {
        try { win.setOpacity(validLevel); } catch (_) {}
      }
    }
    logger.info(`[WINDOW] Set global opacity to ${validLevel}`);
  }

  getWindow(type) {
    if (type === 'chat') return this.windows.get('ask') || this.windows.get('chat');
    if (type === 'llmResponse') return this.windows.get('vision') || this.windows.get('llmResponse');
    if (type === 'settings') return this.windows.get('params') || this.windows.get('settings');
    return this.windows.get(type);
  }

  showOnCurrentDesktop(win) {
    if (!win || win.isDestroyed()) return;

    const llmWin = this.windows.get('llmResponse');
    const isLLM = llmWin && !llmWin.isDestroyed() && win.id === llmWin.id;

    if (process.platform === 'darwin') {
      // macOS: prevent space switching and keep visibility stable
      win.hide();
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

      const setMacOSAlwaysOnTop = () => {
        if (win.isDestroyed()) return;
        try {
          win.setAlwaysOnTop(true, 'screen-saver', 2);
        } catch {
          try { win.setAlwaysOnTop(true, 'pop-up-menu', 2); }
          catch { try { win.setAlwaysOnTop(true, 'floating', 2); }
          catch { win.setAlwaysOnTop(true); }}
        }
      };

      setMacOSAlwaysOnTop();

      setTimeout(() => {
        if (win.isDestroyed()) return;
        win.show();
        win.focus();
        setMacOSAlwaysOnTop();
        setTimeout(() => { if (!win.isDestroyed()) setMacOSAlwaysOnTop(); }, 100);
        // Keep LLM window visible across workspaces; others revert
        setTimeout(() => {
          if (win.isDestroyed()) return;
          if (!isLLM) {
            win.setVisibleOnAllWorkspaces(false);
          }
          setMacOSAlwaysOnTop();
        }, 300);
      }, 50);
    } else {
      // Linux/Windows
      logger.info('[STEP-LOG] START showOnCurrentDesktop (Linux/Windows)', {
        id: win.id,
        boundsBefore: win.getBounds(),
        isVisibleBefore: win.isVisible()
      });

      logger.info('[STEP-LOG] BEFORE win.setVisibleOnAllWorkspaces(true)');
      try {
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      } catch (e) {
        logger.warn('[STEP-LOG] setVisibleOnAllWorkspaces error:', e.message);
      }
      logger.info('[STEP-LOG] AFTER win.setVisibleOnAllWorkspaces(true)');

      logger.info('[STEP-LOG] BEFORE win.setAlwaysOnTop(true)');
      win.setAlwaysOnTop(true);
      logger.info('[STEP-LOG] AFTER win.setAlwaysOnTop(true)', { isAlwaysOnTop: win.isAlwaysOnTop() });

      logger.info('[STEP-LOG] BEFORE win.show()', { isVisible: win.isVisible() });
      win.show();
      logger.info('[STEP-LOG] AFTER win.show()', { isVisible: win.isVisible() });

      logger.info('[STEP-LOG] BEFORE win.focus()', { isFocused: win.isFocused() });
      win.focus();
      logger.info('[STEP-LOG] AFTER win.focus()', { isFocused: win.isFocused() });

      // Step 8: Verify bounds and visible monitor
      const postShowBounds = win.getBounds();
      const allDisplays = screen.getAllDisplays();
      const primaryDisplay = screen.getPrimaryDisplay();
      const containingDisplay = allDisplays.find(d => {
        const db = d.bounds;
        return (
          postShowBounds.x < db.x + db.width &&
          postShowBounds.x + postShowBounds.width > db.x &&
          postShowBounds.y < db.y + db.height &&
          postShowBounds.y + postShowBounds.height > db.y
        );
      });

      logger.info('[STEP-LOG] WINDOW MONITOR & BOUNDS VERIFICATION:', {
        boundsAfterShow: postShowBounds,
        primaryDisplayBounds: primaryDisplay.bounds,
        primaryDisplayWorkArea: primaryDisplay.workArea,
        totalDisplays: allDisplays.length,
        isOnVisibleMonitor: !!containingDisplay,
        containingDisplayId: containingDisplay ? containingDisplay.id : 'NONE',
        containingDisplayBounds: containingDisplay ? containingDisplay.bounds : null
      });

      setTimeout(() => {
        if (!win.isDestroyed()) {
          win.setAlwaysOnTop(true);
        }
      }, 500);
    }

    logger.info('[STEP-LOG] COMPLETED showOnCurrentDesktop', {
      platform: process.platform,
      windowId: win.id,
      isDestroyed: win.isDestroyed(),
      isVisible: win.isVisible(),
      bounds: win.getBounds()
    });
  }
  
  setupWindowEventHandlers() {
    this.windows.forEach((window, type) => {
      window.webContents.on('did-finish-load', () => {
        logger.info(`[WEB-CONTENTS] "${type}" window loaded content`);
      });
      window.webContents.on('dom-ready', () => {
        logger.info(`[WEB-CONTENTS] "${type}" window DOM ready`);
      });

      window.on('closed', () => {
        logger.debug('Window closed', { type });
        this.windows.delete(type);
      });

      window.on('focus', () => {
        this.activeWindow = type;
        logger.debug('Window focused', { type });
      });

      // SIMPLIFIED blur handler - no aggressive re-focusing
      window.on('blur', () => {
        // Only log, don't force focus back
        logger.debug('Window blurred', { type });
      });

      window.on('show', () => {
        logger.debug('Window shown', { type });
      });

      window.on('hide', () => {
        logger.debug('Window hidden', { type });
      });

      // Handle window minimize attempts
      window.on('minimize', (event) => {
        event.preventDefault();
        logger.debug('Prevented window minimize', { type });
      });

      window.on('restore', () => {
        // Simplified restore handling
        logger.debug('Window restored', { type });
      });
    });
  }

  setupScreenCaptureAvailabilityWatcher() {
    // Avoid screencast portal errors on Linux and thread desktop errors on Windows
    if (process.platform === 'linux' || process.platform === 'win32') {
      logger.info('Skipping screen capture availability watcher on Linux/Windows to avoid desktop thread errors');
      return;
    }

    if (this.screenCaptureAvailabilityWatcher) {
      clearInterval(this.screenCaptureAvailabilityWatcher);
    }

    // This is only a capture availability probe. desktopCapturer.getSources()
    // cannot tell whether another app is currently sharing the screen.
    this.screenCaptureAvailabilityWatcher = setInterval(async () => {
      await this.checkScreenCaptureAvailability();
    }, 5000); // Check every 5 seconds instead of 1

    logger.info('Screen capture availability watcher initialized');
  }

  async checkScreenCaptureAvailability() {
    if (this.isCheckingScreenCaptureStatus) {
      logger.debug('Skipping overlapping screen capture availability check');
      return;
    }

    this.isCheckingScreenCaptureStatus = true;
    const previousAvailability = this.screenCaptureStatus.available;
    const checkedAt = new Date().toISOString();

    try {
      await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 1, height: 1 }
      });

      this.screenCaptureStatus = {
        available: true,
        lastError: null,
        lastCheckedAt: checkedAt
      };

      if (previousAvailability === false) {
        logger.info('Screen capture enumeration recovered');
      }
    } catch (error) {
      this.screenCaptureStatus = {
        available: false,
        lastError: error.message,
        lastCheckedAt: checkedAt
      };

      const logContext = {
        error: error.message,
        isScreenBeingShared: this.isScreenBeingShared
      };

      if (previousAvailability === false) {
        logger.debug('Screen capture enumeration still unavailable', logContext);
      } else {
        logger.warn('Screen capture enumeration unavailable; leaving screen sharing mode unchanged', logContext);
      }
    } finally {
      this.isCheckingScreenCaptureStatus = false;
    }
  }

  startScreenSharingMode() {
    if (!this.isScreenBeingShared) {
      this.isScreenBeingShared = true;
      this.wasVisibleBeforeSharing = this.isVisible;
      this.handleScreenSharingStarted();
    }
  }

  stopScreenSharingMode() {
    if (this.isScreenBeingShared) {
      this.isScreenBeingShared = false;
      this.handleScreenSharingStopped();
    }
  }

  handleScreenSharingStarted() {
    logger.info('Screen sharing mode enabled - hiding windows');
    
    this.windows.forEach((window, type) => {
      if (!window.isDestroyed()) {
        window.hide();
        window.setPosition(-10000, -10000);
      }
    });
  }

  handleScreenSharingStopped() {
    logger.info('Screen sharing mode disabled - restoring windows');
    
    if (this.wasVisibleBeforeSharing) {
      this.moveWindowsToActiveScreen();
      this.showAllWindows();
    }
  }

  async switchToWindow(windowType) {
    const chatWin = this.windows.get('chat');
    logger.info(`[WINDOW] switchToWindow entered for type: "${windowType}"`, {
      windowType,
      'this.windows.has("chat")': this.windows.has('chat'),
      'this.windows.get("chat") exists': !!chatWin,
      'isDestroyed()': chatWin ? chatWin.isDestroyed() : 'N/A',
      'isVisible()': chatWin && !chatWin.isDestroyed() ? chatWin.isVisible() : 'N/A',
      'bounds': chatWin && !chatWin.isDestroyed() ? chatWin.getBounds() : 'N/A',
      'isScreenBeingShared': this.isScreenBeingShared
    });

    if (this.windows.has('chat') && this.windows.get('chat') && !this.windows.get('chat').isDestroyed() && this.windows.get('chat').isVisible() && windowType === 'chat') {
      logger.info(`[WINDOW] chat window is currently visible, hiding it for toggle test`);
      this.hideChatWindow();
      return;
    }

    if (!this.windowConfigs[windowType]) {
      logger.warn('Attempted to switch to unknown window type', { windowType });
      return;
    }

    if (this.isScreenBeingShared) {
      logger.warn('[WINDOW] Screen is being shared, skipping switchToWindow');
      return;
    }

    let targetWindow = this.windows.get(windowType);
    if ((!targetWindow || targetWindow.isDestroyed()) && windowType === 'chat') {
      logger.info('[WINDOW] Chat window missing or destroyed, recreating...');
      targetWindow = await this.createChatWindow();
    }

    if (targetWindow && !targetWindow.isDestroyed()) {
      logger.info(`[WINDOW] targetWindow "${windowType}" found. Bounds before show:`, targetWindow.getBounds());
      logger.info(`[STEP-LOG] BEFORE calling showOnCurrentDesktop("${windowType}")`);
      this.showOnCurrentDesktop(targetWindow);
      logger.info(`[STEP-LOG] AFTER calling showOnCurrentDesktop("${windowType}")`);

      this.activeWindow = windowType;
      
      logger.info('Switched to window successfully', {
        windowType,
        isVisible: this.isVisible,
        targetBounds: targetWindow.getBounds(),
        targetIsVisible: targetWindow.isVisible(),
        targetIsAlwaysOnTop: targetWindow.isAlwaysOnTop()
      });
    } else {
      logger.error(`[WINDOW] targetWindow "${windowType}" not found in this.windows!`);
    }
  }

  // Step 5: Temporary test that completely bypasses existing window-management logic
  testDirectChatShow() {
    const chatWindow = this.windows.get('chat');
    if (!chatWindow || chatWindow.isDestroyed()) {
      logger.error('[BYPASS-TEST] chatWindow does not exist or is destroyed!');
      return;
    }
    logger.info('[BYPASS-TEST] Step 5: Starting Direct chatWindow show/focus/setAlwaysOnTop test');
    logger.info('[BYPASS-TEST] BEFORE chatWindow.show()', { isVisible: chatWindow.isVisible(), bounds: chatWindow.getBounds() });
    chatWindow.show();
    logger.info('[BYPASS-TEST] AFTER chatWindow.show()', { isVisible: chatWindow.isVisible(), bounds: chatWindow.getBounds() });

    logger.info('[BYPASS-TEST] BEFORE chatWindow.focus()', { isFocused: chatWindow.isFocused() });
    chatWindow.focus();
    logger.info('[BYPASS-TEST] AFTER chatWindow.focus()', { isFocused: chatWindow.isFocused() });

    logger.info('[BYPASS-TEST] BEFORE chatWindow.setAlwaysOnTop(true)', { isAlwaysOnTop: chatWindow.isAlwaysOnTop() });
    chatWindow.setAlwaysOnTop(true);
    logger.info('[BYPASS-TEST] AFTER chatWindow.setAlwaysOnTop(true)', { isAlwaysOnTop: chatWindow.isAlwaysOnTop() });
  }

  // Step 6: Temporary test for chatWindow.showInactive()
  testChatShowInactive() {
    const chatWindow = this.windows.get('chat');
    if (!chatWindow || chatWindow.isDestroyed()) {
      logger.error('[BYPASS-TEST] chatWindow does not exist or is destroyed for showInactive!');
      return;
    }
    logger.info('[BYPASS-TEST] Step 6: Starting Direct chatWindow.showInactive() test');
    logger.info('[BYPASS-TEST] BEFORE chatWindow.showInactive()', { isVisible: chatWindow.isVisible(), bounds: chatWindow.getBounds() });
    chatWindow.showInactive();
    logger.info('[BYPASS-TEST] AFTER chatWindow.showInactive()', { isVisible: chatWindow.isVisible(), bounds: chatWindow.getBounds() });
  }

  showAllWindows() {
    if (this.isScreenBeingShared) {
      return;
    }

    this.windows.forEach((window, type) => {
      if (type !== 'llmResponse') { // Don't show LLM response unless it has content
        this.showOnCurrentDesktop(window);
      }
    });
    
    this.isVisible = true;
    const activeWindow = this.windows.get(this.activeWindow);
    if (activeWindow) {
      activeWindow.focus();
    }
    
    logger.info('All windows shown on current desktop', { 
      activeWindow: this.activeWindow,
      windowCount: this.windows.size 
    });
  }

  hideAllWindows() {
    this.windows.forEach((window, type) => {
      if (type !== 'llmResponse') {
        window.hide();
      }
    });
    
    this.isVisible = false;
    logger.info('All windows hidden');
  }

  toggleVisibility() {
    if (this.isScreenBeingShared) {
      return this.isVisible;
    }

    if (this.isVisible) {
      this.hideAllWindows();
    } else {
      this.showAllWindows();
    }
    
    return this.isVisible;
  }

  setInteractive(interactive) {
    this.isInteractive = interactive;
    
    this.windows.forEach((window, type) => {
      if (!window.isDestroyed()) {
        if (type === 'prompter') {
          // Prompter maintains its own click-through state via setPrompterInteractive
          return;
        }
        if (interactive) {
          // Interactive mode: allow mouse events for all windows
          window.setIgnoreMouseEvents(false);
        } else {
          // Non-interactive mode: enable click-through with forwarding for all windows
          window.setIgnoreMouseEvents(true, { forward: true });
        }
        window.webContents.send('interaction-mode-changed', interactive);
      }
    });
    
    logger.info('Window interaction mode changed', { 
      interactive,
      clickThrough: !interactive,
      affectedWindows: Array.from(this.windows.keys())
    });
  }

  toggleInteraction() {
    this.setInteractive(!this.isInteractive);
    
    // Ensure all windows remain always-on-top after interaction mode change
    this.enforceAlwaysOnTopForAllWindows();
    
    return this.isInteractive;
  }

  // New method to enforce always-on-top for all windows
  enforceAlwaysOnTopForAllWindows() {
    this.windows.forEach((window, type) => {
      if (!window.isDestroyed()) {
        try {
          if (process.platform === 'darwin') {
            // Try multiple levels for macOS
            window.setAlwaysOnTop(true, 'pop-up-menu', 1);
            
            setTimeout(() => {
              if (!window.isDestroyed()) {
                window.setAlwaysOnTop(true, 'floating', 1);
              }
            }, 100);
            
            setTimeout(() => {
              if (!window.isDestroyed()) {
                window.setAlwaysOnTop(true, 'screen-saver', 1);
              }
            }, 200);
          } else {
            // Windows and Linux
            window.setAlwaysOnTop(true);
            
            // Additional enforcement after a short delay
            setTimeout(() => {
              if (!window.isDestroyed()) {
                window.setAlwaysOnTop(true);
              }
            }, 100);
          }
        } catch (error) {
          logger.warn('Error enforcing always-on-top', { 
            type, 
            error: error.message 
          });
          // Fallback to basic always-on-top
          try {
            window.setAlwaysOnTop(true);
          } catch (fallbackError) {
            logger.error('Fallback always-on-top failed', { 
              type, 
              error: fallbackError.message 
            });
          }
        }
      }
    });
    
    logger.debug('Enforced always-on-top for all windows with aggressive strategy', {
      platform: process.platform,
      windowCount: this.windows.size
    });
  }

  // Public method to manually enforce always-on-top for all windows
  forceAlwaysOnTopForAllWindows() {
    this.enforceAlwaysOnTopForAllWindows();
    logger.info('Manually enforced always-on-top for all windows');
  }

  // Debug method to test and verify always-on-top functionality
  testAlwaysOnTopForAllWindows() {
    const results = {};
    
    this.windows.forEach((window, type) => {
      if (!window.isDestroyed()) {
        try {
          const isAlwaysOnTop = window.isAlwaysOnTop();
          
          if (process.platform === 'darwin') {
            // Test different levels on macOS
            window.setAlwaysOnTop(true, 'screen-saver', 2);
            setTimeout(() => {
              if (!window.isDestroyed()) {
                window.setAlwaysOnTop(true, 'pop-up-menu', 2);
                setTimeout(() => {
                  if (!window.isDestroyed()) {
                    window.setAlwaysOnTop(true, 'floating', 2);
                  }
                }, 50);
              }
            }, 50);
          } else {
            // For other platforms
            window.setAlwaysOnTop(true);
            setTimeout(() => {
              if (!window.isDestroyed()) {
                window.setAlwaysOnTop(true);
              }
            }, 50);
          }
          
          results[type] = {
            success: true,
            isAlwaysOnTop: isAlwaysOnTop,
            isVisible: window.isVisible(),
            isDestroyed: window.isDestroyed()
          };
          
        } catch (error) {
          results[type] = {
            success: false,
            error: error.message,
            isDestroyed: window.isDestroyed()
          };
        }
      } else {
        results[type] = {
          success: false,
          error: 'Window is destroyed'
        };
      }
    });
    
    logger.info('Always-on-top test results', { 
      platform: process.platform,
      results 
    });
    
    return results;
  }

  showLLMResponse(content, metadata = {}) {
    logger.debug('showLLMResponse called', {
      isScreenBeingShared: this.isScreenBeingShared,
      contentLength: content.length,
      skill: metadata.skill
    });

    if (this.isScreenBeingShared) {
      logger.warn('LLM response blocked due to screen sharing mode');
      return;
    }

    const llmWindow = this.windows.get('llmResponse');
    if (!llmWindow) {
      logger.error('LLM response window not available');
      return;
    }

    // Ensure window is not destroyed before use
    if (llmWindow.isDestroyed()) {
      logger.error('LLM response window is destroyed');
      return;
    }

    logger.debug('Sending display-llm-response event to window');
    llmWindow.webContents.send('display-llm-response', {
      content,
      metadata,
      timestamp: new Date().toISOString()
    });
    
    // If the Ask panel is active and this is a typed chat query, don't displace Ask with Vision
    if (this.activePanel === 'ask' && !metadata.isImageAnalysis) {
      logger.debug('Ask panel is currently active; keeping Ask visible');
      return;
    }

    logger.debug('Showing and focusing LLM window');
    this.showOnCurrentDesktop(llmWindow);
    
    // Position bound windows when LLM response is shown
    if (this.bindWindows) {
      this.positionBoundWindows();
    }
        
    logger.info('LLM response displayed', {
      contentLength: content.length,
      skill: metadata.skill,
      windowVisible: llmWindow.isVisible(),
      boundWindows: this.bindWindows
    });
  }

  showLLMLoading() {
    if (this.isScreenBeingShared) {
      logger.warn('LLM loading blocked due to screen sharing mode');
      return;
    }

    const llmWindow = this.windows.get('llmResponse');
    if (llmWindow) {
      logger.debug('Showing LLM loading state');
      llmWindow.webContents.send('show-loading');
      this.showOnCurrentDesktop(llmWindow);
      
      // Position bound windows when LLM loading is shown
      if (this.bindWindows) {
        this.positionBoundWindows();
      }
      
      logger.debug('LLM loading window shown');
    } else {
      logger.error('LLM window not available for loading state');
    }
  }

  hideLLMResponse() {
    const llmWindow = this.windows.get('llmResponse');
    if (llmWindow) {
      llmWindow.hide();
    }
  }

  showSettings() {
    if (this.isScreenBeingShared) return;

    const settingsWindow = this.windows.get('settings');
    if (settingsWindow) {
      this.showOnCurrentDesktop(settingsWindow);
      this.centerWindow(settingsWindow); // This now positions at top-center
      
      // Notify that settings window is shown
      setTimeout(() => {
        settingsWindow.webContents.send('settings-window-shown');
      }, 50);
      
      logger.info('Settings window displayed at top');
    }
  }

  hideSettings() {
    const settingsWindow = this.windows.get('settings');
    if (settingsWindow) {
      settingsWindow.hide();
    }
  }

  async showOnboarding() {
    if (this.isScreenBeingShared) return null;

    let onboardingWindow = this.windows.get('onboarding');
    if (!onboardingWindow) {
      onboardingWindow = await this.createWindow('onboarding');
      this.windows.set('onboarding', onboardingWindow);

      // Once the wizard renderer signals it's ready, send it the
      // current first-run status so it can pre-populate correctly.
      onboardingWindow.webContents.once('did-finish-load', () => {
        logger.info('Onboarding window loaded');
      });
    }

    this.showOnCurrentDesktop(onboardingWindow);
    this.centerWindow(onboardingWindow);
    onboardingWindow.focus();
    logger.info('Onboarding window displayed');
    return onboardingWindow;
  }

  hideOnboarding() {
    const onboardingWindow = this.windows.get('onboarding');
    if (onboardingWindow) {
      onboardingWindow.hide();
    }
  }

  closeOnboarding() {
    const onboardingWindow = this.windows.get('onboarding');
    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      onboardingWindow.close();
    }
    this.windows.delete('onboarding');
  }

  expandLLMWindow(contentMetrics = null) {
    const llmWindow = this.windows.get('llmResponse');
    if (!llmWindow || this.isScreenBeingShared) return;

    const optimalSize = this.calculateOptimalWindowSize(contentMetrics);
    
    // Ensure we have valid numbers for setSize
    const width = Math.round(Number(optimalSize.width)) || 840;
    const height = Math.round(Number(optimalSize.height)) || 480;
    
    llmWindow.setSize(width, height);
    
    // If windows are bound, position them together; otherwise center the LLM window
    if (this.bindWindows) {
      this.positionBoundWindows();
    } else {
      this.centerWindow(llmWindow);
    }
    
    logger.debug('LLM window resized', { 
      newSize: `${width}x${height}`,
      basedOnContent: !!contentMetrics,
      boundWindows: this.bindWindows
    });
  }

  calculateOptimalWindowSize(contentMetrics) {
    const display = this.currentDisplay || screen.getPrimaryDisplay();
    const { width: screenWidth, height: screenHeight } = display.workArea || display.workAreaSize;
    
    let width = 840; // Default LLM window width
    let height = 480; // Default LLM window height
    
    if (contentMetrics && typeof contentMetrics === 'object') {
      const lineCount = Number(contentMetrics.lineCount) || 20;
      const avgLineLength = Number(contentMetrics.avgLineLength) || 80;
      
      width = Math.min(Math.max(avgLineLength * 8, 500), screenWidth * 0.8);
      height = Math.min(Math.max(lineCount * 25 + 100, 300), screenHeight * 0.8);
    }
    
    return { 
      width: Math.round(Number(width)) || 840, 
      height: Math.round(Number(height)) || 480 
    };
  }

  centerWindow(window) {
    const display = this.currentDisplay || screen.getPrimaryDisplay();
    const { x: displayX, y: displayY, width: screenWidth, height: screenHeight } = display.workArea || display.workAreaSize;
    const [windowWidth, windowHeight] = window.getSize();
    
    // Center horizontally but position at top
    const topMargin = 20;
    const x = displayX + Math.round((screenWidth - windowWidth) / 2);
    const y = displayY + topMargin;
    
    window.setPosition(x, y);
    
    logger.debug('Positioned window at top-center', {
      position: `${x},${y}`,
      topMargin,
      display: display.id || 'primary'
    });
  }

  broadcastToAllWindows(channel, data) {
    const windowStates = {};
    
    this.windows.forEach((window, type) => {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, data);
        windowStates[type] = {
          isVisible: window.isVisible(),
          isDestroyed: window.isDestroyed(),
          hasWebContents: !!window.webContents
        };
      } else {
        windowStates[type] = { isDestroyed: true };
      }
    });
    
    logger.info('Broadcast sent to all windows', { 
      channel, 
      windowCount: this.windows.size,
      windowStates,
      dataKeys: data ? Object.keys(data) : [],
      // Fixed: Check for 'content' instead of 'response' to match actual data structure
      dataPreview: data && data.content ? data.content.substring(0, 50) + '...' : 
                   data && data.response ? data.response.substring(0, 50) + '...' : 'No response'
    });
  }

  getWindow(type) {
    return this.windows.get(type);
  }

  getActiveWindow() {
    return this.windows.get(this.activeWindow);
  }

  getWindowStats() {
    const stats = {};
    
    this.windows.forEach((window, type) => {
      stats[type] = {
        isVisible: window.isVisible(),
        isFocused: window.isFocused(),
        position: window.getPosition(),
        size: window.getSize()
      };
    });
    
    return {
      windows: stats,
      activeWindow: this.activeWindow,
      isInteractive: this.isInteractive,
      isVisible: this.isVisible,
      isScreenBeingShared: this.isScreenBeingShared,
      screenCaptureStatus: { ...this.screenCaptureStatus }
    };
  }

  destroyAllWindows() {
    this.windows.forEach((window, type) => {
      logger.debug('Destroying window', { type });
      if (!window.isDestroyed()) {
        window.destroy();
      }
    });
    
    this.windows.clear();
    
    // Clean up all watchers
    if (this.screenWatcher) {
      clearInterval(this.screenWatcher);
      this.screenWatcher = null;
    }
    
    if (this.desktopWatcher) {
      clearInterval(this.desktopWatcher);
      this.desktopWatcher = null;
    }

    if (this.screenCaptureAvailabilityWatcher) {
      clearInterval(this.screenCaptureAvailabilityWatcher);
      this.screenCaptureAvailabilityWatcher = null;
    }
    
    logger.info('All windows destroyed');
  }

  setupScreenTracking() {
    // Initialize with current cursor position or fallback safely to primary display
    let cursorPoint = null;
    try {
      cursorPoint = screen.getCursorScreenPoint();
      if (cursorPoint && typeof cursorPoint.x === 'number' && Math.abs(cursorPoint.x) < 50000 && Math.abs(cursorPoint.y) < 50000) {
        this.currentDisplay = screen.getDisplayNearestPoint(cursorPoint);
      } else {
        this.currentDisplay = screen.getPrimaryDisplay();
      }
    } catch (_) {
      this.currentDisplay = screen.getPrimaryDisplay();
    }
    
    screen.on('display-added', () => {
      logger.info('[WINDOW] Display added - auto-hiding for stealth');
      this.panicHide();
      this.handleDisplayChange();
    });

    screen.on('display-removed', () => {
      logger.debug('Display removed');
      this.handleDisplayChange();
    });

    if (powerMonitor) {
      try {
        powerMonitor.on('lock-screen', () => {
          logger.info('[WINDOW] Screen locked, triggering panic hide');
          this.panicHide();
        });
        powerMonitor.on('suspend', () => {
          logger.info('[WINDOW] System suspend, triggering panic hide');
          this.panicHide();
        });
      } catch (err) {
        logger.warn('[WINDOW] Could not attach powerMonitor listeners', { error: err.message });
      }
    }

    screen.on('display-metrics-changed', () => {
      logger.debug('Display metrics changed');
      this.handleDisplayChange();
    });

    // More frequent tracking during initialization
    this.screenWatcher = setInterval(() => {
      this.trackActiveScreen();
    }, 2000);

    // SIMPLIFIED desktop tracking
    this.setupDesktopTracking();

    logger.info('Screen and desktop tracking initialized', {
      currentDisplay: this.currentDisplay.id,
      cursorPosition: cursorPoint
    });
  }

  handleDisplayChange() {
    setTimeout(() => {
      this.moveWindowsToActiveScreen();
    }, 500);
  }

  trackActiveScreen() {
    if (this.isScreenBeingShared) return;

    let cursorPoint = null;
    try {
      cursorPoint = screen.getCursorScreenPoint();
      if (!cursorPoint || typeof cursorPoint.x !== 'number' || Math.abs(cursorPoint.x) > 50000 || Math.abs(cursorPoint.y) > 50000) {
        return;
      }
    } catch (_) {
      return;
    }
    const activeDisplay = screen.getDisplayNearestPoint(cursorPoint);
    
    if (!this.currentDisplay || (activeDisplay && activeDisplay.id !== this.currentDisplay.id)) {
      this.currentDisplay = activeDisplay;
      this.moveWindowsToActiveScreen();
      
      logger.debug('Active screen changed', {
        displayId: activeDisplay.id,
        bounds: activeDisplay.bounds
      });
    }
  }

  moveWindowsToActiveScreen() {
    if (!this.currentDisplay || this.isScreenBeingShared) return;

    const { x: displayX, y: displayY, width: displayWidth, height: displayHeight } = this.currentDisplay.workArea;
    
    // Handle bound windows specially
    if (this.bindWindows) {
      const mainWindow = this.windows.get('main');
      const llmWindow = this.windows.get('llmResponse');
      
      if (mainWindow && llmWindow && !mainWindow.isDestroyed() && !llmWindow.isDestroyed()) {
        // Position bound windows on the new screen and ensure they appear on current desktop
        this.positionBoundWindows();
        if (mainWindow.isVisible()) this.showOnCurrentDesktop(mainWindow);
        if (llmWindow.isVisible()) this.showOnCurrentDesktop(llmWindow);
      }
    }
    
    this.windows.forEach((window, type) => {
      if (window && !window.isDestroyed()) {
        // Skip main and llmResponse if they're bound (already handled above)
        if (this.bindWindows && (type === 'main' || type === 'llmResponse')) {
          return;
        }
        
        const [windowWidth, windowHeight] = window.getSize();
        
        let newX, newY;
        
        // All windows positioned at top of screen
        const topMargin = 20;
        
        switch (type) {
          case 'main':
            newX = displayX + 50;
            newY = displayY + topMargin;
            break;
          case 'chat':
            newX = displayX + displayWidth - windowWidth - 50;
            newY = displayY + topMargin;
            break;
          case 'skills':
            newX = displayX + 50;
            newY = displayY + topMargin + 100; // Slightly lower to avoid overlap
            break;
          case 'llmResponse':
            newX = displayX + (displayWidth - windowWidth) / 2;
            newY = displayY + topMargin;
            break;
          case 'settings':
            newX = displayX + (displayWidth - windowWidth) / 2;
            newY = displayY + topMargin;
            break;
          default:
            newX = displayX + 100;
            newY = displayY + topMargin;
        }
        
        window.setPosition(Math.round(newX), Math.round(newY));
        
        // Ensure always-on-top is maintained after moving
        if (process.platform === 'darwin') {
          window.setAlwaysOnTop(true, 'screen-saver', 1);
        } else {
          window.setAlwaysOnTop(true);
        }
        
        // Ensure window appears on current desktop if it's visible
        if (window.isVisible()) {
          this.showOnCurrentDesktop(window);
        }
        
        logger.debug('Window moved to active screen and shown on current desktop', {
          type,
          position: `${newX},${newY}`,
          isVisible: window.isVisible(),
          displayId: this.currentDisplay.id
        });
      }
    });
  }

  setupDesktopTracking() {
    // MUCH less aggressive desktop tracking
    this.desktopWatcher = setInterval(() => {
      this.trackDesktopChanges();
    }, 10000); // Changed from 1500ms to 10000ms (10 seconds)

    logger.info('Desktop tracking initialized');
  }

  trackDesktopChanges() {
    if (this.isScreenBeingShared) return;

    // Simplified tracking - just log changes
    if (process.platform === 'darwin') {
      const cursorPoint = screen.getCursorScreenPoint();
      const currentSpaceSignature = `${cursorPoint.x}_${cursorPoint.y}`;
      
      if (this.lastActiveSpace && this.lastActiveSpace !== currentSpaceSignature) {
        logger.debug('Desktop space might have changed');
      }
      
      this.lastActiveSpace = currentSpaceSignature;
    }
  }

  // REMOVED all the aggressive enforcement methods that were causing flickering:
  // - handlePossibleSpaceChange()
  // - handleSpaceChange() 
  // - ensureWindowVisibility()
  // - enforceWindowProperties()
  // - enforceAllWindowProperties()
  // - enforceAlwaysOnTop()

  // Public methods for manual screen sharing control
  enableScreenSharingMode() {
    this.startScreenSharingMode();
  }

  disableScreenSharingMode() {
    this.stopScreenSharingMode();
  }

  isInScreenSharingMode() {
    return this.isScreenBeingShared;
  }

  // Window binding management methods
  setWindowBinding(enabled) {
    this.bindWindows = enabled;
    
    if (enabled) {
      // Position bound windows when binding is enabled
      const mainWindow = this.windows.get('main');
      const llmWindow = this.windows.get('llmResponse');
      
      if (mainWindow && llmWindow) {
        this.positionBoundWindows();
      }
      
      logger.info('Window binding enabled');
    } else {
      logger.info('Window binding disabled');
    }
    
    return this.bindWindows;
  }

  toggleWindowBinding() {
    return this.setWindowBinding(!this.bindWindows);
  }

  getWindowBindingStatus() {
    return {
      enabled: this.bindWindows,
      gap: this.windowGap,
      position: this.boundWindowsPosition
    };
  }

  setWindowGap(gap) {
    this.windowGap = Math.max(0, gap);
    
    // Re-position if currently bound
    if (this.bindWindows) {
      this.positionBoundWindows();
    }
    
    logger.debug('Window gap updated', { gap: this.windowGap });
    return this.windowGap;
  }

  showChatWindow() {
    const chatWindow = this.windows.get('chat');
    if (chatWindow && !chatWindow.isDestroyed()) {
      this.showOnCurrentDesktop(chatWindow);
      logger.debug('Chat window shown');
    }
  }

  hideChatWindow() {
    const chatWindow = this.windows.get('chat');
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.hide();
      logger.debug('Chat window hidden');
    }
  }

  handleRecordingStarted() {
    this.isRecording = true;
    this.showChatWindow();
    // Notify all windows about recording state
    this.broadcastToAllWindows('recording-started');
    logger.debug('Recording started, chat window shown');
  }

  handleRecordingStopped() {
    this.isRecording = false;
    this.hideChatWindow();
    // Notify all windows about recording state
    this.broadcastToAllWindows('recording-stopped');
    logger.debug('Recording stopped, chat window hidden');
  }

  broadcastSkillChange(skill) {
    this.windows.forEach((window, type) => {
      if (!window.isDestroyed()) {
        window.webContents.send('skill-changed', { skill });
      }
    });
    
    logger.info('Skill change broadcasted to all windows', { 
      skill,
      windowCount: this.windows.size 
    });
    }
}

module.exports = new WindowManager();
