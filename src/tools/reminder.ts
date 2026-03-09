import { registerTool } from './index.js';
import { createReminder } from '../database/index.js';

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'create_reminder',
            description: 'Creates a reminder that will be sent to the user via a message at the specified time',
            parameters: {
                type: 'object',
                properties: {
                    _userId: { type: 'string', description: 'Internal user ID, automatically populated, do not pass' },
                    message: { type: 'string', description: 'The reminder message to send' },
                    time: { type: 'string', description: 'ISO 8601 string representing the exact time to remind the user (e.g., 2026-03-07T15:00:00-03:00)' }
                },
                required: ['message', 'time', '_userId']
            }
        }
    },
    execute: async (args: { _userId?: string; message: string; time: string }) => {
        if (!args._userId) return "Error: user_id no proporcionado internamente.";
        try {
            const remindAt = new Date(args.time);
            if (isNaN(remindAt.getTime())) {
                return "Error: Formato de fecha inválido. Utilice formato ISO 8601.";
            }

            await createReminder(args._userId, args.message, remindAt);
            return `Recordatorio guardado con éxito. Se te avisará a las: ${remindAt.toLocaleString()}`;
        } catch (error: any) {
            return `Error creando recordatorio: ${error.message}`;
        }
    }
});
