import { getGoogleAuth } from '../google/auth.js';
import { google } from 'googleapis';
import { getCompletion, textToSpeech, Message } from '../llm/index.js';
import { bot } from '../bot/index.js';
import { config } from '../config/index.js';
import { getLeads } from '../database/index.js';
import axios from 'axios';
import fs from 'fs';

export async function sendWeeklyDigest() {
    console.log("Iniciando Weekly Digest (viernes 21hs)...");

    try {
        // 1. Emails de la semana
        let emails = "";
        try {
            const auth = getGoogleAuth();
            const gmail = google.gmail({ version: 'v1', auth });
            const listRes = await gmail.users.threads.list({ userId: 'me', q: 'newer_than:7d', maxResults: 10 });
            const threads = listRes.data.threads;
            if (threads && threads.length > 0) {
                const lines: string[] = [];
                for (const thread of threads) {
                    const threadRes = await gmail.users.threads.get({
                        userId: 'me', id: thread.id!,
                        format: 'metadata', metadataHeaders: ['Subject', 'From'],
                    });
                    const msg = threadRes.data.messages?.[0];
                    const headers = msg?.payload?.headers ?? [];
                    const subject = headers.find(h => h.name === 'Subject')?.value ?? '(sin asunto)';
                    const from = headers.find(h => h.name === 'From')?.value ?? '(desconocido)';
                    lines.push(`- De: ${from} | Asunto: ${subject}`);
                }
                emails = lines.join('\n');
            } else {
                emails = "Sin correos relevantes esta semana.";
            }
        } catch { emails = "No se pudieron obtener los emails."; }

        // 2. Eventos de calendario
        const now = new Date();
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const sevenDaysAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        let pastEvents = "";
        let upcomingEvents = "";
        try {
            const auth = getGoogleAuth();
            const calendar = google.calendar({ version: 'v3', auth });
            const pastRes = await calendar.events.list({
                calendarId: 'primary', timeMin: sevenDaysAgo.toISOString(),
                timeMax: now.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 10,
            });
            pastEvents = (pastRes.data.items ?? []).map(e => {
                const d = e.start?.dateTime ?? e.start?.date ?? '';
                const label = d ? new Date(d).toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
                return `- ${label ? label + ': ' : ''}${e.summary ?? '(sin título)'}`;
            }).join('\n') || "Sin eventos esta semana.";

            const upRes = await calendar.events.list({
                calendarId: 'primary', timeMin: now.toISOString(),
                timeMax: sevenDaysAhead.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 10,
            });
            upcomingEvents = (upRes.data.items ?? []).map(e => {
                const d = e.start?.dateTime ?? e.start?.date ?? '';
                const label = d ? new Date(d).toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
                return `- ${label ? label + ': ' : ''}${e.summary ?? '(sin título)'}`;
            }).join('\n') || "Sin eventos la próxima semana.";
        } catch {
            pastEvents = "No se pudieron obtener eventos.";
            upcomingEvents = "No se pudieron obtener eventos.";
        }

        // 3. Noticias de la semana (Argentina + mundo)
        let news = "";
        try {
            const resp = await axios.post('https://api.tavily.com/search', {
                api_key: config.TAVILY_API_KEY,
                query: 'noticias más importantes de la semana Argentina mundo economía',
                search_depth: 'basic',
                max_results: 8,
            }, { timeout: 15000 });
            const results = resp.data?.results ?? [];
            news = results.map((r: any) => `- ${r.title}`).join('\n') || "No se pudieron obtener noticias.";
        } catch { news = "No se pudieron obtener noticias esta semana."; }

        // 4. Mercados
        let markets = "";
        try {
            const [dolarRes, cryptoRes] = await Promise.allSettled([
                axios.get('https://dolarapi.com/v1/dolares', { timeout: 8000 }),
                axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true', { timeout: 8000 }),
            ]);
            const dolarLines: string[] = [];
            if (dolarRes.status === 'fulfilled') {
                for (const r of dolarRes.value.data) {
                    if (['blue', 'oficial', 'mep'].includes(r.casa?.toLowerCase())) {
                        dolarLines.push(`${r.nombre}: $${r.venta}`);
                    }
                }
            }
            const cryptoLines: string[] = [];
            if (cryptoRes.status === 'fulfilled') {
                const d = cryptoRes.value.data;
                if (d.bitcoin) cryptoLines.push(`BTC: US$${d.bitcoin.usd.toLocaleString()} (${d.bitcoin.usd_24h_change?.toFixed(1)}%)`);
                if (d.ethereum) cryptoLines.push(`ETH: US$${d.ethereum.usd.toLocaleString()} (${d.ethereum.usd_24h_change?.toFixed(1)}%)`);
            }
            markets = [...dolarLines, ...cryptoLines].join(' | ') || "No se pudieron obtener datos de mercado.";
        } catch { markets = "No se pudieron obtener datos de mercado."; }

        // 5. Resumen de leads CRM
        let leadsInfo = "";
        try {
            const allLeads = getLeads();
            const nuevos = allLeads.filter(l => l.status === 'nuevo').length;
            const contactados = allLeads.filter(l => l.status === 'contactado').length;
            const interesados = allLeads.filter(l => l.status === 'interesado').length;
            const propuestas = allLeads.filter(l => l.status === 'propuesta_enviada').length;
            const cerrados = allLeads.filter(l => l.status === 'cerrado').length;
            leadsInfo = `Total leads: ${allLeads.length} | Nuevos: ${nuevos} | Contactados: ${contactados} | Interesados: ${interesados} | Propuestas enviadas: ${propuestas} | Cerrados: ${cerrados}`;
        } catch { leadsInfo = "No se pudo obtener el estado del CRM."; }

        const dataBlock = `
NOTICIAS DE LA SEMANA:
${news}

MERCADOS:
${markets}

CRM / LEADS:
${leadsInfo}

EMAILS DE LA SEMANA:
${emails}

REUNIONES Y EVENTOS DE ESTA SEMANA:
${pastEvents}

AGENDA PRÓXIMA SEMANA:
${upcomingEvents}
`;

        // 6a. Generar script de audio (conversacional, ~2 minutos)
        const audioPrompt = `
Sos el asistente personal de Gianni, de BrescoPack (maquinaria agroindustrial, Colón, Buenos Aires).
Hoy es viernes ${now.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.

Escribí un resumen semanal para escuchar como audio de 2 minutos. Tono espartano, directo, en español rioplatense. Sin símbolos ni emojis — solo texto hablado fluido.

Cubrí: noticias importantes, mercados, estado del CRM, agenda de la próxima semana, 3 acciones concretas. Cerrá con frase motivadora.

${dataBlock}`;

        // 6b. Generar resumen de texto estructurado con emojis y secciones
        const textPrompt = `
Sos el asistente personal de Gianni, de BrescoPack (maquinaria agroindustrial, Colón, Buenos Aires).
Hoy es viernes ${now.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.

Generá un resumen semanal en texto para Telegram. Usá emojis como bullets y separadores entre secciones. Sin markdown (no uses # ni **). Texto limpio, estructurado, fácil de leer en el celular.

Secciones obligatorias:
🌍 NOTICIAS DE LA SEMANA
💰 MERCADOS
🎯 CRM Y LEADS
📧 EMAILS Y REUNIONES
📅 PRÓXIMA SEMANA
✅ 3 ACCIONES CONCRETAS PARA LA SEMANA

${dataBlock}`;

        const [audioResp, textResp] = await Promise.all([
            getCompletion([{ role: 'user', content: audioPrompt }], []),
            getCompletion([{ role: 'user', content: textPrompt }], []),
        ]);

        // 7. Enviar audio + texto
        let audioPath: string | null = null;
        try {
            const { InputFile } = await import('grammy');

            // Send audio
            if (config.ELEVENLABS_API_KEY && audioResp.content) {
                audioPath = await textToSpeech(audioResp.content);
                for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
                    try {
                        await bot.api.sendVoice(userId, new InputFile(audioPath), { caption: "Resumen Semanal — Viernes 21hs" });
                    } catch (err: any) {
                        console.error(`Error enviando audio a ${userId}`, err.message);
                    }
                }
            }

            // Send structured text
            if (textResp.content) {
                for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
                    try {
                        await bot.api.sendMessage(userId, textResp.content);
                    } catch (err: any) {
                        console.error(`Error enviando texto a ${userId}`, err.message);
                    }
                }
            }
        } finally {
            if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
        }

    } catch (error) {
        console.error("Error en Weekly Digest:", error);
    }
}
