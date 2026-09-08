// Simple logger for renderer process
const logger = {
    info: (...args) => console.log('[MainWindowUI]', ...args),
    debug: (...args) => console.log('[MainWindowUI DEBUG]', ...args),
    error: (...args) => console.error('[MainWindowUI ERROR]', ...args),
    warn: (...args) => console.warn('[MainWindowUI WARN]', ...args)
};

class MainWindowUI {
    constructor() {
        this.isInteractive = false;
        this.isHidden = false;
        this.currentSkill = 'dsa'; // Default, will be updated from settings
        this.statusDot = null;
        this.skillIndicator = null;
        this.micButton = null;
        this.isRecording = false;
        this.speechAvailable = false; // track availability
        this._popoverHideTimeout = null;
        // Renderer-side audio capture state (used for Whisper on Windows)
        this._audioContext = null;
        this._mediaStream = null;
        this._scriptNode = null;
        this._captureInterval = null;
        
        // Define available skills for navigation (including auto)
        this.availableSkills = [
            'auto',
            'dsa',
            'system-design',
            'behavioral',
            'tech-qa',
            'general'
        ];
        this.isSkillLocked = false;
        
        this.init();
    }

    async init() {
        try {
            this.setupElements();
            this.setupEventListeners();
            
            // Load available skills dynamically
            try {
                if (window.electronAPI && window.electronAPI.getSkills) {
                    const skills = await window.electronAPI.getSkills();
                    if (Array.isArray(skills) && skills.length > 0) {
                        const ids = skills.map(s => typeof s === 'string' ? s : s.id);
                        this.availableSkills = ['auto', ...ids];
                    }
                }
            } catch (e) {
                logger.warn('Failed to fetch available skills', e);
            }

            // Load current skill from settings
            await this.loadCurrentSkill();
            
            // Load current interaction state
            await this.loadCurrentInteractionState();
            
            // Fetch speech availability
            await this.loadSpeechAvailability();

            // Load current interview mode state
            if (window.electronAPI && window.electronAPI.getInterviewMode) {
                try {
                    const active = await window.electronAPI.getInterviewMode();
                    this.handleInterviewModeChanged(active);
                } catch (_) {}
            }
            
            this.updateSkillIndicator();
            this.updateAllElementStates(); // Update all elements with current state
            this.resizeWindowToContent();
            
            logger.info('Main window UI initialized', {
                component: 'MainWindowUI',
                skill: this.currentSkill,
                interactive: this.isInteractive
            });

            // Notify the main process that the overlay renderer is ready
            // so it can push the latest speech availability state.
            if (window.electronAPI && window.electronAPI.notifyMainWindowReady) {
                window.electronAPI.notifyMainWindowReady();
            }
            
        } catch (error) {
            logger.error('Failed to initialize main window UI', {
                component: 'MainWindowUI',
                error: error.message
            });
        }
    }

    async loadCurrentSkill() {
        try {
            if (window.electronAPI && window.electronAPI.getSettings) {
                const settings = await window.electronAPI.getSettings();
                if (settings && settings.activeSkill) {
                    this.currentSkill = settings.activeSkill;
                    logger.debug('Loaded current skill from settings', {
                        component: 'MainWindowUI',
                        skill: this.currentSkill
                    });
                }
            }
        } catch (error) {
            logger.warn('Failed to load current skill from settings', {
                component: 'MainWindowUI',
                error: error.message
            });
        }
    }

    async loadCurrentInteractionState() {
        try {
            // Request current interaction state from main process
            if (window.electronAPI && window.electronAPI.getWindowStats) {
                const stats = await window.electronAPI.getWindowStats();
                if (stats && typeof stats.isInteractive === 'boolean') {
                    this.isInteractive = stats.isInteractive;
                    logger.debug('Loaded current interaction state', {
                        component: 'MainWindowUI',
                        interactive: this.isInteractive
                    });
                }
            }
        } catch (error) {
            // If we can't get the state, assume non-interactive (safer default)
            this.isInteractive = false;
            logger.warn('Failed to load current interaction state, defaulting to non-interactive', {
                component: 'MainWindowUI',
                error: error.message
            });
        }
    }

    async loadSpeechAvailability() {
        try {
            if (window.electronAPI && window.electronAPI.getSpeechAvailability) {
                this.speechAvailable = await window.electronAPI.getSpeechAvailability();
                this.applyMicVisibility();
            }
        } catch (e) {
            this.speechAvailable = false;
            this.applyMicVisibility();
        }
    }

    applyMicVisibility() {
        if (this.micButton) {
            if (this.speechAvailable) {
                this.micButton.style.display = '';
            } else {
                this.micButton.style.display = 'none';
            }
            // Resize to reflect layout change
            setTimeout(() => this.resizeWindowToContent(), 50);
        }
    }

    updateAllElementStates() {
        // Update all interactive elements with current state
        this.updateStatusDot();
        this.updateSkillIndicatorState();
        this.updateMicButtonState();
        this.updateSettingsIndicatorState();
    }

    updateStatusDot() {
        if (this.statusDot) {
            logger.debug('Updating status dot', {
                component: 'MainWindowUI',
                isInteractive: this.isInteractive,
                currentClasses: this.statusDot.className
            });
            
            // Remove both classes first
            this.statusDot.classList.remove('interactive', 'non-interactive');
            
            // Add the appropriate class
            if (this.isInteractive) {
                this.statusDot.classList.add('interactive');
            } else {
                this.statusDot.classList.add('non-interactive');
            }
            
            logger.debug('Status dot updated', {
                component: 'MainWindowUI',
                interactive: this.isInteractive,
                newClasses: this.statusDot.className
            });
        } else {
            logger.error('Status dot element not found');
        }
    }

    updateSkillIndicatorState() {
        if (this.skillIndicator) {
            // Remove both classes first
            this.skillIndicator.classList.remove('interactive', 'non-interactive');
            
            // Add the appropriate class
            if (this.isInteractive) {
                this.skillIndicator.classList.add('interactive');
            } else {
                this.skillIndicator.classList.add('non-interactive');
            }
            
            logger.debug('Skill indicator state updated', {
                component: 'MainWindowUI',
                interactive: this.isInteractive,
                classes: this.skillIndicator.className
            });
        }
    }

