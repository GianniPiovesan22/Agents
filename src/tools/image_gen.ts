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

        const models = [
            'gemini-2.0-flash-exp',
            'gemini-2.0-flash-preview-image-generation',
            'gemini-2.5-flash-preview-image-generation',
        ];

        for (const model of models) {
            try {
                console.log(`🖼️ Trying image generation with model: ${model}`);
                const response = await ai.models.generateContent({
                    model,
                    contents: [{ role: 'user', parts: [{ text: args.prompt }] }],
                    config: {
                        responseModalities: ['TEXT', 'IMAGE'],
                    },
                });

                const parts = response.candidates?.[0]?.content?.parts ?? [];
                console.log(`🖼️ Response parts: ${JSON.stringify(parts.map((p: any) => Object.keys(p)))}`);
                const imagePart = parts.find((p: any) => p.inlineData?.mimeType?.startsWith('image/'));

                if (!imagePart?.inlineData?.data) {
                    console.log(`🖼️ No image part found for model ${model}, trying next...`);
                    continue;
                }

                const mimeType = imagePart.inlineData.mimeType;
                const ext = mimeType.includes('png') ? 'png' : 'jpg';
                const tempPath = path.join(os.tmpdir(), `img_${Date.now()}.${ext}`);
                const buffer = Buffer.from(imagePart.inlineData.data, 'base64');
                fs.writeFileSync(tempPath, buffer);
                console.log(`🖼️ Image saved to ${tempPath}`);
                return `[IMG:${tempPath}]`;
            } catch (error: any) {
                console.error(`🖼️ Model ${model} failed: ${error.message}`);
            }
        }

        return 'Error generando imagen: ningún modelo disponible pudo generar la imagen. Verificá que tu Gemini API key tenga acceso a generación de imágenes.';
    },
});

console.log('🖼️ Image Generation tool registered (Nano Banana 2)');
