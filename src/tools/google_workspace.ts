import { registerTool } from './index.js';
import { getGoogleAuth } from '../google/auth.js';
import { google } from 'googleapis';

const NOT_CONFIGURED = 'Google Workspace no configurado. Contactá al admin.';

function isNotConfigured(err: unknown): boolean {
    return err instanceof Error && err.message.includes('Google auth not configured');
}

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
            const auth = getGoogleAuth();
            const gmail = google.gmail({ version: 'v1', auth });

            const listRes = await gmail.users.threads.list({
                userId: 'me',
                q: args.query,
                maxResults: 10,
            });

            const threads = listRes.data.threads;
            if (!threads || threads.length === 0) {
                return 'No emails found matching your search.';
            }

            const lines: string[] = [`Found ${threads.length} thread(s):\n`];

            for (const thread of threads) {
                const threadRes = await gmail.users.threads.get({
                    userId: 'me',
                    id: thread.id!,
                    format: 'metadata',
                    metadataHeaders: ['Subject', 'From', 'Date'],
                });

                const msg = threadRes.data.messages?.[0];
                const headers = msg?.payload?.headers ?? [];
                const get = (name: string) => headers.find(h => h.name === name)?.value ?? '(unknown)';

                lines.push(`- Subject: ${get('Subject')}`);
                lines.push(`  From: ${get('From')}`);
                lines.push(`  Date: ${get('Date')}`);
                lines.push(`  Thread ID: ${thread.id}`);
                lines.push('');
            }

            return lines.join('\n');
        } catch (error: any) {
            if (isNotConfigured(error)) return NOT_CONFIGURED;
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
            const auth = getGoogleAuth();
            const gmail = google.gmail({ version: 'v1', auth });

            const listRes = await gmail.users.messages.list({
                userId: 'me',
                q: args.query,
                maxResults: 10,
            });

            const messages = listRes.data.messages;
            if (!messages || messages.length === 0) {
                return 'No messages found.';
            }

            const lines: string[] = [`Found ${messages.length} message(s):\n`];

            for (const msg of messages) {
                const msgRes = await gmail.users.messages.get({
                    userId: 'me',
                    id: msg.id!,
                    format: 'metadata',
                    metadataHeaders: ['Subject', 'From', 'Date'],
                });

                const headers = msgRes.data.payload?.headers ?? [];
                const get = (name: string) => headers.find(h => h.name === name)?.value ?? '(unknown)';
                const snippet = msgRes.data.snippet ?? '';

                lines.push(`- Subject: ${get('Subject')}`);
                lines.push(`  From: ${get('From')}`);
                lines.push(`  Date: ${get('Date')}`);
                lines.push(`  Snippet: ${snippet}`);
                lines.push(`  Message ID: ${msg.id}`);
                lines.push('');
            }

            return lines.join('\n');
        } catch (error: any) {
            if (isNotConfigured(error)) return NOT_CONFIGURED;
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
            const auth = getGoogleAuth();
            const gmail = google.gmail({ version: 'v1', auth });

            const contentType = args.html ? 'text/html' : 'text/plain';
            const raw = [
                `To: ${args.to}`,
                `Subject: ${args.subject}`,
                `Content-Type: ${contentType}; charset=utf-8`,
                `MIME-Version: 1.0`,
                '',
                args.body,
            ].join('\r\n');

            const encoded = Buffer.from(raw)
                .toString('base64')
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=+$/, '');

            await gmail.users.messages.send({
                userId: 'me',
                requestBody: { raw: encoded },
            });

            return `Email sent successfully to ${args.to}.`;
        } catch (error: any) {
            if (isNotConfigured(error)) return NOT_CONFIGURED;
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
            const auth = getGoogleAuth();
            const gmail = google.gmail({ version: 'v1', auth });

            const raw = [
                `To: ${args.to}`,
                `Subject: ${args.subject}`,
                `Content-Type: text/plain; charset=utf-8`,
                `MIME-Version: 1.0`,
                '',
                args.body,
            ].join('\r\n');

            const encoded = Buffer.from(raw)
                .toString('base64')
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=+$/, '');

            const res = await gmail.users.drafts.create({
                userId: 'me',
                requestBody: { message: { raw: encoded } },
            });

            return `Draft created successfully. Draft ID: ${res.data.id}`;
        } catch (error: any) {
            if (isNotConfigured(error)) return NOT_CONFIGURED;
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
            const auth = getGoogleAuth();
            const calendar = google.calendar({ version: 'v3', auth });

            const res = await calendar.events.list({
                calendarId: args.calendar_id,
                timeMin: args.from,
                timeMax: args.to,
                singleEvents: true,
                orderBy: 'startTime',
                maxResults: 20,
            });

            const events = res.data.items;
            if (!events || events.length === 0) {
                return 'No events found for that date range.';
            }

            const lines: string[] = [`Found ${events.length} event(s):\n`];

            for (const event of events) {
                const start = event.start?.dateTime ?? event.start?.date ?? '(no start)';
                const end = event.end?.dateTime ?? event.end?.date ?? '(no end)';
                lines.push(`- ${event.summary ?? '(no title)'}`);
                lines.push(`  Start: ${start}`);
                lines.push(`  End:   ${end}`);
                if (event.description) lines.push(`  Description: ${event.description}`);
                if (event.location) lines.push(`  Location: ${event.location}`);
                lines.push('');
            }

            return lines.join('\n');
        } catch (error: any) {
            if (isNotConfigured(error)) return NOT_CONFIGURED;
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
            const auth = getGoogleAuth();
            const calendar = google.calendar({ version: 'v3', auth });

            const res = await calendar.events.insert({
                calendarId: args.calendar_id,
                requestBody: {
                    summary: args.summary,
                    description: args.description,
                    start: { dateTime: args.from },
                    end: { dateTime: args.to },
                },
            });

            return `Event "${args.summary}" created. Event ID: ${res.data.id}`;
        } catch (error: any) {
            if (isNotConfigured(error)) return NOT_CONFIGURED;
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
            const auth = getGoogleAuth();
            const drive = google.drive({ version: 'v3', auth });

            const res = await drive.files.list({
                q: `fullText contains '${args.query.replace(/'/g, "\\'")}' and trashed = false`,
                pageSize: 10,
                fields: 'files(id, name, mimeType, modifiedTime, size)',
            });

            const files = res.data.files;
            if (!files || files.length === 0) {
                return 'No files found matching your search.';
            }

            const lines: string[] = [`Found ${files.length} file(s):\n`];
            for (const file of files) {
                lines.push(`- ${file.name ?? '(unnamed)'}`);
                lines.push(`  Type: ${file.mimeType ?? '(unknown)'}`);
                lines.push(`  Modified: ${file.modifiedTime ?? '(unknown)'}`);
                lines.push(`  ID: ${file.id}`);
                lines.push('');
            }

            return lines.join('\n');
        } catch (error: any) {
            if (isNotConfigured(error)) return NOT_CONFIGURED;
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
            const auth = getGoogleAuth();
            const drive = google.drive({ version: 'v3', auth });

            const parentId = args.folder_id ?? 'root';
            const res = await drive.files.list({
                q: `'${parentId}' in parents and trashed = false`,
                pageSize: 20,
                fields: 'files(id, name, mimeType, modifiedTime)',
            });

            const files = res.data.files;
            if (!files || files.length === 0) {
                return 'No files found.';
            }

            const lines: string[] = [`Found ${files.length} file(s):\n`];
            for (const file of files) {
                lines.push(`- ${file.name ?? '(unnamed)'}`);
                lines.push(`  Type: ${file.mimeType ?? '(unknown)'}`);
                lines.push(`  Modified: ${file.modifiedTime ?? '(unknown)'}`);
                lines.push(`  ID: ${file.id}`);
                lines.push('');
            }

            return lines.join('\n');
        } catch (error: any) {
            if (isNotConfigured(error)) return NOT_CONFIGURED;
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
            const auth = getGoogleAuth();
            const people = google.people({ version: 'v1', auth });

            const res = await people.otherContacts.list({
                pageSize: 20,
                readMask: 'names,emailAddresses,phoneNumbers',
            });

            const contacts = res.data.otherContacts;
            if (!contacts || contacts.length === 0) {
                return 'No contacts found.';
            }

            const lines: string[] = [`Found ${contacts.length} contact(s):\n`];
            for (const contact of contacts) {
                const name = contact.names?.[0]?.displayName ?? '(no name)';
                const email = contact.emailAddresses?.[0]?.value ?? '(no email)';
                const phone = contact.phoneNumbers?.[0]?.value ?? '';
                lines.push(`- ${name}`);
                lines.push(`  Email: ${email}`);
                if (phone) lines.push(`  Phone: ${phone}`);
                lines.push('');
            }

            return lines.join('\n');
        } catch (error: any) {
            if (isNotConfigured(error)) return NOT_CONFIGURED;
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
            const auth = getGoogleAuth();
            const sheets = google.sheets({ version: 'v4', auth });

            const res = await sheets.spreadsheets.values.get({
                spreadsheetId: args.sheet_id,
                range: args.range,
            });

            const values = res.data.values;
            if (!values || values.length === 0) {
                return 'No data found in that range.';
            }

            const lines: string[] = [];
            for (const row of values) {
                lines.push(row.join('\t'));
            }

            return lines.join('\n');
        } catch (error: any) {
            if (isNotConfigured(error)) return NOT_CONFIGURED;
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
            const auth = getGoogleAuth();
            const docs = google.docs({ version: 'v1', auth });

            const res = await docs.documents.get({ documentId: args.doc_id });

            const content = res.data.body?.content;
            if (!content || content.length === 0) {
                return 'Document is empty.';
            }

            const textParts: string[] = [];

            for (const element of content) {
                if (element.paragraph) {
                    const paraText = (element.paragraph.elements ?? [])
                        .map(el => el.textRun?.content ?? '')
                        .join('');
                    textParts.push(paraText);
                }
            }

            const text = textParts.join('').trim();
            return text || 'Document is empty.';
        } catch (error: any) {
            if (isNotConfigured(error)) return NOT_CONFIGURED;
            return `Error reading document: ${error.message}`;
        }
    },
});

