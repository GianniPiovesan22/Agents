import { registerTool } from './index.js';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ═══════════════════════════════════════════════════════════════
// IMAGE GENERATION — Pollinations.ai (free, no API key)
// ═══════════════════════════════════════════════════════════════

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'generate_image',
            description: 'Generate an image from a text description using AI. Use this when the user asks to create, draw, design, or generate an image. Returns the path to the generated image file.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: {
                        type: 'string',
                        description: 'Detailed description of the image to generate (e.g. "a cat wearing a space suit floating in outer space, digital art style")'
                    }
                },
                required: ['prompt'],
            },
        },
    },
    execute: async (args) => {
        try {
            const encoded = encodeURIComponent(args.prompt);
            const url = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&nologo=true&enhance=true`;

            console.log(`🖼️ Generating image via Pollinations.ai...`);
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 60000,
            });

            const tempPath = path.join(os.tmpdir(), `img_${Date.now()}.jpg`);
            fs.writeFileSync(tempPath, Buffer.from(response.data));
            console.log(`🖼️ Image saved to ${tempPath}`);
            return `[IMG:${tempPath}]`;
        } catch (error: any) {
            console.error(`🖼️ Image generation failed: ${error.message}`);
            return `Error generando imagen: ${error.message}`;
        }
    },
});

console.log('🖼️ Image Generation tool registered (Pollinations.ai)');
