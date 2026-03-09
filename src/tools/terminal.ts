import { registerTool } from './index.js';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

// Security: Only allow safe, read-only commands
const ALLOWED_COMMANDS = [
    'dir', 'ls', 'ipconfig', 'ifconfig', 'netstat', 'tasklist', 'ps',
    'whoami', 'ping', 'systeminfo', 'hostname', 'date', 'time',
    'echo', 'type', 'cat', 'head', 'tail', 'wc', 'df', 'free',
    'uname', 'uptime', 'nslookup', 'tracert', 'traceroute',
];

// Block dangerous shell operators that could chain commands
const DANGEROUS_PATTERNS = /[;&|`$(){}[\]<>!\\]|(\bsudo\b)|(\brm\b)|(\bdel\b)|(\bformat\b)|(\bshutdown\b)|(\breboot\b)|(\bkill\b)|(\btaskkill\b)|(\bpowershell\b)|(\bcmd\b)|(\bwget\b)|(\bcurl\b)|(\bnew-object\b)|(\binvoke-\b)|(\bstart-process\b)/i;

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'run_terminal_command',
            description: 'Executes a safe, read-only terminal command on the host machine. Only diagnostic commands are allowed (dir, ipconfig, netstat, tasklist, ping, systeminfo, etc.). Destructive or write commands are blocked.',
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: 'The diagnostic command to run (e.g., "dir", "ipconfig", "netstat -ano", "tasklist")',
                    }
                },
                required: ['command'],
            },
        },
    },
    execute: async (args) => {
        try {
            // Security: Validate command against allowlist
            const baseCmd = args.command.trim().split(/\s+/)[0].toLowerCase();
            if (!ALLOWED_COMMANDS.includes(baseCmd)) {
                return `🚫 Comando bloqueado por seguridad. Solo se permiten comandos de diagnóstico: ${ALLOWED_COMMANDS.join(', ')}`;
            }

            // Security: Block dangerous shell operators and patterns
            if (DANGEROUS_PATTERNS.test(args.command)) {
                return '🚫 Comando bloqueado: contiene operadores o patrones potencialmente peligrosos.';
            }

            console.log(`⚠️ EXECUTING TERMINAL COMMAND: ${args.command}`);

            // Execute command with a timeout so it doesn't hang the bot forever
            const { stdout, stderr } = await execPromise(args.command, { timeout: 15000 });

            let output = '';
            if (stdout) output += `STDOUT:\n${stdout.substring(0, 3000)}\n`;
            if (stderr) output += `STDERR:\n${stderr.substring(0, 1000)}\n`;

            if (!output) return "Comando ejecutado sin salida (éxito silencioso).";

            return `Resultados del comando '${args.command}':\n\n${output}`;

        } catch (error: any) {
            return `Error ejecutando comando en terminal:\n${error.message}`;
        }
    },
});

console.log('🔌 Terminal Execution tool registered (USE WITH CAUTION)');
