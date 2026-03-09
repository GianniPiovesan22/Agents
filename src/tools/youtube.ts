import { registerTool } from './index.js';
import ytdl from '@distube/ytdl-core';
import fs from 'fs';
import path from 'path';
import { transcribeAudio } from '../llm/index.js';

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'get_youtube_transcript',
            description: 'Extracts the audio from a YouTube video link, transcribes it, and returns the full text transcript. Useful for summarizing videos.',
            parameters: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: 'The full YouTube video URL (e.g. https://www.youtube.com/watch?v=...)'
                    }
                },
                required: ['url'],
            },
        },
    },
    execute: async (args) => {
        try {
            if (!ytdl.validateURL(args.url)) {
                return "La URL proporcionada no parece ser un enlace válido de YouTube.";
            }

            console.log(`Downloading audio for YouTube video: ${args.url}`);

            const tmpPath = path.join(process.cwd(), 'tmp');
            if (!fs.existsSync(tmpPath)) fs.mkdirSync(tmpPath, { recursive: true });

            const audioFile = path.join(tmpPath, `yt_${Date.now()}.mp3`);

            await new Promise<void>((resolve, reject) => {
                const stream = ytdl(args.url, { filter: 'audioonly', quality: 'highestaudio' });
                const fileStream = fs.createWriteStream(audioFile);

                stream.pipe(fileStream);
                stream.on('end', () => resolve());
                stream.on('error', (err) => reject(err));
                fileStream.on('error', (err) => reject(err));
            });

            console.log("Transcribing YouTube audio...");
            const transcript = await transcribeAudio(audioFile);

            // Clean up
            if (fs.existsSync(audioFile)) {
                fs.unlinkSync(audioFile);
            }

            if (!transcript) {
                return "No se pudo extraer texto o el video no contiene habla inteligible.";
            }

            return `Transcripción del video:\n\n${transcript}`;

        } catch (error: any) {
            return `Error transcribiendo video de YouTube: ${error.message}`;
        }
    },
});

console.log('🔌 YouTube transcript tool registered');
