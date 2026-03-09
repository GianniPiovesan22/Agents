import { GoogleGenAI } from '@google/genai';
import { config } from './src/config/index.js';

async function main() {
    const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });

    // Test generated image
    try {
        const response = await ai.models.generateImages({
            model: 'imagen-4.0-generate-001',
            prompt: 'a cat',
        });
        console.log('Image generation success!', response.generatedImages?.[0]?.image?.imageBytes ? 'bytes received' : 'no bytes');
    } catch (e: any) {
        console.error('Image generation failed:', e.message);
    }
}
main();
