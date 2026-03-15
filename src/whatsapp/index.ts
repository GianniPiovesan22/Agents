import express from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { config } from '../config/index.js';
import { getHistory, saveMessage } from '../database/index.js';
import { runAgent } from '../agent/loop.js';
import axios from 'axios';

const WHATSAPP_API_URL = 'https://graph.facebook.com/v22.0';

/**
 * Send a text message via WhatsApp Cloud API
 */
async function sendWhatsAppMessage(to: string, text: string) {
    const phoneNumberId = config.WHATSAPP_PHONE_NUMBER_ID;
    const token = config.WHATSAPP_ACCESS_TOKEN;

    if (!phoneNumberId || !token) {
        console.error('❌ WhatsApp not configured: missing PHONE_NUMBER_ID or ACCESS_TOKEN');
        return;
    }

    // WhatsApp has a 4096 character limit per message
    const chunks = splitMessage(text, 4000);

    for (const chunk of chunks) {
        try {
            await axios.post(
                `${WHATSAPP_API_URL}/${phoneNumberId}/messages`,
                {
                    messaging_product: 'whatsapp',
                    to,
                    type: 'text',
                    text: { body: chunk },
                },
                {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                    },
                }
            );
        } catch (error: any) {
            console.error('❌ WhatsApp send error:', error.response?.data || error.message);
        }
    }
}

/**
 * Mark a message as read
 */
async function markAsRead(messageId: string) {
    const phoneNumberId = config.WHATSAPP_PHONE_NUMBER_ID;
    const token = config.WHATSAPP_ACCESS_TOKEN;

    if (!phoneNumberId || !token) return;

    try {
        await axios.post(
            `${WHATSAPP_API_URL}/${phoneNumberId}/messages`,
            {
                messaging_product: 'whatsapp',
                status: 'read',
                message_id: messageId,
            },
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
            }
        );
    } catch (error: any) {
        // Silently fail — read receipts are not critical
    }
}

/**
 * Split long messages into chunks
 */
function splitMessage(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
        }

        // Try to break at a newline or space
        let breakPoint = remaining.lastIndexOf('\n', maxLength);
        if (breakPoint < maxLength * 0.5) {
            breakPoint = remaining.lastIndexOf(' ', maxLength);
        }
        if (breakPoint < maxLength * 0.3) {
            breakPoint = maxLength;
        }

        chunks.push(remaining.substring(0, breakPoint));
        remaining = remaining.substring(breakPoint).trimStart();
    }

    return chunks;
}

/**
 * Handle incoming WhatsApp message
 */
async function handleIncomingMessage(from: string, text: string, messageId: string) {
    // Whitelist check — must be before any processing
    const allowedNumbers = config.WHATSAPP_ALLOWED_NUMBERS;
    if (!allowedNumbers || allowedNumbers.length === 0) {
        console.warn(`⚠️ WHATSAPP_ALLOWED_NUMBERS not configured — all WhatsApp messages rejected`);
        return;
    }
    if (!allowedNumbers.includes(from)) {
        console.warn(`⚠️ Unauthorized WhatsApp sender: ${from}`);
        return;
    }

    console.log(`📱 WhatsApp message from ${from}: ${text}`);

    // Mark as read
    await markAsRead(messageId);

    // Use phone number as user ID (prefixed to avoid conflicts with Telegram IDs)
    const userId = `wa_${from}`;

    try {
        // Save user message
        await saveMessage(userId, 'user', text);

        // Get history
        const history = await getHistory(userId);

        // Run agent (same Gemini-powered agent as Telegram)
        const responseText = await runAgent(userId, history);

        // Save assistant response
        await saveMessage(userId, 'assistant', responseText);

        // Send response via WhatsApp
        await sendWhatsAppMessage(from, responseText);

    } catch (error: any) {
        console.error('❌ WhatsApp handler error:', error);
        await sendWhatsAppMessage(from, 'Ups, tuve un error procesando tu mensaje. Intentá de nuevo.');
    }
}

/**
 * Create and configure the Express webhook server for WhatsApp
 */
