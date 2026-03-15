import dotenv from 'dotenv';
import { z } from 'zod';
import path from 'path';

dotenv.config();

const configSchema = z.object({
    TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
    TELEGRAM_ALLOWED_USER_IDS: z.string().transform((val) => val.split(',').map(id => id.trim())),
    GROQ_API_KEY: z.string().min(1, "GROQ_API_KEY is required"),
    ANTHROPIC_API_KEY: z.string().optional(),
    TAVILY_API_KEY: z.string().optional(),
    GEMINI_API_KEY: z.string().optional(),
    OPENROUTER_API_KEY: z.string().optional(),
    OPENROUTER_MODEL: z.string().default("openrouter/free"),
    DB_PATH: z.string().default("./memory.db"),
    FIREBASE_PROJECT_ID: z.string().optional(),
    GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
    ELEVENLABS_API_KEY: z.string().optional(),
    ELEVENLABS_VOICE_ID: z.string().default("p7AwDmKvTdoHTBuueGvP"),
    GOG_ACCOUNT: z.string().optional(),
    // WhatsApp Cloud API
    WHATSAPP_ACCESS_TOKEN: z.string().optional(),
    WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
    WHATSAPP_VERIFY_TOKEN: z.string().default("opengravity_webhook_2026"),
    WHATSAPP_BUSINESS_ID: z.string().optional(),
    WEBHOOK_PORT: z.string().default("3000").transform(Number),
    // Security & Scalability
    LLM_TIMEOUT_MS: z.string().default('30000').transform(Number),
    TERMINAL_SANDBOX_DIR: z.string().default(path.join(process.cwd(), 'workspace')),
    WHATSAPP_APP_SECRET: z.string().optional(),
    WHATSAPP_ALLOWED_NUMBERS: z.string().optional().transform(val => val ? val.split(',').map(s => s.trim()) : []),
    MEMORY_MAX_EMBEDDINGS: z.string().default('500').transform(Number),
});

const parsedConfig = configSchema.safeParse(process.env);

if (!parsedConfig.success) {
    console.error("❌ Invalid configuration:", parsedConfig.error.format());
    process.exit(1);
}

export const config = parsedConfig.data;