// ═══════════════════════════════════════════════════════════════
// GMAIL REPLY
// ═══════════════════════════════════════════════════════════════

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'gmail_reply',
            description: 'Reply to an existing Gmail thread. Fetches the last message in the thread and sends a reply with proper In-Reply-To and References headers.',
            parameters: {
                type: 'object',
                properties: {
                    thread_id: {
                        type: 'string',
                        description: 'The Gmail thread ID to reply to'
                    },
                    body: {
                        type: 'string',
                        description: 'The reply body text (plain text)'
                    }
                },
                required: ['thread_id', 'body'],
            },
        },
    },
    execute: async (args) => {
        try {
            const auth = getGoogleAuth();
            const gmail = google.gmail({ version: 'v1', auth });

            // Get the last message in the thread
            const threadRes = await gmail.users.threads.get({
                userId: 'me',
                id: args.thread_id,
                format: 'metadata',
                metadataHeaders: ['Subject', 'From', 'To', 'Message-ID', 'References'],
            });

            const messages = threadRes.data.messages;
            if (!messages || messages.length === 0) {
                return `Error: No messages found in thread ${args.thread_id}`;
            }

            const lastMsg = messages[messages.length - 1];
            const headers = lastMsg.payload?.headers ?? [];
            const get = (name: string) => headers.find(h => h.name === name)?.value ?? '';

            const subject = get('Subject');
            const from = get('From');
            const messageId = get('Message-ID');
            const references = get('References');

            // Build reply — send back to the original sender
            const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
            const newReferences = references
                ? `${references} ${messageId}`
                : messageId;

            const rawLines = [
                `To: ${from}`,
                `Subject: ${replySubject}`,
                `In-Reply-To: ${messageId}`,
                `References: ${newReferences}`,
                `Content-Type: text/plain; charset=utf-8`,
                `MIME-Version: 1.0`,
                '',
                args.body,
            ];

            const raw = Buffer.from(rawLines.join('\r\n'))
                .toString('base64')
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=+$/, '');

            await gmail.users.messages.send({
                userId: 'me',
                requestBody: { raw, threadId: args.thread_id },
            });

            return `Respuesta enviada correctamente al hilo ${args.thread_id}.`;
        } catch (error: any) {
            if (isNotConfigured(error)) return NOT_CONFIGURED;
            return `Error replying to thread: ${error.message}`;
        }
    },
});

