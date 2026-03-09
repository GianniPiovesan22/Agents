import { registerTool } from './index.js';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

/**
 * Security: Validate URLs to prevent SSRF attacks.
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
            name: 'analyze_github_repo',
            description: 'Reads the structure and files of a public GitHub repository. Use this to analyze a project\'s code, architecture, or to answer questions about it.',
            parameters: {
                type: 'object',
                properties: {
                    repo_url: {
                        type: 'string',
                        description: 'The URL of the public GitHub repository (e.g. https://github.com/facebook/react)'
                    },
                    subpath: {
                        type: 'string',
                        description: 'Optional. A specific sub-path or file in the repo to analyze (e.g. "src/components")'
                    }
                },
                required: ['repo_url'],
            },
        },
    },
    execute: async (args) => {
        try {
            if (!isAllowedUrl(args.repo_url)) {
                return 'Error: URL no permitida. Solo se aceptan URLs públicas de GitHub.';
            }

            console.log(`🔍 Analyzing GitHub Repo: ${args.repo_url}`);

            // Clean URL to extract owner/repo
            const cleanUrl = args.repo_url.replace(/\/$/, '');
            const match = cleanUrl.match(/github\.com\/([^/]+)\/([^/]+)/);

            if (!match) {
                return "La URL proporcionada no parece ser un repositorio válido de GitHub.";
            }

            const [_, owner, repo] = match;
            const subpathVal = args.subpath ? `/${args.subpath}` : '';

            // We use the Jina Reader API to get a clean Markdown version of the repo's content
            const jinaUrl = `https://r.jina.ai/https://github.com/${owner}/${repo}/tree/main${subpathVal}`;

            const response = await axios.get(jinaUrl, {
                headers: {
                    'Accept': 'text/event-stream, application/json, text/plain, */*',
                },
                timeout: 30000
            });

            let content = response.data;
            if (typeof content !== 'string') {
                content = JSON.stringify(content);
            }

            // Truncate to avoid blowing up the context window if the repo is massive
            if (content.length > 50000) {
                content = content.substring(0, 50000) + "\n\n... [Contenido truncado por longitud excesiva] ...";
            }

            return `Estructura y contenido del repositorio ${owner}/${repo}${subpathVal}:\n\n${content}`;

        } catch (error: any) {
            console.error("Github error", error.message);
            return `Error leyendo repositorio de GitHub. Si el repositorio es muy grande, intenta especificar un 'subpath'. Detalles: ${error.message}`;
        }
    },
});

console.log('🔌 GitHub Analysis tool registered');
