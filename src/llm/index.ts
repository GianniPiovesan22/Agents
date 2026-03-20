import Groq from 'groq-sdk';
import { GoogleGenAI, Type } from '@google/genai';
import { config } from '../config/index.js';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import pRetry, { AbortError } from 'p-retry';

// ── Providers ──────────────────────────────────────────────────
const groq = new Groq({ apiKey: config.GROQ_API_KEY });
const openRouter = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: config.OPENROUTER_API_KEY,
});

export const geminiClient = config.GEMINI_API_KEY
    ? new GoogleGenAI({ apiKey: config.GEMINI_API_KEY })
    : null;

const anthropicClient = config.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
    : null;

// ── Anthropic Models ───────────────────────────────────────────
const ANTHROPIC_SONNET = 'claude-sonnet-4-5';
const ANTHROPIC_HAIKU  = 'claude-haiku-4-5-20251001';

// ── Intent Types ───────────────────────────────────────────────
type TaskIntent = 'operational' | 'creative' | 'search';

// Keyword heuristics — fallback when Haiku classification fails
const SEARCH_KEYWORDS = [
    'buscá', 'busca', 'investigá', 'investiga', 'noticias', 'qué pasó',
    'que paso', 'información sobre', 'informacion sobre',
];

const CREATIVE_KEYWORDS = [
    'redactá', 'redacta', 'escribí', 'escribi', 'contenido', 'post',
    'email', 'propuesta', 'instagram', 'facebook',
];

function keywordClassify(messages: Message[]): TaskIntent {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUser) return 'operational';

    // Vision/document tasks → creative
    if (lastUser.images?.length || lastUser.documents?.length) return 'creative';

    const text = typeof lastUser.content === 'string' ? lastUser.content.toLowerCase() : '';

    if (SEARCH_KEYWORDS.some(kw => text.includes(kw))) return 'search';
    if (CREATIVE_KEYWORDS.some(kw => text.includes(kw))) return 'creative';

    return 'operational';
}

async function classifyIntent(messages: Message[]): Promise<TaskIntent> {
    if (!anthropicClient) return keywordClassify(messages);

    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUser) return 'operational';

    const userText = typeof lastUser.content === 'string' ? lastUser.content : '';

    // If last message is too short (follow-up like "silo bolsa", "dale", "sí"),
    // look at recent conversation context to infer intent
    const recentContext = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(-6)
        .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`)
        .join('\n');

    const contextForClassification = userText.split(/\s+/).length < 5
        ? recentContext
        : userText;

    try {
        const response = await anthropicClient.messages.create({
            model: ANTHROPIC_HAIKU,
            max_tokens: 10,
            messages: [{
                role: 'user',
                content: `Classify the user's LATEST intent into exactly one category: operational, creative, or search.\nReturn only the category word, nothing else.\n\nConversation:\n${contextForClassification}`,
            }],
        });

        const raw = response.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('')
            .trim()
            .toLowerCase();

        if (raw === 'operational' || raw === 'creative' || raw === 'search') {
            return raw as TaskIntent;
        }

        // Haiku returned something unexpected — fall through to keyword heuristic
        return keywordClassify(messages);
    } catch {
        // Silent fallback — classification errors must never break the flow
        return keywordClassify(messages);
    }
}

// Keywords that always require Sonnet
const SONNET_KEYWORDS = [
    'redactá', 'redacta', 'escribí', 'escribi', 'propuesta', 'presupuesto',
    'analizá', 'analiza', 'análisis', 'analisis', 'investigá', 'investiga',
    'buscá', 'busca', 'leads', 'email', 'correo', 'gmail', 'calendar',
    'drive', 'sheets', 'documento', 'imagen', 'generá', 'genera',
    'instagram', 'contenido', 'digest', 'resumen', 'informe', 'reporte',
    'estrategia', 'plan', 'comparar', 'explica', 'explicá', 'detallá',
];

