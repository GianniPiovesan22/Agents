import type { ForexEvent } from '../database/index.js';

const tableRowRe = /^\|?\s*([\d:apmAPM]*)\s*\|?\s*([A-Z]{3})\s*\|?\s*(\w+)\s*\|?\s*([^|]+?)\s*\|?\s*([^|]*?)\s*\|?\s*([^|]*?)\s*\|?\s*([^|]*?)\s*\|?$/;
const dateHeaderRe = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2},?\s+\d{4}/i;
const dateShortRe = /\b(mon|tue|wed|thu|fri|sat|sun)\w*\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{1,2})/i;

export function parseForexCalendar(markdown: string, initialDate?: string): ForexEvent[] {
    const fetched_at = new Date().toISOString();
    const lines = markdown.split('\n');
    let currentDate = initialDate ?? new Date().toISOString().slice(0, 10);
    let idx = 0;
    const parsed: ForexEvent[] = [];

    for (const rawLine of lines) {
        const line = rawLine.trim();

        const dh = line.match(dateHeaderRe);
        if (dh) {
            const p = new Date(dh[0]);
            if (!isNaN(p.getTime())) currentDate = p.toISOString().slice(0, 10);
            continue;
        }

        const ds = line.match(dateShortRe);
        if (ds) {
            const p = new Date(`${ds[2]} ${ds[3]} ${new Date().getFullYear()}`);
            if (!isNaN(p.getTime())) currentDate = p.toISOString().slice(0, 10);
            continue;
        }

        const m = line.match(tableRowRe);
        if (m) {
            const [, time, currency, impactRaw, eventName, forecast, previous, actual] = m;
            const cleanName = eventName.replace(/\*/g, '').trim();
            if (!cleanName || cleanName === 'Event' || cleanName === '---') continue;

            const lower = impactRaw.toLowerCase();
            const impact = lower.includes('high') || lower.includes('red') ? 'High'
                : lower.includes('medium') || lower.includes('orange') ? 'Medium' : 'Low';

            const id = `${currentDate}_${currency}_${cleanName}_${idx++}`.replace(/\s+/g, '_').slice(0, 100);

            parsed.push({
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

    return parsed;
}
