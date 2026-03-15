import Groq from 'groq-sdk';
import { GoogleGenAI, Type } from '@google/genai';
import { config } from '../config/index.js';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import pRetry, { AbortError } from 'p-retry';

// ── Providers ──────────────────────────────────────────────────
const groq = new Groq({ apiKey: config.GROQ_API_KEY });

const anthropicClient = config.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
    : null;
const openRouter = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: config.OPENROUTER_API_KEY,
});

const geminiClient = config.GEMINI_API_KEY
    ? new GoogleGenAI({ apiKey: config.GEMINI_API_KEY })
    : null;

// ── Model Tiers ────────────────────────────────────────────────
const MODELS = {
    fast: 'gemini-2.0-flash',       // Quick tasks: greetings, simple Q&A, tools
    pro: 'gemini-2.0-pro-exp-02-05', // Complex: analysis, research, coding, long context
    ultra: 'gemini-2.0-pro-exp-02-05', // Hardest: deep reasoning, multi-step planning
} as const;

const GROQ_MODEL = 'llama-3.3-70b-versatile';

// ── Smart Model Router ─────────────────────────────────────────
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

function classifyComplexity(messages: Message[]): keyof typeof MODELS {
    // Get the last user message
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUserMsg) return 'fast';

    const text = lastUserMsg.content.toLowerCase();

    // Short messages (< 20 chars) are almost always simple
    if (text.length < 20) return 'fast';

    // Check for complexity keywords
    const complexityScore = COMPLEX_KEYWORDS.filter(kw => text.includes(kw)).length;

    // Long messages with multiple sentences suggest complex requests
    const sentenceCount = (text.match(/[.!?]+/g) || []).length + 1;
    const wordCount = text.split(/\s+/).length;

    // Scoring: keywords + length + sentence complexity
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
            contents.push({
                role: 'user',
                parts,
            });
        } else if (msg.role === 'assistant' || msg.role === 'model') {
            const parts: any[] = [];
            if (msg.content) {
                parts.push({ text: msg.content });
            }
            if (parts.length > 0) {
                contents.push({ role: 'model', parts });
            }
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

// ── Gemini Completion ──────────────────────────────────────────
async function geminiCompletion(messages: Message[], tools?: Tool[], modelOverride?: string): Promise<CompletionResult> {
    if (!geminiClient) throw new Error('Gemini not configured');

    const tier = classifyComplexity(messages);
    const model = modelOverride || MODELS[tier];
    console.log(`🧠 Model: ${model} (tier: ${tier})`);

    const { systemInstruction, contents } = convertMessagesForGemini(messages);

    const geminiConfig: any = {};
    if (systemInstruction) {
        geminiConfig.systemInstruction = systemInstruction;
    }
    if (tools && tools.length > 0) {
        geminiConfig.tools = convertToolsForGemini(tools);
    }

    const response = await geminiClient.models.generateContent({
        model,
        contents,
        config: {
            ...geminiConfig,
            abortSignal: AbortSignal.timeout(config.LLM_TIMEOUT_MS),
        },
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

// ── Claude Completion ──────────────────────────────────────────
async function claudeCompletion(messages: Message[], tools?: Tool[]): Promise<CompletionResult> {
    if (!anthropicClient) throw new Error('Anthropic not configured');

    const systemMsg = messages.find(m => m.role === 'system');
    const cleanMessages = messages
        .filter(m => m.role !== 'system')
        .map(m => ({
            role: (m.role === 'model' ? 'assistant' : m.role) as 'user' | 'assistant',
            content: m.content,
        }));

    const anthropicTools = tools?.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters as any,
    }));

    const response = await anthropicClient.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: systemMsg?.content,
        messages: cleanMessages,
        ...(anthropicTools && anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
    });

    const toolCalls: ToolCallResult[] = [];
    let textContent: string | null = null;

    for (const block of response.content) {
        if (block.type === 'text') {
            textContent = block.text;
        } else if (block.type === 'tool_use') {
            toolCalls.push({
                id: block.id,
                name: block.name,
                arguments: block.input as any,
            });
        }
    }

    return { content: textContent, tool_calls: toolCalls };
}