// ═══════════════════════════════════════════════════════════════
// CREATE GOOGLE DOC
// ═══════════════════════════════════════════════════════════════

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'create_google_doc',
            description: 'Create a new Google Docs document with a title and text content.',
            parameters: {
                type: 'object',
                properties: {
                    title: {
                        type: 'string',
                        description: 'The title of the new document'
                    },
                    content: {
                        type: 'string',
                        description: 'The text content to insert into the document'
                    }
                },
                required: ['title', 'content'],
            },
        },
    },
    execute: async (args) => {
        try {
            const auth = getGoogleAuth();
            const docs = google.docs({ version: 'v1', auth });

            // Create the document
            const createRes = await docs.documents.create({
                requestBody: { title: args.title },
            });

            const docId = createRes.data.documentId;
            if (!docId) return 'Error: No se pudo obtener el ID del documento creado.';

            // Insert the content
            await docs.documents.batchUpdate({
                documentId: docId,
                requestBody: {
                    requests: [
                        {
                            insertText: {
                                location: { index: 1 },
                                text: args.content,
                            },
                        },
                    ],
                },
            });

            return `Documento "${args.title}" creado correctamente. ID: ${docId}\nURL: https://docs.google.com/document/d/${docId}/edit`;
        } catch (error: any) {
            if (isNotConfigured(error)) return NOT_CONFIGURED;
            return `Error creating Google Doc: ${error.message}`;
        }
    },
});

