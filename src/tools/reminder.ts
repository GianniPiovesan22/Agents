import { registerTool } from './index.js';
import { createReminder } from '../database/index.js';
import { getGoogleAuth } from '../google/auth.js';
import { google } from 'googleapis';

// Day-of-week abbreviations for RRULE BYDAY (0=SU,1=MO,...,6=SA)
const WEEKDAY_RRULE = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * Build a recurrence pattern string stored in DB.
 * Format: "daily" | "weekly:N" (0–6) | "monthly:N" (1–31)
 */
function buildRecurrencePattern(
    recurrence: 'daily' | 'weekly' | 'monthly',
    recurrence_day?: number
): string {
    if (recurrence === 'daily') return 'daily';
    if (recurrence === 'weekly') return `weekly:${recurrence_day ?? 1}`;
    return `monthly:${recurrence_day ?? 1}`;
}

/**
 * Compute the first fire datetime based on recurrence pattern + time string "HH:MM".
 * Returns a Date >= now.
 */
function computeFirstFireAt(
    recurrence: 'daily' | 'weekly' | 'monthly',
    recurrence_day: number | undefined,
    recurrence_time: string
): Date {
    const [hh, mm] = recurrence_time.split(':').map(Number);
    const now = new Date();

    const candidate = new Date(now);
    candidate.setSeconds(0, 0);
    candidate.setHours(hh, mm, 0, 0);

    if (recurrence === 'daily') {
        if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
        return candidate;
    }

    if (recurrence === 'weekly') {
        const targetDay = recurrence_day ?? 1; // 0=Sun … 6=Sat
        const currentDay = candidate.getDay();
        let daysAhead = (targetDay - currentDay + 7) % 7;
        if (daysAhead === 0 && candidate <= now) daysAhead = 7;
        candidate.setDate(candidate.getDate() + daysAhead);
        return candidate;
    }

    // monthly
    const targetDom = recurrence_day ?? 1;
    candidate.setDate(targetDom);
    if (candidate <= now) {
        candidate.setMonth(candidate.getMonth() + 1);
        candidate.setDate(targetDom);
    }
    return candidate;
}

/**
 * Build the RRULE string for Google Calendar.
 */
function buildRRule(recurrencePattern: string): string {
    if (recurrencePattern === 'daily') return 'RRULE:FREQ=DAILY';
    if (recurrencePattern.startsWith('weekly:')) {
        const day = parseInt(recurrencePattern.split(':')[1], 10);
        const byday = WEEKDAY_RRULE[day] ?? 'MO';
        return `RRULE:FREQ=WEEKLY;BYDAY=${byday}`;
    }
    if (recurrencePattern.startsWith('monthly:')) {
        const dom = recurrencePattern.split(':')[1];
        return `RRULE:FREQ=MONTHLY;BYMONTHDAY=${dom}`;
    }
    return 'RRULE:FREQ=DAILY';
}

/**
 * Create a recurring event in Google Calendar. Errors are logged but do NOT
 * prevent the local reminder from being saved.
 */
async function createCalendarRecurringEvent(
    message: string,
    firstFireAt: Date,
    recurrencePattern: string
): Promise<void> {
    try {
        const auth = getGoogleAuth();
        const calendar = google.calendar({ version: 'v3', auth });

        const startIso = firstFireAt.toISOString();
        const endDate = new Date(firstFireAt.getTime() + 30 * 60 * 1000);
        const endIso = endDate.toISOString();

        await calendar.events.insert({
            calendarId: 'primary',
            requestBody: {
                summary: message,
                start: { dateTime: startIso },
                end: { dateTime: endIso },
                recurrence: [buildRRule(recurrencePattern)],
            },
        });
    } catch (err: any) {
        console.error('Google Calendar recurring event creation failed:', err.message);
    }
}

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'create_reminder',
            description: 'Creates a reminder that will be sent to the user via a message at the specified time. Supports one-off and recurring reminders (daily, weekly, monthly).',
            parameters: {
                type: 'object',
                properties: {
                    _userId: { type: 'string', description: 'Internal user ID, automatically populated, do not pass' },
                    message: { type: 'string', description: 'The reminder message to send' },
                    time: {
                        type: 'string',
                        description: 'ISO 8601 string for one-off reminders (e.g. 2026-03-07T15:00:00-03:00). Ignored when recurrence is set.'
                    },
                    recurrence: {
                        type: 'string',
                        enum: ['daily', 'weekly', 'monthly'],
                        description: 'Recurrence type. If set, the reminder repeats.'
                    },
                    recurrence_day: {
                        type: 'number',
                        description: 'For weekly: day of week 0=Sunday … 6=Saturday. For monthly: day of month 1–31.'
                    },
                    recurrence_time: {
                        type: 'string',
                        description: 'Time for recurring reminder in "HH:MM" 24h format (e.g. "09:00"). Required when recurrence is set.'
                    }
                },
                required: ['message', '_userId']
            }
        }
    },
    execute: async (args: {
        _userId?: string;
        message: string;
        time?: string;
        recurrence?: 'daily' | 'weekly' | 'monthly';
        recurrence_day?: number;
        recurrence_time?: string;
    }) => {
        if (!args._userId) return 'Error: user_id no proporcionado internamente.';

        try {
            if (args.recurrence) {
                // --- Recurring reminder ---
                if (!args.recurrence_time) {
                    return 'Error: recurrence_time es requerido para recordatorios recurrentes (formato "HH:MM").';
                }

                const pattern = buildRecurrencePattern(args.recurrence, args.recurrence_day);
                const firstFireAt = computeFirstFireAt(args.recurrence, args.recurrence_day, args.recurrence_time);

                await createReminder(
                    args._userId,
                    args.message,
                    firstFireAt,
                    pattern,
                    args.recurrence_time
                );

                // Sync to Google Calendar (best-effort)
                await createCalendarRecurringEvent(args.message, firstFireAt, pattern);

                return `Recordatorio recurrente creado. Primer disparo: ${firstFireAt.toLocaleString()}. Patrón: ${pattern}.`;
            } else {
                // --- One-off reminder ---
                if (!args.time) {
                    return 'Error: time es requerido para recordatorios puntuales (formato ISO 8601).';
                }
                const remindAt = new Date(args.time);
                if (isNaN(remindAt.getTime())) {
                    return 'Error: Formato de fecha inválido. Utilizá formato ISO 8601.';
                }
                await createReminder(args._userId, args.message, remindAt);
                return `Recordatorio guardado con éxito. Se te avisará a las: ${remindAt.toLocaleString()}`;
            }
        } catch (error: any) {
            return `Error creando recordatorio: ${error.message}`;
        }
    }
});
