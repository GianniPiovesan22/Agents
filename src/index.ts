import { startBot } from './bot/index.js';
import { createWhatsAppServer } from './whatsapp/index.js';
import { config } from './config/index.js';
import cron from 'node-cron';
import { getPendingReminders, markReminderSent } from './database/index.js';
import { bot } from './bot/index.js';
import { sendDailyDigest } from './agent/daily_digest.js';
import { sendWeeklyDigest } from './agent/weekly_digest.js';
import { checkProactiveAlerts } from './agent/proactive_alerts.js';

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

        // Weekly Digest Setup (runs every Sunday at 9:00 AM)
        cron.schedule('0 9 * * 0', async () => {
            await sendWeeklyDigest();
        });
        console.log("📅 Cron job for Weekly Digest initialized (Sunday 09:00 AM)");

        // Proactive Alerts (runs every 5 minutes)
        cron.schedule('*/5 * * * *', async () => {
            for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
                await checkProactiveAlerts(userId);
            }
        });
        console.log("🔔 Cron job for Proactive Alerts initialized (every 5 minutes)");

    } catch (error) {
        console.error("Critical failure during startup:", error);
        process.exit(1);
    }
}

main();
