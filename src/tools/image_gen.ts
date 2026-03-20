import { registerTool } from './index.js';
import { geminiClient } from '../llm/index.js';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ═══════════════════════════════════════════════════════════════
// IMAGE GENERATION — Imagen 4 (primary) / Pollinations.ai (fallback)
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
        // ── Primary: Imagen 4 ──────────────────────────────────
        if (geminiClient) {
            try {
                console.log(`🖼️ Generating image via Imagen 4...`);
                const response = await geminiClient.models.generateImages({
                    model: 'imagen-4.0-generate-001',
                    prompt: args.prompt,
                    config: { numberOfImages: 1 },
                });

                const imageData = response.generatedImages?.[0]?.image?.imageBytes;
                if (!imageData) throw new Error('No image returned');

                const buffer = Buffer.from(imageData, 'base64');
                const tempPath = path.join(os.tmpdir(), `img_${Date.now()}.jpg`);
                fs.writeFileSync(tempPath, buffer);
                console.log(`🖼️ Image saved to ${tempPath}`);
                return `[IMG:${tempPath}]`;
            } catch (imagenError: any) {
                console.error('⚠️ Imagen 4 failed, falling back to Pollinations:', imagenError.message);
            }
        }

        // ── Fallback: Pollinations.ai ──────────────────────────
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

console.log('🖼️ Image Generation tool registered (Imagen 4 / Pollinations.ai fallback)');
