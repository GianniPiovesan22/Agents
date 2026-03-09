import { registerTool } from './index.js';
import axios from 'axios';

// ═══════════════════════════════════════════════════════════════
// WEATHER — wttr.in (free, no API key)
// ═══════════════════════════════════════════════════════════════

registerTool({
    definition: {
        type: 'function',
        function: {
            name: 'get_weather',
            description: 'Get current weather and forecast for a city. Returns temperature, conditions, humidity, wind, and 3-day forecast.',
            parameters: {
                type: 'object',
                properties: {
                    city: {
                        type: 'string',
                        description: 'City name (e.g. "Buenos Aires", "London", "New York")'
                    }
                },
                required: ['city'],
            },
        },
    },
    execute: async (args) => {
        try {
            // Get detailed weather in JSON format
            const response = await axios.get(`https://wttr.in/${encodeURIComponent(args.city)}?format=j1`, {
                headers: { 'User-Agent': 'OpenGravity/1.0' },
                timeout: 10000,
            });

            const data = response.data;
            const current = data.current_condition?.[0];
            const location = data.nearest_area?.[0];

            if (!current) return `No se encontró información del clima para "${args.city}".`;

            const locationName = location?.areaName?.[0]?.value || args.city;
            const country = location?.country?.[0]?.value || '';

            let result = `🌍 **${locationName}, ${country}**\n`;
            result += `🌡️ Temperatura: ${current.temp_C}°C (Sensación: ${current.FeelsLikeC}°C)\n`;
            result += `☁️ Condición: ${current.lang_es?.[0]?.value || current.weatherDesc?.[0]?.value || 'N/A'}\n`;
            result += `💧 Humedad: ${current.humidity}%\n`;
            result += `💨 Viento: ${current.windspeedKmph} km/h ${current.winddir16Point}\n`;
            result += `👁️ Visibilidad: ${current.visibility} km\n`;
            result += `☀️ UV: ${current.uvIndex}\n`;

            // 3-day forecast
            const forecast = data.weather;
            if (forecast?.length > 0) {
                result += `\n📅 Pronóstico:\n`;
                for (const day of forecast.slice(0, 3)) {
                    const desc = day.hourly?.[4]?.lang_es?.[0]?.value || day.hourly?.[4]?.weatherDesc?.[0]?.value || '';
                    result += `  ${day.date}: ${day.mintempC}°C - ${day.maxtempC}°C | ${desc}\n`;
                }
            }

            return result;
        } catch (error: any) {
            return `Error obteniendo el clima: ${error.message}`;
        }
    },
});

console.log('☁️ Weather tool registered (wttr.in)');
