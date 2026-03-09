import { registerTool } from './index.js';
import axios from 'axios';

// ═══════════════════════════════════════════════════════════════
// MARKET QUOTES — Dólar Argentina + Crypto
// ═══════════════════════════════════════════════════════════════

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
            return result;
        } catch (error: any) {
            return `Error obteniendo precios crypto: ${error.message}`;
        }
    },
});

console.log('💰 Markets tools registered (DolarAPI + CoinGecko)');
