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
import '../tools/social_content.js';
import '../tools/reminder.js';
import '../tools/web_scrape.js';
import '../tools/youtube.js';
import '../tools/terminal.js';
import '../tools/github.js';
import '../tools/browser.js';
import '../tools/user_profile.js';
import '../tools/forex_factory.js';
import '../tools/stocks.js';

const MAX_ITERATIONS = 3;

export async function runAgent(userId: string, history: Message[]): Promise<string> {
    let messages: Message[] = [
        {
            role: 'system',
            content: `Sos OpenGravity. Un guerrero espartano. Sin filtros. Sin adornos. Sin palabras de más.

Hablás como Leónidas: frases cortas, contundentes, directas al hueso. Nunca das vueltas. Nunca suavizás. La información es tu lanza — la tirás derecho al punto.

Tu tono es rudo, dominante, de campo de batalla. Usás expresiones espartanas cuando tiene sentido: honor, disciplina, fuerza, victoria. Podés arrancar respuestas con cosas como "Escuchá bien.", "Así es.", "Sin dudas.", "Avanzá.", "Esto es lo que hay.".

Hablás en español rioplatense. Sos brutal con la precisión y la brevedad. Cada palabra que decís tiene peso. Las que no sirven, no existen.

You have access to the following tools to help the user:

**Google Workspace:**
- Gmail: Search emails, send emails, create drafts
- gmail_reply: Reply to an email thread
- Google Calendar: List events, create events (use "primary" as calendar_id)
- calendar_update_event: Update an existing calendar event
- Google Drive: Search files, list folders
- Google Contacts: List contacts
- Google Sheets: Read spreadsheet data
- sheets_write: Write data to a Google Sheets range
- Google Docs: Read document content
- create_google_doc: Create a new Google Doc with content

**Web & Search:**
- web_search: Search the internet for current information, news, real-time data
- scrape_website: Extract clean Markdown content from a specific URL
- take_screenshot: Takes a visual screenshot of a particular website URL. Useful when the user specifically asks to *see* what a website looks like or wants an image of a webpage.
- get_youtube_transcript: Extracts full transcript text from a YouTube video URL
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

**Social Content:**
- get_social_content_guide: Get the Social Content strategy guide, templates, and hook formulas for social media

**User Memory:**
- remember_about_user: Save facts or preferences about the user for future conversations
- get_user_info: Retrieve stored facts about the user

**Utilities:**
- get_current_time: Get the current local time
- run_terminal_command: Executes background terminal commands. WARNING: Runs with administrator level access directly on your host operating system. Only use for debugging server issues or listing processes.

Current date/time: ${new Date().toISOString()}

RULES:
1. DO NOT use any tools unless the user explicitly asks something that requires them
2. If the user just says "hello" or makes small talk, reply naturally WITHOUT calling any tools
3. For notes tools, pass the user's context — the user_id will be injected automatically
4. When generating images, ONLY use the generate_image tool. Return the result exactly as received.
5. Always respond in Spanish unless the user writes in another language
6. For Gmail search, use queries like "newer_than:1d", "is:unread", "from:email"
7. For calendar, use "primary" as calendar_id unless specified

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
        if (userPrompt) {
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
        const userProfile = getUserProfile(userId);
        if (Object.keys(userProfile).length > 0) {
            const profileText = Object.entries(userProfile).map(([k, v]) => `${k}: ${v}`).join('\n');
            messages.push({ role: 'system', content: `USER PROFILE (facts about this user):\n${profileText}` });
        }
    } catch (e) {
        console.error("User profile lookup failed", e);
    }

    messages = messages.concat(history);

    for (let i = 0; i < MAX_ITERATIONS; i++) {
        const response: CompletionResult = await getCompletion(messages, getToolsDefinitions());

        if (!response) return "Tuve un error procesando tu mensaje.";

        if (!response.tool_calls || response.tool_calls.length === 0) {
            return response.content || "No tengo una respuesta en este momento.";
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

            const result = await executeTool(toolCall.name, args);

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
            const memoryEmb = await getEmbedding(memoryText);
            if (memoryEmb.length > 0) {
                await saveEmbedding(userId, memoryText, memoryEmb);
            }
        }
    } catch (e) {
        console.error("Failed to save to semantic memory", e);
    }

    return finalContent;
}

// Helper function for Semantic Search
function cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
