import { registerTool } from './index.js';
import axios from 'axios';

// ═══════════════════════════════════════════════════════════════
// MARKET QUOTES — Dólar Argentina + Crypto
// ═══════════════════════════════════════════════════════════════

// In-memory cache: key → { data, expiresAt }
const cache = new Map<string, { data: any; expiresAt: number }>();

const DOLLAR_TTL_MS = 5 * 60 * 1000;   // 5 minutes for dollar rates
const MARKET_TTL_MS = 10 * 60 * 1000;  // 10 minutes for crypto and grains

function getCached(key: string): any | null {
    const entry = cache.get(key);
    if (entry && Date.now() < entry.expiresAt) return entry.data;
    return null;
}

function setCached(key: string, data: any, ttlMs: number): void {
    cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// ── Argentine Dollar Quotes ────────────────────────────────────
registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'get_dollar_rates',
            description: 'Get current Argentine dollar exchange rates (blue, oficial, MEP, CCL, crypto, tarjeta). Use when the user asks about dollar prices in Argentina.',
            parameters: {
                type: 'object',
                properties: {},
                required: [],
            },
        },
    },
    execute: async () => {
        try {
            const cached = getCached('dollar_rates');
            if (cached) return cached;

            const response = await axios.get('https://dolarapi.com/v1/dolares', { timeout: 10000 });
            const rates = response.data;

            if (!rates || rates.length === 0) {
                return 'No se pudo obtener la cotización del dólar.';
            }

            let result = '💵 **Cotización Dólar Argentina**\n\n';
            for (const rate of rates) {
                const name = rate.nombre || rate.casa || 'N/A';
                const buy = rate.compra ? `$${rate.compra}` : '-';
                const sell = rate.venta ? `$${rate.venta}` : '-';
                result += `• **${name}**: Compra: ${buy} | Venta: ${sell}\n`;
            }

            result += `\n🕐 Actualizado: ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`;
            setCached('dollar_rates', result, DOLLAR_TTL_MS);
            return result;
        } catch (error: any) {
            return `Error obteniendo cotización del dólar: ${error.message}`;
        }
    },
});

// ── Crypto Prices ──────────────────────────────────────────────
registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'get_crypto_prices',
            description: 'Get current cryptocurrency prices in USD and ARS. Supports Bitcoin (BTC), Ethereum (ETH), Solana (SOL), and more.',
            parameters: {
                type: 'object',
                properties: {
                    coins: {
                        type: 'string',
                        description: 'Comma-separated list of coin IDs (e.g. "bitcoin,ethereum,solana"). Default: bitcoin,ethereum,solana'
                    }
                },
                required: [],
            },
        },
    },
    execute: async (args) => {
        try {
            const coins = args.coins || 'bitcoin,ethereum,solana';
            const cacheKey = `crypto_prices:${coins}`;
            const cached = getCached(cacheKey);
            if (cached) return cached;

            const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
                params: {
                    ids: coins,
                    vs_currencies: 'usd,ars',
                    include_24hr_change: true,
                },
                timeout: 10000,
            });

            const data = response.data;
            if (!data || Object.keys(data).length === 0) {
                return 'No se pudieron obtener los precios de criptomonedas.';
            }

            let result = '₿ **Cotización Crypto**\n\n';
            const coinNames: Record<string, string> = {
                bitcoin: 'Bitcoin (BTC)',
                ethereum: 'Ethereum (ETH)',
                solana: 'Solana (SOL)',
                cardano: 'Cardano (ADA)',
                dogecoin: 'Dogecoin (DOGE)',
                ripple: 'XRP',
                polkadot: 'Polkadot (DOT)',
            };

            for (const [id, prices] of Object.entries(data) as any) {
                const name = coinNames[id] || id;
                const usd = prices.usd ? `US$${prices.usd.toLocaleString()}` : '-';
                const ars = prices.ars ? `AR$${prices.ars.toLocaleString()}` : '-';
                const change = prices.usd_24h_change ? `${prices.usd_24h_change > 0 ? '📈' : '📉'} ${prices.usd_24h_change.toFixed(2)}%` : '';
                result += `• **${name}**: ${usd} | ${ars} ${change}\n`;
            }

            result += `\n🕐 Actualizado: ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`;
            setCached(cacheKey, result, MARKET_TTL_MS);
            return result;
        } catch (error: any) {
            return `Error obteniendo precios crypto: ${error.message}`;
        }
    },
});