export function createWhatsAppServer() {
    const app = express();

    // TASK-19: Raw body capture for HMAC validation on /webhook route
    // Must be registered BEFORE express.json() so req.body is a Buffer for the webhook route
    app.use('/webhook', express.raw({ type: '*/*' }));
    app.use(express.json());

    const VERIFY_TOKEN = config.WHATSAPP_VERIFY_TOKEN || 'opengravity_webhook_2026';
    const APP_SECRET = config.WHATSAPP_APP_SECRET;

    // TASK-22: Rate limiter — applied exclusively to POST /webhook
    const webhookLimiter = rateLimit({
        windowMs: 60 * 1000,   // 1 minute window
        max: 100,              // 100 requests per IP per minute
        standardHeaders: true, // includes Retry-After header
        legacyHeaders: false,
        message: { error: 'Too many requests' },
    });

    // ── Webhook Verification (GET) ─────────────────────────────
    app.get('/webhook', (req, res) => {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('✅ WhatsApp webhook verified');
            return res.status(200).send(challenge);
        }

        console.warn('❌ Webhook verification failed');
        return res.sendStatus(403);
    });

    // ── Webhook Messages (POST) ────────────────────────────────
    // TASK-22: webhookLimiter applied first (rate limit)
    // TASK-20: HMAC validation inline in handler
    app.post('/webhook', webhookLimiter, async (req, res) => {
        // TASK-20: HMAC-SHA256 validation
        if (!APP_SECRET) {
            console.error('❌ WHATSAPP_APP_SECRET not configured — rejecting all webhook requests');
            return res.sendStatus(401);
        }

        const signature = req.headers['x-hub-signature-256'] as string | undefined;
        if (!signature) {
            console.warn('⚠️ Missing x-hub-signature-256 header');
            return res.sendStatus(401);
        }

        const rawBody = req.body as Buffer;
        const expectedSig = 'sha256=' + crypto
            .createHmac('sha256', APP_SECRET)
            .update(rawBody)
            .digest('hex');

        // timingSafeEqual requires equal-length buffers — check lengths first
        const sigBuffer = Buffer.from(signature);
        const expectedBuffer = Buffer.from(expectedSig);
        if (sigBuffer.length !== expectedBuffer.length ||
            !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
            console.warn('❌ WhatsApp HMAC validation failed');
            return res.sendStatus(401);
        }

        // Parse body manually (req.body is Buffer due to express.raw())
        let body: any;
        try {
            body = JSON.parse(rawBody.toString('utf-8'));
        } catch {
            return res.sendStatus(400);
        }

        // Respond 200 quickly to avoid Meta retries
        res.sendStatus(200);

        try {
            if (body.object !== 'whatsapp_business_account') return;

            const entries = body.entry || [];

            for (const entry of entries) {
                const changes = entry.changes || [];

                for (const change of changes) {
                    if (change.field !== 'messages') continue;

                    const messages = change.value?.messages || [];

                    for (const message of messages) {
                        // Only handle text messages for now
                        if (message.type === 'text' && message.text?.body) {
                            const from = message.from; // Phone number
                            const text = message.text.body;
                            const messageId = message.id;

                            // Process asynchronously
                            handleIncomingMessage(from, text, messageId).catch(err => {
                                console.error('WhatsApp processing error:', err);
                            });
                        }
                    }
                }
            }
        } catch (error) {
            console.error('WhatsApp webhook error:', error);
        }
    });

    // ── Health Check ────────────────────────────────────────────
    app.get('/health', (_req, res) => {
        res.json({
            status: 'ok',
            services: {
                telegram: '✅ running',
                whatsapp: config.WHATSAPP_ACCESS_TOKEN ? '✅ configured' : '⚠️ not configured',
                gemini: config.GEMINI_API_KEY ? '✅ active' : '⚠️ using Groq fallback',
            },
            timestamp: new Date().toISOString(),
        });
    });

    const PORT = config.WEBHOOK_PORT || 3000;
    app.listen(PORT, () => {
        console.log(`🌐 WhatsApp webhook server listening on port ${PORT}`);
        console.log(`   Webhook URL: http://localhost:${PORT}/webhook`);
        console.log(`   Health check: http://localhost:${PORT}/health`);
    });

    return app;
}