// ═══════════════════════════════════════════════════════════════
// SHEETS WRITE
// ═══════════════════════════════════════════════════════════════

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'sheets_write',
            description: 'Write data to a Google Sheets range. Values must be a JSON array of arrays, e.g. [["Name","Age"],["Ana","30"]].',
            parameters: {
                type: 'object',
                properties: {
                    spreadsheet_id: {
                        type: 'string',
                        description: 'The Google Sheets document ID (from the URL)'
                    },
                    range: {
                        type: 'string',
                        description: 'The range to write to (e.g. "Sheet1!A1:B2")'
                    },
                    values: {
                        type: 'string',
                        description: 'JSON string of an array of arrays representing rows and columns (e.g. \'[["A","B"],["1","2"]]\')'
                    }
                },
                required: ['spreadsheet_id', 'range', 'values'],
            },
        },
    },
    execute: async (args) => {
        try {
            const auth = getGoogleAuth();
            const sheets = google.sheets({ version: 'v4', auth });

            let parsedValues: any[][];
            try {
                parsedValues = JSON.parse(args.values);
            } catch {
                return 'Error: el parámetro "values" no es un JSON válido de arrays.';
            }

            const res = await sheets.spreadsheets.values.update({
                spreadsheetId: args.spreadsheet_id,
                range: args.range,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: parsedValues },
            });

            return `Datos escritos correctamente. Celdas actualizadas: ${res.data.updatedCells ?? 0}`;
        } catch (error: any) {
            if (isNotConfigured(error)) return NOT_CONFIGURED;
            return `Error writing to Sheets: ${error.message}`;
        }
    },
});

