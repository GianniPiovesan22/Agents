import { registerTool } from './index.js';
import { config } from '../config/index.js';
import { GoogleGenAI } from '@google/genai';

const ai = config.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: config.GEMINI_API_KEY }) : null;

// ═══════════════════════════════════════════════════════════════
// WEB SEARCH — Google Search Grounding via Gemini
// ═══════════════════════════════════════════════════════════════

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'web_search',
            description: 'Search the internet for current information. Use this when the user asks about recent events, news, real-time data, or anything that requires up-to-date web information. Returns a grounded answer with sources.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'The search query (e.g. "latest news about AI", "who won the Champions League 2025", "SpaceX launch schedule")'
                    }
                },
                required: ['query'],
            },
        },
    },
    execute: async (args) => {
        if (!ai) return 'Error: Gemini API not configured. Set GEMINI_API_KEY.';

        try {
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [{ role: 'user', parts: [{ text: args.query }] }],
                config: {
                    tools: [{ googleSearch: {} }],
                },
            });

            let result = response.text || 'No results found.';

            // Append grounding sources if available
            const groundingMeta = (response as any).candidates?.[0]?.groundingMetadata;
            if (groundingMeta?.groundingChunks?.length > 0) {
                const sources = groundingMeta.groundingChunks
                    .filter((c: any) => c.web?.uri)
                    .slice(0, 5)
                    .map((c: any, i: number) => `${i + 1}. ${c.web.title || 'Source'}: ${c.web.uri}`)
                    .join('\n');
                if (sources) {
                    result += `\n\n📎 Fuentes:\n${sources}`;
                }
            }

            return result;
        } catch (error: any) {
            return `Error searching the web: ${error.message}`;
        }
    },
});

console.log('🌐 Web Search tool registered (Google Search Grounding)');
