import { google } from 'googleapis';
import { config } from '../config/index.js';

export function getGoogleAuth() {
    if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET || !config.GOOGLE_REFRESH_TOKEN) {
        throw new Error('Google auth not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN');
    }
    const auth = new google.auth.OAuth2(
        config.GOOGLE_CLIENT_ID,
        config.GOOGLE_CLIENT_SECRET
    );
    auth.setCredentials({ refresh_token: config.GOOGLE_REFRESH_TOKEN });
    return auth;
}
