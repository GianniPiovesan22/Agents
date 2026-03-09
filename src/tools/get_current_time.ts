import { registerTool } from './index.js';

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'get_current_time',
            description: 'Get the current local time.',
            parameters: {
                type: 'object',
                properties: {},
                required: [],
            },
        },
    },
    execute: async () => {
        return new Date().toLocaleString();
    },
});
