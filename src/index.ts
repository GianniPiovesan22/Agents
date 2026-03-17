import { startBot } from './bot/index.js';
import { createWhatsAppServer } from './whatsapp/index.js';
import { config } from './config/index.js';
import cron from 'node-cron';
import { getPendingReminders, markReminderSent, getRecurringReminders, updateReminderNextFire, getUpcomingHighImpactEvents, markForexEventNotified, saveForexEvents, ForexEvent, getStaleLeads } from './database/index.js';
import { bot } from './bot/index.js';
import { sendDailyDigest } from './agent/daily_digest.js';
import { sendWeeklyDigest } from './agent/weekly_digest.js';
import { checkProactiveAlerts } from './agent/proactive_alerts.js';
import axios from 'axios';

/**
 * Compute the next fire datetime for a recurring reminder.
 * recurrencePattern: "daily" | "weekly:N" | "monthly:N"
 * recurrenceTime: "HH:MM"
 */
function computeNextFire(recurrencePattern: string, recurrenceTime: string): Date {
    const [hh, mm] = recurrenceTime.split(':').map(Number);
    const now = new Date();
    const next = new Date(now);
    next.setSeconds(0, 0);
    next.setHours(hh, mm, 0, 0);

    if (recurrencePattern === 'daily') {
        next.setDate(next.getDate() + 1);
        return next;
    }

    if (recurrencePattern.startsWith('weekly:')) {
        const targetDay = parseInt(recurrencePattern.split(':')[1], 10);
        next.setDate(next.getDate() + 7); // same weekday, next week
        next.setHours(hh, mm, 0, 0);
        // Align to correct weekday from now+1day forward
        const base = new Date(now);
        base.setDate(base.getDate() + 1);
        base.setHours(hh, mm, 0, 0);
        let daysAhead = (targetDay - base.getDay() + 7) % 7;
        if (daysAhead === 0) daysAhead = 7;
        base.setDate(base.getDate() + daysAhead);
        return base;
    }

    if (recurrencePattern.startsWith('monthly:')) {
        const dom = parseInt(recurrencePattern.split(':')[1], 10);
        next.setMonth(next.getMonth() + 1);
        next.setDate(dom);
        next.setHours(hh, mm, 0, 0);
        return next;
    }

    // Fallback: daily
    next.setDate(next.getDate() + 1);
    return next;
}

