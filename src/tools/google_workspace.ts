import { registerTool } from './index.js';
import { runGog } from '../google/gog.js';

// ═══════════════════════════════════════════════════════════════
// GMAIL TOOLS
// ═══════════════════════════════════════════════════════════════

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'gmail_search',
            description: 'Search Gmail emails. Use Gmail search queries like "newer_than:1d", "from:user@email.com", "is:unread", "subject:keyword", "in:inbox", etc. Returns threads by default.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Gmail search query (e.g. "newer_than:7d is:unread", "from:boss@company.com", "subject:meeting")'
                    }
                },
                required: ['query'],
            },
        },
    },
    execute: async (args) => {
        try {
            const result = await runGog(['gmail', 'search', args.query, '--max', '10']);
            return result || 'No emails found matching your search.';
        } catch (error: any) {
            return `Error searching Gmail: ${error.message}`;
        }
    },
});

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'gmail_messages_search',
            description: 'Search individual Gmail messages (not threads). Useful when you need every individual email, not grouped by thread. Use Gmail search queries.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Gmail search query (e.g. "in:inbox newer_than:1d", "from:user@email.com")'
                    }
                },
                required: ['query'],
            },
        },
    },
    execute: async (args) => {
        try {
            const result = await runGog(['gmail', 'messages', 'search', args.query, '--max', '10']);
            return result || 'No messages found.';
        } catch (error: any) {
            return `Error searching messages: ${error.message}`;
        }
    },
});

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'gmail_send',
            description: 'Send an email via Gmail. Can send plain text or HTML emails.',
            parameters: {
                type: 'object',
                properties: {
                    to: {
                        type: 'string',
                        description: 'Recipient email address'
                    },
                    subject: {
                        type: 'string',
                        description: 'Email subject line'
                    },
                    body: {
                        type: 'string',
                        description: 'Email body (plain text)'
                    },
                    html: {
                        type: 'boolean',
                        description: 'If true, treat body as HTML content'
                    }
                },
                required: ['to', 'subject', 'body'],
            },
        },
    },
    execute: async (args) => {
        try {
            const cmdArgs = ['gmail', 'send', '--to', args.to, '--subject', args.subject];
            if (args.html) {
                cmdArgs.push('--body-html', args.body);
            } else {
                cmdArgs.push('--body', args.body);
            }
            const result = await runGog(cmdArgs);
            return `✅ Email sent successfully to ${args.to}. ${result}`;
        } catch (error: any) {
            return `Error sending email: ${error.message}`;
        }
    },
});

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'gmail_draft_create',
            description: 'Create an email draft in Gmail.',
            parameters: {
                type: 'object',
                properties: {
                    to: {
                        type: 'string',
                        description: 'Recipient email address'
                    },
                    subject: {
                        type: 'string',
                        description: 'Email subject line'
                    },
                    body: {
                        type: 'string',
                        description: 'Email body (plain text)'
                    }
                },
                required: ['to', 'subject', 'body'],
            },
        },
    },
    execute: async (args) => {
        try {
            const result = await runGog(['gmail', 'drafts', 'create', '--to', args.to, '--subject', args.subject, '--body', args.body]);
            return `✅ Draft created successfully. ${result}`;
        } catch (error: any) {
            return `Error creating draft: ${error.message}`;
        }
    },
});

// ═══════════════════════════════════════════════════════════════
// GOOGLE CALENDAR TOOLS
// ═══════════════════════════════════════════════════════════════

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'calendar_list_events',
            description: 'List upcoming events from Google Calendar. Shows events between two dates. Use ISO 8601 date format (e.g. 2026-03-07T00:00:00-03:00).',
            parameters: {
                type: 'object',
                properties: {
                    calendar_id: {
                        type: 'string',
                        description: 'Calendar ID (use "primary" for the main calendar)'
                    },
                    from: {
                        type: 'string',
                        description: 'Start date in ISO 8601 format (e.g. "2026-03-07T00:00:00-03:00")'
                    },
                    to: {
                        type: 'string',
                        description: 'End date in ISO 8601 format (e.g. "2026-03-14T23:59:59-03:00")'
                    }
                },
                required: ['calendar_id', 'from', 'to'],
            },
        },
    },
    execute: async (args) => {
        try {
            const result = await runGog(['calendar', 'events', args.calendar_id, '--from', args.from, '--to', args.to]);
            return result || 'No events found for that date range.';
        } catch (error: any) {
            return `Error listing calendar events: ${error.message}`;
        }
    },
});

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'calendar_create_event',
            description: 'Create a new event on Google Calendar.',
            parameters: {
                type: 'object',
                properties: {
                    calendar_id: {
                        type: 'string',
                        description: 'Calendar ID (use "primary" for the main calendar)'
                    },
                    summary: {
                        type: 'string',
                        description: 'Event title/summary'
                    },
                    from: {
                        type: 'string',
                        description: 'Start date/time in ISO 8601 format'
                    },
                    to: {
                        type: 'string',
                        description: 'End date/time in ISO 8601 format'
                    },
                    description: {
                        type: 'string',
                        description: 'Optional event description'
                    }
                },
                required: ['calendar_id', 'summary', 'from', 'to'],
            },
        },
    },
    execute: async (args) => {
        try {
            const cmdArgs = ['calendar', 'create', args.calendar_id, '--summary', args.summary, '--from', args.from, '--to', args.to];
            if (args.description) {
                cmdArgs.push('--description', args.description);
            }
            const result = await runGog(cmdArgs);
            return `✅ Event "${args.summary}" created. ${result}`;
        } catch (error: any) {
            return `Error creating event: ${error.message}`;
        }
    },
});