function selectAnthropicModel(messages: Message[], tools?: Tool[]): string {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUser) return ANTHROPIC_HAIKU;

    // Always Sonnet for images or documents (vision tasks)
    if (lastUser.images?.length || lastUser.documents?.length) return ANTHROPIC_SONNET;

    const text = typeof lastUser.content === 'string' ? lastUser.content.toLowerCase() : '';

    // Sonnet only for genuinely complex/long tasks
    if (text.length > 400 && SONNET_KEYWORDS.some(kw => text.includes(kw))) return ANTHROPIC_SONNET;

    // Haiku for everything else (tool calls included — Anthropic is now a fallback, not primary)
    return ANTHROPIC_HAIKU;
}

// ── Gemini Model Tiers (fallback) ──────────────────────────────
const GEMINI_MODELS = {
    fast: 'gemini-2.5-flash',
    pro: 'gemini-2.5-pro',
    ultra: 'gemini-2.5-pro',
} as const;

const GROQ_MODEL = 'llama-3.3-70b-versatile';

// ── Smart Model Router (for Gemini fallback) ───────────────────
const COMPLEX_KEYWORDS = [
    // Analysis & reasoning
    'analizá', 'analiza', 'análisis', 'explicame', 'explicá', 'detallado',
    'profundidad', 'razona', 'razonamiento', 'por qué', 'porque',
    // Coding
    'código', 'programa', 'script', 'función', 'refactorizar', 'debug',
    'error en el código', 'implementar', 'arquitectura',
    // Writing & creativity
    'redactá', 'escribí', 'ensayo', 'artículo', 'informe', 'reporte',
    'plan de negocios', 'estrategia', 'propuesta',
    // Research
    'investigá', 'compará', 'ventajas y desventajas', 'pros y contras',
    'resumen ejecutivo', 'review',
    // Math & data
    'calculá', 'fórmula', 'estadística', 'probabilidad', 'ecuación',
    // Explicit request for power
    'usá pro', 'modelo potente', 'pensá bien', 'con detalle', 'a fondo',
];

function classifyComplexity(messages: Message[]): keyof typeof GEMINI_MODELS {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUserMsg) return 'fast';

    const text = lastUserMsg.content.toLowerCase();
    if (text.length < 20) return 'fast';

    const complexityScore = COMPLEX_KEYWORDS.filter(kw => text.includes(kw)).length;
    const sentenceCount = (text.match(/[.!?]+/g) || []).length + 1;
    const wordCount = text.split(/\s+/).length;

    let score = complexityScore * 2;
    if (wordCount > 50) score += 2;
    if (wordCount > 100) score += 2;
    if (sentenceCount > 3) score += 1;

    if (score >= 6) return 'ultra';
    if (score >= 2) return 'pro';
    return 'fast';
}

// ── Shared Types ───────────────────────────────────────────────
export interface Message {
    role: 'user' | 'assistant' | 'system' | 'tool' | 'model';
    content: string;
    tool_call_id?: string;
    name?: string;
    images?: { mimeType: string, data: string }[];
    documents?: { mimeType: string, data: string }[]; // base64-encoded documents (PDF)
    tool_calls?: ToolCallResult[]; // for in-memory use (Anthropic format)
}

export interface Tool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: object;
    };
}

export interface ToolCallResult {
    id: string;
    name: string;
    arguments: string | object;
}

export interface CompletionResult {
    content: string | null;
    tool_calls: ToolCallResult[];
}