// ── Argentine Grain Prices ─────────────────────────────────────
registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'get_grain_prices',
            description: 'Get current Argentine grain prices (soja, maíz, trigo, girasol) from BCR Rosario pizarra. Use when the user asks about grain prices, commodities, or agro markets in Argentina.',
            parameters: {
                type: 'object',
                properties: {
                    crops: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional list of crops to show (e.g. ["soja", "maiz"]). Default: all (soja, maiz, trigo, girasol).',
                    },
                },
                required: [],
            },
        },
    },
    execute: async (args) => {
        const requestedCrops: string[] = args.crops && args.crops.length > 0
            ? args.crops.map((c: string) => c.toLowerCase())
            : ['soja', 'maiz', 'trigo', 'girasol'];

        const cropAliases: Record<string, string[]> = {
            soja: ['soja', 'soybean', 'soy'],
            maiz: ['maíz', 'maiz', 'corn'],
            trigo: ['trigo', 'wheat'],
            girasol: ['girasol', 'sunflower'],
        };

        const cropEmojis: Record<string, string> = {
            soja: '🟡',
            maiz: '🟡',
            trigo: '🟡',
            girasol: '🌻',
        };

        const sources = [
            'https://r.jina.ai/https://www.bcr.com.ar/es/mercados/granos/pizarra-de-precios',
            'https://r.jina.ai/https://news.agrofy.com.ar/mercados/precios-granos',
        ];

        let markdown = '';
        let sourceName = 'BCR Rosario';

        const grainCacheEntry = getCached('grain_raw');
        if (grainCacheEntry) {
            markdown = grainCacheEntry.markdown;
            sourceName = grainCacheEntry.sourceName;
        } else {
            for (let i = 0; i < sources.length; i++) {
                try {
                    const res = await axios.get(sources[i], {
                        headers: { 'Accept': 'text/plain' },
                        timeout: 20000,
                    });
                    markdown = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
                    sourceName = i === 0 ? 'BCR Rosario' : 'Agrofy';
                    if (markdown.length > 5) break;
                } catch (_) {
                    // try next source
                }
            }
            if (markdown.length > 5) {
                setCached('grain_raw', { markdown, sourceName }, MARKET_TTL_MS);
            }
        }

        if (!markdown || markdown.length < 5) {
            return 'No se pudieron obtener los precios de granos en este momento. Intentá más tarde.';
        }

        // Parse prices — look for patterns like USD 250/tn, $120000/tn, 250 USD, etc.
        const prices: Record<string, string> = {};

        const lines = markdown.split('\n');
        for (const line of lines) {
            const lower = line.toLowerCase();
            for (const [cropKey, aliases] of Object.entries(cropAliases)) {
                if (prices[cropKey]) continue; // already found
                if (!aliases.some(a => lower.includes(a))) continue;

                // Try to extract price — various formats
                const pricePatterns = [
                    /USD\s*([\d.,]+)/i,
                    /US\$\s*([\d.,]+)/i,
                    /\$\s*([\d.,]+)\s*\/?\s*tn/i,
                    /([\d.,]+)\s*USD/i,
                    /([\d.,]+)\s*usd/i,
                    /\|\s*([\d.,]+)\s*\|/,
                    /([\d.]{3,})/,
                ];

                for (const pattern of pricePatterns) {
                    const match = line.match(pattern);
                    if (match) {
                        const val = match[1].replace(/\./g, '').replace(',', '.');
                        const num = parseFloat(val);
                        // Sanity check: grain prices are typically between 100 and 500 USD/tn
                        if (!isNaN(num) && num > 50 && num < 100000) {
                            prices[cropKey] = num > 1000 ? `AR$${num.toLocaleString('es-AR')}` : `USD ${num.toLocaleString('es-AR')}`;
                            break;
                        }
                    }
                }
            }
        }

        const now = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
        const dateStr = new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

        let result = `🌾 Pizarra ${sourceName}\n📅 ${dateStr}\n\n`;

        let found = false;
        for (const cropKey of requestedCrops) {
            if (cropAliases[cropKey] || cropKey) {
                const normalizedKey = Object.keys(cropAliases).find(k =>
                    cropAliases[k].includes(cropKey) || k === cropKey
                ) || cropKey;

                const emoji = cropEmojis[normalizedKey] || '🌾';
                const displayName = normalizedKey.charAt(0).toUpperCase() + normalizedKey.slice(1);
                const price = prices[normalizedKey];

                if (price) {
                    result += `${emoji} ${displayName}: ${price}/tn\n`;
                    found = true;
                }
            }
        }

        if (!found) {
            result += 'No se pudieron parsear los precios de la fuente. El formato puede haber cambiado.\n';
        }

        result += `\n🕐 Actualizado: ${now}`;
        return result;
    },
});

console.log('💰 Markets tools registered (DolarAPI + CoinGecko + BCR Grains)');
