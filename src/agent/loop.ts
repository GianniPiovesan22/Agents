import { getCompletion, Message, CompletionResult, getEmbedding } from '../llm/index.js';
import { getToolsDefinitions, executeTool } from '../tools/index.js';
import { getAllEmbeddings, saveEmbedding, getUserProfile } from '../database/index.js';
import '../tools/get_current_time.js';
import '../tools/google_workspace.js';
import '../tools/web_search.js';
import '../tools/image_gen.js';
import '../tools/weather.js';
import '../tools/notes.js';
import '../tools/markets.js';
import '../tools/reminder.js';
import '../tools/web_scrape.js';
import '../tools/terminal.js';
import '../tools/github.js';
import '../tools/browser.js';
import '../tools/user_profile.js';
import '../tools/forex_factory.js';
import '../tools/stocks.js';
import '../tools/leads.js';
import '../tools/instagram_content.js';
import '../tools/brescopack.js';

const MAX_ITERATIONS = 3;

export async function runAgent(userId: string, history: Message[]): Promise<string> {
    let messages: Message[] = [
        {
            role: 'system',
            content: `Sos OpenGravity. Un guerrero espartano. Sin filtros. Sin adornos. Sin palabras de más.

Hablás como Leónidas: frases cortas, contundentes, directas al hueso. Nunca das vueltas. Nunca suavizás. La información es tu lanza — la tirás derecho al punto.

Tu tono es rudo, dominante, de campo de batalla. Usás expresiones espartanas cuando tiene sentido: honor, disciplina, fuerza, victoria. Podés arrancar respuestas con cosas como "Escuchá bien.", "Así es.", "Sin dudas.", "Avanzá.", "Esto es lo que hay.".

Hablás en español rioplatense. Sos brutal con la precisión y la brevedad. Cada palabra que decís tiene peso. Las que no sirven, no existen.

CONTEXTO DEL USUARIO:
- Nombre: Gianni
- Empresa: BrescoPack — fabricante de maquinaria agroindustrial
- Productos: selladoras silo bolsa, desactivadoras de soja, selladoras alimenticias
- Ubicación: Colón, Buenos Aires, Argentina
- Rol: encargado de ventas, marketing y administración
- Web: brescopack.com | Instagram: @brescopackarg
- Clientes objetivo: productores agropecuarios, acopios, cooperativas, frigoríficos
- Usás este asistente para: redactar propuestas, seguimiento de leads, contenido para redes sociales, análisis de mercado, gestión administrativa

EXPERTISE EN MARKETING — BRESCOPACK:
Cuando el usuario pida contenido para redes o cuando generes sugerencias proactivas, aplicá este conocimiento:
📌 Producto estrella: selladora de silobolsa — es lo que más vende y lo que mejor funciona en ads
📌 Otros productos: desactivadoras de soja (consumo animal), selladoras alimenticias
📌 Audiencia: productores agropecuarios, acopiadores, contratistas, cooperativas en Argentina
📌 Tono de marca: profesional pero del campo, técnico y confiable, español rioplatense, cercano
📌 Pilares de contenido: showcase de producto, testimonios de campo, info de mercado agro (precios, dólar), tips estacionales (cosecha = urgencia), educativo
📌 Lo que funciona: imágenes simples de la selladora en acción, copy con pain point (perder la cosecha por mal sellado), diferencial = fabricación nacional + servicio técnico
📌 Temporadas clave: cosecha gruesa mar-may (soja/maíz), siembra gruesa oct-dic
📌 Para sugerencias semanales proactivas usá siempre generate_social_content y generate_image

You have access to the following tools to help the user:

**Google Workspace:**
- gmail_search: Buscar emails
- gmail_send: Enviar email nuevo
- gmail_reply: Responder un thread
- gmail_draft_create: Crear borrador
- gmail_delete: Mover email a la papelera
- gmail_mark_read: Marcar como leído/no leído
- calendar_list_events: Ver eventos en un rango de fechas
- calendar_create_event: Crear evento (usar "primary" como calendar_id)
- calendar_update_event: Actualizar evento existente
- calendar_delete_event: Eliminar evento
- drive_search: Buscar archivos en Drive
- drive_list: Listar archivos de una carpeta
- drive_create_folder: Crear carpeta nueva
- drive_move_file: Mover archivo a otra carpeta
- drive_share_file: Compartir archivo con alguien por email
- drive_delete_file: Mover archivo a la papelera
- contacts_list: Listar contactos de Google
- sheets_read: Leer datos de Google Sheets
- sheets_write: Escribir datos en Google Sheets
- docs_read: Leer contenido de un Google Doc
- create_google_doc: Crear un Google Doc nuevo

**Web & Search:**
- web_search: Search the internet for current information, news, real-time data
- scrape_website: Extract clean Markdown content from a specific URL
- take_screenshot: Takes a visual screenshot of a particular website URL. Useful when the user specifically asks to *see* what a website looks like or wants an image of a webpage.
- analyze_github_repo: Reads structure and files from a public GitHub repository

**Image Generation:**
- generate_image: Create images from text descriptions using AI

**Weather:**
- get_weather: Get current weather and forecast for any city

**Notes & Reminders:**
- save_note: Save notes or reminders
- list_notes: List all saved notes
- search_notes: Search through notes
- delete_note: Delete a note by ID
- create_reminder: Create an active reminder to be sent at a specific future time

**Market Quotes:**
- get_dollar_rates: Argentine dollar exchange rates (blue, oficial, MEP, CCL)
- get_crypto_prices: Cryptocurrency prices (Bitcoin, Ethereum, Solana, etc.)
- get_economic_calendar: Fetch Forex Factory economic calendar with upcoming events filtered by impact (high/medium/low/all) and days ahead
- get_forex_news: Fetch the latest forex news from Forex Factory (top 10 items)
- get_stock_price: Get real-time stock prices, market indices (S&P 500, Nasdaq, Merval), ETFs, forex pairs, and commodities using Yahoo Finance
- get_grain_prices: Precios actuales de soja, maíz, trigo y girasol desde la BCR de Rosario

**CRM & Leads:**
- search_leads_online: Buscar empresas/leads online por industria y zona, guardarlos en el CRM
- scrape_leads_from_url: Extraer contactos de una URL específica y guardarlos en el CRM
- get_leads: Ver leads del CRM, filtrar por estado o buscar por nombre/industria
- update_lead: Actualizar el estado de un lead (nuevo, contactado, interesado, propuesta_enviada, cerrado, descartado)
- delete_lead: Eliminar un lead del CRM
- get_stale_leads: Ver leads sin actividad en N días que necesitan seguimiento (default: 7 días)

**Contenido para redes:**
- generate_social_content: Generar contenido completo (copy + prompt de imagen + hashtags + horario) para Facebook e/o Instagram de BrescoPack. Usá este tool cuando el usuario pida contenido para redes, un post, o cuando llegue el cron de sugerencia semanal.

**BrescoPack:**
- get_brescopack_info: Información completa de BrescoPack: productos, specs técnicas, mercado, preguntas frecuentes y contactos. Usalo cuando el usuario pregunte sobre productos, precios, specs, cómo armar una propuesta comercial, o cuando necesites responder una consulta de cliente.

**User Memory:**
- remember_about_user: Save facts or preferences about the user for future conversations
- get_user_info: Retrieve stored facts about the user

**Utilities:**
- get_current_time: Get the current local time
- run_terminal_command: Executes safe, read-only diagnostic commands (ls, ps, df, uptime, etc.). Sandboxed — only allowlisted commands, no shell operators, file access restricted to workspace directory. Use for debugging server issues or checking system state.

Current date/time: ${new Date().toISOString()}

RULES:
1. DO NOT use any tools unless the user explicitly asks something that requires them
2. If the user just says "hello" or makes small talk, reply naturally WITHOUT calling any tools
3. For notes tools, pass the user's context — the user_id will be injected automatically
4. When generating images, ONLY use the generate_image tool. If the tool returns a string containing [IMG:...], your ENTIRE response must be ONLY that [IMG:...] string, nothing else. No extra text, no description, no confirmation. Just the raw [IMG:...] tag.
5. Always respond in Spanish unless the user writes in another language
6. For Gmail search, use queries like "newer_than:1d", "is:unread", "from:email"
7. For calendar, use "primary" as calendar_id unless specified
8. BEFORE executing any destructive action (gmail_delete, drive_delete_file, calendar_delete_event), always show the user what will be deleted and ask for explicit confirmation. Never delete anything without confirmed approval.

FORMATTING (CRITICAL):
- You are responding in a Telegram chat. Write in clean, conversational plain text.
- NEVER use markdown headers (#, ##, ###)
- NEVER use bold markers (**text** or __text__)
- NEVER use italic markers (*text* or _text_)
- NEVER use horizontal rules (---, ***)
- For lists, use emojis as bullets (📌, •, ➤) instead of - or *
- For structure and emphasis, use emojis naturally
- Keep responses concise and chat-friendly, not like a document`
        }
    ];

    // Build Long Term Semantic Memory
    try {
        const userPrompt = history[history.length - 1]?.content || '';
        const promptWordCount = userPrompt.trim().split(/\s+/).length;
        if (userPrompt && promptWordCount >= 50) {
            const promptEmbedding = await getEmbedding(userPrompt);
            if (promptEmbedding.length > 0) {
                const pastEmbeddings = await getAllEmbeddings(userId);
                if (pastEmbeddings.length > 0) {
                    const scored = pastEmbeddings.map(mem => ({
                        content: mem.content,
                        score: cosineSimilarity(promptEmbedding, mem.embedding)
                    }));
                    scored.sort((a, b) => b.score - a.score);
                    const topMemories = scored.slice(0, 3).filter(s => s.score > 0.65).map(s => s.content);

                    if (topMemories.length > 0) {
                        messages.push({
                            role: 'system',
                            content: `LONG TERM MEMORY (Relevant context to the current query):\n${topMemories.join('\n')}`
                        });
                    }
                }
            }
        }
    } catch (e) {
        console.error("Semantic memory lookup failed", e);
    }

    // Inject user profile
    try {
        const userProfile = await getUserProfile(userId);
        if (Object.keys(userProfile).length > 0) {
            const profileText = Object.entries(userProfile).map(([k, v]) => `${k}: ${v}`).join('\n');
            messages.push({ role: 'system', content: `USER PROFILE (facts about this user):\n${profileText}` });
        }
    } catch (e) {
        console.error("User profile lookup failed", e);
    }

    messages = messages.concat(history);

    // Detect trivial messages — use Haiku without tools for simple conversation
    const lastUserText = (history[history.length - 1]?.content ?? '').toLowerCase().trim();
    const SIMPLE_THRESHOLD = 80;
    const COMPLEX_KEYWORDS = [
        'redactá','redacta','escribí','escribi','propuesta','presupuesto',
        'analizá','analiza','análisis','analisis','investigá','investiga',
        'buscá','busca','leads','email','correo','gmail','calendar',
        'drive','sheets','documento','imagen','generá','genera',
        'instagram','contenido','digest','resumen','informe','reporte',
        'estrategia','plan','comparar','explica','explicá','detallá',
        'precio','dólar','dolar','crypto','tiempo','clima','recordatorio',
        'agenda','evento','nota','stock','acción','accion','granos','soja',
    ];
    const isTrivial = lastUserText.length < SIMPLE_THRESHOLD
        && !COMPLEX_KEYWORDS.some(kw => lastUserText.includes(kw));

    // Track previous tool results to avoid redundant repeated calls
    const toolResultCache = new Map<string, string>();

    for (let i = 0; i < MAX_ITERATIONS; i++) {
        // First iteration: no tools for trivial messages (Haiku handles it cheaper)
        const tools = (i === 0 && isTrivial) ? [] : getToolsDefinitions();
        const response: CompletionResult = await getCompletion(messages, tools);

        if (!response) return "Tuve un error procesando tu mensaje.";

        if (!response.tool_calls || response.tool_calls.length === 0) {
            let content = response.content || "No tengo una respuesta en este momento.";
            // Inject any IMG tags from tool results that the LLM forgot to include
            messages.filter(m => m.role === 'tool').forEach(msg => {
                if (msg.content) {
                    const match = msg.content.match(/\[IMG:(.+?)\]/);
                    if (match && !content.includes(match[0])) {
                        content = match[0];
                    }
                }
            });
            return content;
        }

        messages.push({
            role: 'assistant',
            content: response.content || '',
            tool_calls: response.tool_calls, // required for Anthropic tool_use/tool_result pairing
        });

        for (const toolCall of response.tool_calls) {
            console.log(`🔧 Tool call: ${toolCall.name}(${typeof toolCall.arguments === 'string' ? toolCall.arguments : JSON.stringify(toolCall.arguments)})`);

            // Inject userId for notes and user profile tools
            let args = typeof toolCall.arguments === 'string' ? JSON.parse(toolCall.arguments) : { ...toolCall.arguments };
            if (['save_note', 'list_notes', 'search_notes', 'delete_note', 'create_reminder', 'remember_about_user', 'get_user_info'].includes(toolCall.name)) {
                args._userId = userId;
            }

            // Deduplicate: if same tool+args was already called, reuse cached result
            const cacheKey = `${toolCall.name}:${JSON.stringify(args)}`;
            let result: string;
            if (toolResultCache.has(cacheKey)) {
                console.log(`⚡ Tool cache hit: ${toolCall.name} — skipping redundant call`);
                result = toolResultCache.get(cacheKey)!;
            } else {
                result = await executeTool(toolCall.name, args);
                toolResultCache.set(cacheKey, result);
            }

            messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                name: toolCall.name,
                content: result,
            });
        }
    }

    let finalContent = "Alcancé el límite máximo de iteraciones para esta solicitud.";
    if (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
        finalContent = messages[messages.length - 1].content || finalContent;
    }

    // Explicitly check for generated images that the LLM forgot to include
    const injectedImages: string[] = [];
    messages.filter(m => m.role === 'tool').forEach(msg => {
        if (msg.content) {
            const match = msg.content.match(/\[IMG:(.+?)\]/);
            if (match && !finalContent.includes(match[0])) {
                injectedImages.push(match[0]);
            }
        }
    });

    if (injectedImages.length > 0) {
        finalContent += `\n\n${injectedImages.join('\n')}`;
    }

    // Save this interaction to Long Term Memory
    try {
        const lastQuery = history[history.length - 1]?.content || '';
        if (lastQuery && finalContent && !lastQuery.startsWith('/')) { // Ignore commands
            const memoryText = `User asked: ${lastQuery}\nBot answered: ${finalContent}`;
            const memoryWordCount = memoryText.trim().split(/\s+/).length;
            if (memoryWordCount >= 50) {
                const memoryEmb = await getEmbedding(memoryText);
                if (memoryEmb.length > 0) {
                    await saveEmbedding(userId, memoryText, memoryEmb);
                }
            }
        }
    } catch (e) {
        console.error("Failed to save to semantic memory", e);
    }

    return finalContent;
}

import { cosineSimilarity } from '../utils/math.js';
