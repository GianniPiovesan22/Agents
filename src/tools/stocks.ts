import { registerTool } from './index.js';
import axios from 'axios';

// ═══════════════════════════════════════════════════════════════
// STOCK PRICES — Yahoo Finance
// ═══════════════════════════════════════════════════════════════

const FRIENDLY_NAMES: Record<string, string> = {
    '^GSPC': 'S&P 500',
    '^IXIC': 'Nasdaq',
    '^DJI': 'Dow Jones',
    '^MERV': 'Merval',
    '^RUT': 'Russell 2000',
    'GC=F': 'Oro',
    'CL=F': 'Petróleo (WTI)',
    'EURUSD=X': 'EUR/USD',
};

interface YahooQuote {
    regularMarketPrice?: number;
    regularMarketChange?: number;
    regularMarketChangePercent?: number;
    shortName?: string;
    longName?: string;
    currency?: string;
}

// In-memory cache: symbol → { data, expiresAt }
const stockCache = new Map<string, { data: { symbol: string; quote: YahooQuote | null; error?: string }; expiresAt: number }>();
const STOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function fetchSymbol(symbol: string): Promise<{ symbol: string; quote: YahooQuote | null; error?: string }> {
    const cached = stockCache.get(symbol);
    if (cached && Date.now() < cached.expiresAt) return cached.data;

    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
        const response = await axios.get(url, {
            params: { interval: '1d', range: '1d' },
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0',
            },
        });

        const meta = response.data?.chart?.result?.[0]?.meta;
        if (!meta) {
            return { symbol, quote: null, error: 'Sin datos' };
        }

        const result = {
            symbol,
            quote: {
                regularMarketPrice: meta.regularMarketPrice,
                regularMarketChange: meta.regularMarketChange,
                regularMarketChangePercent: meta.regularMarketChangePercent,
                shortName: meta.shortName,
                longName: meta.longName,
                currency: meta.currency,
            },
        };
        stockCache.set(symbol, { data: result, expiresAt: Date.now() + STOCK_TTL_MS });
        return result;
    } catch (error: any) {
        return { symbol, quote: null, error: error.message };
    }
}

function formatQuote(symbol: string, quote: YahooQuote): string {
    const name = FRIENDLY_NAMES[symbol] || quote.shortName || quote.longName || symbol;
    const price = quote.regularMarketPrice;
    const change = quote.regularMarketChange;
    const changePct = quote.regularMarketChangePercent;
    const currency = quote.currency || '';

    const priceStr = price != null
        ? `${currency} ${price.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : '-';

    if (change == null || changePct == null) {
        return `• ${name} (${symbol}): ${priceStr}`;
    }

    const arrow = change >= 0 ? '📈' : '📉';
    const sign = change >= 0 ? '+' : '';
    const changeStr = `${sign}${change.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const pctStr = `${sign}${changePct.toFixed(2)}%`;

    return `${arrow} ${name} (${symbol}): ${priceStr}  ${changeStr} (${pctStr})`;
}

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'get_stock_price',
            description: 'Get real-time stock prices, market indices (S&P 500, Nasdaq, Merval), ETFs, forex pairs, and commodities using Yahoo Finance. Use when the user asks about stock prices, market indices, or financial instruments.',
            parameters: {
                type: 'object',
                properties: {
                    symbols: {
                        type: 'string',
                        description: 'Comma-separated list of ticker symbols. Examples: "AAPL,MSFT", "^GSPC,^IXIC,^MERV", "GGAL.BA,YPF", "GC=F,CL=F"',
                    },
                },
                required: ['symbols'],
            },
        },
    },
    execute: async (args) => {
        const raw: string = args.symbols || '';
        const symbols = raw.split(',').map((s: string) => s.trim()).filter(Boolean);

        if (symbols.length === 0) {
            return 'Indicá al menos un símbolo. Ejemplos: AAPL, ^GSPC, ^MERV, GC=F';
        }

        const results = await Promise.allSettled(symbols.map(fetchSymbol));

        const lines: string[] = [];

        for (const result of results) {
            if (result.status === 'rejected') {
                lines.push(`❌ Error inesperado: ${result.reason}`);
                continue;
            }

            const { symbol, quote, error } = result.value;

            if (error || !quote) {
                lines.push(`❌ ${symbol}: ${error || 'Sin datos disponibles'}`);
                continue;
            }

            lines.push(formatQuote(symbol, quote));
        }

        const timestamp = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
        lines.push('');
        lines.push(`🕐 ${timestamp}`);
        lines.push('Fuente: Yahoo Finance | Datos pueden tener delay de 15min');

        return lines.join('\n');
    },
});

console.log('📊 Stocks tool registered (Yahoo Finance)');
