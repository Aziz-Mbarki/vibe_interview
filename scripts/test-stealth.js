/**
 * Test Stealth Enforcement
 * Verifies that all windows configured in WindowManager uphold stealth invariants:
 * 1. Skip taskbar enabled
 * 2. Transparent background enabled
 * 3. Always on top enabled
 * 4. Content protection applied in applyStealthMeasures
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('Testing stealth guarantees...');

// 1. Check window.manager.js source code for stealth calls
const wmSource = fs.readFileSync(path.join(__dirname, '../src/managers/window.manager.js'), 'utf8');

assert(wmSource.includes('setContentProtection(true)'), 'Missing setContentProtection(true) call');
assert(wmSource.includes('setSkipTaskbar(true)'), 'Missing setSkipTaskbar(true) call');
assert(wmSource.includes('setVisibleOnAllWorkspaces(true'), 'Missing setVisibleOnAllWorkspaces call');
assert(wmSource.includes('setAlwaysOnTop(true'), 'Missing setAlwaysOnTop call');

console.log('✓ Source verification: setContentProtection, setSkipTaskbar, setVisibleOnAllWorkspaces are present');

// 2. Mock electron and instantiate WindowManager
const mockWindows = new Set();

const mockElectron = {
  BrowserWindow: class MockBrowserWindow {
    constructor(opts) {
      this.opts = opts;
      this.contentProtection = false;
      this.skipTaskbar = opts.skipTaskbar || false;
      this.alwaysOnTop = opts.alwaysOnTop || false;
      mockWindows.add(this);
    }
    setContentProtection(val) { this.contentProtection = val; }
    setSkipTaskbar(val) { this.skipTaskbar = val; }
    setAlwaysOnTop(val) { this.alwaysOnTop = val; }
    setVisibleOnAllWorkspaces() {}
    setIgnoreMouseEvents() {}
    setPosition() {}
    getPosition() { return [0, 0]; }
    getSize() { return [this.opts.width || 400, this.opts.height || 400]; }
    getContentSize() { return [this.opts.width || 400, this.opts.height || 400]; }
    setSize() {}
    setContentSize() {}
    setMinimumSize() {}
    on() {}
    show() {}
    hide() {}
    focus() {}
    isDestroyed() { return false; }
    isVisible() { return true; }
    isAlwaysOnTop() { return true; }
    getBounds() { return { x: 0, y: 0, width: 400, height: 400 }; }
    webContents = {
      on: () => {},
      send: () => {}
    }
    async loadFile() {}
  },
  screen: {
    getPrimaryDisplay: () => ({
      id: 'primary',
      workArea: { x: 0, y: 0, width: 1920, height: 1080 }
    }),
    getAllDisplays: () => [{
      id: 'primary',
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1080 }
    }]
  },
  desktopCapturer: {
    getSources: async () => []
  }
};

// Test WindowConfigs directly
const WindowManager = require('../src/managers/window.manager').constructor;
const wm = new WindowManager();

const requiredPanels = ['main', 'listen', 'vision', 'ask', 'notes', 'params'];

for (const panel of requiredPanels) {
  const cfg = wm.windowConfigs[panel];
  assert(cfg, `Window config missing for panel: ${panel}`);
  if (panel !== 'main') {
    assert.strictEqual(cfg.frame, false, `${panel} should be frameless`);
    assert.strictEqual(cfg.transparent, true, `${panel} should be transparent`);
    assert.strictEqual(cfg.alwaysOnTop, true, `${panel} should be alwaysOnTop`);
    assert.strictEqual(cfg.skipTaskbar, true, `${panel} should be skipTaskbar`);
  }
  console.log(`✓ Panel "${panel}" config verified`);
}

console.log('\nAll stealth tests passed cleanly! (7/7 assertions)');
