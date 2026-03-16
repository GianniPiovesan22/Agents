import { registerTool } from './index.js';
import { setUserProfile, getUserProfile } from '../database/index.js';

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'remember_about_user',
            description: 'Saves a fact or preference about the user for future conversations. Use this when the user tells you something about themselves (name, preferences, habits, etc.) that should be remembered.',
            parameters: {
                type: 'object',
                properties: {
                    key: {
                        type: 'string',
                        description: 'A short identifier for this fact (e.g. "name", "preferred_language", "work_schedule", "favorite_topic")'
                    },
                    value: {
                        type: 'string',
                        description: 'The value or description to remember (e.g. "Gianni", "prefers concise answers", "works 9-6", "crypto")'
                    },
                    _userId: {
                        type: 'string',
                        description: 'Injected automatically by the agent loop — do not set manually'
                    }
                },
                required: ['key', 'value'],
            },
        },
    },
    execute: async (args) => {
        const userId = args._userId as string;
        if (!userId) return 'Error: no se pudo identificar al usuario.';
        const key = String(args.key).trim();
        const value = String(args.value).trim();
        if (!key || !value) return 'Error: clave o valor vacíos.';
        setUserProfile(userId, key, value);
        return `Recordé que ${key}: ${value}`;
    },
});

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'get_user_info',
            description: 'Retrieves all stored facts and preferences about the current user.',
            parameters: {
                type: 'object',
                properties: {
                    _userId: {
                        type: 'string',
                        description: 'Injected automatically by the agent loop — do not set manually'
                    }
                },
                required: [],
            },
        },
    },
    execute: async (args) => {
        const userId = args._userId as string;
        if (!userId) return 'Error: no se pudo identificar al usuario.';
        const profile = getUserProfile(userId);
        const entries = Object.entries(profile);
        if (entries.length === 0) return 'No hay información guardada sobre este usuario todavía.';
        const lines = entries.map(([k, v]) => `- ${k}: ${v}`);
        return `Información del usuario:\n${lines.join('\n')}`;
    },
});

console.log('User profile tools registered (remember_about_user, get_user_info)');
