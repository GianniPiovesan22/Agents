import { Bot } from 'grammy';
import { config } from '../config/index.js';
import { getHistory, saveMessage } from '../database/index.js';
import { runAgent } from '../agent/loop.js';
import { transcribeAudio, textToSpeech, getCompletion, Message } from '../llm/index.js';
import path from 'path';
import fs from 'fs';
import os from 'os';
import axios from 'axios';

export const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

// User Whitelist Middleware
bot.use(async (ctx, next) => {
    const userId = ctx.from?.id.toString();
    if (userId && config.TELEGRAM_ALLOWED_USER_IDS.includes(userId)) {
        return next();
    }
    if (ctx.from) {
        console.warn(`🚫 Unauthorized access attempt from User ID: ${userId}`);
        await ctx.reply("Lo siento, no tienes permiso para usar este bot.");
    }
});

/**
 * Downloads a file from Telegram.
 */
async function downloadTelegramFile(fileId: string): Promise<string> {
    const file = await bot.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const tempPath = path.join(os.tmpdir(), `voice_${fileId}_${Date.now()}.ogg`);

    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
    });

    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', () => resolve(tempPath));
        writer.on('error', reject);
    });
}

/**
 * Common response logic (Text or Voice)
 */
async function handleResponse(
    ctx: any,
    userId: string,
    userInput: string,
    forceVoice: boolean = false,
    images?: { mimeType: string, data: string }[]
) {
    const shouldVoice = forceVoice || /audio|habla|escucha|voz|decime/i.test(userInput);

    // Show appropriate action
    await ctx.replyWithChatAction(shouldVoice ? 'upload_voice' : 'typing');

    try {
        // Save user message
        await saveMessage(userId, 'user', userInput);

        // Get history
        const history = await getHistory(userId) as any[];

        if (images && images.length > 0) {
            const lastUserMsg = history[history.length - 1];
            if (lastUserMsg && lastUserMsg.role === 'user') {
                lastUserMsg.images = images;
            }
        }

        // Run agent
        const responseText = await runAgent(userId, history);

        // Check if response contains images
        const imgRegex = /\[IMG:(.+?)\]/g;
        let match;
        const imgPaths: string[] = [];
        
        while ((match = imgRegex.exec(responseText)) !== null) {
            imgPaths.push(match[1]);
        }

        if (imgPaths.length > 0) {
            const caption = responseText.replace(/\[IMG:(.+?)\]/g, '').trim();
            try {
                const { InputFile } = await import('grammy');
                
                if (imgPaths.length === 1) {
                    await ctx.replyWithPhoto(new InputFile(imgPaths[0]), {
                        caption: caption || '🖼️ Imagen generada',
                    });
                } else {
                    const mediaGroup = imgPaths.map((imgPath, i) => ({
                        type: 'photo' as const,
                        media: new InputFile(imgPath),
                        caption: i === 0 ? (caption || '🖼️ Imágenes generadas') : undefined,
                    }));
                    await ctx.replyWithMediaGroup(mediaGroup);
                }
            } finally {
                for (const imgPath of imgPaths) {
                    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
                }
            }
            await saveMessage(userId, 'assistant', caption || 'Imágenes generadas');
            return;
        }

        // Save assistant response
        await saveMessage(userId, 'assistant', responseText);

        if (shouldVoice && config.ELEVENLABS_API_KEY) {
            try {
                const audioPath = await textToSpeech(responseText);
                try {
                    const { InputFile } = await import('grammy');
                    await ctx.replyWithVoice(new InputFile(audioPath));
                } finally {
                    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
                }
            } catch (voiceError: any) {
                console.error("⚠️ ElevenLabs TTS failed, falling back to text:", voiceError.message);
                await ctx.reply(responseText);
            }
        } else {
            await ctx.reply(responseText);
        }
    } catch (error: any) {
        console.error("Response Error:", error);
        let errorMsg = "Ups, no pude procesar eso correctamente.";
        const errMsgStr = error.message?.toLowerCase() || '';

        if (errMsgStr.includes('index')) {
            errorMsg = "⚠️ Firebase necesita un índice. Revisa la consola del bot para el enlace de creación.";
        } else if (errMsgStr.includes('elevenlabs')) {
            errorMsg = "🎙️ Error con ElevenLabs. Revisa tu API Key.";
        } else if (errMsgStr.includes('402') || errMsgStr.includes('billing') || errMsgStr.includes('spend limit')) {
            errorMsg = "💳 Tu saldo en OpenRouter se ha agotado o has alcanzado el límite de gasto (402). Por favor recarga tu cuenta.";
        } else if (errMsgStr.includes('quota') || errMsgStr.includes('rate limit') || errMsgStr.includes('429')) {
            errorMsg = "⏳ ¡Límite de peticiones alcanzado! Gemini y Groq llegaron a su límite gratuito por ahora. Espera 1 minuto y vuelve a intentarlo.";
        } else if (errMsgStr.includes('paid plans') || errMsgStr.includes('imagen')) {
            errorMsg = "🎨 Google ahora requiere cuenta de pago ('Pay-as-you-go') en AI Studio para generar o editar imágenes.";
        }
        await ctx.reply(errorMsg);
    }
}

