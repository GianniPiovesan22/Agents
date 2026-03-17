import { startBot } from './bot/index.js';
import { createWhatsAppServer } from './whatsapp/index.js';
import { config } from './config/index.js';
import cron from 'node-cron';
import { getPendingReminders, markReminderSent, getUpcomingHighImpactEvents, markForexEventNotified, saveForexEvents, ForexEvent } from './database/index.js';
import { bot } from './bot/index.js';
import { sendDailyDigest } from './agent/daily_digest.js';
import { sendWeeklyDigest } from './agent/weekly_digest.js';
import { checkProactiveAlerts } from './agent/proactive_alerts.js';
import axios from 'axios';

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
                for (const reminder of pending) {
                    try {
                        await bot.api.sendMessage(reminder.userId, `⏰ *Recordatorio:*\n${reminder.message}`, { parse_mode: 'Markdown' });
                        await markReminderSent(reminder.id, reminder.source);
                    } catch (err: any) {
                        console.error(`Error sending reminder to ${reminder.userId}:`, err.message);
                    }
                }
            } catch (e: any) {
                console.error("Cron Reminder Error:", e.message);
            }
        });
        console.log("⏰ Cron job for reminders initialized");

        // Daily Digest Setup (runs at 08:30 AM daily server time)
        cron.schedule('30 8 * * *', async () => {
            await sendDailyDigest();
        });
        console.log("🌅 Cron job for Daily Digest initialized (08:30 AM)");

        // Weekly Digest Setup (runs every Friday at 9:00 PM)
        cron.schedule('0 21 * * 5', async () => {
            await sendWeeklyDigest();
        });
        console.log("📅 Cron job for Weekly Digest initialized (Friday 09:00 PM)");

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

        // Forex Factory — daily calendar cache refresh (runs at 7:00 AM, before daily digest)
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
        });
        console.log("📈 Cron job for Forex calendar daily refresh initialized (07:00 AM)");

    } catch (error) {
        console.error("Critical failure during startup:", error);
        process.exit(1);
    }
}

main();