// ── Groq Completion (fallback) ─────────────────────────────────
async function groqCompletion(messages: Message[], tools?: Tool[]): Promise<CompletionResult> {
    const cleanMessages = messages.map(m => {
        const { images, ...rest } = m;
        return rest;
    });

    const response = await groq.chat.completions.create(
        {
            model: GROQ_MODEL,
            messages: cleanMessages as any,
            tools: tools as any,
            tool_choice: 'auto',
        },
        { signal: AbortSignal.timeout(config.LLM_TIMEOUT_MS) }
    );

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

// ── OpenRouter Completion (Second Fallback) ────────────────────
async function openRouterCompletion(messages: Message[], tools?: Tool[]): Promise<CompletionResult> {
    const cleanMessages = messages.map(m => {
        const { images, ...rest } = m;
        // Map inner roles to standard OpenAI roles
        return {
            ...rest,
            role: (rest.role === 'model' ? 'assistant' : rest.role) as any
        };
    });

    const openaiTools = tools?.map(t => ({
        type: 'function' as const,
        function: {
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters as any
        }
    }));

    const response = await openRouter.chat.completions.create(
        {
            model: config.OPENROUTER_MODEL || 'openrouter/auto',
            messages: cleanMessages as any,
            tools: openaiTools,
        },
        { signal: AbortSignal.timeout(config.LLM_TIMEOUT_MS) }
    );

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
    return await pRetry(async () => {
        const tier = classifyComplexity(messages);
        const useClaudeForThisRequest = anthropicClient && (tier === 'pro' || tier === 'ultra');

        // Claude for complex requests only
        if (useClaudeForThisRequest) {
            try {
                console.log(`🧠 Model: claude-sonnet-4-6 (tier: ${tier})`);
                return await claudeCompletion(messages, tools);
            } catch (error: any) {
                if (error.name === 'AbortError' || error.name === 'TimeoutError') {
                    throw new AbortError(`LLM timeout after ${config.LLM_TIMEOUT_MS}ms (Claude)`);
                }
                console.error('⚠️ Claude error, falling back to Groq:', error?.message || error);
            }
        }

        // Gemini for medium complexity (if configured)
        if (geminiClient && tier !== 'fast') {
            try {
                return await geminiCompletion(messages, tools);
            } catch (error: any) {
                if (error.name === 'AbortError' || error.name === 'TimeoutError') {
                    throw new AbortError(`LLM timeout after ${config.LLM_TIMEOUT_MS}ms (Gemini)`);
                }
                console.error('⚠️ Gemini error, falling back to Groq:', error?.message || error);
            }
        }

        // Groq for fast/simple requests (default)
        try {
            console.log(`⚡ Model: groq/llama-3.3-70b (tier: ${tier})`);
            return await groqCompletion(messages, tools);
        } catch (error: any) {
            if (error.name === 'AbortError' || error.name === 'TimeoutError') {
                throw new AbortError(`LLM timeout after ${config.LLM_TIMEOUT_MS}ms (Groq)`);
            }
            console.error('⚠️ Groq API error, falling back to OpenRouter:', error?.message || error);
            try {
                return await openRouterCompletion(messages, tools);
            } catch (lastError: any) {
                if (lastError.name === 'AbortError' || lastError.name === 'TimeoutError') {
                    throw new AbortError(`LLM timeout after ${config.LLM_TIMEOUT_MS}ms (OpenRouter)`);
                }
                console.error('❌ OpenRouter API error:', lastError);
                throw lastError;
            }
        }
    }, { retries: 2 });
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
    } catch (error) {
        console.error("Error generating embedding:", error);
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
