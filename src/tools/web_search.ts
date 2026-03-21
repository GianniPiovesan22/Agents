import { registerTool } from './index.js';
import { config } from '../config/index.js';
import axios from 'axios';

// ═══════════════════════════════════════════════════════════════
// WEB SEARCH — Tavily (primary)
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
        if (!config.TAVILY_API_KEY) return 'Error: Tavily API not configured. Set TAVILY_API_KEY.';

        try {
            console.log(`🌐 Searching web via Tavily: ${args.query}`);
            const response = await axios.post(
                'https://api.tavily.com/search',
                {
                    api_key: config.TAVILY_API_KEY,
                    query: args.query,
                    search_depth: 'basic',
                    max_results: 5,
                    include_answer: true,
                },
                { timeout: 15000 }
            );

            const data = response.data;
            let result = data.answer || 'No answer found.';

            if (data.results?.length > 0) {
                const sources = data.results
                    .slice(0, 5)
                    .map((r: any, i: number) => `${i + 1}. ${r.title || 'Source'}: ${r.url}`)
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

console.log('🌐 Web Search tool registered (Tavily)');
