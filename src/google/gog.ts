import { execFile } from 'child_process';
import path from 'path';

const isWindows = process.platform === 'win32';
const GOG_BINARY = isWindows ? 'gog.exe' : 'gog';
const GOG_PATH = path.resolve(process.cwd(), 'gog-bin', GOG_BINARY);
const GOG_ACCOUNT = process.env.GOG_ACCOUNT || '';

/**
 * Executes a gog CLI command and returns the output as a string.
 * Handles timeouts and errors gracefully.
 */
export function runGog(args: string[], timeoutMs: number = 30000): Promise<string> {
    return new Promise((resolve, reject) => {
        const env = { ...process.env };
        if (GOG_ACCOUNT) {
            env.GOG_ACCOUNT = GOG_ACCOUNT;
        }

        const child = execFile(GOG_PATH, args, {
            env,
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024 * 5, // 5MB
        }, (error, stdout, stderr) => {
            if (error) {
                // Include stderr for better debugging
                const errorMsg = stderr?.trim() || error.message;
                console.error(`[gog] Error running: gog ${args.join(' ')}`, errorMsg);
                reject(new Error(`gog error: ${errorMsg}`));
                return;
            }
            resolve(stdout.trim());
        });
    });
}

/**
 * Checks if gog is properly authenticated.
 */
export async function checkGogAuth(): Promise<boolean> {
    try {
        const result = await runGog(['auth', 'list']);
        return result.length > 0 && !result.includes('no accounts');
    } catch {
        return false;
    }
}
