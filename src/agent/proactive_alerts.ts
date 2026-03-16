import { getGoogleAuth } from '../google/auth.js';
import { google } from 'googleapis';
import { bot } from '../bot/index.js';

// Track sent alerts in-memory to avoid duplicates within the same process run
// Key format: `${userId}:${eventId}:${startTime}`
const sentAlerts = new Set<string>();

export async function checkProactiveAlerts(userId: string): Promise<void> {
    try {
        const auth = getGoogleAuth();
        const calendar = google.calendar({ version: 'v3', auth });

        const now = new Date();
        // Window: events starting between 25 and 35 minutes from now
        const windowStart = new Date(now.getTime() + 25 * 60 * 1000);
        const windowEnd = new Date(now.getTime() + 35 * 60 * 1000);

        const res = await calendar.events.list({
            calendarId: 'primary',
            timeMin: windowStart.toISOString(),
            timeMax: windowEnd.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 10,
        });

        const items = res.data.items;
        if (!items || items.length === 0) return;

        for (const event of items) {
            const eventId = event.id ?? '';
            const startRaw = event.start?.dateTime ?? event.start?.date ?? '';
            const alertKey = `${userId}:${eventId}:${startRaw}`;

            // Skip if already alerted
            if (sentAlerts.has(alertKey)) continue;

            const title = event.summary ?? '(sin título)';
            const startDate = startRaw ? new Date(startRaw) : null;
            const timeStr = startDate
                ? startDate.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
                : '';

            const message = `⏰ Recordatorio: *${title}* en 30 minutos${timeStr ? ` (${timeStr})` : ''}`;

            try {
                await bot.api.sendMessage(userId, message, { parse_mode: 'Markdown' });
                sentAlerts.add(alertKey);
                console.log(`Proactive alert sent to ${userId}: ${title}`);
            } catch (err: any) {
                console.error(`Error enviando alerta proactiva al user ${userId}:`, err.message);
            }
        }
    } catch (e: any) {
        // Silently ignore Google auth errors (not configured)
        if (!e.message?.includes('Google auth not configured')) {
            console.error(`checkProactiveAlerts error for user ${userId}:`, e.message);
        }
    }
}
