import { registerTool } from './index.js';
import dbExports from '../database/index.js';

// ═══════════════════════════════════════════════════════════════
// NOTES & REMINDERS — SQLite local
// ═══════════════════════════════════════════════════════════════

const db = dbExports.localDb;

// Create notes table if it doesn't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT DEFAULT '',
    reminder_date TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── Save Note ──────────────────────────────────────────────────
registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'save_note',
            description: 'Save a note or reminder for the user. Use this when the user wants to remember something, create a to-do, or set a reminder.',
            parameters: {
                type: 'object',
                properties: {
                    title: {
                        type: 'string',
                        description: 'Short title or summary of the note'
                    },
                    content: {
                        type: 'string',
                        description: 'Detailed content of the note (optional)'
                    },
                    reminder_date: {
                        type: 'string',
                        description: 'Optional reminder date in ISO format (e.g. "2026-03-08T09:00:00"). Leave empty if not a reminder.'
                    }
                },
                required: ['title'],
            },
        },
    },
    execute: async (args) => {
        try {
            const userId = args._userId || 'default';
            const stmt = db.prepare('INSERT INTO notes (user_id, title, content, reminder_date) VALUES (?, ?, ?, ?)');
            const result = stmt.run(userId, args.title, args.content || '', args.reminder_date || null);

            let response = `✅ Nota guardada: "${args.title}" (ID: ${result.lastInsertRowid})`;
            if (args.reminder_date) {
                response += `\n⏰ Recordatorio: ${args.reminder_date}`;
            }
            return response;
        } catch (error: any) {
            return `Error guardando nota: ${error.message}`;
        }
    },
});

// ── List Notes ─────────────────────────────────────────────────
registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'list_notes',
            description: 'List all saved notes and reminders for the user. Shows titles, dates, and reminder status.',
            parameters: {
                type: 'object',
                properties: {},
                required: [],
            },
        },
    },
    execute: async (args) => {
        try {
            const userId = args._userId || 'default';
            const stmt = db.prepare('SELECT id, title, content, reminder_date, created_at FROM notes WHERE user_id = ? ORDER BY created_at DESC LIMIT 30');
            const notes = stmt.all(userId) as any[];

            if (notes.length === 0) {
                return 'No tenés notas guardadas.';
            }

            let result = `📝 Tus notas (${notes.length}):\n\n`;
            for (const note of notes) {
                result += `• **[${note.id}]** ${note.title}`;
                if (note.content) result += ` — ${note.content.substring(0, 80)}`;
                if (note.reminder_date) result += ` ⏰ ${note.reminder_date}`;
                result += ` (${note.created_at})\n`;
            }

            return result;
        } catch (error: any) {
            return `Error listando notas: ${error.message}`;
        }
    },
});

// ── Search Notes ───────────────────────────────────────────────
registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'search_notes',
            description: 'Search through saved notes by keyword.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search keyword to find in note titles and content'
                    }
                },
                required: ['query'],
            },
        },
    },
    execute: async (args) => {
        try {
            const userId = args._userId || 'default';
            const stmt = db.prepare('SELECT id, title, content, reminder_date FROM notes WHERE user_id = ? AND (title LIKE ? OR content LIKE ?) ORDER BY created_at DESC LIMIT 20');
            const searchTerm = `%${args.query}%`;
            const notes = stmt.all(userId, searchTerm, searchTerm) as any[];

            if (notes.length === 0) {
                return `No se encontraron notas con "${args.query}".`;
            }

            let result = `🔍 Resultados para "${args.query}" (${notes.length}):\n\n`;
            for (const note of notes) {
                result += `• **[${note.id}]** ${note.title}`;
                if (note.content) result += ` — ${note.content.substring(0, 80)}`;
                if (note.reminder_date) result += ` ⏰ ${note.reminder_date}`;
                result += '\n';
            }

            return result;
        } catch (error: any) {
            return `Error buscando notas: ${error.message}`;
        }
    },
});

// ── Delete Note ────────────────────────────────────────────────
registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'delete_note',
            description: 'Delete a note by its ID number.',
            parameters: {
                type: 'object',
                properties: {
                    note_id: {
                        type: 'string',
                        description: 'The ID number of the note to delete'
                    }
                },
                required: ['note_id'],
            },
        },
    },
    execute: async (args) => {
        try {
            const userId = args._userId || 'default';
            const stmt = db.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?');
            const result = stmt.run(args.note_id, userId);

            if (result.changes === 0) {
                return `No se encontró la nota con ID ${args.note_id}.`;
            }
            return `🗑️ Nota ${args.note_id} eliminada.`;
        } catch (error: any) {
            return `Error eliminando nota: ${error.message}`;
        }
    },
});

console.log('📝 Notes & Reminders tools registered (SQLite)');
