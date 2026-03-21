import { registerTool } from './index.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTEXT_PATH = join(__dirname, '../../BRESCOPACK_CONTEXT.md');

let cachedContext: string | null = null;

function loadContext(): string {
    if (!cachedContext) {
        try {
            cachedContext = readFileSync(CONTEXT_PATH, 'utf-8');
        } catch {
            cachedContext = 'Error: no se pudo cargar el contexto de BrescoPack.';
        }
    }
    return cachedContext;
}

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'get_brescopack_info',
            description: 'Returns complete information about BrescoPack: products, technical specs, target market, pricing notes, FAQs, and contact details. Use this tool when the user asks about products, prices, technical specs, how to write a sales proposal, or when you need to answer a client question about BrescoPack machinery.',
            parameters: {
                type: 'object',
                properties: {},
                required: [],
            },
        },
    },
    execute: async () => {
        return loadContext();
    },
});

console.log('BrescoPack tool registered (get_brescopack_info)');
