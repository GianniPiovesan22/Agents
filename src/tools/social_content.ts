import { registerTool } from './index.js';
import fs from 'fs';
import path from 'path';

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'get_social_content_guide',
            description: 'Get the Social Content strategy guide and templates. Use this when the user asks for help creating or optimizing social media content for LinkedIn, Twitter, Instagram, TikTok, or Facebook.',
            parameters: {
                type: 'object',
                properties: {},
                required: [],
            },
        },
    },
    execute: async () => {
        try {
            const content = fs.readFileSync(path.resolve(process.cwd(), 'SOCIAL-CONTENT.md'), 'utf-8');
            return content;
        } catch (error: any) {
            return `Error reading Social Content guide: ${error.message}`;
        }
    },
});

console.log('📱 Social Content tool registered');