// ═══════════════════════════════════════════════════════════════
// GOOGLE DRIVE TOOLS
// ═══════════════════════════════════════════════════════════════

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'drive_search',
            description: 'Search for files and folders in Google Drive.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search query for Drive files (e.g. "budget", "report 2024")'
                    }
                },
                required: ['query'],
            },
        },
    },
    execute: async (args) => {
        try {
            const result = await runGog(['drive', 'search', args.query, '--max', '10']);
            return result || 'No files found matching your search.';
        } catch (error: any) {
            return `Error searching Drive: ${error.message}`;
        }
    },
});

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'drive_list',
            description: 'List files in Google Drive root or a specific folder.',
            parameters: {
                type: 'object',
                properties: {
                    folder_id: {
                        type: 'string',
                        description: 'Folder ID to list (omit for root folder)'
                    }
                },
                required: [],
            },
        },
    },
    execute: async (args) => {
        try {
            const cmdArgs = ['drive', 'ls'];
            if (args.folder_id) cmdArgs.push(args.folder_id);
            cmdArgs.push('--max', '20');
            const result = await runGog(cmdArgs);
            return result || 'No files found.';
        } catch (error: any) {
            return `Error listing Drive files: ${error.message}`;
        }
    },
});

// ═══════════════════════════════════════════════════════════════
// GOOGLE CONTACTS TOOLS
// ═══════════════════════════════════════════════════════════════

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'contacts_list',
            description: 'List Google Contacts.',
            parameters: {
                type: 'object',
                properties: {},
                required: [],
            },
        },
    },
    execute: async () => {
        try {
            const result = await runGog(['contacts', 'list', '--max', '20']);
            return result || 'No contacts found.';
        } catch (error: any) {
            return `Error listing contacts: ${error.message}`;
        }
    },
});

// ═══════════════════════════════════════════════════════════════
// GOOGLE SHEETS TOOLS
// ═══════════════════════════════════════════════════════════════

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'sheets_read',
            description: 'Read data from a Google Sheets spreadsheet.',
            parameters: {
                type: 'object',
                properties: {
                    sheet_id: {
                        type: 'string',
                        description: 'The Google Sheets document ID (from the URL)'
                    },
                    range: {
                        type: 'string',
                        description: 'The range to read (e.g. "Sheet1!A1:D10")'
                    }
                },
                required: ['sheet_id', 'range'],
            },
        },
    },
    execute: async (args) => {
        try {
            const result = await runGog(['sheets', 'get', args.sheet_id, args.range, '--json']);
            return result || 'No data found in that range.';
        } catch (error: any) {
            return `Error reading sheet: ${error.message}`;
        }
    },
});

// ═══════════════════════════════════════════════════════════════
// GOOGLE DOCS TOOLS
// ═══════════════════════════════════════════════════════════════

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'docs_read',
            description: 'Read the text content of a Google Docs document.',
            parameters: {
                type: 'object',
                properties: {
                    doc_id: {
                        type: 'string',
                        description: 'The Google Docs document ID (from the URL)'
                    }
                },
                required: ['doc_id'],
            },
        },
    },
    execute: async (args) => {
        try {
            const result = await runGog(['docs', 'cat', args.doc_id]);
            return result || 'Document is empty.';
        } catch (error: any) {
            return `Error reading document: ${error.message}`;
        }
    },
});

console.log('🔌 Google Workspace tools registered (Gmail, Calendar, Drive, Contacts, Sheets, Docs)');
