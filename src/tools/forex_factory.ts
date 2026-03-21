import { registerTool } from './index.js';
import axios from 'axios';
import { saveForexEvents, ForexEvent } from '../database/index.js';

// ═══════════════════════════════════════════════════════════════
// FOREX FACTORY — Economic Calendar + News
// Uses the public FF JSON calendar feed (no scraping needed)
// ═══════════════════════════════════════════════════════════════

const FF_CALENDAR_THIS_WEEK = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const FF_CALENDAR_NEXT_WEEK = 'https://nfs.faireconomy.media/ff_calendar_nextweek.json';
const JINA_BASE = 'https://r.jina.ai';
const FF_NEWS_URL = 'https://www.forexfactory.com/news';

interface FFCalendarItem {
    title: string;
    country: string;
    date: string;       // ISO string e.g. "2025-03-17T08:30:00-0400"
    impact: string;     // "High" | "Medium" | "Low" | "Non-Economic"
    forecast: string;
    previous: string;
    actual?: string;
}

async function fetchCalendarWeek(url: string): Promise<FFCalendarItem[]> {
    const response = await axios.get<FFCalendarItem[]>(url, { timeout: 15000 });
    return Array.isArray(response.data) ? response.data : [];
}

function toForexEvent(item: FFCalendarItem, index: number): ForexEvent {
    const date = new Date(item.date);
    const event_date = date.toISOString().slice(0, 10);
    const event_time = date.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
    const id = `${event_date}_${item.country}_${item.title}_${index}`.replace(/\s+/g, '_').slice(0, 100);

    return {
        id,
        event_date,
        event_time,
        currency: item.country,
        event_name: item.title,
        impact: item.impact,
        forecast: item.forecast || undefined,
        previous: item.previous || undefined,
        actual: item.actual || undefined,
        fetched_at: new Date().toISOString(),
    };
}

function formatEvents(events: ForexEvent[]): string {
    if (events.length === 0) return 'No se encontraron eventos económicos para el período solicitado.';

    const byDate: Record<string, ForexEvent[]> = {};
    for (const e of events) {
        if (!byDate[e.event_date]) byDate[e.event_date] = [];
        byDate[e.event_date].push(e);
    }

    const impactEmoji: Record<string, string> = { High: '🔴', Medium: '🟠', Low: '🟡', 'Non-Economic': '⚪' };

    let result = '📅 Calendario Económico — Forex Factory\n\n';
    for (const [date, dayEvents] of Object.entries(byDate).sort()) {
        const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('es-AR', {
            weekday: 'long', day: 'numeric', month: 'long'
        });
        result += `${dateLabel.toUpperCase()}\n`;
        for (const e of dayEvents) {
            const emoji = impactEmoji[e.impact] ?? '⚪';
            const time = e.event_time ? `${e.event_time} ` : '';
            const currency = e.currency ? `[${e.currency}] ` : '';
            const forecast = e.forecast ? ` | Prev: ${e.forecast}` : '';
            const prev = e.previous ? ` | Ant: ${e.previous}` : '';
            result += `${emoji} ${time}${currency}${e.event_name}${forecast}${prev}\n`;
        }
        result += '\n';
    }

    return result.trimEnd();
}

// ── get_economic_calendar ───────────────────────────────────────
registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'get_economic_calendar',
            description: 'Fetches the Forex Factory economic calendar. Returns upcoming economic events grouped by day, optionally filtered by impact level (high/medium/low).',
            parameters: {
                type: 'object',
                properties: {
                    impact: {
                        type: 'string',
                        enum: ['high', 'medium', 'low', 'all'],
                        description: 'Filter events by impact level. Default: "high"',
                    },
                    days: {
                        type: 'number',
                        description: 'Number of days ahead to show (1-7). Default: 3',
                    },
                },
                required: [],
            },
        },
    },
    execute: async (args: { impact?: string; days?: number }) => {
        const impactFilter = (args.impact ?? 'high').toLowerCase();
        const days = Math.min(Math.max(args.days ?? 3, 1), 7);

        try {
            // Fetch this week + next week in parallel
            const [thisWeek, nextWeek] = await Promise.allSettled([
                fetchCalendarWeek(FF_CALENDAR_THIS_WEEK),
                fetchCalendarWeek(FF_CALENDAR_NEXT_WEEK),
            ]);

            const raw: FFCalendarItem[] = [
                ...(thisWeek.status === 'fulfilled' ? thisWeek.value : []),
                ...(nextWeek.status === 'fulfilled' ? nextWeek.value : []),
            ];

            if (raw.length === 0) {
                return 'No se pudo obtener el calendario económico. Intentá de nuevo en unos minutos.';
            }

            const allEvents = raw.map((item, i) => toForexEvent(item, i));

            // Save to cache
            saveForexEvents(allEvents);

            // Filter by date range
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const cutoff = new Date(today);
            cutoff.setDate(cutoff.getDate() + days);

            const todayStr = today.toISOString().slice(0, 10);
            const cutoffStr = cutoff.toISOString().slice(0, 10);

            let filtered = allEvents.filter(e => e.event_date >= todayStr && e.event_date <= cutoffStr);

            // Filter by impact
            if (impactFilter !== 'all') {
                const targetImpact = impactFilter.charAt(0).toUpperCase() + impactFilter.slice(1);
                filtered = filtered.filter(e => e.impact === targetImpact);
            }

            return formatEvents(filtered);
        } catch (error: any) {
            return `Error obteniendo el calendario económico: ${error.message}`;
        }
    },
});

// ── get_forex_news ──────────────────────────────────────────────
registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'get_forex_news',
            description: 'Fetches the latest high-impact forex news from Forex Factory. Returns the top 10 most recent news items.',
            parameters: {
                type: 'object',
                properties: {},
                required: [],
            },
        },
    },
    execute: async () => {
        try {
            const response = await axios.get(`${JINA_BASE}/${FF_NEWS_URL}`, {
                headers: { 'Accept': 'text/plain, */*' },
                timeout: 20000,
            });

            let markdown: string = typeof response.data === 'string'
                ? response.data
                : JSON.stringify(response.data);

            if (markdown.length > 20000) markdown = markdown.slice(0, 20000);

            const lines = markdown.split('\n').filter(l => l.trim().length > 0);
            const newsItems: string[] = [];
            let i = 0;
            let count = 0;

            while (i < lines.length && count < 10) {
                const line = lines[i].trim();
                if (line.startsWith('##') || line.startsWith('**')) {
                    const title = line.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim();
                    if (title.length > 5 && title.length < 200) {
                        let summary = '';
                        let j = i + 1;
                        while (j < lines.length && !lines[j].trim()) j++;
                        if (j < lines.length) {
                            const nextLine = lines[j].trim();
                            if (!nextLine.startsWith('#') && !nextLine.startsWith('**') && nextLine.length < 300) {
                                summary = nextLine.replace(/\*/g, '').trim();
                                i = j;
                            }
                        }
                        newsItems.push(`📌 ${title}${summary ? `\n   ${summary}` : ''}`);
                        count++;
                    }
                }
                i++;
            }

            if (newsItems.length === 0) {
                return `📰 Forex Factory News\n\n${markdown.slice(0, 3000)}`;
            }

            return `📰 Forex Factory News — Top ${newsItems.length} noticias\n\n${newsItems.join('\n\n')}`;
        } catch (error: any) {
            return `Error obteniendo noticias de Forex Factory: ${error.message}`;
        }
    },
});

console.log('📈 Forex Factory tools registered (economic calendar + news)');

export { parseForexCalendar } from '../utils/forex-parser.js';
