import { registerTool } from './index.js';
import { config } from '../config/index.js';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import os from 'os';

const ai = config.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: config.GEMINI_API_KEY }) : null;

// ═══════════════════════════════════════════════════════════════
// IMAGE GENERATION — Gemini Imagen 3
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
        if (!ai) return 'Error: Gemini API not configured. Set GEMINI_API_KEY.';

        try {
            const response = await ai.models.generateImages({
                model: 'imagen-4.0-generate-001',
                prompt: args.prompt,
                config: {
                    numberOfImages: 1,
                },
            });

            if (!response.generatedImages || response.generatedImages.length === 0) {
                return 'No se pudo generar la imagen. Intentá con otra descripción.';
            }

            const imageData = response.generatedImages[0].image;
            if (!imageData || !imageData.imageBytes) {
                return 'Error: la imagen generada no contiene datos.';
            }

            // Save to temp file
            const tempPath = path.join(os.tmpdir(), `img_${Date.now()}.png`);
            const buffer = Buffer.from(imageData.imageBytes, 'base64');
            fs.writeFileSync(tempPath, buffer);

            // Return special format that the bot handler will detect
            return `[IMG:${tempPath}]`;
        } catch (error: any) {
            console.error('Image generation error:', error);
            return `Error generando imagen: ${error.message}`;
        }
    },
});

console.log('🖼️ Image Generation tool registered (Gemini Imagen 3)');
