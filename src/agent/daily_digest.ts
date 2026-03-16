import { getGoogleAuth } from '../google/auth.js';
import { google } from 'googleapis';
import { getCompletion, textToSpeech, Message } from '../llm/index.js';
import { bot } from '../bot/index.js';
import { config } from '../config/index.js';
import fs from 'fs';

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

        // 3. Crear el prompt
        const promptText = `
Sos un asistente ejecutivo estelar. Elaborá un script para ser leído en un audio corto de no más de 1 minuto, arrancando con un tono motivador de buenos días (hoy es ${new Date().toLocaleDateString('es-AR')}).
Debes darle al usuario su "Daily Digest" basado en la siguiente información recopilada:

Emails importantes sin leer:
${emails ? emails : "Ningún email nuevo destacable."}

Eventos del calendario para hoy:
${events ? events : "Tenés la agenda libre de reuniones por hoy."}

Haz que suene coloquial, cálido y enfocado al éxito del día.
`;

        const messages: Message[] = [{ role: 'user', content: promptText }];
        const response = await getCompletion(messages, []);

        if (!response.content) return;

        // 4. Generar Voz y Enviar a todos los administradores (allowed users)
        let audioPath: string | null = null;
        try {
            audioPath = await textToSpeech(response.content);
            const { InputFile } = await import('grammy');

            for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
                try {
                    await bot.api.sendVoice(userId, new InputFile(audioPath), { caption: "Tu Resumen Diario (Daily Digest)" });
                } catch (telegramErr) {
                    console.error(`Error enviando digest al user ${userId}`, telegramErr);
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