// ── Anthropic Message Conversion ───────────────────────────────
function convertMessagesForAnthropic(messages: Message[]) {
    let system = '';
    const converted: any[] = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            system += (system ? '\n\n' : '') + msg.content;
            continue;
        }

        if (msg.role === 'user') {
            const parts: any[] = [];
            if (msg.content) parts.push({ type: 'text', text: msg.content });
            if (msg.images) {
                for (const img of msg.images) {
                    parts.push({
                        type: 'image',
                        source: { type: 'base64', media_type: img.mimeType, data: img.data },
                    });
                }
            }
            if (msg.documents) {
                for (const doc of msg.documents) {
                    parts.push({
                        type: 'document',
                        source: { type: 'base64', media_type: doc.mimeType, data: doc.data },
                    });
                }
            }
            converted.push({ role: 'user', content: parts });

        } else if (msg.role === 'assistant' || msg.role === 'model') {
            const parts: any[] = [];
            if (msg.content) parts.push({ type: 'text', text: msg.content });
            // Include tool_use blocks so Anthropic sees the proper pairing
            if (msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    const input = typeof tc.arguments === 'string'
                        ? JSON.parse(tc.arguments)
                        : tc.arguments;
                    parts.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
                }
            }
            if (parts.length > 0) {
                converted.push({ role: 'assistant', content: parts });
            }

        } else if (msg.role === 'tool') {
            // Tool results must be user messages with tool_result blocks
            const toolResult = {
                type: 'tool_result',
                tool_use_id: msg.tool_call_id,
                content: msg.content || '',
            };
            // If the previous converted message is already a user message (aggregating multiple tool results)
            const prev = converted[converted.length - 1];
            if (prev && prev.role === 'user' && Array.isArray(prev.content)) {
                prev.content.push(toolResult);
            } else {
                converted.push({ role: 'user', content: [toolResult] });
            }
        }
    }

    return { system, messages: converted };
}

// ── Anthropic Completion (PRIMARY) ─────────────────────────────
async function anthropicCompletion(messages: Message[], tools?: Tool[], forceModel?: string): Promise<CompletionResult> {
    if (!anthropicClient) throw new Error('Anthropic not configured');

    const model = forceModel ?? selectAnthropicModel(messages, tools);
    const inputTokens = messages.reduce((acc, m) => acc + (typeof m.content === 'string' ? m.content.length / 4 : 0), 0);
    console.log(`🧠 Provider: Anthropic (${model}) | ~${Math.round(inputTokens)} tokens`);

    const { system, messages: anthropicMessages } = convertMessagesForAnthropic(messages);

    const anthropicTools = tools?.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters as any,
    }));

    const response = await anthropicClient.messages.create({
        model,
        max_tokens: 8096,
        ...(system ? { system } : {}),
        messages: anthropicMessages,
        ...(anthropicTools && anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
    });

    const textContent = response.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('') || null;

    const toolCalls: ToolCallResult[] = response.content
        .filter((b: any) => b.type === 'tool_use')
        .map((b: any) => ({
            id: b.id,
            name: b.name,
            arguments: b.input,
        }));

    return { content: textContent, tool_calls: toolCalls };
}

// ── Gemini Schema Conversion ───────────────────────────────────
function convertToolsForGemini(tools: Tool[]) {
    return [{
        functionDeclarations: tools.map(t => ({
            name: t.function.name,
            description: t.function.description,
            parameters: convertSchemaForGemini(t.function.parameters),
        })),
    }];
}

function convertSchemaForGemini(schema: any): any {
    if (!schema) return undefined;
    const converted: any = {};

    if (schema.type === 'object') converted.type = Type.OBJECT;
    else if (schema.type === 'string') converted.type = Type.STRING;
    else if (schema.type === 'number' || schema.type === 'integer') converted.type = Type.NUMBER;
    else if (schema.type === 'boolean') converted.type = Type.BOOLEAN;
    else if (schema.type === 'array') converted.type = Type.ARRAY;

    if (schema.description) converted.description = schema.description;
    if (schema.enum) converted.enum = schema.enum;
    if (schema.required) converted.required = schema.required;

    if (schema.properties) {
        converted.properties = {};
        for (const [key, value] of Object.entries(schema.properties)) {
            converted.properties[key] = convertSchemaForGemini(value);
        }
    }

    if (schema.items) {
        converted.items = convertSchemaForGemini(schema.items);
    }

    return converted;
}