    updateMicButtonState() {
        if (this.micButton) {
            // Also hide when unavailable
            this.applyMicVisibility();
            // Remove both classes first
            this.micButton.classList.remove('interactive', 'non-interactive');
            
            // Add the appropriate class
            if (this.isInteractive) {
                this.micButton.classList.add('interactive');
            } else {
                this.micButton.classList.add('non-interactive');
            }
            
            // Update button state
            this.micButton.disabled = !this.isInteractive;
            
            logger.debug('Mic button state updated', {
                component: 'MainWindowUI',
                interactive: this.isInteractive,
                disabled: !this.isInteractive
            });
        }
    }

    updateSettingsIndicatorState() {
        if (this.settingsIndicator) {
            // Remove both classes first
            this.settingsIndicator.classList.remove('interactive', 'non-interactive');
            
            // Add the appropriate class
            if (this.isInteractive) {
                this.settingsIndicator.classList.add('interactive');
            } else {
                this.settingsIndicator.classList.add('non-interactive');
            }
            
            logger.debug('Settings indicator state updated', {
                component: 'MainWindowUI',
                interactive: this.isInteractive
            });
        } else {
            logger.debug('Settings indicator not found, skipping state update');
        }
    }

    resizeWindowToContent() {
        // Wait for DOM to fully render
        setTimeout(() => {
            const hubElement = document.getElementById('hub') || document.querySelector('.hub') || document.querySelector('.command-tab');
            if (hubElement && window.electronAPI && window.electronAPI.resizeWindow) {
                const rect = hubElement.getBoundingClientRect();
                const width = Math.max(760, Math.ceil(rect.width + 24));
                let height = Math.max(44, Math.ceil(rect.height + 4));

                // If shortcuts popover is visible, extend height to fit it
                if (this.shortcutsPopover && (this.shortcutsPopover.classList.contains('is-open') || this.shortcutsPopover.classList.contains('show'))) {
                    const popRect = this.shortcutsPopover.getBoundingClientRect();
                    height = Math.max(height, Math.ceil(36 + popRect.height + 12));
                }
                
                logger.debug('Resizing window to content', {
                    width,
                    height,
                    component: 'MainWindowUI'
                });
                
                window.electronAPI.resizeWindow(width, height);
            }
        }, 100);
    }

