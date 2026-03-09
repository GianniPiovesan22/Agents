import { registerTool } from './index.js';
import axios from 'axios';

/**
 * Security: Validate URLs to prevent SSRF attacks against internal services.
 */
function isAllowedUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) return false;
        const host = parsed.hostname.toLowerCase();
        if (host === 'localhost' || host === '0.0.0.0' || host.startsWith('127.')
            || host.startsWith('10.') || host.startsWith('172.16.') || host.startsWith('172.17.')
            || host.startsWith('192.168.') || host.startsWith('169.254.')
            || host.endsWith('.internal') || host.endsWith('.local')) return false;
        return true;
    } catch { return false; }
}

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'scrape_website',
            description: 'Extracts clean Markdown content from any website URL for reading articles, docs, or web pages',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'The absolute URL to scrape (e.g., https://example.com)' }
                },
                required: ['url']
            }
        }
    },
    execute: async (args: { url: string }) => {
        if (!isAllowedUrl(args.url)) {
            return 'Error: URL no permitida. Solo se aceptan URLs públicas (http/https, sin IPs privadas ni localhost).';
        }
        try {
            const response = await axios.get(`https://r.jina.ai/${args.url}`, {
                headers: {
                    'Accept': 'text/event-stream, application/json, text/plain, */*'
                }
            });
            let text = response.data;
            if (typeof text !== 'string') text = JSON.stringify(text); // fallback just in case
            if (text.length > 25000) {
                text = text.substring(0, 25000) + "\n... [Texto truncado porque la web era muy larga]";
            }
            return text;
        } catch (error: any) {
            return `Failed to scrape website: ${error.message}`;
        }
    }
});
