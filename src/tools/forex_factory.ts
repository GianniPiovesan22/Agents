import { registerTool } from './index.js';
import axios from 'axios';
import { saveForexEvents, ForexEvent } from '../database/index.js';

// ═══════════════════════════════════════════════════════════════
// FOREX FACTORY — Economic Calendar + News
// ═══════════════════════════════════════════════════════════════

const JINA_BASE = 'https://r.jina.ai';
const FF_CALENDAR_URL = 'https://www.forexfactory.com/calendar';
const FF_NEWS_URL = 'https://www.forexfactory.com/news';

/**
 * Determine impact level from text found in the markdown.
 * Forex Factory uses color-coded icons; Jina renders them as alt text or labels.
 */
function parseImpact(raw: string): string {
    const lower = raw.toLowerCase();
    if (lower.includes('high') || lower.includes('red')) return 'High';
    if (lower.includes('medium') || lower.includes('orange')) return 'Medium';
    if (lower.includes('low') || lower.includes('yellow')) return 'Low';
    return 'Low';
}

/**
 * Parses the Jina-rendered markdown of the FF calendar page.
 * Returns an array of structured event objects.
 */
function parseCalendarMarkdown(markdown: string): ForexEvent[] {
    const events: ForexEvent[] = [];
    const fetched_at = new Date().toISOString();

    // Split into lines and scan for table rows or structured data.
    // Jina typically renders the FF calendar as a markdown table or line-delimited blocks.
    // We look for lines that have a time pattern (HH:MM), currency code (3 letters), and event name.
    const lines = markdown.split('\n');

    // State to track current date header
    let currentDate = new Date().toISOString().slice(0, 10);
    let eventIndex = 0;

    // Regex to capture table-like rows: time | currency | impact | event | forecast | previous | actual
    // Jina may render FF calendar as: | time | currency | impact | event | forecast | previous | actual |
    const tableRowRe = /^\|?\s*([\d:apmAPM]*)\s*\|?\s*([A-Z]{3})\s*\|?\s*(\w+)\s*\|?\s*([^|]+?)\s*\|?\s*([^|]*?)\s*\|?\s*([^|]*?)\s*\|?\s*([^|]*?)\s*\|?$/;

    // Also handle date headers like "Mon Mar 17" or "Monday, March 17, 2025"
    const dateHeaderRe = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2},?\s+\d{4}/i;
    const dateShortRe = /\b(mon|tue|wed|thu|fri|sat|sun)\w*\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{1,2})/i;

    for (const rawLine of lines) {
        const line = rawLine.trim();

        // Detect date headers
        const dateHeaderMatch = line.match(dateHeaderRe);
        if (dateHeaderMatch) {
            const parsed = new Date(dateHeaderMatch[0]);
            if (!isNaN(parsed.getTime())) {
                currentDate = parsed.toISOString().slice(0, 10);
            }
            continue;
        }

        const dateShortMatch = line.match(dateShortRe);
        if (dateShortMatch) {
            const year = new Date().getFullYear();
            const parsed = new Date(`${dateShortMatch[2]} ${dateShortMatch[3]} ${year}`);
            if (!isNaN(parsed.getTime())) {
                currentDate = parsed.toISOString().slice(0, 10);
            }
            continue;
        }

        // Try to match a table row with at least currency + event
        const match = line.match(tableRowRe);
        if (match) {
            const [, time, currency, impactRaw, eventName, forecast, previous, actual] = match;
            const cleanName = eventName.replace(/\*/g, '').trim();
            if (!cleanName || cleanName === 'Event' || cleanName === '---') continue;

            const impact = parseImpact(impactRaw);
            const id = `${currentDate}_${currency}_${cleanName}_${eventIndex++}`.replace(/\s+/g, '_').slice(0, 100);

            events.push({
                id,
                event_date: currentDate,
                event_time: time.trim() || undefined,
                currency: currency.trim(),
                event_name: cleanName,
                impact,
                forecast: forecast?.trim() || undefined,
                previous: previous?.trim() || undefined,
                actual: actual?.trim() || undefined,
                fetched_at,
            });
        }
    }

    return events;
}

