import { startBot } from './bot/index.js';
import { createWhatsAppServer } from './whatsapp/index.js';
import { config } from './config/index.js';
import cron from 'node-cron';
import { getPendingReminders, markReminderSent, getRecurringReminders, updateReminderNextFire, getUpcomingHighImpactEvents, markForexEventNotified, saveForexEvents, ForexEvent, getStaleLeads, getRecentContentTypes } from './database/index.js';
import { bot } from './bot/index.js';
import { sendDailyDigest } from './agent/daily_digest.js';
import { sendWeeklyDigest } from './agent/weekly_digest.js';
import { checkProactiveAlerts } from './agent/proactive_alerts.js';
import { executeTool } from './tools/index.js';
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
            try {
                await sendDailyDigest();
            } catch (e: any) {
                console.error("Daily Digest cron error:", e.message);
                for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
                    bot.api.sendMessage(userId, `⚠️ *Error en tarea programada \\[Daily Digest\\]:* ${e.message}`, { parse_mode: 'MarkdownV2' }).catch(() => {});
                }
            }
        }, { timezone: 'America/Argentina/Buenos_Aires' });
        console.log("🌅 Cron job for Daily Digest initialized (08:30 AM ART)");

        // Weekly Digest Setup (runs every Friday at 9:00 PM Buenos Aires time)
        cron.schedule('0 21 * * 5', async () => {
            try {
                await sendWeeklyDigest();
            } catch (e: any) {
                console.error("Weekly Digest cron error:", e.message);
                for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
                    bot.api.sendMessage(userId, `⚠️ *Error en tarea programada \\[Weekly Digest\\]:* ${e.message}`, { parse_mode: 'MarkdownV2' }).catch(() => {});
                }
            }
        }, { timezone: 'America/Argentina/Buenos_Aires' });
        console.log("📅 Cron job for Weekly Digest initialized (Friday 09:00 PM ART)");

        // Proactive Alerts (runs every 5 minutes)
        cron.schedule('*/5 * * * *', async () => {
            try {
                for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
                    await checkProactiveAlerts(userId);
                }
            } catch (e: any) {
                console.error("Proactive Alerts cron error:", e.message);
                for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
                    bot.api.sendMessage(userId, `⚠️ *Error en tarea programada \\[Proactive Alerts\\]:* ${e.message}`, { parse_mode: 'MarkdownV2' }).catch(() => {});
                }
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
                for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
                    bot.api.sendMessage(userId, `⚠️ *Error en tarea programada \\[Forex Calendar Refresh\\]:* ${e.message}`, { parse_mode: 'MarkdownV2' }).catch(() => {});
                }
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
                for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
                    bot.api.sendMessage(userId, `⚠️ *Error en tarea programada \\[Stale Leads\\]:* ${e.message}`, { parse_mode: 'MarkdownV2' }).catch(() => {});
                }
            }
        }, { timezone: 'America/Argentina/Buenos_Aires' });
        console.log("🎯 Cron job for stale leads follow-up initialized (09:00 AM ART)");

        // Social Content Suggestion — every Monday at 08:00 AM ART
        const CONTENT_TYPES = ['product', 'testimonial', 'market_info', 'seasonal'] as const;
        cron.schedule('0 8 * * 1', async () => {
            try {
                // Pick content type based on week-of-year mod 4 (simple rotation),
                // but skip any type already used in the last 3 weeks
                const now = new Date();
                const startOfYear = new Date(now.getFullYear(), 0, 1);
                const weekNumber = Math.ceil(((now.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
                const recentTypes = new Set(getRecentContentTypes(21));
                let contentType = CONTENT_TYPES[weekNumber % 4];
                if (recentTypes.has(contentType)) {
                    const fallback = CONTENT_TYPES.find(t => !recentTypes.has(t));
                    if (fallback) contentType = fallback;
                }

                const contentTypeLabels: Record<string, string> = {
                    product: 'Showcase de producto',
                    testimonial: 'Testimonio de cliente',
                    market_info: 'Info del mercado agro',
                    seasonal: 'Contenido estacional',
                };

                console.log(`📱 Generando sugerencia de contenido semanal (tipo: ${contentType})...`);

                // Generate content via tool
                const contentResult = await executeTool('generate_social_content', {
                    platform: 'both',
                    content_type: contentType,
                });

                let copy = '';
                let hashtags = '';
                let bestTime = 'Martes o Miércoles 9-11hs';
                let platformNotes = '';
                let imagePrompt = 'Professional Argentine agricultural machinery, silo bag sealer in field, golden pampas landscape, photorealistic';

                try {
                    const parsed = JSON.parse(contentResult);
                    copy = parsed.copy ?? contentResult;
                    hashtags = Array.isArray(parsed.hashtags)
                        ? parsed.hashtags.map((h: string) => `#${h.replace(/^#/, '')}`).join(' ')
                        : '';
                    bestTime = parsed.best_time ?? bestTime;
                    platformNotes = parsed.platform_notes ?? '';
                    imagePrompt = parsed.image_prompt ?? imagePrompt;
                } catch {
                    copy = contentResult;
                }

                // Generate image
                let imgPath: string | null = null;
                try {
                    const imageResult = await executeTool('generate_image', { prompt: imagePrompt });
                    const imgMatch = imageResult.match(/\[IMG:(.+?)\]/);
                    if (imgMatch) imgPath = imgMatch[1];
                } catch (imgErr: any) {
                    console.error('📱 Error generando imagen para sugerencia semanal:', imgErr.message);
                }

                const notesLine = platformNotes ? `\n💡 *Nota:* ${platformNotes}` : '';
                const message = `📱 *Contenido sugerido para esta semana*\n\n*Plataforma:* Facebook \\+ Instagram\n*Tipo:* ${contentTypeLabels[contentType]}\n\n*📝 Copy:*\n${copy}\n\n*🏷️ Hashtags:*\n${hashtags}\n\n*🕐 Mejor horario:* ${bestTime}${notesLine}\n\nRespondé:\n✅ *"publicar"* — lo guardamos listo\n✏️ *"ajustá \\[lo que quieras cambiar\\]"* — lo refinamos\n🔄 *"nuevo"* — generamos otro`;

                for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
                    try {
                        if (imgPath) {
                            const { InputFile } = await import('grammy');
                            const fs = await import('fs');
                            await bot.api.sendPhoto(userId, new InputFile(imgPath), {
                                caption: message,
                                parse_mode: 'MarkdownV2',
                            });
                            if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
                        } else {
                            await bot.api.sendMessage(userId, message, { parse_mode: 'MarkdownV2' });
                        }
                    } catch (sendErr: any) {
                        console.error(`📱 Error enviando sugerencia de contenido a ${userId}:`, sendErr.message);
                        // Fallback: send plain text without MarkdownV2
                        try {
                            await bot.api.sendMessage(userId, `Sugerencia de contenido semanal (${contentTypeLabels[contentType]}):\n\n${copy}\n\nHashtags: ${hashtags}\nHorario: ${bestTime}`);
                        } catch {}
                    }
                }
            } catch (e: any) {
                console.error("Social Content cron error:", e.message);
                for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
                    bot.api.sendMessage(userId, `⚠️ *Error en tarea programada \\[Sugerencia de Contenido\\]:* ${e.message}`, { parse_mode: 'MarkdownV2' }).catch(() => {});
                }
            }
        }, { timezone: 'America/Argentina/Buenos_Aires' });
        console.log("📱 Cron job for Social Content suggestion initialized (Monday 08:00 AM ART)");

    } catch (error) {
        console.error("Critical failure during startup:", error);
        process.exit(1);
    }
}

main();