function convertMessagesForGemini(messages: Message[]) {
    const systemInstruction: string[] = [];
    const contents: any[] = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            systemInstruction.push(msg.content);
            continue;
        }

        if (msg.role === 'user') {
            const parts: any[] = [{ text: msg.content }];
            if (msg.images) {
                for (const img of msg.images) {
                    parts.push({
                        inlineData: {
                            data: img.data,
                            mimeType: img.mimeType
                        }
                    });
                }
            }
            contents.push({ role: 'user', parts });
        } else if (msg.role === 'assistant' || msg.role === 'model') {
            const parts: any[] = [];
            if (msg.content) parts.push({ text: msg.content });
            if (parts.length > 0) contents.push({ role: 'model', parts });
        } else if (msg.role === 'tool') {
            contents.push({
                role: 'user',
                parts: [{
                    functionResponse: {
                        name: msg.name || 'unknown',
                        response: { result: msg.content },
                    },
                }],
            });
        }
    }

    return { systemInstruction: systemInstruction.join('\n\n'), contents };
}

// ── Gemini Completion (Fallback 1) ─────────────────────────────
async function geminiCompletion(messages: Message[], tools?: Tool[]): Promise<CompletionResult> {
    if (!geminiClient) throw new Error('Gemini not configured');

    const tier = classifyComplexity(messages);
    const model = GEMINI_MODELS[tier];
    const inputTokens = messages.reduce((acc, m) => acc + (typeof m.content === 'string' ? m.content.length / 4 : 0), 0);
    console.log(`🧠 Provider: Gemini (${model}, tier: ${tier}) | ~${Math.round(inputTokens)} tokens`);

    const { systemInstruction, contents } = convertMessagesForGemini(messages);

    const geminiConfig: any = {};
    if (systemInstruction) geminiConfig.systemInstruction = systemInstruction;
    if (tools && tools.length > 0) geminiConfig.tools = convertToolsForGemini(tools);

    const response = await geminiClient.models.generateContent({
        model,
        contents,
        config: geminiConfig,
    });

    const textContent = response.text || null;
    const toolCalls: ToolCallResult[] = [];

    if (response.functionCalls && response.functionCalls.length > 0) {
        for (const fc of response.functionCalls) {
            toolCalls.push({
                id: `gemini_${fc.name}_${Date.now()}`,
                name: fc.name || '',
                arguments: fc.args || {},
            });
        }
    }

    return { content: textContent, tool_calls: toolCalls };
}

// ── Groq Completion (Fallback 2) ───────────────────────────────
async function groqCompletion(messages: Message[], tools?: Tool[]): Promise<CompletionResult> {
    const inputTokens = messages.reduce((acc, m) => acc + (typeof m.content === 'string' ? m.content.length / 4 : 0), 0);
    console.log(`🧠 Provider: Groq (${GROQ_MODEL}) | 🟢 free | ~${Math.round(inputTokens)} tokens`);

    const cleanMessages = messages.map(m => {
        const { images, tool_calls, ...rest } = m;
        return rest;
    });

    const response = await groq.chat.completions.create({
        model: GROQ_MODEL,
        messages: cleanMessages as any,
        tools: tools as any,
        tool_choice: 'auto',
    });

    const msg = response.choices[0].message;
    const toolCalls: ToolCallResult[] = [];

    if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
            toolCalls.push({
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments,
            });
        }
    }

    return { content: msg.content || null, tool_calls: toolCalls };
}

// ── OpenRouter Completion (Fallback 3) ─────────────────────────
async function openRouterCompletion(messages: Message[], tools?: Tool[]): Promise<CompletionResult> {
    console.log(`🧠 Provider: OpenRouter (${config.OPENROUTER_MODEL || 'openrouter/auto'})`);

    const cleanMessages = messages.map(m => {
        const { images, tool_calls, ...rest } = m;
        return {
            ...rest,
            role: (rest.role === 'model' ? 'assistant' : rest.role) as any,
        };
    });

    const openaiTools = tools?.map(t => ({
        type: 'function' as const,
        function: {
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters as any,
        },
    }));

    const response = await openRouter.chat.completions.create({
        model: config.OPENROUTER_MODEL || 'openrouter/auto',
        messages: cleanMessages as any,
        tools: openaiTools,
    });

    const msg = response.choices[0].message;
    const toolCalls: ToolCallResult[] = [];

    if (msg.tool_calls) {
        for (const tc of msg.tool_calls as any[]) {
            toolCalls.push({
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments,
            });
        }
    }

    return { content: msg.content || null, tool_calls: toolCalls };
}