// Handler for voice messages
bot.on(['message:voice', 'message:audio'], async (ctx) => {
    const userId = ctx.from.id.toString();
    const voice = ctx.message.voice || ctx.message.audio;
    if (!voice) return;

    let tempFile: string | null = null;
    try {
        tempFile = await downloadTelegramFile(voice.file_id);
        const transcription = await transcribeAudio(tempFile);

        if (!transcription || transcription.trim().length === 0) {
            await ctx.reply("No pude entender el audio.");
            return;
        }

        await ctx.reply(`🎤 *Escuchado:* _"${transcription}"_`, { parse_mode: 'Markdown' });
        await handleResponse(ctx, userId, transcription, true);

    } catch (error) {
        console.error("Voice Handler Error:", error);
        await ctx.reply("Hubo un problema con tu audio.");
    } finally {
        if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
});

// Handler for photo messages
bot.on('message:photo', async (ctx) => {
    const userId = ctx.from.id.toString();
    const photos = ctx.message.photo;
    if (!photos || photos.length === 0) return;

    const bestPhoto = photos[photos.length - 1];

    // Reject files over 15MB
    if (bestPhoto.file_size && bestPhoto.file_size > 15 * 1024 * 1024) {
        await ctx.reply("La imagen es demasiado grande (máx. 15MB).");
        return;
    }

    let tempFile: string | null = null;
    try {
        await ctx.reply("📸 Procesando imagen...");
        await ctx.replyWithChatAction('typing');

        const file = await bot.api.getFile(bestPhoto.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 30000 });

        if (response.data.byteLength > 15 * 1024 * 1024) {
            await ctx.reply("La imagen es demasiado grande para procesar (máx. 15MB).");
            return;
        }

        const base64Data = Buffer.from(response.data).toString('base64');
        const caption = ctx.message.caption || 'Analizá esta imagen y describí lo que ves. Si hay maquinaria, instalaciones o documentos, extraé información relevante.';

        const messages: Message[] = [
            {
                role: 'user',
                content: caption,
                images: [{ mimeType: 'image/jpeg', data: base64Data }],
            }
        ];

        const result = await getCompletion(messages);
        const analysisText = result.content || 'No pude analizar la imagen.';

        await ctx.reply(analysisText);
    } catch (error: any) {
        console.error("Photo Handler Error:", error);
        await ctx.reply("Hubo un problema procesando tu imagen. Intentá de nuevo.");
    } finally {
        if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
});

// Handler for documents (PDF, images sent as files, CSV, TXT)
bot.on('message:document', async (ctx) => {
    const userId = ctx.from.id.toString();
    const document = ctx.message.document;
    if (!document) return;

    const mime = document.mime_type || '';
    const fileName = document.file_name?.toLowerCase() || '';
    const isPdf = mime === 'application/pdf' || fileName.endsWith('.pdf');
    const isImage = mime.startsWith('image/');
    const isCsvOrTxt = mime.includes('csv') || mime.includes('text') || fileName.match(/\.(csv|txt)$/);

    if (!isPdf && !isImage && !isCsvOrTxt) {
        await ctx.reply("Solo puedo analizar PDFs e imágenes por ahora.");
        return;
    }

    // Reject files over 15MB
    if (document.file_size && document.file_size > 15 * 1024 * 1024) {
        await ctx.reply("El archivo es demasiado grande para procesar (máx. 15MB).");
        return;
    }

    let tempFile: string | null = null;
    try {
        await ctx.reply("📄 Procesando documento...");
        await ctx.replyWithChatAction('typing');

        const file = await bot.api.getFile(document.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 30000 });

        if (response.data.byteLength > 15 * 1024 * 1024) {
            await ctx.reply("El archivo es demasiado grande para procesar (máx. 15MB).");
            return;
        }

        const caption = ctx.message.caption;

        if (isPdf) {
            const base64Data = Buffer.from(response.data).toString('base64');
            const promptText = caption || 'Analizá este documento PDF y extraé la información más relevante: datos de contacto, precios, condiciones, fechas importantes.';

            const messages: Message[] = [
                {
                    role: 'user',
                    content: promptText,
                    documents: [{ mimeType: 'application/pdf', data: base64Data }],
                }
            ];

            const result = await getCompletion(messages);
            const analysisText = result.content || 'No pude analizar el documento.';
            await ctx.reply(analysisText);

        } else if (isImage) {
            const base64Data = Buffer.from(response.data).toString('base64');
            const imageMediaType = (mime.startsWith('image/') ? mime : 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
            const promptText = caption || 'Analizá esta imagen y describí lo que ves. Si hay maquinaria, instalaciones o documentos, extraé información relevante.';

            const messages: Message[] = [
                {
                    role: 'user',
                    content: promptText,
                    images: [{ mimeType: imageMediaType, data: base64Data }],
                }
            ];

            const result = await getCompletion(messages);
            const analysisText = result.content || 'No pude analizar la imagen.';
            await ctx.reply(analysisText);

        } else {
            // CSV / TXT — read as text and send through agent
            tempFile = path.join(os.tmpdir(), `doc_${document.file_id}_${Date.now()}`);
            fs.writeFileSync(tempFile, Buffer.from(response.data));

            let extractedText = '';
            if (isCsvOrTxt) {
                extractedText = fs.readFileSync(tempFile, 'utf-8');
            }

            if (extractedText.length > 20000) {
                extractedText = extractedText.substring(0, 20000) + '\n... [Texto truncado por longitud]';
            }

            const prompt = `Analizá el siguiente documento llamado ${document.file_name}:\n\n${extractedText}`;
            await handleResponse(ctx, userId, prompt, false);
        }

    } catch (error: any) {
        console.error("Document Handler Error:", error);
        await ctx.reply("Hubo un problema procesando tu documento. Intentá de nuevo.");
    } finally {
        if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
});

// Message Handler
bot.on('message:text', async (ctx) => {
    const userId = ctx.from.id.toString();
    await handleResponse(ctx, userId, ctx.message.text);
});

/**
 * Starts the Telegram bot.
 */
export async function startBot() {
    console.log("🚀 OpenGravity Bot is starting...");
    bot.start({
        onStart: (botInfo) => {
            console.log(`✅ Bot @${botInfo.username} is running.`);
        },
    });
}
