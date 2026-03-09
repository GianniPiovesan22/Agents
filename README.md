# 🌌 OpenGravity

Agente de IA personal, local y seguro con interfaz de Telegram.

## Características
- **Privacidad Total**: Funciona localmente (excepto por las llamadas al LLM).
- **Seguridad**: Solo responde a usuarios autorizados.
- **Memoria**: Recuerda conversaciones pasadas usando SQLite.
- **Herramientas**: Puede ejecutar acciones (como consultar la hora).

## Requisitos
- Node.js 20+
- Un token de bot de Telegram (@BotFather)
- Una API Key de Groq

## Instalación

1. Clona el repositorio.
2. Instala dependencias:
   ```bash
   npm install
   ```
3. Configura las variables de entorno:
   - Copia `.env.example` a `.env`.
   - Rellena los valores necesarios.
   - En `TELEGRAM_ALLOWED_USER_IDS`, pon tus IDs de Telegram separados por comas.

## Ejecución

Para desarrollo con recarga automática:
```bash
npm run dev
```

Para producción:
```bash
npm run build
npm start
```

## Estructura del Proyecto
- `src/agent`: Lógica del loop del agente.
- `src/bot`: Configuración y handlers de Telegram.
- `src/config`: Validación de variables de entorno.
- `src/database`: Persistencia con SQLite.
- `src/llm`: Integración con modelos de lenguaje.
- `src/tools`: Herramientas que el agente puede usar.