// ── Main Completion ────────────────────────────────────────────
export async function getCompletion(messages: Message[], tools?: Tool[]): Promise<CompletionResult> {
    const primary = config.PRIMARY_PROVIDER || 'groq';
    const routingMode = config.ROUTING_MODE ?? 'smart';

    const result = await pRetry(async () => {
        // ── Smart routing (default) ────────────────────────────
        if (routingMode === 'smart') {
            const intent = await classifyIntent(messages);
            console.log(`🎯 Intent: ${intent} → ${intent === 'creative' ? 'Claude Sonnet' : intent === 'search' ? 'Gemini Flash' : 'Groq'}`);

            if (intent === 'creative') {
                // Creative: Claude Sonnet always (quality writing, vision, proposals)
                if (anthropicClient) {
                    try { return await anthropicCompletion(messages, tools, ANTHROPIC_SONNET); }
                    catch (e: any) { console.error('⚠️ Anthropic (creative) error, falling back to Groq:', e?.message); }
                }
                // Fallback chain: Groq → Gemini → OpenRouter
                try { return await groqCompletion(messages, tools); }
                catch (e: any) { console.error('⚠️ Groq fallback error, trying Gemini:', e?.message); }
                if (geminiClient) {
                    try { return await geminiCompletion(messages, tools); }
                    catch (e: any) { console.error('⚠️ Gemini fallback error, trying OpenRouter:', e?.message); }
                }

            } else if (intent === 'search') {
                // Search: Gemini Flash (Google grounding, web research)
                if (geminiClient) {
                    try { return await geminiCompletion(messages, tools); }
                    catch (e: any) { console.error('⚠️ Gemini (search) error, falling back to Groq:', e?.message); }
                }
                // Fallback chain: Groq → Anthropic → OpenRouter
                try { return await groqCompletion(messages, tools); }
                catch (e: any) { console.error('⚠️ Groq fallback error, trying Anthropic:', e?.message); }
                if (anthropicClient) {
                    try { return await anthropicCompletion(messages, tools); }
                    catch (e: any) { console.error('⚠️ Anthropic fallback error, trying OpenRouter:', e?.message); }
                }

            } else {
                // Operational: Groq (fast, free, tool calls, calendar, leads)
                try { return await groqCompletion(messages, tools); }
                catch (e: any) { console.error('⚠️ Groq (operational) error, falling back to Gemini:', e?.message); }
                if (geminiClient) {
                    try { return await geminiCompletion(messages, tools); }
                    catch (e: any) { console.error('⚠️ Gemini fallback error, trying Anthropic:', e?.message); }
                }
                if (anthropicClient) {
                    try { return await anthropicCompletion(messages, tools); }
                    catch (e: any) { console.error('⚠️ Anthropic fallback error, trying OpenRouter:', e?.message); }
                }
            }

        } else if (primary === 'anthropic') {
            // ── Legacy mode: Anthropic first (quality-first, higher cost) ──
            if (anthropicClient) {
                try { return await anthropicCompletion(messages, tools); }
                catch (e: any) { console.error('⚠️ Anthropic error, falling back to Gemini:', e?.message); }
            }
            if (geminiClient) {
                try { return await geminiCompletion(messages, tools); }
                catch (e: any) { console.error('⚠️ Gemini error, falling back to Groq:', e?.message); }
            }
            try { return await groqCompletion(messages, tools); }
            catch (e: any) { console.error('⚠️ Groq error, falling back to OpenRouter:', e?.message); }

        } else {
            // ── ROUTING_MODE=groq: cost-optimized chain — Groq → Gemini → Anthropic ──
            try { return await groqCompletion(messages, tools); }
            catch (e: any) { console.error('⚠️ Groq error, falling back to Gemini:', e?.message); }

            if (geminiClient) {
                try { return await geminiCompletion(messages, tools); }
                catch (e: any) { console.error('⚠️ Gemini error, falling back to Anthropic:', e?.message); }
            }

            if (anthropicClient) {
                try { return await anthropicCompletion(messages, tools); }
                catch (e: any) { console.error('⚠️ Anthropic error, falling back to OpenRouter:', e?.message); }
            }
        }

        // Last resort: OpenRouter
        try {
            return await openRouterCompletion(messages, tools);
        } catch (lastError) {
            console.error('❌ All providers failed:', lastError);
            throw lastError;
        }
    }, { retries: 2 });

    // Fallback parser for hallucinated <function(name)>args</function> strings
    if (result && result.tool_calls.length === 0 && result.content && result.content.includes('<function(')) {
        const regex = /<function\(([\w_]+)\)>?(.*?)<\/function>/gs;
        let match;
        let newContent = result.content;

        while ((match = regex.exec(result.content)) !== null) {
            const name = match[1];
            const rawArgs = match[2];
            try {
                const parsedArgs = JSON.parse(rawArgs.trim());
                result.tool_calls.push({
                    id: `regex_${name}_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
                    name,
                    arguments: parsedArgs,
                });
                newContent = newContent.replace(match[0], '').trim();
            } catch (e) {
                console.warn("⚠️ Failed to parse hallucinated function arguments:", rawArgs);
            }
        }

        result.content = newContent === '' ? null : newContent;
    }

    return result as CompletionResult;
}

/**
 * Transcribes audio using Groq's Whisper.
 */
export async function transcribeAudio(filePath: string) {
    const fs = await import('fs');
    const response = await groq.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: 'whisper-large-v3',
    });
    return response.text;
}

/**
 * Generates an embedding vector for a given text using Gemini.
 */
export async function getEmbedding(text: string): Promise<number[]> {
    if (!geminiClient) throw new Error('Gemini not configured for embeddings');

    try {
        const result = await geminiClient.models.embedContent({
            model: 'text-embedding-004',
            contents: text,
        });

        return result.embeddings?.[0]?.values || [];
    } catch (error: any) {
        if (error.status === 404 || error.message?.includes('404')) {
            console.error("⚠️ Embeddings API returned 404 (Ignored). Note: Some Gemini keys don't support text-embedding models.");
        } else {
            console.error("⚠️ Error generating embedding:", error.message || error);
        }
        return [];
    }
}

/**
 * Generates speech from text using ElevenLabs.
 */
export async function textToSpeech(text: string): Promise<string> {
    const axios = (await import('axios')).default;
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');

    const tempPath = path.join(os.tmpdir(), `tts_${Date.now()}.mp3`);

    const response = await axios({
        method: 'POST',
        url: `https://api.elevenlabs.io/v1/text-to-speech/${config.ELEVENLABS_VOICE_ID}/stream`,
        headers: {
            'Accept': 'audio/mpeg',
            'xi-api-key': config.ELEVENLABS_API_KEY,
            'Content-Type': 'application/json',
        },
        data: {
            text,
            model_id: 'eleven_multilingual_v2',
            voice_settings: {
                stability: 0.5,
                similarity_boost: 0.75,
            }
        },
        responseType: 'stream',
    }).catch(async (err) => {
        if (err.response) {
            let errorBody = '';
            try {
                const chunks: Buffer[] = [];
                for await (const chunk of err.response.data) {
                    chunks.push(Buffer.from(chunk));
                }
                errorBody = Buffer.concat(chunks).toString('utf-8');
            } catch { errorBody = 'Could not read error body'; }
            console.error(`ElevenLabs Error [${err.response.status}]:`, errorBody);
            throw new Error(`ElevenLabs API error ${err.response.status}: ${errorBody}`);
        }
        throw err;
    });

    const writer = fs.createWriteStream(tempPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', () => resolve(tempPath));
        writer.on('error', reject);
    });
}