    setupElements() {
        this.hub = document.getElementById('hub');
        this.openPanel = null;
        this.statusDot = document.getElementById('statusDot');
        this.hubMore = document.getElementById('hubMore') || document.getElementById('infoButton');
        this.shortcutsPopover = document.getElementById('shortcutsPopover');
        this.quotaChip = document.getElementById('quotaChip');
        this.interviewChip = document.getElementById('interviewChip');
        this.interviewTimer = document.getElementById('interviewTimer');
        this.isInterviewActive = false;
        this._interviewTimerInterval = null;
        this._interviewStartTime = null;
        this.listenLiveDot = document.getElementById('listenLiveDot');
        this.skillIndicator = document.getElementById('skillIndicator');
        this.settingsIndicator = document.getElementById('settingsIndicator');
        this.micButton = document.getElementById('micButton');
        this.isBlackout = false;

        // Wire Interview Mode master toggle button
        if (this.interviewChip) {
            let lastToggleTime = 0;
            const toggleInterview = async (e) => {
                const now = Date.now();
                if (now - lastToggleTime < 300) return;
                lastToggleTime = now;

                if (e) {
                    e.preventDefault();
                    e.stopPropagation();
                }
                logger.info('Interview button triggered, isInterviewActive:', this.isInterviewActive);
                if (window.electronAPI && window.electronAPI.setInterviewMode) {
                    try {
                        const nextState = !this.isInterviewActive;
                        const res = await window.electronAPI.setInterviewMode(nextState);
                        this.handleInterviewModeChanged(res !== undefined ? !!res : nextState);
                    } catch (err) {
                        logger.error('Failed to toggle interview mode via button', err);
                    }
                }
            };

            this.interviewChip.addEventListener('click', toggleInterview);
            this.interviewChip.addEventListener('pointerup', (e) => {
                if (e.button === 0) toggleInterview(e);
            });
        }

        // Wire Smog Hub Tabs
        if (this.hub) {
            this.hub.querySelectorAll('.hub-tab').forEach(tab => {
                tab.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const panel = tab.dataset.panel;
                    this.selectPanel(panel);
                });
            });
        }

        // Hub more / Shortcuts popover
        if (this.hubMore && this.shortcutsPopover) {
            this.hubMore.addEventListener('click', (e) => {
                e.stopPropagation();
                this.shortcutsPopover.classList.toggle('show');
            });
            document.addEventListener('click', (e) => {
                if (this.shortcutsPopover && !this.shortcutsPopover.contains(e.target) && e.target !== this.hubMore) {
                    this.shortcutsPopover.classList.remove('show');
                }
            });
        }

        // Legacy screenshot button support if present
        const commandItems = document.querySelectorAll('.command-item');
        this.screenshotButton = commandItems && commandItems[0];
        if (this.screenshotButton) {
            this.screenshotButton.addEventListener('click', () => {
                if (this.isInteractive && window.electronAPI && window.electronAPI.takeScreenshot) {
                    window.electronAPI.takeScreenshot();
                }
            });
        }

        // Skill indicator click cycles through available skills
        if (this.skillIndicator) {
            this.skillIndicator.addEventListener('click', () => {
                if (!this.isInteractive) return;
                this.navigateSkill(1);
            });

            this.skillIndicator.addEventListener('contextmenu', async (e) => {
                e.preventDefault();
                if (!this.isInteractive) return;
                if (window.electronAPI && window.electronAPI.setSkillLock) {
                    const target = this.isSkillLocked ? null : (this.currentSkill === 'auto' ? 'dsa' : this.currentSkill);
                    try {
                        const res = await window.electronAPI.setSkillLock(target);
                        this.isSkillLocked = !!res?.locked;
                        this.updateSkillIndicator();
                    } catch (err) {
                        logger.error('Failed to toggle skill lock', err);
                    }
                }
            });
        }

        if (this.settingsIndicator) {
            this.settingsIndicator.addEventListener('click', () => {
                if (this.isInteractive) {
                    this.selectPanel('params');
                }
            });
        }

        if (this.micButton) {
            this.micButton.addEventListener('click', async () => {
                if (this.isInteractive && this.speechAvailable) {
                    try {
                        if (this.isRecording) {
                            await window.electronAPI.stopSpeechRecognition();
                        } else {
                            await window.electronAPI.startSpeechRecognition();
                        }
                    } catch (error) {
                        logger.error('Speech recognition toggle failed', {
                            component: 'MainWindowUI',
                            error: error.message
                        });
                        this.isRecording = false;
                        this.updateMicButtonState();
                    }
                } else if (this.isInteractive && !this.speechAvailable) {
                    logger.warn('Mic clicked but speech recognition is not available', {
                        component: 'MainWindowUI'
                    });
                    this.loadSpeechAvailability();
                }
            });
        }

        // Language dropdown
        this.languageSelect = document.getElementById('codingLanguage');
        if (this.languageSelect) {
            // Set default to C++ if no value is set
            this.languageSelect.value = 'cpp';
            
            // Initialize with current setting
            if (window.electronAPI && window.electronAPI.getSettings) {
                window.electronAPI.getSettings().then(settings => {
                    if (settings && settings.codingLanguage) {
                        this.languageSelect.value = settings.codingLanguage;
                    } else {
                        // Save C++ as default if no language is set
                        this.languageSelect.value = 'cpp';
                        window.electronAPI.saveSettings({ codingLanguage: 'cpp' });
                    }
                }).catch(() => {
                    // Fallback to C++ on error
                    this.languageSelect.value = 'cpp';
                });
            }

            this.languageSelect.addEventListener('change', (e) => {
                const lang = e.target.value;
                if (window.electronAPI && window.electronAPI.saveSettings) {
                    window.electronAPI.saveSettings({ codingLanguage: lang });
                }
                // Resize for any width change
                setTimeout(() => {
                    const commandTab = document.querySelector('.command-tab');
                    if (commandTab && window.electronAPI && window.electronAPI.resizeWindow) {
                        const rect = commandTab.getBoundingClientRect();
                        window.electronAPI.resizeWindow(Math.ceil(rect.width), Math.ceil(rect.height));
                    }
                }, 50);
            });
        }

        // Info button / shortcuts popover
        if (this.infoButton && this.shortcutsPopover) {
            this.infoButton.addEventListener('click', (e) => {
                if (!this.isInteractive) return;
                e.stopPropagation();
                this.toggleShortcutsPopover();
            });

            // Hover to show
            this.infoButton.addEventListener('mouseenter', () => {
                if (!this.isInteractive) return;
                this.showShortcutsPopover();
            });
            // Queue hide when leaving the button
            this.infoButton.addEventListener('mouseleave', () => this.queueHideShortcutsPopover());

            // Keep open when hovering popover
            this.shortcutsPopover.addEventListener('mouseenter', () => {
                if (this._popoverHideTimeout) {
                    clearTimeout(this._popoverHideTimeout);
                    this._popoverHideTimeout = null;
                }
            });
            // Hide after a small delay when leaving popover
            this.shortcutsPopover.addEventListener('mouseleave', () => this.queueHideShortcutsPopover());

            // Close on outside click
            document.addEventListener('click', (e) => {
                if (!this.shortcutsPopover) return;
                const isClickInside = this.shortcutsPopover.contains(e.target) || this.infoButton.contains(e.target);
                if (!isClickInside && this.shortcutsPopover.classList.contains('is-open')) {
                    this.hideShortcutsPopover();
                }
            });

            // Close on Escape
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.shortcutsPopover && this.shortcutsPopover.classList.contains('is-open')) {
                    this.hideShortcutsPopover();
                }
            });
        }
    }

    async selectPanel(name) {
        const next = this.openPanel === name ? null : name; // click active tab = close (toggle)
        if (this.hub) {
            this.hub.querySelectorAll('.hub-tab').forEach(t =>
                t.setAttribute('aria-selected', String(t.dataset.panel === next)));
        }
        this.openPanel = next;
        if (window.electronAPI && window.electronAPI.setActivePanel) {
            await window.electronAPI.setActivePanel(next);
        }
    }

    setupEventListeners() {
        if (window.electronAPI) {
            // Smog blackout mode listener
            if (window.electronAPI.onBlackout) {
                window.electronAPI.onBlackout((on) => {
                    this.isBlackout = !!on;
                    document.documentElement.classList.toggle('blackout', this.isBlackout);
                });
            }

            // Quota updates
            if (window.electronAPI.onQuota) {
                window.electronAPI.onQuota((data) => {
                    if (!data) return;
                    const totalEl = document.getElementById('quotaTotal');
                    const pctEl = document.getElementById('quotaPct');
                    const restEl = document.getElementById('quotaRest');
                    if (totalEl && data.total) totalEl.textContent = data.total;
                    if (pctEl && data.pct) pctEl.textContent = data.pct;
                    if (restEl && data.rest) restEl.textContent = data.rest;
                });
            }

            // Interview mode listener
            if (window.electronAPI.onInterviewModeChanged) {
                window.electronAPI.onInterviewModeChanged((data) => {
                    const active = typeof data === 'boolean' ? data : !!data?.active;
                    this.handleInterviewModeChanged(active);
                });
            }

            // Fix interaction mode change listener
            window.electronAPI.onInteractionModeChanged((event, interactive) => {
                logger.debug('Interaction mode changed received:', interactive);
                this.handleInteractionModeChanged(interactive);
            });

            window.electronAPI.onRecordingStarted(() => {
                this.handleRecordingStarted();
            });

            window.electronAPI.onRecordingStopped(() => {
                this.handleRecordingStopped();
            });

            window.electronAPI.onSkillChanged((event, data) => {
                if (data && data.skill) {
                    this.handleSkillChanged(data);
                }
            });

            window.electronAPI.onSpeechAvailability((event, data) => {
                this.speechAvailable = !!(data && data.available);
                this.applyMicVisibility();
            });

            // Listen for coding language changes from other windows
            window.electronAPI.onCodingLanguageChanged((event, data) => {
                if (data && data.language && this.languageSelect) {
                    // avoid clobbering if same value
                    if (this.languageSelect.value !== data.language) {
                        this.languageSelect.value = data.language;
                    }
                    logger.debug('Language updated from other window', {
                        component: 'MainWindowUI',
                        language: data.language
                    });
                }
            });

            // Listen for main window shown event to refresh speech availability
            window.electronAPI.onMainWindowShown(() => {
                logger.debug('Main window shown - refreshing speech availability', {
                    component: 'MainWindowUI'
                });
                this.loadSpeechAvailability();
            });
            
            // Global keyboard shortcuts
            document.addEventListener('keydown', (e) => {
                if (e.altKey && e.key === 'r' && this.isInteractive) {
                    e.preventDefault();
                    if (!this.speechAvailable) return; // guard when unavailable
                    if (this.isRecording) {
                        window.electronAPI.stopSpeechRecognition();
                    } else {
                        window.electronAPI.startSpeechRecognition();
                    }
                }
            });
        }
        
        // Also listen via the api interface for backup
        if (window.api) {
            
            window.api.receive('interaction-mode-changed', (interactive) => {
                logger.debug('Interaction mode changed via api:', interactive);
                this.handleInteractionModeChanged(interactive);
            });
            
            window.api.receive('skill-updated', (data) => {
                logger.info('Skill updated event received from main process:', data);
                if (data && data.skill) {
                    this.handleSkillChanged(data);
                } else if (typeof data === 'string') {
                    // Handle case where skill is passed directly as string
                    this.handleSkillChanged({ skill: data });
                } else {
                    logger.warn('Skill updated event received but no skill data found:', data);
                }
            });
            
            // Listen for skill updates from settings window  
            window.api.receive('update-skill', (skill) => {
                logger.info('Direct skill update received from settings:', skill);
                this.handleSkillChanged({ skill: skill });
            });
        } else {
            logger.error('window.api not available - event listeners not set up!');
        }
        
        // Keyboard shortcuts
        this.setupKeyboardShortcuts();
        
        // Settings shortcut
        this.setupSettingsShortcut();
    }

    handleLLMResponse(data) {
        const skill = data.skill || data.metadata?.skill || 'General';
        const skillNames = {
            'dsa': 'DSA',
            'behavioral': 'Behavioral', 
            'sales': 'Sales',
            'presentation': 'Presentation',
            'data-science': 'Data Science',
            'programming': 'Programming',
            'devops': 'DevOps',
            'system-design': 'System Design',
            'negotiation': 'Negotiation'
        };
        
        const displaySkill = skillNames[skill] || skill.toUpperCase();
        
        logger.info('LLM response received', {
            component: 'MainWindowUI',
            skill: skill,
            displaySkill: displaySkill
        });
    }

    handleLLMError(data) {
        logger.error('LLM error received', {
            component: 'MainWindowUI',
            error: data.error
        });
    }

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            const isCmdOrCtrl = e.metaKey || e.ctrlKey;

            // Smog panel shortcuts
            if (isCmdOrCtrl && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
                e.preventDefault();
                this.selectPanel('ask');
                return;
            }
            if (isCmdOrCtrl && e.shiftKey && (e.key === 'S' || e.key === 's')) {
                e.preventDefault();
                if (window.electronAPI && window.electronAPI.takeScreenshot) {
                    window.electronAPI.takeScreenshot();
                }
                this.selectPanel('vision');
                return;
            }
            if (isCmdOrCtrl && e.key === ',') {
                e.preventDefault();
                this.selectPanel('params');
                return;
            }
            if (isCmdOrCtrl && e.shiftKey && (e.key === 'B' || e.key === 'b')) {
                e.preventDefault();
                this.isBlackout = !this.isBlackout;
                if (window.electronAPI && window.electronAPI.setBlackout) {
                    window.electronAPI.setBlackout(this.isBlackout);
                }
                return;
            }

            if (e.metaKey && e.key === '\\') {
                this.isHidden = !this.isHidden;
                if (this.isHidden) {
                    this.showHiddenIndicator();
                }
            }
            
            // Handle Cmd + Arrow keys based on interaction mode
            if (e.metaKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                e.preventDefault();

                if (this.isInteractive) {
                    // Interactive mode: Cmd + Up/Down for skill navigation
                    if (e.key === 'ArrowUp') {
                        this.navigateSkill(-1); // Previous skill
                    } else if (e.key === 'ArrowDown') {
                        this.navigateSkill(1); // Next skill
                    }
                } else {
                    // Non-interactive mode: Cmd + Arrow keys for window movement
                    this.moveWindow(e.key);
                }
            }
        });
    }

    handleInteractionModeChanged(interactive) {
        logger.info('Handling interaction mode change', {
            component: 'MainWindowUI',
            newState: interactive,
            previousState: this.isInteractive
        });
        
        // Update the internal state
        this.isInteractive = interactive;
        
        // Update all UI elements to reflect the new state
        this.updateAllElementStates();

        // Auto-hide popover when leaving interactive mode
        if (!this.isInteractive && this.shortcutsPopover && this.shortcutsPopover.style.display !== 'none') {
            this.hideShortcutsPopover();
        }
        
        // Update skill indicator tooltip
        this.updateSkillIndicator();
        
        logger.info('Interaction mode change completed', {
            component: 'MainWindowUI',
            interactive: this.isInteractive,
            statusDotClass: this.statusDot ? this.statusDot.className : 'not found',
            skillIndicatorClass: this.skillIndicator ? this.skillIndicator.className : 'not found'
        });
    }

    handleInterviewModeChanged(active) {
        this.isInterviewActive = !!active;
        logger.info('Handling interview mode change', {
            component: 'MainWindowUI',
            active: this.isInterviewActive
        });

        if (this.interviewChip) {
            this.interviewChip.classList.toggle('active', this.isInterviewActive);
            const label = this.interviewChip.querySelector('.label');
            if (label) {
                label.textContent = this.isInterviewActive ? 'Live' : 'Interview';
            }
        }

        if (this.isInterviewActive) {
            if (!this._interviewTimerInterval) {
                this._interviewStartTime = Date.now();
                this._interviewTimerInterval = setInterval(() => {
                    if (!this.interviewTimer || !this._interviewStartTime) return;
                    const elapsedSec = Math.floor((Date.now() - this._interviewStartTime) / 1000);
                    const h = String(Math.floor(elapsedSec / 3600)).padStart(2, '0');
                    const m = String(Math.floor((elapsedSec % 3600) / 60)).padStart(2, '0');
                    const s = String(elapsedSec % 60).padStart(2, '0');
                    this.interviewTimer.textContent = `${h}:${m}:${s}`;
                }, 1000);
            }
        } else {
            if (this._interviewTimerInterval) {
                clearInterval(this._interviewTimerInterval);
                this._interviewTimerInterval = null;
            }
            this._interviewStartTime = null;
            if (this.interviewTimer) {
                this.interviewTimer.textContent = '00:00:00';
            }
        }
        this.resizeWindowToContent();
    }

    handleSkillChanged(data) {
        const oldSkill = this.currentSkill;
        this.currentSkill = data.skill;
        
        logger.info('Handling skill change', {
            component: 'MainWindowUI',
            oldSkill: oldSkill,
            newSkill: data.skill,
            skillIndicatorExists: !!this.skillIndicator
        });
        
        this.updateSkillIndicator();
        
        logger.info('Skill changed successfully', {
            component: 'MainWindowUI',
            skill: data.skill
        });
    }

    handleSkillActivated(skillName) {
        this.currentSkill = skillName;
        this.updateSkillIndicator();
        
        logger.info('Skill activated', {
            component: 'MainWindowUI',
            skill: skillName
        });
    }

    handleScreenshotRequest() {
        logger.debug('Screenshot request received', { component: 'MainWindowUI' });
    }

    handleRecordingStarted() {
        this.isRecording = true;
        if (this.listenLiveDot) {
            this.listenLiveDot.hidden = false;
        }
        if (this.micButton) {
            this.micButton.classList.add('recording');
        }
        // On Windows and macOS, Whisper audio is captured here in the renderer
        // (Web Audio API) rather than the main process: Windows lacks sox/rec/
        // arecord, and macOS avoids an unbundled Homebrew `sox`. Must match the
        // main process's useRendererCapture gate (speech.service.js). Linux uses
        // the native recorder. navigator.userAgentData is preferred when present
        // since navigator.platform is deprecated.
        const platform = (typeof navigator !== 'undefined' &&
          ((navigator.userAgentData && navigator.userAgentData.platform) ||
            navigator.platform || '')).toLowerCase();
        const useRendererCapture = platform.includes('win') || platform.includes('mac');
        if (useRendererCapture) {
            this._startRendererAudioCapture();
        }
        logger.debug('Recording started', { component: 'MainWindowUI' });
    }

    handleRecordingStopped() {
        this.isRecording = false;
        if (this.listenLiveDot) {
            this.listenLiveDot.hidden = true;
        }
        if (this.micButton) {
            this.micButton.classList.remove('recording');
        }
        this._stopRendererAudioCapture();
        logger.debug('Recording stopped', { component: 'MainWindowUI' });
    }

    /**
     * Resample a mono Float32Array from inSampleRate to outSampleRate (e.g. 44.1k/48k -> 16k).
     */
    _resampleTo16k(inputData, inputRate, outputRate = 16000) {
        if (!inputData || inputData.length === 0) return new Float32Array(0);
        if (inputRate === outputRate) return inputData;
        const ratio = inputRate / outputRate;
        const newLength = Math.round(inputData.length / ratio);
        const result = new Float32Array(newLength);
        let offsetResult = 0;
        let offsetBuffer = 0;
        while (offsetResult < result.length) {
            const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
            let accum = 0;
            let count = 0;
            for (let i = offsetBuffer; i < nextOffsetBuffer && i < inputData.length; i++) {
                accum += inputData[i];
                count++;
            }
            result[offsetResult] = count > 0 ? accum / count : (inputData[offsetBuffer] || 0);
            offsetResult++;
            offsetBuffer = nextOffsetBuffer;
        }
        return result;
    }

    /**
     * Capture microphone audio in the renderer using the Web Audio API.
     * This is used for Whisper on Windows where node-record-lpcm16's sox/rec
     * dependencies are unavailable.
     */
    async _startRendererAudioCapture() {
        try {
            this._stopRendererAudioCapture();

            let stream;
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                        sampleRate: { ideal: 16000 }
                    }
                });
            } catch (constraintErr) {
                logger.warn('getUserMedia with constraints failed, retrying with basic audio: true', constraintErr);
                stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            }
            this._mediaStream = stream;

            let audioContext;
            try {
                audioContext = new (window.AudioContext || window.webkitAudioContext)({
                    sampleRate: 16000
                });
            } catch (ctxErr) {
                logger.warn('AudioContext(16000) failed, falling back to default sampleRate', ctxErr);
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            this._audioContext = audioContext;

            if (audioContext.state === 'suspended') {
                logger.info('AudioContext is suspended, resuming...');
                await audioContext.resume();
            }

            const inputSampleRate = audioContext.sampleRate;
            logger.info(`Renderer audio capture using AudioContext sampleRate: ${inputSampleRate}Hz, tracks: ${stream.getAudioTracks().length}`);

            const source = audioContext.createMediaStreamSource(stream);
            const bufferSize = 4096;
            const scriptNode = audioContext.createScriptProcessor(bufferSize, 1, 1);
            this._scriptNode = scriptNode;

            let chunkCounter = 0;
            scriptNode.onaudioprocess = (event) => {
                if (!this.isRecording || !window.electronAPI || !window.electronAPI.sendAudioChunk) {
                    return;
                }
                const rawChannel = event.inputBuffer.getChannelData(0);
                const inputData = this._resampleTo16k(rawChannel, inputSampleRate, 16000);

                const pcm16 = new Int16Array(inputData.length);
                let sumSquares = 0;
                for (let i = 0; i < inputData.length; i++) {
                    const s = Math.max(-1, Math.min(1, inputData[i]));
                    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                    sumSquares += s * s;
                }
                const rms = Math.sqrt(sumSquares / (inputData.length || 1));

                chunkCounter++;
                if (chunkCounter % 15 === 0 && rms > 0.005) {
                    logger.debug(`[AudioCapture] Voice energy detected: RMS=${rms.toFixed(4)}`);
                }

                window.electronAPI.sendAudioChunk(pcm16.buffer);
            };

            source.connect(scriptNode);
            scriptNode.connect(audioContext.destination);

            logger.info('Renderer audio capture started successfully', { component: 'MainWindowUI' });
        } catch (error) {
            logger.error('Failed to start renderer audio capture', {
                component: 'MainWindowUI',
                error: error.message
            });
            if (this.micButton) {
                this.micButton.classList.remove('recording');
                this.micButton.title = `Mic Error: ${error.message}`;
            }
            // Notify main process so it can stop the recording state
            try {
                await window.electronAPI.stopSpeechRecognition();
            } catch (_) { /* ignore */ }
        }
    }

    _stopRendererAudioCapture() {
        try {
            if (this._scriptNode) {
                this._scriptNode.disconnect();
                this._scriptNode.onaudioprocess = null;
                this._scriptNode = null;
            }
            if (this._mediaStream) {
                this._mediaStream.getTracks().forEach((track) => track.stop());
                this._mediaStream = null;
            }
            if (this._audioContext) {
                this._audioContext.close().catch(() => {});
                this._audioContext = null;
            }
            if (this._captureInterval) {
                clearInterval(this._captureInterval);
                this._captureInterval = null;
            }
        } catch (error) {
            logger.error('Error stopping renderer audio capture', {
                component: 'MainWindowUI',
                error: error.message
            });
        }
    }

    handleSkillChanged(data) {
        if (!data) return;
        const skill = typeof data === 'string' ? data : (data.skill || this.currentSkill);
        this.currentSkill = skill;
        if (data.locked !== undefined) {
            this.isSkillLocked = !!data.locked;
        }
        if (Array.isArray(data.availableSkills) && data.availableSkills.length > 0) {
            const ids = data.availableSkills.map(s => typeof s === 'string' ? s : s.id);
            this.availableSkills = ids.includes('auto') ? ids : ['auto', ...ids];
        }
        this.updateSkillIndicator();
    }

    handleSkillActivated(skill) {
        this.currentSkill = skill;
        this.updateSkillIndicator();
    }

    updateSkillIndicator() {
        const skillNames = {
            'auto': 'Auto',
            'dsa': 'DSA',
            'system-design': 'System Design',
            'behavioral': 'Behavioral', 
            'tech-qa': 'Tech Q&A',
            'general': 'General'
        };
        
        if (!this.skillIndicator) {
            logger.error('Skill indicator element not found!');
            return;
        }
        
        const baseName = skillNames[this.currentSkill] || this.currentSkill.toUpperCase();
        const displayName = this.isSkillLocked ? `🔒 ${baseName}` : baseName;
        const skillSpan = this.skillIndicator.querySelector('span');
        
        if (skillSpan) {
            const oldText = skillSpan.textContent;
            skillSpan.textContent = displayName;
                        
            const tooltip = this.isInteractive ? 
                `${baseName} ${this.isSkillLocked ? '(Locked)' : ''} - Click / ⌘↑↓ to cycle, Right-click to lock` : 
                `${baseName} ${this.isSkillLocked ? '(Locked)' : ''} - Enable interactive mode (Alt+A) to navigate`;
            this.skillIndicator.title = tooltip;
            
            // Add visual feedback for skill change
            this.animateSkillChange();
        } else {
            logger.error('Skill span element not found within skill indicator!');
        }
    }

    animateSkillChange() {
        if (this.skillIndicator) {
            this.skillIndicator.style.transform = 'scale(1.1)';
            this.skillIndicator.style.transition = 'transform 0.2s ease';
            
            setTimeout(() => {
                this.skillIndicator.style.transform = 'scale(1)';
            }, 200);
        }
    }

    navigateSkill(direction) {
        if (!this.isInteractive) {
            return;
        }
        
        let currentIndex = this.availableSkills.indexOf(this.currentSkill);
        if (currentIndex === -1) {
            currentIndex = 0;
        }
        
        // Calculate new index with wrapping
        let newIndex = currentIndex + direction;
        if (newIndex >= this.availableSkills.length) {
            newIndex = 0; // Wrap to beginning
        } else if (newIndex < 0) {
            newIndex = this.availableSkills.length - 1; // Wrap to end
        }
        
        const newSkill = this.availableSkills[newIndex];
        
        // Update skill locally and notify main process
        this.currentSkill = newSkill;
        this.updateSkillIndicator();
        
        // Save the skill change via IPC
        if (window.electronAPI && window.electronAPI.updateActiveSkill) {
            window.electronAPI.updateActiveSkill(newSkill).then(() => {
                logger.info('Skill navigation completed', {
                    component: 'MainWindowUI',
                    newSkill,
                    direction: direction > 0 ? 'down' : 'up'
                });
            }).catch(error => {
                logger.error('Failed to update skill via navigation', {
                    component: 'MainWindowUI',
                    error: error.message
                });
            });
        }
        
        // Show visual feedback
        this.showSkillChangeNotification(newSkill, direction);
    }

    showSkillChangeNotification(skill, direction) {
        const skillNames = {
            'auto': 'Auto',
            'dsa': 'DSA',
            'system-design': 'System Design',
            'behavioral': 'Behavioral', 
            'tech-qa': 'Tech Q&A',
            'general': 'General'
        };
        
        const displayName = skillNames[skill] || skill.toUpperCase();
        const arrow = direction > 0 ? '↓' : '↑';
        
        // Create temporary notification
        const notification = document.createElement('div');
        notification.className = 'skill-change-notification';
        notification.innerHTML = `${arrow} ${displayName}`;
        notification.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 8px 16px;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 600;
            z-index: 1000;
            opacity: 0;
            transition: opacity 0.2s ease;
        `;
        
        document.body.appendChild(notification);
        
        // Animate in
        setTimeout(() => {
            notification.style.opacity = '1';
        }, 10);
        
        // Remove after 1 second
        setTimeout(() => {
            notification.style.opacity = '0';
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 200);
        }, 1000);
    }

    showHiddenIndicator() {
        const indicator = document.querySelector('.hidden-indicator');
        if (indicator) {
            indicator.classList.add('show');
            setTimeout(() => {
                indicator.classList.remove('show');
            }, 3000);
        }
    }

    toggleInteractiveMode() {
        this.isInteractive = !this.isInteractive;
        this.updateAllElementStates();
        
        logger.debug('Interactive mode toggled', {
            component: 'MainWindowUI',
            interactive: this.isInteractive
        });
    }

    moveWindow(direction) {
        const moveDistance = 20; // pixels
        
        if (window.electronAPI && window.electronAPI.moveWindow) {
            let deltaX = 0, deltaY = 0;
            
            switch(direction) {
                case 'ArrowUp':
                    deltaY = -moveDistance;
                    break;
                case 'ArrowDown':
                    deltaY = moveDistance;
                    break;
                case 'ArrowLeft':
                    deltaX = -moveDistance;
                    break;
                case 'ArrowRight':
                    deltaX = moveDistance;
                    break;
            }
            
            window.electronAPI.moveWindow(deltaX, deltaY);
            logger.debug('Moving window', {
                component: 'MainWindowUI',
                direction: direction,
                deltaX: deltaX,
                deltaY: deltaY,
                interactive: this.isInteractive
            });
        } else {
            logger.warn('moveWindow API not available', { component: 'MainWindowUI' });
        }
    }

    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `fixed top-4 right-4 p-4 rounded-lg text-white z-50 ${
            type === 'error' ? 'bg-red-600' : 
            type === 'success' ? 'bg-green-600' :
            'bg-blue-600'
        }`;
        notification.textContent = message;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 5000);
        
        logger.debug('Notification shown', {
            component: 'MainWindowUI',
            message,
            type
        });
    }

    async showGeminiConfig() {
        try {
            const status = await window.electronAPI.getGeminiStatus();
            
            const modal = this.createGeminiConfigModal(status);
            document.body.appendChild(modal);
            
            logger.debug('Gemini config modal shown', { component: 'MainWindowUI' });
        } catch (error) {
            logger.error('Failed to show Gemini config', {
                component: 'MainWindowUI',
                error: error.message
            });
            this.showNotification('Failed to load Gemini configuration', 'error');
        }
    }

    createGeminiConfigModal(status) {
        const modal = document.createElement('div');
        modal.className = 'fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50';
        modal.innerHTML = `
            <div class="bg-gray-900 text-white p-6 rounded-lg max-w-md w-full">
                <div class="flex justify-between items-center mb-4">
                    <h2 class="text-xl font-bold">🤖 Gemini Flash 1.5 Configuration</h2>
                    <button class="text-gray-400 hover:text-white" onclick="this.closest('.fixed').remove()">✕</button>
                </div>
                
                <div class="mb-4 p-3 rounded ${status.hasApiKey ? 'bg-green-900' : 'bg-red-900'}">
                    <p><strong>Status:</strong> ${status.hasApiKey ? 'Configured' : 'Not Configured'}</p>
                    <p><strong>Model:</strong> ${status.model}</p>
                </div>
                
                <div class="mb-4">
                    <label class="block text-sm font-medium mb-2">API Key:</label>
                    <input type="password" id="geminiApiKey" placeholder="Enter your Gemini API key" 
                           class="w-full p-2 bg-gray-800 border border-gray-600 rounded text-white">
                    <p class="text-xs text-gray-400 mt-1">
                        Get your API key from: <a href="https://makersuite.google.com/app/apikey" target="_blank" class="text-blue-400">Google AI Studio</a>
                    </p>
                </div>
                
                <div class="flex space-x-2">
                    <button onclick="mainWindowUI.configureGemini()" class="flex-1 bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded">
                        Configure
                    </button>
                    <button onclick="mainWindowUI.testGeminiConnection()" class="flex-1 bg-green-600 hover:bg-green-700 px-4 py-2 rounded">
                        Test Connection
                    </button>
                </div>
                
                <div class="mt-4 text-center">
                    <button class="bg-gray-600 hover:bg-gray-700 px-4 py-2 rounded" onclick="this.closest('.fixed').remove()">
                        Close
                    </button>
                </div>
            </div>
        `;
        return modal;
    }

    async configureGemini() {
        const apiKey = document.getElementById('geminiApiKey').value.trim();
        if (!apiKey) {
            this.showNotification('Please enter an API key', 'error');
            return;
        }
        
        try {
            const result = await window.electronAPI.setGeminiApiKey(apiKey);
            if (result.success) {
                this.showNotification('Gemini API key configured successfully!', 'success');
                document.querySelector('.fixed').remove();
                
                logger.info('Gemini API key configured', { component: 'MainWindowUI' });
            } else {
                this.showNotification(`Configuration failed: ${result.error}`, 'error');
                logger.error('Gemini configuration failed', {
                    component: 'MainWindowUI',
                    error: result.error
                });
            }
        } catch (error) {
            this.showNotification(`Error: ${error.message}`, 'error');
            logger.error('Gemini configuration error', {
                component: 'MainWindowUI',
                error: error.message
            });
        }
    }

    async testGeminiConnection() {
        try {
            const result = await window.electronAPI.testGeminiConnection();
            if (result.success) {
                this.showNotification('Gemini connection test successful!', 'success');
                logger.info('Gemini connection test successful', { component: 'MainWindowUI' });
            } else {
                this.showNotification(`Connection test failed: ${result.error}`, 'error');
                logger.error('Gemini connection test failed', {
                    component: 'MainWindowUI',
                    error: result.error
                });
            }
        } catch (error) {
            this.showNotification(`Error: ${error.message}`, 'error');
            logger.error('Gemini connection test error', {
                component: 'MainWindowUI',
                error: error.message
            });
        }
    }

    setupSettingsShortcut() {
        document.addEventListener('keydown', (e) => {
            // Cmd+, or Ctrl+, for settings
            if ((e.metaKey || e.ctrlKey) && e.key === ',') {
                logger.debug('Settings keyboard shortcut pressed');
                e.preventDefault();
                this.openSettings();
            }
        });
    }

    openSettings() {
        try {
            if (window.electronAPI && window.electronAPI.showSettings) {
                window.electronAPI.showSettings();
            } else {
                logger.error('electronAPI or showSettings not available');
                return;
            }
            
            // Add visual feedback
            if (this.settingsIndicator) {
                this.settingsIndicator.style.transform = 'scale(1.1)';
                this.settingsIndicator.style.transition = 'transform 0.2s ease';
                
                setTimeout(() => {
                    this.settingsIndicator.style.transform = 'scale(1)';
                }, 200);
            }
            
            logger.info('Settings window opened', { component: 'MainWindowUI' });
        } catch (error) {
            logger.error('Failed to open settings', {
                component: 'MainWindowUI',
                error: error.message
            });
            this.showNotification('Failed to open settings', 'error');
        }
    }

    showSettingsMenu() {
        const menu = document.createElement('div');
        menu.className = 'settings-menu';
        menu.style.cssText = `
            position: absolute;
            right: 10px;
            top: 35px;
            background: rgba(0, 0, 0, 0.8);
            backdrop-filter: blur(20px);
            border-radius: 8px;
            border: 1px solid rgba(255, 255, 255, 0.15);
            padding: 8px 0;
            min-width: 150px;
            z-index: 1000;
        `;

        const settingsOption = this.createMenuItem('Settings', 'fa-cog', () => {
            this.openSettings();
            document.body.removeChild(menu);
        });

        const quitOption = this.createMenuItem('Quit OpenCluely', 'fa-power-off', () => {
            if (window.electronAPI) {
                window.electronAPI.quitApp();
            }
        });

        menu.appendChild(settingsOption);
        menu.appendChild(this.createMenuSeparator());
        menu.appendChild(quitOption);

        // Add click outside listener to close menu
        const closeMenu = (e) => {
            if (!menu.contains(e.target) && !this.settingsIndicator.contains(e.target)) {
                document.body.removeChild(menu);
                document.removeEventListener('click', closeMenu);
            }
        };
        document.addEventListener('click', closeMenu);

        document.body.appendChild(menu);
    }

    createMenuItem(text, iconClass, onClick) {
        const item = document.createElement('div');
        item.style.cssText = `
            padding: 8px 16px;
            color: rgba(255, 255, 255, 0.9);
            font-size: 13px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
            transition: all 0.2s ease;
        `;
        item.innerHTML = `<i class="fas ${iconClass}"></i>${text}`;
        item.addEventListener('mouseover', () => {
            item.style.background = 'rgba(255, 255, 255, 0.1)';
        });
        item.addEventListener('mouseout', () => {
            item.style.background = 'transparent';
        });
        item.addEventListener('click', onClick);
        return item;
    }

    createMenuSeparator() {
        const separator = document.createElement('div');
        separator.style.cssText = `
            height: 1px;
            background: rgba(255, 255, 255, 0.1);
            margin: 8px 0;
        `;
        return separator;
    }

    toggleShortcutsPopover() {
        if (!this.shortcutsPopover) return;
    const isOpen = this.shortcutsPopover.classList.contains('is-open');
    if (!isOpen) {
            this.showShortcutsPopover();
        } else {
            this.hideShortcutsPopover();
        }
    }

    showShortcutsPopover() {
        if (!this.shortcutsPopover) return;
        if (this._popoverHideTimeout) {
            clearTimeout(this._popoverHideTimeout);
            this._popoverHideTimeout = null;
        }
    this.shortcutsPopover.classList.add('is-open');
        // Resize main window to fit popover
        setTimeout(() => this.resizeWindowToContent(), 50);
    }

    hideShortcutsPopover() {
        if (!this.shortcutsPopover) return;
    this.shortcutsPopover.classList.remove('is-open');
    // resize back to compact after transition
    setTimeout(() => this.resizeWindowToContent(), 130);
    }

    queueHideShortcutsPopover() {
        if (!this.shortcutsPopover) return;
        if (this._popoverHideTimeout) clearTimeout(this._popoverHideTimeout);
        this._popoverHideTimeout = setTimeout(() => this.hideShortcutsPopover(), 180);
    }
}

// Initialize when DOM is ready
let mainWindowUI;
if (typeof document !== 'undefined') {
    // Add immediate visual indicator that script is loading
    const style = document.createElement('style');
    document.head.appendChild(style);
    
    document.addEventListener('DOMContentLoaded', () => {
                
        mainWindowUI = new MainWindowUI();
        // Make it globally accessible for debugging
        window.mainWindowUI = mainWindowUI;
        logger.info('MainWindowUI initialized and available as window.mainWindowUI');
    });
}

// module.exports = MainWindowUI; // Not needed in browser context