/**
 * One-time script to obtain a Google OAuth2 refresh_token.
 *
 * Usage:
 *   npx tsx scripts/google-auth.ts
 *
 * Prerequisites:
 *   - client_secret.json must exist in the project root
 *   - Run this locally (not on Railway)
 *
 * What it does:
 *   1. Reads client_secret.json
 *   2. Prints an authorization URL — open it in your browser
 *   3. Paste the authorization code when prompted
 *   4. Prints the refresh_token to add to your env vars
 */

import { google } from 'googleapis';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET_PATH = path.resolve(__dirname, '..', 'client_secret.json');

const SCOPES = [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/contacts.readonly',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/documents.readonly',
];

function prompt(question: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

async function main() {
    if (!fs.existsSync(SECRET_PATH)) {
        console.error(`ERROR: client_secret.json not found at ${SECRET_PATH}`);
        process.exit(1);
    }

    const raw = fs.readFileSync(SECRET_PATH, 'utf-8');
    const secret = JSON.parse(raw);

    // Support both "installed" and "web" credential types
    const creds = secret.installed || secret.web;
    if (!creds) {
        console.error('ERROR: client_secret.json must have an "installed" or "web" key.');
        process.exit(1);
    }

    const { client_id, client_secret, redirect_uris } = creds;
    const redirectUri = redirect_uris[0]; // typically "urn:ietf:wg:oauth:2.0:oob" or "http://localhost"

    const auth = new google.auth.OAuth2(client_id, client_secret, redirectUri);

    const authUrl = auth.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent', // force consent to always get a refresh_token
        scope: SCOPES,
    });

    console.log('\n=== Google OAuth2 — Obtención de Refresh Token ===\n');
    console.log('1. Abrí esta URL en tu navegador:\n');
    console.log('   ' + authUrl);
    console.log('\n2. Autorizá la aplicación con tu cuenta de Google.');
    console.log('3. Copiá el código de autorización que aparece.\n');

    const code = await prompt('Pegá el código de autorización aquí: ');

    if (!code) {
        console.error('ERROR: No se ingresó ningún código.');
        process.exit(1);
    }

    try {
        const { tokens } = await auth.getToken(code);

        console.log('\n=== ¡Listo! Tokens obtenidos ===\n');

        if (tokens.refresh_token) {
            console.log('GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token);
            console.log('\nAgregá esta variable a tu .env local y a las variables de Railway:');
            console.log('  GOOGLE_CLIENT_ID=' + client_id);
            console.log('  GOOGLE_CLIENT_SECRET=' + client_secret);
            console.log('  GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token);
        } else {
            console.warn('\nWARNING: No se recibió refresh_token.');
            console.warn('Esto puede pasar si ya autorizaste antes sin revocar el acceso.');
            console.warn('Para forzar uno nuevo:');
            console.warn('  1. Andá a https://myaccount.google.com/permissions');
            console.warn('  2. Revocá el acceso a esta app');
            console.warn('  3. Corré este script de nuevo');
        }

        console.log('\nTokens completos (por si los necesitás):');
        console.log(JSON.stringify(tokens, null, 2));
    } catch (err: any) {
        console.error('\nERROR al intercambiar el código:', err.message);
        process.exit(1);
    }
}

main();
