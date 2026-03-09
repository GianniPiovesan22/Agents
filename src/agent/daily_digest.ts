import { runGog } from '../google/gog.js';
import { getCompletion, textToSpeech, Message } from '../llm/index.js';
import { bot } from '../bot/index.js';
import { config } from '../config/index.js';
import fs from 'fs';

export async function sendDailyDigest() {
    console.log("☀️ Iniciando generación de Resumen Diario (Daily Digest)...");

    try {
        // 1. Obtener correos importantes no leídos de hoy
        let emails = "";
        try {
            emails = await runGog(['gmail', 'search', 'is:unread newer_than:1d', '--max', '5']);
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
            events = await runGog(['calendar', 'events', 'primary', '--from', today.toISOString(), '--to', endOfDay.toISOString()]);
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
        const audioPath = await textToSpeech(response.content);
        const { InputFile } = await import('grammy');

        for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
            try {
                await bot.api.sendVoice(userId, new InputFile(audioPath), { caption: "🌅 Tu Resumen Diario (Daily Digest)" });
            } catch (telegramErr) {
                console.error(`Error enviando digest al user ${userId}`, telegramErr);
            }
        }

        // clean temp file
        if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);

    } catch (error) {
        console.error("Error en Daily Digest:", error);
    }
}