/**
 * Format events grouped by day for display.
 */
function formatEvents(events: ForexEvent[]): string {
    if (events.length === 0) return 'No se encontraron eventos económicos para el período solicitado.';

    // Group by date
    const byDate: Record<string, ForexEvent[]> = {};
    for (const e of events) {
        if (!byDate[e.event_date]) byDate[e.event_date] = [];
        byDate[e.event_date].push(e);
    }

    const impactEmoji: Record<string, string> = { High: '🔴', Medium: '🟠', Low: '🟡' };

    let result = '📅 **Calendario Económico — Forex Factory**\n\n';
    for (const [date, dayEvents] of Object.entries(byDate).sort()) {
        const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('es-AR', {
            weekday: 'long', day: 'numeric', month: 'long'
        });
        result += `**${dateLabel}**\n`;
        for (const e of dayEvents) {
            const emoji = impactEmoji[e.impact] ?? '⚪';
            const time = e.event_time ? `\`${e.event_time}\` ` : '';
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
            const response = await axios.get(`${JINA_BASE}/${FF_CALENDAR_URL}`, {
                headers: { 'Accept': 'text/plain, */*' },
                timeout: 20000,
            });

            let markdown: string = typeof response.data === 'string'
                ? response.data
                : JSON.stringify(response.data);

            if (markdown.length > 40000) {
                markdown = markdown.slice(0, 40000);
            }

            const allEvents = parseCalendarMarkdown(markdown);

            // Filter by date range
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() + days);
            const cutoffStr = cutoff.toISOString().slice(0, 10);
            const todayStr = new Date().toISOString().slice(0, 10);

            let filtered = allEvents.filter(e => e.event_date >= todayStr && e.event_date <= cutoffStr);

            // Filter by impact
            if (impactFilter !== 'all') {
                const targetImpact = impactFilter.charAt(0).toUpperCase() + impactFilter.slice(1);
                filtered = filtered.filter(e => e.impact === targetImpact);
            }

            // Cache to SQLite
            if (allEvents.length > 0) {
                saveForexEvents(allEvents);
            }

            return formatEvents(filtered);
        } catch (error: any) {
            return `Error obteniendo el calendario económico de Forex Factory: ${error.message}`;
        }
    },
});

// ── get_forex_news ──────────────────────────────────────────────
registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'get_forex_news',
            description: 'Fetches the latest high-impact forex news from Forex Factory. Returns the top 10 most recent news items with title, time, and summary.',
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

            if (markdown.length > 20000) {
                markdown = markdown.slice(0, 20000);
            }

            // Extract news items: look for lines that resemble news entries
            // Jina renders FF news as markdown with headings/paragraphs
            const lines = markdown.split('\n').filter(l => l.trim().length > 0);
            const newsItems: string[] = [];
            let i = 0;
            let count = 0;

            while (i < lines.length && count < 10) {
                const line = lines[i].trim();
                // Heading lines (## or ### or bold) often are news titles
                if (line.startsWith('##') || line.startsWith('**')) {
                    const title = line.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim();
                    if (title.length > 5 && title.length < 200) {
                        // Try to grab the next non-empty line as summary
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
                        newsItems.push(`• **${title}**${summary ? `\n  ${summary}` : ''}`);
                        count++;
                    }
                }
                i++;
            }

            if (newsItems.length === 0) {
                // Fallback: return raw truncated markdown
                return `📰 **Forex Factory News**\n\n${markdown.slice(0, 3000)}\n\n_(Vista cruda — el parser no encontró ítems estructurados)_`;
            }

            return `📰 **Forex Factory News** — Top ${newsItems.length} noticias\n\n${newsItems.join('\n\n')}`;
        } catch (error: any) {
            return `Error obteniendo noticias de Forex Factory: ${error.message}`;
        }
    },
});

console.log('📈 Forex Factory tools registered (economic calendar + news)');