// ═══════════════════════════════════════════════════════════════
// CALENDAR UPDATE EVENT
// ═══════════════════════════════════════════════════════════════

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'calendar_update_event',
            description: 'Update an existing Google Calendar event. Only the fields you provide will be changed.',
            parameters: {
                type: 'object',
                properties: {
                    event_id: {
                        type: 'string',
                        description: 'The ID of the calendar event to update'
                    },
                    summary: {
                        type: 'string',
                        description: 'New title/summary for the event (optional)'
                    },
                    start_time: {
                        type: 'string',
                        description: 'New start time in ISO 8601 format (optional)'
                    },
                    end_time: {
                        type: 'string',
                        description: 'New end time in ISO 8601 format (optional)'
                    },
                    description: {
                        type: 'string',
                        description: 'New description for the event (optional)'
                    }
                },
                required: ['event_id'],
            },
        },
    },
    execute: async (args) => {
        try {
            const auth = getGoogleAuth();
            const calendar = google.calendar({ version: 'v3', auth });

            const patch: Record<string, any> = {};
            if (args.summary) patch.summary = args.summary;
            if (args.description) patch.description = args.description;
            if (args.start_time) patch.start = { dateTime: args.start_time };
            if (args.end_time) patch.end = { dateTime: args.end_time };

            if (Object.keys(patch).length === 0) {
                return 'No se proporcionaron campos para actualizar.';
            }

            const res = await calendar.events.patch({
                calendarId: 'primary',
                eventId: args.event_id,
                requestBody: patch,
            });

            return `Evento actualizado correctamente. Título: "${res.data.summary}"`;
        } catch (error: any) {
            if (isNotConfigured(error)) return NOT_CONFIGURED;
            return `Error updating calendar event: ${error.message}`;
        }
    },
});

// ═══════════════════════════════════════════════════════════════
// GMAIL — DELETE / TRASH
// ═══════════════════════════════════════════════════════════════

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'gmail_delete',
            description: 'Move a Gmail message or thread to trash.',
            parameters: {
                type: 'object',
                properties: {
                    message_id: {
                        type: 'string',
                        description: 'The Gmail message ID to trash'
                    }
                },
                required: ['message_id'],
            },
        },
    },
    execute: async (args) => {
        try {
            const auth = getGoogleAuth();
            const gmail = google.gmail({ version: 'v1', auth });
            await gmail.users.messages.trash({ userId: 'me', id: args.message_id });
            return `Mensaje ${args.message_id} movido a la papelera.`;
        } catch (error: any) {
            if (isNotConfigured(error)) return NOT_CONFIGURED;
            return `Error eliminando mensaje: ${error.message}`;
        }
    },
});

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'gmail_mark_read',
            description: 'Mark a Gmail message as read or unread.',
            parameters: {
                type: 'object',
                properties: {
                    message_id: {
                        type: 'string',
                        description: 'The Gmail message ID'
                    },
                    read: {
                        type: 'boolean',
                        description: 'true to mark as read, false to mark as unread'
                    }
                },
                required: ['message_id', 'read'],
            },
        },
    },
    execute: async (args) => {
        try {
            const auth = getGoogleAuth();
            const gmail = google.gmail({ version: 'v1', auth });
            await gmail.users.messages.modify({
                userId: 'me',
                id: args.message_id,
                requestBody: {
                    removeLabelIds: args.read ? ['UNREAD'] : [],
                    addLabelIds: args.read ? [] : ['UNREAD'],
                },
            });
            return `Mensaje marcado como ${args.read ? 'leído' : 'no leído'}.`;
        } catch (error: any) {
            if (isNotConfigured(error)) return NOT_CONFIGURED;
            return `Error actualizando mensaje: ${error.message}`;
        }
    },
});

// ═══════════════════════════════════════════════════════════════
// CALENDAR — DELETE EVENT
// ═══════════════════════════════════════════════════════════════

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'calendar_delete_event',
            description: 'Delete an event from Google Calendar.',
            parameters: {
                type: 'object',
                properties: {
                    event_id: {
                        type: 'string',
                        description: 'The ID of the calendar event to delete'
                    }
                },
                required: ['event_id'],
            },
        },
    },
    execute: async (args) => {
        try {
            const auth = getGoogleAuth();
            const calendar = google.calendar({ version: 'v3', auth });
            await calendar.events.delete({ calendarId: 'primary', eventId: args.event_id });
            return `Evento ${args.event_id} eliminado correctamente.`;
        } catch (error: any) {
            if (isNotConfigured(error)) return NOT_CONFIGURED;
            return `Error eliminando evento: ${error.message}`;
        }
    },
});

