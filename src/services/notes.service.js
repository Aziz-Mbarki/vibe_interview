const fs = require('fs');
const path = require('path');
const os = require('os');
const { dialog, shell, BrowserWindow } = require('electron');
const config = require('../core/config');
const logger = require('../core/logger').createServiceLogger('NOTES');

class NotesService {
  constructor() {
    this.notesDir = path.join(config.appDataDir, 'notes');
    this.ensureDirectory();
  }

  ensureDirectory() {
    try {
      if (!fs.existsSync(this.notesDir)) {
        fs.mkdirSync(this.notesDir, { recursive: true });
      }
    } catch (e) {
      logger.error('Failed to create notes directory', { error: e.message });
    }
  }

  /**
   * List all notes sorted by createdAt descending
   */
  async list() {
    this.ensureDirectory();
    try {
      const files = await fs.promises.readdir(this.notesDir);
      const notes = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await fs.promises.readFile(path.join(this.notesDir, file), 'utf8');
          const note = JSON.parse(raw);
          notes.push({
            id: note.id || path.basename(file, '.json'),
            title: note.title || 'Untitled Note',
            createdAt: note.createdAt || Date.now(),
            durationMs: note.durationMs || 0,
            summary: note.summary || ''
          });
        } catch (err) {
          logger.warn(`Could not read note file ${file}`, { error: err.message });
        }
      }
      return notes.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch (e) {
      logger.error('Failed to list notes', { error: e.message });
      return [];
    }
  }

  /**
   * Get note by ID
   */
  async get(id) {
    if (!id) return null;
    this.ensureDirectory();
    const filePath = path.join(this.notesDir, `${id}.json`);
    try {
      const raw = await fs.promises.readFile(filePath, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      logger.error(`Failed to get note ${id}`, { error: e.message });
      return null;
    }
  }

  /**
   * Save or update a note
   */
  async save(note) {
    if (!note) return null;
    this.ensureDirectory();
    const id = note.id || `note_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const fullNote = {
      id,
      title: note.title || 'Untitled Note',
      createdAt: note.createdAt || Date.now(),
      updatedAt: Date.now(),
      durationMs: note.durationMs || 0,
      summary: note.summary || '',
      keyPoints: Array.isArray(note.keyPoints) ? note.keyPoints : [],
      decisions: Array.isArray(note.decisions) ? note.decisions : [],
      actionItems: Array.isArray(note.actionItems) ? note.actionItems : [],
      questions: Array.isArray(note.questions) ? note.questions : [],
      body: note.body || '',
      transcriptRef: note.transcriptRef || null
    };

    const filePath = path.join(this.notesDir, `${id}.json`);
    try {
      await fs.promises.writeFile(filePath, JSON.stringify(fullNote, null, 2), 'utf8');
      logger.info(`Note saved: ${id}`);
      return fullNote;
    } catch (e) {
      logger.error(`Failed to save note ${id}`, { error: e.message });
      throw e;
    }
  }

  /**
   * Delete a note by ID
   */
  async remove(id) {
    if (!id) return false;
    const filePath = path.join(this.notesDir, `${id}.json`);
    try {
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
        logger.info(`Note deleted: ${id}`);
        return true;
      }
      return false;
    } catch (e) {
      logger.error(`Failed to delete note ${id}`, { error: e.message });
      return false;
    }
  }

  /**
   * Export note in requested format: 'copy' | 'markdown' | 'pdf' | 'email'
   */
  async export(id, format) {
    const note = await this.get(id);
    if (!note) throw new Error(`Note not found: ${id}`);

    const markdownText = this.generateMarkdown(note);

    switch (format) {
      case 'copy':
        return { success: true, text: markdownText };

      case 'markdown': {
        const { filePath } = await dialog.showSaveDialog({
          title: 'Export Note as Markdown',
          defaultPath: `${this.sanitizeFilename(note.title || 'Note')}.md`,
          filters: [{ name: 'Markdown', extensions: ['md'] }]
        });
        if (filePath) {
          await fs.promises.writeFile(filePath, markdownText, 'utf8');
          return { success: true, path: filePath };
        }
        return { success: false, cancelled: true };
      }

      case 'pdf': {
        const { filePath } = await dialog.showSaveDialog({
          title: 'Export Note as PDF',
          defaultPath: `${this.sanitizeFilename(note.title || 'Note')}.pdf`,
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        });
        if (!filePath) return { success: false, cancelled: true };

        const printWin = new BrowserWindow({
          show: false,
          webPreferences: { nodeIntegration: false, contextIsolation: true }
        });
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 40px; color: #111; line-height: 1.6; }
          h1 { font-size: 22px; border-bottom: 2px solid #ddd; padding-bottom: 8px; }
          h2 { font-size: 16px; margin-top: 24px; }
          ul { padding-left: 20px; }
          li { margin-bottom: 6px; }
          .meta { color: #666; font-size: 12px; margin-bottom: 20px; }
        </style></head><body>
          <h1>${this.escapeHtml(note.title || 'Note')}</h1>
          <div class="meta">Created: ${new Date(note.createdAt).toLocaleString()} | Duration: ${Math.round((note.durationMs || 0) / 60000)}m</div>
          ${note.summary ? `<p><strong>Summary:</strong> ${this.escapeHtml(note.summary)}</p>` : ''}
          <div>${(note.body || '').replace(/\\n/g, '<br>')}</div>
        </body></html>`;

        await printWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        const pdfBuffer = await printWin.webContents.printToPDF({
          printBackground: true,
          margins: { marginType: 'default' }
        });
        printWin.close();
        await fs.promises.writeFile(filePath, pdfBuffer);
        return { success: true, path: filePath };
      }

      case 'email': {
        const subject = encodeURIComponent(note.title || 'OpenCluely Interview Notes');
        const body = encodeURIComponent(markdownText);
        await shell.openExternal(`mailto:?subject=${subject}&body=${body}`);
        return { success: true };
      }

      default:
        throw new Error(`Unsupported export format: ${format}`);
    }
  }

  /**
   * Auto-clean notes older than retentionDays
   */
  async autoClean(retentionDays = 30) {
    this.ensureDirectory();
    try {
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      const files = await fs.promises.readdir(this.notesDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(this.notesDir, file);
        try {
          const stats = await fs.promises.stat(filePath);
          if (stats.mtimeMs < cutoff) {
            await fs.promises.unlink(filePath);
            logger.info(`Auto-cleaned stale note: ${file}`);
          }
        } catch (_) {}
      }
    } catch (e) {
      logger.warn('Auto-cleaning notes failed', { error: e.message });
    }
  }

  generateMarkdown(note) {
    const parts = [
      `# ${note.title || 'Interview Note'}`,
      `*Date: ${new Date(note.createdAt).toLocaleString()}*`,
      ''
    ];
    if (note.summary) {
      parts.push(`## Summary`, note.summary, '');
    }
    if (note.keyPoints && note.keyPoints.length) {
      parts.push(`## Key Points`, ...note.keyPoints.map(p => `- ${p}`), '');
    }
    if (note.questions && note.questions.length) {
      parts.push(`## Questions`, ...note.questions.map(q => `- ${q}`), '');
    }
    if (note.decisions && note.decisions.length) {
      parts.push(`## Decisions`, ...note.decisions.map(d => `- ${d}`), '');
    }
    if (note.actionItems && note.actionItems.length) {
      parts.push(`## Action Items`, ...note.actionItems.map(a => `- [ ] ${a}`), '');
    }
    if (note.body) {
      parts.push(`## Notes`, note.body, '');
    }
    return parts.join('\n');
  }

  sanitizeFilename(name) {
    return name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
  }

  escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

module.exports = new NotesService();
