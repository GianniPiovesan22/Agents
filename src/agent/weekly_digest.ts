import { getGoogleAuth } from '../google/auth.js';
import { google } from 'googleapis';
import { getCompletion, textToSpeech, Message } from '../llm/index.js';
import { bot } from '../bot/index.js';
import { config } from '../config/index.js';
import fs from 'fs';

export async function sendWeeklyDigest() {
    console.log("Iniciando generación de Resumen Semanal (Weekly Digest)...");

    try {
        // 1. Obtener emails de los últimos 7 días
        let emails = "";
        try {
            const auth = getGoogleAuth();
            const gmail = google.gmail({ version: 'v1', auth });

            const listRes = await gmail.users.threads.list({
                userId: 'me',
                q: 'newer_than:7d',
                maxResults: 10,
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
                emails = "Sin correos recibidos en los últimos 7 días.";
            }
        } catch (e: any) {
            emails = "No pudimos obtener los emails de la semana.";
        }

        // 2. Obtener eventos de los últimos 7 días y los próximos 7 días
        const now = new Date();
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const sevenDaysAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        let pastEvents = "";
        let upcomingEvents = "";
        try {
            const auth = getGoogleAuth();
            const calendar = google.calendar({ version: 'v3', auth });

            // Eventos de la semana pasada
            const pastRes = await calendar.events.list({
                calendarId: 'primary',
                timeMin: sevenDaysAgo.toISOString(),
                timeMax: now.toISOString(),
                singleEvents: true,
                orderBy: 'startTime',
                maxResults: 15,
            });

            const pastItems = pastRes.data.items;
            if (pastItems && pastItems.length > 0) {
                const lines = pastItems.map(event => {
                    const start = event.start?.dateTime ?? event.start?.date ?? '';
                    const date = start
                        ? new Date(start).toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' })
                        : '';
                    return `- ${date ? date + ': ' : ''}${event.summary ?? '(sin título)'}`;
                });
                pastEvents = lines.join('\n');
            } else {
                pastEvents = "Sin eventos registrados la semana pasada.";
            }

            // Eventos de la próxima semana
            const upcomingRes = await calendar.events.list({
                calendarId: 'primary',
                timeMin: now.toISOString(),
                timeMax: sevenDaysAhead.toISOString(),
                singleEvents: true,
                orderBy: 'startTime',
                maxResults: 15,
            });

            const upcomingItems = upcomingRes.data.items;
            if (upcomingItems && upcomingItems.length > 0) {
                const lines = upcomingItems.map(event => {
                    const start = event.start?.dateTime ?? event.start?.date ?? '';
                    const date = start
                        ? new Date(start).toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' })
                        : '';
                    return `- ${date ? date + ': ' : ''}${event.summary ?? '(sin título)'}`;
                });
                upcomingEvents = lines.join('\n');
            } else {
                upcomingEvents = "Sin eventos en los próximos 7 días.";
            }
        } catch (e: any) {
            pastEvents = "No pudimos obtener los eventos de la semana pasada.";
            upcomingEvents = "No pudimos obtener los eventos de la próxima semana.";
        }

        // 3. Crear el prompt
        const promptText = `
Sos un asistente ejecutivo argentino. Elaborá un resumen semanal para ser escuchado como audio de aproximadamente 1 minuto.
Escribí en español rioplatense, con tono cálido, directo y motivador.
Hoy es domingo ${new Date().toLocaleDateString('es-AR')}.

Lo que pasó esta semana (emails recibidos):
${emails}

Reuniones y eventos de la semana pasada:
${pastEvents}

Lo que viene la próxima semana (próximos 7 días):
${upcomingEvents}

Hacé un recap de lo que pasó, mencioná los puntos más importantes, y prepará al usuario para la semana que viene.
Cerrá con una frase motivadora breve.
`;

        const messages: Message[] = [{ role: 'user', content: promptText }];
        const response = await getCompletion(messages, []);

        if (!response.content) return;

        // 4. Generar Voz y Enviar a todos los usuarios permitidos
        let audioPath: string | null = null;
        try {
            if (config.ELEVENLABS_API_KEY) {
                audioPath = await textToSpeech(response.content);
                const { InputFile } = await import('grammy');

                for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
                    try {
                        await bot.api.sendVoice(userId, new InputFile(audioPath), { caption: "Tu Resumen Semanal" });
                    } catch (telegramErr) {
                        console.error(`Error enviando weekly digest al user ${userId}`, telegramErr);
                    }
                }
            } else {
                // Fallback: enviar como texto si ElevenLabs no está configurado
                for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
                    try {
                        await bot.api.sendMessage(userId, `*Resumen Semanal*\n\n${response.content}`, { parse_mode: 'Markdown' });
                    } catch (telegramErr) {
                        console.error(`Error enviando weekly digest (texto) al user ${userId}`, telegramErr);
                    }
                }
            }
        } finally {
            if (audioPath && fs.existsSync(audioPath)) {
                fs.unlinkSync(audioPath);
            }
        }

    } catch (error) {
        console.error("Error en Weekly Digest:", error);
    }
}
