import { startBot } from './bot/index.js';
import { createWhatsAppServer } from './whatsapp/index.js';
import { config } from './config/index.js';
import cron from 'node-cron';
import { getPendingReminders, markReminderSent } from './database/index.js';
import { bot } from './bot/index.js';
import { sendDailyDigest } from './agent/daily_digest.js';

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

    } catch (error) {
        console.error("Critical failure during startup:", error);
        process.exit(1);
    }
}

main();