async function main() {
    try {
        // Start Telegram bot
        await startBot();

        // Start WhatsApp webhook server
        if (config.WHATSAPP_ACCESS_TOKEN) {
            createWhatsAppServer();
        } else {
            console.log('📱 WhatsApp not configured — set WHATSAPP_ACCESS_TOKEN to enable');
        }

        // Setup Cron for Reminders (runs every minute)
        cron.schedule('* * * * *', async () => {
            try {
                const pending = await getPendingReminders();
                // Fetch recurring reminder IDs that are due (they also appear in pending)
                const recurringDue = getRecurringReminders().filter(r => r.remindAt <= new Date());
                const recurringDueIds = new Set(recurringDue.map(r => r.id));

                for (const reminder of pending) {
                    try {
                        await bot.api.sendMessage(reminder.userId, `⏰ *Recordatorio:*\n${reminder.message}`, { parse_mode: 'Markdown' });

                        if (typeof reminder.id === 'number' && recurringDueIds.has(reminder.id)) {
                            // Recurring: compute next fire instead of marking sent
                            const rec = recurringDue.find(r => r.id === reminder.id)!;
                            const nextFireAt = computeNextFire(rec.recurrence, rec.recurrenceTime);
                            updateReminderNextFire(rec.id, nextFireAt);
                        } else {
                            await markReminderSent(reminder.id, reminder.source);
                        }
                    } catch (err: any) {
                        console.error(`Error sending reminder to ${reminder.userId}:`, err.message);
                    }
                }
            } catch (e: any) {
                console.error("Cron Reminder Error:", e.message);
            }
        });
        console.log("⏰ Cron job for reminders initialized");

        // Daily Digest Setup (runs at 08:30 AM Buenos Aires time)
        cron.schedule('30 8 * * *', async () => {
            await sendDailyDigest();
        }, { timezone: 'America/Argentina/Buenos_Aires' });
        console.log("🌅 Cron job for Daily Digest initialized (08:30 AM ART)");

        // Weekly Digest Setup (runs every Friday at 9:00 PM Buenos Aires time)
        cron.schedule('0 21 * * 5', async () => {
            await sendWeeklyDigest();
        }, { timezone: 'America/Argentina/Buenos_Aires' });
        console.log("📅 Cron job for Weekly Digest initialized (Friday 09:00 PM ART)");

        // Proactive Alerts (runs every 5 minutes)
        cron.schedule('*/5 * * * *', async () => {
            for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
                await checkProactiveAlerts(userId);
            }
        });
        console.log("🔔 Cron job for Proactive Alerts initialized (every 5 minutes)");

        // Forex Factory — high-impact event alerts (every 15 minutes)
        cron.schedule('*/15 * * * *', async () => {
            try {
                const upcoming = getUpcomingHighImpactEvents(30);
                for (const event of upcoming) {
                    const forecast = event.forecast ? event.forecast : 'N/A';
                    const previous = event.previous ? event.previous : 'N/A';
                    const message = `⚠️ High Impact Event in ~30 min\n📅 ${event.event_name} (${event.currency ?? ''})\n🕐 ${event.event_time ?? 'TBD'}\n📊 Forecast: ${forecast} | Previous: ${previous}`;
                    for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
                        try {
                            await bot.api.sendMessage(userId, message);
                        } catch (sendErr: any) {
                            console.error(`Error sending forex alert to ${userId}:`, sendErr.message);
                        }
                    }
                    markForexEventNotified(event.id);
                }
            } catch (e: any) {
                console.error("Forex alert cron error:", e.message);
            }
        });
        console.log("📈 Cron job for Forex high-impact alerts initialized (every 15 minutes)");

        // Forex Factory — daily calendar cache refresh (runs at 7:00 AM Buenos Aires time)
        cron.schedule('0 7 * * *', async () => {
            try {
                const jinaRes = await axios.get('https://r.jina.ai/https://www.forexfactory.com/calendar', {
                    headers: { 'Accept': 'text/plain, */*' },
                    timeout: 20000,
                });
                let markdown: string = typeof jinaRes.data === 'string'
                    ? jinaRes.data
                    : JSON.stringify(jinaRes.data);
                if (markdown.length > 40000) markdown = markdown.slice(0, 40000);

                const fetched_at = new Date().toISOString();
                const lines = markdown.split('\n');
                let currentDate = new Date().toISOString().slice(0, 10);
                let idx = 0;
                const parsed: ForexEvent[] = [];
                const tableRowRe = /^\|?\s*([\d:apmAPM]*)\s*\|?\s*([A-Z]{3})\s*\|?\s*(\w+)\s*\|?\s*([^|]+?)\s*\|?\s*([^|]*?)\s*\|?\s*([^|]*?)\s*\|?\s*([^|]*?)\s*\|?$/;
                const dateHeaderRe = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2},?\s+\d{4}/i;
                const dateShortRe = /\b(mon|tue|wed|thu|fri|sat|sun)\w*\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{1,2})/i;
                for (const rawLine of lines) {
                    const line = rawLine.trim();
                    const dh = line.match(dateHeaderRe);
                    if (dh) { const p = new Date(dh[0]); if (!isNaN(p.getTime())) currentDate = p.toISOString().slice(0, 10); continue; }
                    const ds = line.match(dateShortRe);
                    if (ds) { const p = new Date(`${ds[2]} ${ds[3]} ${new Date().getFullYear()}`); if (!isNaN(p.getTime())) currentDate = p.toISOString().slice(0, 10); continue; }
                    const m = line.match(tableRowRe);
                    if (m) {
                        const [, time, currency, impactRaw, eventName, forecast, previous, actual] = m;
                        const cleanName = eventName.replace(/\*/g, '').trim();
                        if (!cleanName || cleanName === 'Event' || cleanName === '---') continue;
                        const lower = impactRaw.toLowerCase();
                        const impact = lower.includes('high') || lower.includes('red') ? 'High'
                            : lower.includes('medium') || lower.includes('orange') ? 'Medium' : 'Low';
                        const id = `${currentDate}_${currency}_${cleanName}_${idx++}`.replace(/\s+/g, '_').slice(0, 100);
                        parsed.push({ id, event_date: currentDate, event_time: time.trim() || undefined, currency: currency.trim(), event_name: cleanName, impact, forecast: forecast?.trim() || undefined, previous: previous?.trim() || undefined, actual: actual?.trim() || undefined, fetched_at });
                    }
                }
                if (parsed.length > 0) {
                    saveForexEvents(parsed);
                    console.log(`📈 Forex calendar cache refreshed: ${parsed.length} events saved`);
                }
            } catch (e: any) {
                console.error("Forex calendar daily refresh error:", e.message);
            }
        }, { timezone: 'America/Argentina/Buenos_Aires' });
        console.log("📈 Cron job for Forex calendar daily refresh initialized (07:00 AM ART)");

        // Stale Leads Follow-up (runs every day at 9:00 AM Buenos Aires time)
        cron.schedule('0 9 * * *', async () => {
            try {
                const staleLeads = getStaleLeads(7);
                if (staleLeads.length === 0) return;

                const toAlert = staleLeads.slice(0, 5);

                for (const lead of toAlert) {
                    const updatedAt = new Date(lead.updated_at);
                    const daysAgo = Math.floor((Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24));
                    const message = `⚠️ Seguimiento pendiente: ${lead.company_name} lleva ${daysAgo} días sin actividad. Estado: ${lead.status}. ¿Querés que redacte un follow-up?`;
                    for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
                        try {
                            await bot.api.sendMessage(userId, message);
                        } catch (sendErr: any) {
                            console.error(`Error sending stale lead alert to ${userId}:`, sendErr.message);
                        }
                    }
                }
            } catch (e: any) {
                console.error("Stale leads cron error:", e.message);
            }
        }, { timezone: 'America/Argentina/Buenos_Aires' });
        console.log("🎯 Cron job for stale leads follow-up initialized (09:00 AM ART)");

    } catch (error) {
        console.error("Critical failure during startup:", error);
        process.exit(1);
    }
}

main();
