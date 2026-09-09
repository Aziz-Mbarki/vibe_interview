/**
 * Live interview chords. Ctrl+Alt+* is used instead of bare Alt+*
 * because globalShortcut registrations are system-wide and swallow the
 * key — Alt+D/F/C/S/A/W/1/2/3 collide with browser and Windows mnemonics.
 *
 * Electron accelerator form is `Ctrl+Alt+<key>` (Control, not Command, on
 * macOS) so we do not steal Option/Command chords used for special characters.
 */
const LIVE_CHORDS = {
  panic: 'Ctrl+Alt+Space',
  panicFallback: 'Ctrl+Alt+Q',
  autopilot: 'Ctrl+Alt+A',
  screen: 'Ctrl+Alt+S',
  deeper: 'Ctrl+Alt+D',
  shorter: 'Ctrl+Alt+F',
  copy: 'Ctrl+Alt+C',
  more: 'Ctrl+Alt+Down',
  less: 'Ctrl+Alt+Up',
  prev: 'Ctrl+Alt+Left',
  next: 'Ctrl+Alt+Right',
  blackout: 'Ctrl+Alt+B',
  opacity30: 'Ctrl+Alt+1',
  opacity60: 'Ctrl+Alt+2',
  opacity100: 'Ctrl+Alt+3',
  ask: 'Ctrl+Alt+W',
  interview: 'Ctrl+Alt+I',
  speech: 'Ctrl+Alt+R'
};

const LIVE_CHORD_LABELS = {
  panic: 'Panic hide',
  autopilot: 'Toggle autopilot',
  screen: 'Capture screen',
  deeper: 'Deeper answer',
  shorter: 'Shorter answer',
  copy: 'Copy last code',
  more: 'Prompter detail',
  less: 'Prompter summary',
  prev: 'Previous answer',
  next: 'Next answer',
  blackout: 'Toggle blackout',
  opacity30: 'Opacity 30%',
  opacity60: 'Opacity 60%',
  opacity100: 'Opacity 100%',
  ask: 'Push-to-ask',
  interview: 'Interview mode',
  speech: 'Toggle speech'
};

function formatChord(accelerator) {
  return String(accelerator || '').replace(/Ctrl\+/g, 'Ctrl+').replace(/Down/g, '↓').replace(/Up/g, '↑');
}

module.exports = {
  LIVE_CHORDS,
  LIVE_CHORD_LABELS,
  formatChord
};
