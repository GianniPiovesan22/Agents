import { registerTool } from './index.js';
import { execFile } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import { config } from '../config/index.js';

const execFilePromise = util.promisify(execFile);

// Security: Only allow safe, read-only commands
const ALLOWED_COMMANDS = [
    'dir', 'ls', 'ipconfig', 'ifconfig', 'netstat', 'tasklist', 'ps',
    'whoami', 'ping', 'systeminfo', 'hostname', 'date', 'time',
    'echo', 'type', 'cat', 'head', 'tail', 'wc', 'df', 'free',
    'uname', 'uptime', 'nslookup', 'tracert', 'traceroute',
];

// Block dangerous shell operators that could chain commands (kept as defense-in-depth)
const DANGEROUS_PATTERNS = /[;&|`$(){}[\]<>!\\]|[\n\r]|(\bsudo\b)|(\brm\b)|(\bdel\b)|(\bformat\b)|(\bshutdown\b)|(\breboot\b)|(\bkill\b)|(\btaskkill\b)|(\bpowershell\b)|(\bcmd\b)|(\bwget\b)|(\bcurl\b)|(\bnew-object\b)|(\binvoke-\b)|(\bstart-process\b)/i;

// Commands that accept file path arguments and must be sandboxed
const FILE_READ_COMMANDS = ['cat', 'type', 'head', 'tail'];

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

            // Security: Sandbox path validation for file-read commands
            if (FILE_READ_COMMANDS.includes(baseCmd)) {
                const sandboxDir = path.resolve(config.TERMINAL_SANDBOX_DIR);

                // Ensure sandbox directory exists at runtime
                if (!fs.existsSync(sandboxDir)) {
                    fs.mkdirSync(sandboxDir, { recursive: true });
                }

                // Extract file argument: first non-flag token after the command
                const parts = args.command.trim().split(/\s+/);
                const filePart = parts.slice(1).find((p: string) => !p.startsWith('-'));

                if (filePart) {
                    const resolvedPath = path.resolve(sandboxDir, filePart);
                    if (!resolvedPath.startsWith(sandboxDir + path.sep) && resolvedPath !== sandboxDir) {
                        return `🚫 Acceso denegado: el path '${filePart}' está fuera del sandbox permitido (${sandboxDir}). Solo podés leer archivos dentro de ${sandboxDir}.`;
                    }
                }
            }

            console.log(`⚠️ EXECUTING TERMINAL COMMAND: ${args.command}`);

            // Execute with execFile (no shell) to prevent injection via shell interpretation
            const parts = args.command.trim().split(/\s+/);
            const cmd = parts[0];
            const cmdArgs = parts.slice(1);
            const sandboxDir = path.resolve(config.TERMINAL_SANDBOX_DIR);
            if (!fs.existsSync(sandboxDir)) fs.mkdirSync(sandboxDir, { recursive: true });

            const { stdout, stderr } = await execFilePromise(cmd, cmdArgs, { timeout: 15000, cwd: sandboxDir });

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
