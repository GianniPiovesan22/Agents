import { registerTool } from './index.js';
import { config } from '../config/index.js';
import { tavily } from '@tavily/core';

const tavilyClient = config.TAVILY_API_KEY ? tavily({ apiKey: config.TAVILY_API_KEY }) : null;

// ═══════════════════════════════════════════════════════════════
// WEB SEARCH — Tavily AI Search
// ═══════════════════════════════════════════════════════════════

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'web_search',
            description: 'Search the internet for current information, market data, competitor analysis, news, prices, or any topic that requires up-to-date web information. Returns relevant results with sources.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'The search query (e.g. "mercado maquinaria agrícola Argentina 2025", "precio dólar blue hoy", "competidores BrescoPack")'
                    }
                },
                required: ['query'],
            },
        },
    },
    execute: async (args) => {
        if (!tavilyClient) return 'Error: Tavily API not configured. Set TAVILY_API_KEY.';

        try {
            const response = await tavilyClient.search(args.query, {
                searchDepth: 'basic',
                maxResults: 5,
            });

            if (!response.results || response.results.length === 0) {
                return 'No se encontraron resultados para esa búsqueda.';
            }

            const results = response.results
                .map((r: any, i: number) => `**${i + 1}. ${r.title}**\n${r.content}\n🔗 ${r.url}`)
                .join('\n\n');

            return results;
        } catch (error: any) {
            return `Error al buscar: ${error.message}`;
        }
    },
});

console.log('🌐 Web Search tool registered (Tavily)');