// ═══════════════════════════════════════════════════════════════
// DRIVE — CREATE FOLDER / MOVE FILE / SHARE FILE / DELETE FILE
// ═══════════════════════════════════════════════════════════════

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'drive_create_folder',
            description: 'Create a new folder in Google Drive.',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'Name of the new folder'
                    },
                    parent_id: {
                        type: 'string',
                        description: 'Parent folder ID (omit to create in root)'
                    }
                },
                required: ['name'],
            },
        },
    },
    execute: async (args) => {
        try {
            const auth = getGoogleAuth();
            const drive = google.drive({ version: 'v3', auth });
            const res = await drive.files.create({
                requestBody: {
                    name: args.name,
                    mimeType: 'application/vnd.google-apps.folder',
                    parents: args.parent_id ? [args.parent_id] : undefined,
                },
                fields: 'id, name',
            });
            return `Carpeta "${res.data.name}" creada. ID: ${res.data.id}`;
        } catch (error: any) {
            if (isNotConfigured(error)) return NOT_CONFIGURED;
            return `Error creando carpeta: ${error.message}`;
        }
    },
});

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'drive_move_file',
            description: 'Move a file to a different folder in Google Drive.',
            parameters: {
                type: 'object',
                properties: {
                    file_id: {
                        type: 'string',
                        description: 'The ID of the file to move'
                    },
                    folder_id: {
                        type: 'string',
                        description: 'The ID of the destination folder'
                    }
                },
                required: ['file_id', 'folder_id'],
            },
        },
    },
    execute: async (args) => {
        try {
            const auth = getGoogleAuth();
            const drive = google.drive({ version: 'v3', auth });
            const file = await drive.files.get({ fileId: args.file_id, fields: 'parents' });
            const previousParents = (file.data.parents ?? []).join(',');
            const res = await drive.files.update({
                fileId: args.file_id,
                addParents: args.folder_id,
                removeParents: previousParents,
                fields: 'id, name, parents',
            });
            return `Archivo "${res.data.name}" movido correctamente.`;
        } catch (error: any) {
            if (isNotConfigured(error)) return NOT_CONFIGURED;
            return `Error moviendo archivo: ${error.message}`;
        }
    },
});

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'drive_share_file',
            description: 'Share a Google Drive file with someone by email.',
            parameters: {
                type: 'object',
                properties: {
                    file_id: {
                        type: 'string',
                        description: 'The ID of the file to share'
                    },
                    email: {
                        type: 'string',
                        description: 'Email address of the person to share with'
                    },
                    role: {
                        type: 'string',
                        enum: ['reader', 'commenter', 'writer'],
                        description: 'Permission level: reader, commenter, or writer. Default: reader'
                    }
                },
                required: ['file_id', 'email'],
            },
        },
    },
    execute: async (args) => {
        try {
            const auth = getGoogleAuth();
            const drive = google.drive({ version: 'v3', auth });
            await drive.permissions.create({
                fileId: args.file_id,
                requestBody: {
                    type: 'user',
                    role: args.role ?? 'reader',
                    emailAddress: args.email,
                },
            });
            return `Archivo compartido con ${args.email} como ${args.role ?? 'reader'}.`;
        } catch (error: any) {
            if (isNotConfigured(error)) return NOT_CONFIGURED;
            return `Error compartiendo archivo: ${error.message}`;
        }
    },
});

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'drive_delete_file',
            description: 'Move a file to trash in Google Drive.',
            parameters: {
                type: 'object',
                properties: {
                    file_id: {
                        type: 'string',
                        description: 'The ID of the file to delete'
                    }
                },
                required: ['file_id'],
            },
        },
    },
    execute: async (args) => {
        try {
            const auth = getGoogleAuth();
            const drive = google.drive({ version: 'v3', auth });
            await drive.files.update({ fileId: args.file_id, requestBody: { trashed: true } });
            return `Archivo ${args.file_id} movido a la papelera.`;
        } catch (error: any) {
            if (isNotConfigured(error)) return NOT_CONFIGURED;
            return `Error eliminando archivo: ${error.message}`;
        }
    },
});

console.log('Google Workspace tools registered (Gmail, Calendar, Drive, Contacts, Sheets, Docs, + new tools)');
