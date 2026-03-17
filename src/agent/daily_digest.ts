import { getGoogleAuth } from '../google/auth.js';
import { google } from 'googleapis';
import { getCompletion, textToSpeech, Message } from '../llm/index.js';
import { bot } from '../bot/index.js';
import { config } from '../config/index.js';
import fs from 'fs';
import axios from 'axios';
import Database from 'better-sqlite3';
import path from 'path';
import { saveForexEvents, ForexEvent } from '../database/index.js';

export async function sendDailyDigest() {
    console.log("Iniciando generación de Resumen Diario (Daily Digest)...");

    try {
        // 1. Obtener correos importantes no leídos de hoy
        let emails = "";
        try {
            const auth = getGoogleAuth();
            const gmail = google.gmail({ version: 'v1', auth });

            const listRes = await gmail.users.threads.list({
                userId: 'me',
                q: 'is:unread newer_than:1d',
                maxResults: 5,
            });

            const threads = listRes.data.threads;
            if (threads && threads.length > 0) {
                const lines: string[] = [];
                for (const thread of threads) {
                    const threadRes = await gmail.users.threads.get({
                        userId: 'me',
                        id: thread.id!,
                        format: 'metadata',
                        metadataHeaders: ['Subject', 'From'],
                    });
                    const msg = threadRes.data.messages?.[0];
                    const headers = msg?.payload?.headers ?? [];
                    const subject = headers.find(h => h.name === 'Subject')?.value ?? '(sin asunto)';
                    const from = headers.find(h => h.name === 'From')?.value ?? '(desconocido)';
                    lines.push(`- De: ${from} | Asunto: ${subject}`);
                }
                emails = lines.join('\n');
            } else {
                emails = "Sin correos nuevos no leídos.";
            }
        } catch (e: any) {
            emails = "No pudimos obtener los emails recientes.";
        }

        // 2. Obtener eventos para el día de hoy
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);

        let events = "";
        try {
            const auth = getGoogleAuth();
            const calendar = google.calendar({ version: 'v3', auth });

            const res = await calendar.events.list({
                calendarId: 'primary',
                timeMin: today.toISOString(),
                timeMax: endOfDay.toISOString(),
                singleEvents: true,
                orderBy: 'startTime',
                maxResults: 10,
            });

            const items = res.data.items;
            if (items && items.length > 0) {
                const lines = items.map(event => {
                    const start = event.start?.dateTime ?? event.start?.date ?? '';
                    const time = start ? new Date(start).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '';
                    return `- ${time ? time + ' ' : ''}${event.summary ?? '(sin título)'}`;
                });
                events = lines.join('\n');
            } else {
                events = "Agenda libre de reuniones por hoy.";
            }
        } catch (e: any) {
            events = "No pudimos obtener los eventos del calendario para hoy.";
        }

        // 3. Cotizaciones del dólar
        let dolarInfo = "";
        try {
            const dolarRes = await axios.get('https://dolarapi.com/v1/dolares', { timeout: 8000 });
            const dolares: any[] = dolarRes.data;
            const blue = dolares.find(d => d.casa === 'blue');
            const oficial = dolares.find(d => d.casa === 'oficial');
            const parts: string[] = [];
            if (oficial) parts.push(`Oficial: $${oficial.venta}`);
            if (blue) parts.push(`Blue: $${blue.venta}`);
            dolarInfo = parts.length > 0 ? parts.join(' | ') : "No disponible";
        } catch (e: any) {
            dolarInfo = "No pudimos obtener las cotizaciones del dólar.";
        }

        // 4. Clima en Buenos Aires
        let weather = "";
        try {
            const weatherRes = await axios.get('https://wttr.in/Buenos+Aires?format=3', {
                timeout: 8000,
                headers: { 'User-Agent': 'OpenGravity/1.0' }
            });
            weather = weatherRes.data?.toString().trim() || "No disponible";
        } catch (e: any) {
            weather = "No pudimos obtener el clima.";
        }

        // 5. Precios de criptomonedas
        let cryptoInfo = "";
        try {
            const cryptoRes = await axios.get(
                'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd',
                { timeout: 8000 }
            );
            const data = cryptoRes.data;
            const btc = data?.bitcoin?.usd;
            const eth = data?.ethereum?.usd;
            const parts: string[] = [];
            if (btc) parts.push(`BTC: $${btc.toLocaleString('en-US')}`);
            if (eth) parts.push(`ETH: $${eth.toLocaleString('en-US')}`);
            cryptoInfo = parts.length > 0 ? parts.join(' | ') : "No disponible";
        } catch (e: any) {
            cryptoInfo = "No pudimos obtener precios de criptomonedas.";
        }

        // 6. High-impact economic events from Forex Factory (today)
        let forexEventsInfo = "";
        try {
            const localDbPath = path.resolve(process.cwd(), 'memory.db');
            const db = new Database(localDbPath);
            const todayStr = new Date().toISOString().slice(0, 10);

            // Try to get today's high-impact events from cache first
            const stmt = db.prepare(
                "SELECT * FROM forex_events WHERE impact = 'High' AND event_date = ? ORDER BY event_time ASC"
            );
            let rows = stmt.all(todayStr) as ForexEvent[];

            // If cache is empty or stale (fetched_at older than 4 hours), fetch fresh
            const stale = rows.length === 0 || (
                rows[0]?.fetched_at &&
                (Date.now() - new Date(rows[0].fetched_at).getTime()) > 4 * 60 * 60 * 1000
            );

            if (stale) {
                try {
                    const jinaRes = await axios.get('https://r.jina.ai/https://www.forexfactory.com/calendar', {
                        headers: { 'Accept': 'text/plain, */*' },
                        timeout: 20000,
                    });
                    let markdown: string = typeof jinaRes.data === 'string'
                        ? jinaRes.data
                        : JSON.stringify(jinaRes.data);
                    if (markdown.length > 40000) markdown = markdown.slice(0, 40000);

                    // Inline lightweight parser (same logic as forex_factory.ts)
                    const fetched_at = new Date().toISOString();
                    const lines = markdown.split('\n');
                    let currentDate = todayStr;
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
                    if (parsed.length > 0) saveForexEvents(parsed);
                    rows = parsed.filter(e => e.impact === 'High' && e.event_date === todayStr);
                } catch (fetchErr: any) {
                    // Leave rows as-is (empty or stale cache)
                }
            }

            if (rows.length > 0) {
                const lines = rows.map(e => {
                    const time = e.event_time ? `${e.event_time} ` : '';
                    const currency = e.currency ? `[${e.currency}] ` : '';
                    const forecast = e.forecast ? ` (Prev: ${e.forecast})` : '';
                    return `- ${time}${currency}${e.event_name}${forecast}`;
                });
                forexEventsInfo = lines.join('\n');
            } else {
                forexEventsInfo = "Sin eventos de alto impacto para hoy.";
            }
        } catch (e: any) {
            forexEventsInfo = "No pudimos obtener el calendario económico.";
        }

        // 8. Recordatorios pendientes (para el primer usuario permitido como referencia)
        let remindersInfo = "";
        try {
            const localDbPath = path.resolve(process.cwd(), 'memory.db');
            const db = new Database(localDbPath);
            const primaryUserId = config.TELEGRAM_ALLOWED_USER_IDS[0];
            if (primaryUserId) {
                const stmt = db.prepare(
                    'SELECT message, remind_at FROM reminders WHERE sent = 0 AND user_id = ? ORDER BY remind_at ASC LIMIT 3'
                );
                const rows = stmt.all(primaryUserId) as { message: string; remind_at: string }[];
                if (rows.length > 0) {
                    const lines = rows.map(r => {
                        const dt = new Date(r.remind_at).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
                        return `- ${r.message} (${dt})`;
                    });
                    remindersInfo = lines.join('\n');
                } else {
                    remindersInfo = "Sin recordatorios pendientes.";
                }
            }
        } catch (e: any) {
            remindersInfo = "No pudimos obtener los recordatorios.";
        }

        // 7. Precios de granos argentinos (BCR Rosario)
        let grainInfo = "";
        try {
            const jinaGrainRes = await axios.get(
                'https://r.jina.ai/https://www.bcr.com.ar/es/mercados/granos/pizarra-de-precios',
                { headers: { 'Accept': 'text/plain' }, timeout: 15000 }
            );
            const markdown: string = typeof jinaGrainRes.data === 'string'
                ? jinaGrainRes.data
                : JSON.stringify(jinaGrainRes.data);

            const cropAliases: Record<string, string[]> = {
                Soja: ['soja'],
                Maíz: ['maíz', 'maiz'],
                Trigo: ['trigo'],
                Girasol: ['girasol'],
            };

            const found: string[] = [];
            for (const line of markdown.split('\n')) {
                const lower = line.toLowerCase();
                for (const [displayName, aliases] of Object.entries(cropAliases)) {
                    if (found.some(f => f.startsWith(displayName))) continue;
                    if (!aliases.some(a => lower.includes(a))) continue;
                    const priceMatch = line.match(/USD\s*([\d.,]+)/i) ||
                        line.match(/US\$\s*([\d.,]+)/i) ||
                        line.match(/([\d.,]+)\s*USD/i);
                    if (priceMatch) {
                        const num = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'));
                        if (!isNaN(num) && num > 50 && num < 100000) {
                            found.push(`${displayName}: USD ${num}`);
                        }
                    }
                }
            }

            grainInfo = found.length > 0 ? found.join(' | ') : "No disponible";
        } catch (_) {
            grainInfo = ""; // silently skip — never block the digest
        }

        // 9. Crear el prompt
        const promptText = `
Sos un asistente ejecutivo estelar. Elaborá un script para ser leído en un audio corto de no más de 1 minuto, arrancando con un tono motivador de buenos días (hoy es ${new Date().toLocaleDateString('es-AR')}).
Debes darle al usuario su "Daily Digest" basado en la siguiente información recopilada:

Emails importantes sin leer:
${emails || "Ningún email nuevo destacable."}

Eventos del calendario para hoy:
${events || "Tenés la agenda libre de reuniones por hoy."}

Cotizaciones del dólar:
${dolarInfo}

Clima en Buenos Aires:
${weather}

Criptomonedas:
${cryptoInfo}

Eventos económicos de alto impacto para hoy:
${forexEventsInfo}
${grainInfo ? `\nPrecios de granos (BCR Rosario):\n${grainInfo}` : ''}
Recordatorios pendientes:
${remindersInfo || "Sin recordatorios pendientes."}

Haz que suene coloquial, cálido y enfocado al éxito del día. Mencioná brevemente las cotizaciones, el clima, los eventos económicos importantes del día y los reminders si los hay.
`;

        const messages: Message[] = [{ role: 'user', content: promptText }];
        const response = await getCompletion(messages, []);

        if (!response.content) return;

        // 8. Generar Voz y Enviar a todos los administradores (allowed users)
        let audioPath: string | null = null;
        try {
            if (config.ELEVENLABS_API_KEY) {
                audioPath = await textToSpeech(response.content);
                const { InputFile } = await import('grammy');

                for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
                    try {
                        await bot.api.sendVoice(userId, new InputFile(audioPath), { caption: "Tu Resumen Diario (Daily Digest)" });
                    } catch (telegramErr) {
                        console.error(`Error enviando digest al user ${userId}`, telegramErr);
                    }
                }
            } else {
                // Fallback: send as text if ElevenLabs not configured
                for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
                    try {
                        await bot.api.sendMessage(userId, response.content);
                    } catch (telegramErr) {
                        console.error(`Error enviando digest (texto) al user ${userId}`, telegramErr);
                    }
                }
            }
        } finally {
            if (audioPath && fs.existsSync(audioPath)) {
                fs.unlinkSync(audioPath);
            }
        }

    } catch (error) {
        console.error("Error en Daily Digest:", error);
    }
}
