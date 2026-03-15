---
change: opengravity-security-scalability
phase: design
date: 2026-03-15
---

# Diseño Técnico: OpenGravity Security & Scalability Refactor

## Orden de implementación

| # | Item | Justificación |
|---|------|---------------|
| 1 | ITEM-01: Rotar `.env.example` | Prerequisito bloqueante. Las claves reales en el repo son el riesgo más inmediato. Sin esto, todo lo demás es ruido. |
| 2 | ITEM-10: Dockerfile credentials fix | Elimina la segunda vía de exposición de credenciales (imagen Docker). Va antes de tocar código funcional. |
| 3 | ITEM-08: Daily Digest finally | Cambio de una sola línea, riesgo cero, cierra un leak de recursos real. Se hace antes de los cambios complejos para construir momentum. |
| 4 | ITEM-09: Firebase Index docs | Sin código de producción. Desbloquea estabilidad del fallback Firebase. |
| 5 | ITEM-07: Bounded Memory | Cambio en `database/index.ts` solo. Bajo riesgo, alto impacto en estabilidad a largo plazo. Sin dependencias de otros items. |
| 6 | ITEM-02: LLM Timeouts | Modifica `llm/index.ts`. Depende de entender bien la interacción con `pRetry` (ver diseño abajo). Crítico para evitar colgadas. |
| 7 | ITEM-03: Terminal Sandbox | Modifica `tools/terminal.ts`. Requiere agregar la variable `TERMINAL_SANDBOX_DIR` al schema de config. |
| 8 | ITEM-04: WhatsApp HMAC | El más complejo por el cambio de middleware. Se hace después de los cambios más simples para reducir superficie de error al integrar. |
| 9 | ITEM-05: WhatsApp Rate Limiting | Depende de que ITEM-04 esté funcionando — mismo archivo, mismo contexto de Express. |
| 10 | ITEM-06: WhatsApp Whitelist | Último porque depende lógicamente de que el webhook ya esté validado (ITEM-04) y limitado (ITEM-05). |

---

## ITEM-01: Rotar `.env.example`

**Cambio necesario**: reemplazar todos los valores reales con placeholders descriptivos y verificar que `.env` esté en `.gitignore`.

**Acción fuera del código** (no automatizable): revocar externamente en los portales correspondientes:
- `GEMINI_API_KEY` → Google AI Studio
- `GROQ_API_KEY` → console.groq.com
- `OPENROUTER_API_KEY` → openrouter.ai
- `ELEVENLABS_API_KEY` → elevenlabs.io
- `TELEGRAM_BOT_TOKEN` → BotFather (`/revoke`)

**Archivo afectado**: `.env.example`

El archivo actual contiene tokens reales en producción (commit `12f64cf`). El resultado debe ser:

```
TELEGRAM_BOT_TOKEN="your-telegram-bot-token"
TELEGRAM_ALLOWED_USER_IDS="your-telegram-user-id"
GROQ_API_KEY="your-groq-api-key"
GEMINI_API_KEY="your-gemini-api-key"
OPENROUTER_API_KEY="your-openrouter-api-key"
...
```

---

## ITEM-02: LLM Timeouts

### Problema actual

Las tres funciones de completion (`geminiCompletion`, `groqCompletion`, `openRouterCompletion`) en `src/llm/index.ts` no pasan ningún signal de timeout al SDK. Si el endpoint tarda o no responde, el proceso cuelga indefinidamente. Peor: `pRetry` con `{ retries: 2 }` reintentaría un `AbortError`, duplicando el tiempo de espera.

### Decisión: AbortSignal.timeout() nativo, no Promise.race()

`AbortSignal.timeout(ms)` está disponible desde Node.js 17.3 / 19.1. El proyecto usa Node.js 22 (ver `FROM node:22-slim` en Dockerfile). Es la API idiomática: no requiere cleanup manual de timers ni wrapping con `Promise.race()`.

**Alternativa descartada**: `Promise.race([call, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])`. Funciona pero deja el timer colgado si la promise principal resuelve antes y no cancela la llamada HTTP subyacente.

### Las 3 firmas de provider con AbortSignal

**Gemini SDK** (`@google/genai` v1.44) — acepta `signal` dentro de `config`:

```typescript
// ANTES (src/llm/index.ts línea 211-215)
const response = await geminiClient.models.generateContent({
    model,
    contents,
    config: geminiConfig,
});

// DESPUÉS
const response = await geminiClient.models.generateContent({
    model,
    contents,
    config: {
        ...geminiConfig,
        abortSignal: AbortSignal.timeout(config.LLM_TIMEOUT_MS),
    },
});
```

> Nota: el campo es `abortSignal` (no `signal`) en `@google/genai`. Verificar en runtime si el SDK respeta el nombre — si no, usar el wrapper con `Promise.race()` solo para Gemini.

**Groq SDK** (`groq-sdk` v0.37) — interfaz compatible con OpenAI SDK, acepta `signal` como segundo argumento del método:

```typescript
// ANTES (src/llm/index.ts línea 240-245)
const response = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages: cleanMessages as any,
    tools: tools as any,
    tool_choice: 'auto',
});

// DESPUÉS
const response = await groq.chat.completions.create(
    {
        model: GROQ_MODEL,
        messages: cleanMessages as any,
        tools: tools as any,
        tool_choice: 'auto',
    },
    { signal: AbortSignal.timeout(config.LLM_TIMEOUT_MS) }
);
```

**OpenRouter** (via `openai` SDK v6.27) — mismo patrón que Groq, `signal` en el segundo argumento (RequestOptions):

```typescript
// ANTES (src/llm/index.ts línea 283-288)
const response = await openRouter.chat.completions.create({
    model: config.OPENROUTER_MODEL || 'openrouter/auto',
    messages: cleanMessages as any,
    tools: openaiTools,
});

// DESPUÉS
const response = await openRouter.chat.completions.create(
    {
        model: config.OPENROUTER_MODEL || 'openrouter/auto',
        messages: cleanMessages as any,
        tools: openaiTools,
    },
    { signal: AbortSignal.timeout(config.LLM_TIMEOUT_MS) }
);
```

### Integración con pRetry: AbortError no debe ser retriable

El problema crítico: cuando `AbortSignal.timeout()` dispara, lanza un `DOMException` con `name === 'TimeoutError'` (Node.js 22) o `name === 'AbortError'` (comportamiento variable según el SDK). `pRetry` no sabe distinguirlo de un error de red transitorio — lo reintentaría dos veces más, multiplicando el tiempo total de espera por 3.

```typescript
// ANTES (src/llm/index.ts línea 306-328)
export async function getCompletion(messages: Message[], tools?: Tool[]): Promise<CompletionResult> {
    return await pRetry(async () => {
        if (geminiClient) {
            try {
                return await geminiCompletion(messages, tools);
            } catch (error: any) {
                console.error('⚠️ Gemini error, falling back to Groq:', error?.message || error);
            }
        }
        try {
            return await groqCompletion(messages, tools);
        } catch (error: any) {
            console.error('⚠️ Groq API error, falling back to OpenRouter:', error?.message || error);
            try {
                return await openRouterCompletion(messages, tools);
            } catch (lastError) {
                console.error('❌ OpenRouter API error:', lastError);
                throw lastError;
            }
        }
    }, { retries: 2 });
}

// DESPUÉS — detectar AbortError/TimeoutError y wrappear con pRetry.AbortError
export async function getCompletion(messages: Message[], tools?: Tool[]): Promise<CompletionResult> {
    return await pRetry(async () => {
        if (geminiClient) {
            try {
                return await geminiCompletion(messages, tools);
            } catch (error: any) {
                if (error.name === 'AbortError' || error.name === 'TimeoutError') {
                    throw new pRetry.AbortError(`LLM timeout after ${config.LLM_TIMEOUT_MS}ms (Gemini)`);
                }
                console.error('⚠️ Gemini error, falling back to Groq:', error?.message || error);
            }
        }
        try {
            return await groqCompletion(messages, tools);
        } catch (error: any) {
            if (error.name === 'AbortError' || error.name === 'TimeoutError') {
                throw new pRetry.AbortError(`LLM timeout after ${config.LLM_TIMEOUT_MS}ms (Groq)`);
            }
            console.error('⚠️ Groq API error, falling back to OpenRouter:', error?.message || error);
            try {
                return await openRouterCompletion(messages, tools);
            } catch (lastError: any) {
                if (lastError.name === 'AbortError' || lastError.name === 'TimeoutError') {
                    throw new pRetry.AbortError(`LLM timeout after ${config.LLM_TIMEOUT_MS}ms (OpenRouter)`);
                }
                console.error('❌ OpenRouter API error:', lastError);
                throw lastError;
            }
        }
    }, { retries: 2 });
}
```

**Justificación de `pRetry.AbortError`**: esta clase especial de `p-retry` interrumpe el ciclo de reintentos inmediatamente y propaga el error al caller sin esperar a que se agoten los `retries`. Es exactamente la semántica que se necesita — un timeout no es un error transitorio retriable.

### Interfaces afectadas

- `src/llm/index.ts`: funciones `geminiCompletion`, `groqCompletion`, `openRouterCompletion`, `getCompletion`
- `src/config/index.ts`: agregar `LLM_TIMEOUT_MS`

---

## ITEM-03: Terminal Sandbox

### Problema actual

`src/tools/terminal.ts` tiene una allowlist de comandos (`cat`, `type`, `head`, `tail`) que pueden leer archivos del filesystem. El check actual solo valida el nombre del comando base, no el path del argumento. `cat /etc/passwd` pasa la validación y ejecuta sin restricción.

### Diseño de la validación de path

La lógica se inserta en la función `execute` del tool, después del check de `DANGEROUS_PATTERNS` y antes del `execPromise`. Se aplica solo a los comandos de lectura de archivos: `cat`, `type`, `head`, `tail`.

```typescript
// ANTES (src/tools/terminal.ts línea 36-52) — sin validación de path
execute: async (args) => {
    try {
        const baseCmd = args.command.trim().split(/\s+/)[0].toLowerCase();
        if (!ALLOWED_COMMANDS.includes(baseCmd)) {
            return `🚫 Comando bloqueado por seguridad...`;
        }
        if (DANGEROUS_PATTERNS.test(args.command)) {
            return '🚫 Comando bloqueado: contiene operadores o patrones potencialmente peligrosos.';
        }
        // ejecuta directo
        const { stdout, stderr } = await execPromise(args.command, { timeout: 15000 });

// DESPUÉS — agregar validación de sandbox para comandos de lectura de archivos
import path from 'path';
import fs from 'fs';

const FILE_READ_COMMANDS = ['cat', 'type', 'head', 'tail'];

execute: async (args) => {
    try {
        const baseCmd = args.command.trim().split(/\s+/)[0].toLowerCase();
        if (!ALLOWED_COMMANDS.includes(baseCmd)) {
            return `🚫 Comando bloqueado por seguridad...`;
        }
        if (DANGEROUS_PATTERNS.test(args.command)) {
            return '🚫 Comando bloqueado: contiene operadores o patrones potencialmente peligrosos.';
        }

        // Sandbox: validar path para comandos de lectura de archivos
        if (FILE_READ_COMMANDS.includes(baseCmd)) {
            const sandboxDir = path.resolve(config.TERMINAL_SANDBOX_DIR);

            // Asegurar que el directorio sandbox existe
            if (!fs.existsSync(sandboxDir)) {
                fs.mkdirSync(sandboxDir, { recursive: true });
            }

            // Extraer el argumento de path del comando (último token no-flag)
            const parts = args.command.trim().split(/\s+/);
            const filePart = parts.slice(1).find(p => !p.startsWith('-'));

            if (filePart) {
                const resolvedPath = path.resolve(sandboxDir, filePart);
                if (!resolvedPath.startsWith(sandboxDir + path.sep) && resolvedPath !== sandboxDir) {
                    return `🚫 Acceso denegado: el path '${filePart}' está fuera del sandbox permitido (${sandboxDir}). Solo podés leer archivos dentro de ${sandboxDir}.`;
                }
            }
        }

        const { stdout, stderr } = await execPromise(args.command, { timeout: 15000 });
```

### Casos cubiertos por path.resolve() + startsWith()

| Input del LLM | path.resolve() resultado | ¿Bloqueado? |
|---|---|---|
| `cat ../../../etc/passwd` | `/etc/passwd` | Sí — no empieza con sandboxDir |
| `cat /etc/passwd` | `/etc/passwd` | Sí — path absoluto fuera del sandbox |
| `cat workspace/data.csv` | `/app/workspace/data.csv` | No — dentro del sandbox |
| `cat %2e%2e%2fetc%2fpasswd` | Bloqueado por `DANGEROUS_PATTERNS` (`%`) | N/A |
| `cat ../../workspace/data.csv` | `/app/workspace/data.csv` | No — resuelve dentro del sandbox |

> Nota sobre URL-encoded traversal (`%2e%2e%2f`): el caracter `%` ya está cubierto por `DANGEROUS_PATTERNS` (`[;&|...]` — el regex actual no incluye `%` explícitamente, pero el OS tampoco interpreta URL encoding en shell). Sin embargo, es recomendable agregar `%` al regex de `DANGEROUS_PATTERNS` como defensa en profundidad.

### Por qué `path.resolve()` y no regex

Un regex para detectar traversal (`../`) es frágil: `....//`, `..%2f`, `.%2e/` y otros encoding pueden bypassarlo. `path.resolve()` delega al sistema operativo la normalización del path — es determinista y cubre todos los casos de traversal que el OS mismo reconoce.

### Interfaces afectadas

- `src/tools/terminal.ts`: función `execute` del tool `run_terminal_command`
- `src/config/index.ts`: agregar `TERMINAL_SANDBOX_DIR`

---

## ITEM-04: WhatsApp HMAC Validation

### Problema actual

El webhook en `src/whatsapp/index.ts` acepta cualquier POST a `/webhook` sin validar el origen. Cualquier actor puede enviar mensajes falsos al bot y hacer que ejecute `runAgent()`.

### Por qué raw body y no parsed JSON

Express con `express.json()` parsea el body y lo convierte en un objeto JS antes de que el handler lo vea. El HMAC de Meta se calcula sobre el **raw bytes del body original**. Si se calcula el HMAC sobre `JSON.stringify(req.body)`, hay dos problemas:

1. La serialización de JSON no está garantizada a ser idéntica al original (espacios, orden de keys).
2. Si el body tiene encoding especial o caracteres no-ASCII, `JSON.stringify` puede mutar el contenido.

La solución es usar `express.raw({ type: '*/*' })` **exclusivamente en la ruta `/webhook`**, antes del `express.json()` global. Esto da acceso al `Buffer` original en `req.body`, que se usa para el HMAC. Luego se parsea manualmente.

```typescript
// ANTES (src/whatsapp/index.ts línea 144-147) — middleware global antes del POST handler
export function createWhatsAppServer() {
    const app = express();
    app.use(express.json());  // ← parsea todo antes del HMAC check

// DESPUÉS — raw middleware específico para la ruta del webhook, ANTES del json global
export function createWhatsAppServer() {
    const app = express();

    // Middleware para HMAC: capturar raw body ANTES de parsear JSON
    // express.raw() debe registrarse ANTES de express.json() para la ruta /webhook
    app.use('/webhook', express.raw({ type: '*/*' }));
    app.use(express.json());
    // ↑ Para todas las demás rutas, express.json() opera normalmente

    const VERIFY_TOKEN = config.WHATSAPP_VERIFY_TOKEN;
    const APP_SECRET = config.WHATSAPP_APP_SECRET;

    // ── Webhook Messages (POST) ────────────────────────────────
    app.post('/webhook', async (req, res) => {
        // 1. Validar HMAC antes de cualquier otra cosa
        if (!APP_SECRET) {
            console.error('❌ WHATSAPP_APP_SECRET no configurado — rechazando todas las requests');
            return res.sendStatus(401);
        }

        const signature = req.headers['x-hub-signature-256'] as string;
        if (!signature) {
            return res.sendStatus(401);
        }

        const rawBody = req.body as Buffer;  // Buffer gracias a express.raw()
        const expectedSig = 'sha256=' + crypto
            .createHmac('sha256', APP_SECRET)
            .update(rawBody)
            .digest('hex');

        // timingSafeEqual previene timing attacks
        const sigBuffer = Buffer.from(signature);
        const expectedBuffer = Buffer.from(expectedSig);
        if (sigBuffer.length !== expectedBuffer.length ||
            !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
            console.warn('❌ WhatsApp HMAC validation failed');
            return res.sendStatus(401);
        }

        // 2. Parsear manualmente (req.body es Buffer, no objeto)
        let body: any;
        try {
            body = JSON.parse(rawBody.toString('utf-8'));
        } catch {
            return res.sendStatus(400);
        }

        // 3. Responder 200 antes de procesar (evitar retries de Meta)
        res.sendStatus(200);

        // 4. Procesar el mensaje...
        if (body.object !== 'whatsapp_business_account') return;
        // ... resto del handler igual que antes
    });
```

**Justificación de `crypto.timingSafeEqual()`**: una comparación simple con `===` es vulnerable a timing attacks — un atacante puede medir el tiempo de respuesta para inferir caracteres correctos del token. `timingSafeEqual` siempre compara todos los bytes independientemente del primer mismatch.

**Importante**: `crypto.timingSafeEqual()` requiere que ambos buffers tengan la **misma longitud**. Si el header enviado tiene longitud diferente, la función tira `RangeError`. Por eso se verifica `sigBuffer.length !== expectedBuffer.length` primero.

### Interfaces afectadas

- `src/whatsapp/index.ts`: función `createWhatsAppServer`, handler `POST /webhook`
- `src/config/index.ts`: agregar `WHATSAPP_APP_SECRET`
- `package.json`: no requiere dependencia nueva (`crypto` es built-in de Node.js)

---

## ITEM-05: WhatsApp Rate Limiting

Cambio simple. Agregar `express-rate-limit` aplicado solo al `POST /webhook`.

```typescript
import rateLimit from 'express-rate-limit';

const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,   // 1 minuto
    max: 100,              // 100 requests por IP por minuto
    standardHeaders: true, // incluye Retry-After en el header
    legacyHeaders: false,
    message: { error: 'Too many requests' },
});

app.post('/webhook', webhookLimiter, hmacMiddleware, async (req, res) => { ... });
```

In-memory store es suficiente: el rate limiting es por IP y la ventana es de 1 minuto. No tiene sentido persistir este estado entre reinicios.

### Interfaces afectadas

- `src/whatsapp/index.ts`
- `package.json`: agregar `express-rate-limit`

---

## ITEM-06: WhatsApp User Whitelist

Agregar check en `handleIncomingMessage` antes de llamar a `runAgent()`. El número de teléfono `from` (ej: `5491112345678`) se compara contra `WHATSAPP_ALLOWED_NUMBERS`.

Si `WHATSAPP_ALLOWED_NUMBERS` no está configurada → rechazar todos los mensajes con warning log. No hay "modo abierto" para WhatsApp.

```typescript
// Al inicio de handleIncomingMessage, antes de saveMessage
const allowedNumbers = config.WHATSAPP_ALLOWED_NUMBERS;
if (!allowedNumbers || allowedNumbers.length === 0) {
    console.warn(`⚠️ WHATSAPP_ALLOWED_NUMBERS no configurado — mensaje de ${from} ignorado`);
    return;
}
if (!allowedNumbers.includes(from)) {
    console.warn(`⚠️ Número no autorizado: ${from}`);
    return;
}
```

`WHATSAPP_ALLOWED_NUMBERS` se parsea en el config schema igual que `TELEGRAM_ALLOWED_USER_IDS`: `z.string().transform(val => val.split(',').map(s => s.trim()))`.

### Interfaces afectadas

- `src/whatsapp/index.ts`: función `handleIncomingMessage`
- `src/config/index.ts`: agregar `WHATSAPP_ALLOWED_NUMBERS`

---

## ITEM-07: Bounded Semantic Memory

### Problema actual

`src/database/index.ts` — `saveEmbedding` inserta sin límite. `getAllEmbeddings` retorna todo. Con uso activo, la tabla `memory_embeddings` crece indefinidamente, y el cosine similarity loop en `loop.ts` itera sobre potencialmente miles de vectores en memoria.

### Decisión de diseño: cleanup inline en saveEmbedding, no job separado

**Por qué inline**: el volumen de escrituras es bajo (máximo una por interacción del usuario). El overhead de una query DELETE extra por insert es despreciable. Un job separado (cron) agrega complejidad operacional: scheduling, estado, posibles race conditions. Para este caso de uso single-user, inline es la solución correcta.

**Por qué retener los más recientes (no TTL)**: un asistente personal acumula contexto valioso de eventos únicos ("firmamos el contrato con X", "el número de tracking es Y"). Con TTL, esos recuerdos se pierden aunque nunca hayan alcanzado el límite. Con límite por cantidad y política `ORDER BY timestamp DESC`, se retienen los más recientes — que para un asistente personal son los más relevantes.

### Schema SQL y lógica de cleanup

```typescript
// ANTES (src/database/index.ts línea 194-201) — sin límite
export async function saveEmbedding(userId: string, content: string, embedding: number[]) {
  try {
    const stmt = localDb.prepare('INSERT INTO memory_embeddings (user_id, content, embedding) VALUES (?, ?, ?)');
    stmt.run(userId, content, JSON.stringify(embedding));
  } catch (e) {
    console.error("Local DB Embedding Save Error:", e);
  }
}

// DESPUÉS — insert + cleanup atómico (SQLite es single-writer, no se necesita transacción explícita para esta operación)
export async function saveEmbedding(userId: string, content: string, embedding: number[]) {
  try {
    const insertStmt = localDb.prepare(
      'INSERT INTO memory_embeddings (user_id, content, embedding) VALUES (?, ?, ?)'
    );
    insertStmt.run(userId, content, JSON.stringify(embedding));

    // Cleanup: mantener solo los MEMORY_MAX_EMBEDDINGS más recientes por usuario
    const cleanupStmt = localDb.prepare(`
      DELETE FROM memory_embeddings
      WHERE user_id = ?
        AND id NOT IN (
          SELECT id FROM memory_embeddings
          WHERE user_id = ?
          ORDER BY timestamp DESC
          LIMIT ?
        )
    `);
    cleanupStmt.run(userId, userId, config.MEMORY_MAX_EMBEDDINGS);
  } catch (e) {
    console.error("Local DB Embedding Save Error:", e);
  }
}
```

```typescript
// ANTES (src/database/index.ts línea 203-214) — retorna todo sin límite
export async function getAllEmbeddings(userId: string): Promise<{ content: string, embedding: number[] }[]> {
  try {
    const stmt = localDb.prepare('SELECT content, embedding FROM memory_embeddings WHERE user_id = ?');

// DESPUÉS — LIMIT como defensa adicional (el cleanup ya debería mantener el invariante)
export async function getAllEmbeddings(userId: string): Promise<{ content: string, embedding: number[] }[]> {
  try {
    const stmt = localDb.prepare(
      'SELECT content, embedding FROM memory_embeddings WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?'
    );
    const rows = stmt.all(userId, config.MEMORY_MAX_EMBEDDINGS) as any[];
```

### Justificación del DELETE con subquery

La query `DELETE ... WHERE id NOT IN (SELECT id ... ORDER BY ... LIMIT ?)` es la forma estándar en SQLite para "keep only N most recent". SQLite soporta `LIMIT` en subqueries dentro de `IN`. Se verifica compatibilidad con `better-sqlite3 v12` — sí es compatible.

**Alternativa considerada**: `DELETE FROM memory_embeddings WHERE user_id = ? AND timestamp < (SELECT timestamp FROM memory_embeddings WHERE user_id = ? ORDER BY timestamp DESC LIMIT 1 OFFSET ?)`. Más compleja y tiene edge cases con timestamps iguales. La subquery con `id NOT IN` es más robusta.

### Interfaces afectadas

- `src/database/index.ts`: funciones `saveEmbedding`, `getAllEmbeddings`
- `src/config/index.ts`: agregar `MEMORY_MAX_EMBEDDINGS`

---

## ITEM-08: Daily Digest temp file cleanup

Cambio mínimo en `src/agent/daily_digest.ts`. Mover el `unlinkSync` a un bloque `finally` para garantizar cleanup incluso si `sendVoice` falla.

```typescript
// ANTES (src/agent/daily_digest.ts línea 52-64) — cleanup solo en el happy path
const audioPath = await textToSpeech(response.content);
const { InputFile } = await import('grammy');
for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
    try {
        await bot.api.sendVoice(userId, new InputFile(audioPath), {...});
    } catch (telegramErr) {
        console.error(`Error enviando digest al user ${userId}`, telegramErr);
    }
}
// clean temp file
if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);

// DESPUÉS — cleanup garantizado con finally
let audioPath: string | null = null;
try {
    audioPath = await textToSpeech(response.content);
    const { InputFile } = await import('grammy');
    for (const userId of config.TELEGRAM_ALLOWED_USER_IDS) {
        try {
            await bot.api.sendVoice(userId, new InputFile(audioPath), {...});
        } catch (telegramErr) {
            console.error(`Error enviando digest al user ${userId}`, telegramErr);
        }
    }
} finally {
    if (audioPath && fs.existsSync(audioPath)) {
        fs.unlinkSync(audioPath);
    }
}
```

El `let audioPath: string | null = null` antes del try es necesario porque el `finally` necesita acceso a la variable — si se declara dentro del try, no es visible en el finally.

### Interfaces afectadas

- `src/agent/daily_digest.ts`: función `sendDailyDigest`

---

## ITEM-09: Firebase Index Documentation

Crear `docs/FIREBASE_SETUP.md` con:
- Los dos índices compuestos requeridos (colección `messages`: `userId ASC` + `timestamp DESC`; colección `reminders`: `sent ASC` + `remindAt ASC`)
- El JSON completo de `firestore.indexes.json`
- Comando `firebase deploy --only firestore:indexes`
- Variables de entorno requeridas para Firebase
- Setup de service account con las dos alternativas (bind mount / `GOOGLE_APPLICATION_CREDENTIALS`)

Este item no modifica código de producción.

### Interfaces afectadas

- `docs/FIREBASE_SETUP.md`: archivo nuevo

---

## ITEM-10: Dockerfile credentials fix

### Problema actual

```dockerfile
# ANTES (Dockerfile línea 19-20) — copia credenciales en la imagen
COPY service-account.json* ./
COPY client_secret.json* ./
```

Aunque el `*` hace que el build no falle si los archivos no existen, si están presentes en el contexto de build, quedan embebidos en la imagen Docker. Cualquiera con acceso a la imagen tiene las credenciales.

### Alternativas analizadas

| Alternativa | Pros | Contras | Decisión |
|---|---|---|---|
| **Bind mount en runtime** (`-v /host/path/service-account.json:/app/service-account.json:ro`) | Simple, sin cambios de código, las credenciales nunca entran a la imagen | El path en el host debe existir, requiere documentar el flag `-v` | **Recomendada — opción A** |
| **Variable de entorno `GOOGLE_APPLICATION_CREDENTIALS`** | Ya existe soporte en el config schema (`z.string().optional()`), estándar de Google SDKs | El contenido del archivo sigue en el host, solo cambia cómo se referencia | **Recomendada — opción B** (ya soportada por el código) |
| **Docker BuildKit secret mount** (`--mount=type=secret,id=sa`) | Las credenciales no quedan en ninguna layer de la imagen, ideal para CI/CD | Requiere BuildKit habilitado, sintaxis diferente en `docker build`, más complejo para uso local | Documentar como opción avanzada |
| **Env var con contenido base64** | Un solo env var, sin archivo | El contenido del JSON en base64 es largo, los SDKs de Google no soportan esto nativamente | Descartada |

**Cambio en Dockerfile**:

```dockerfile
# ANTES
COPY service-account.json* ./
COPY client_secret.json* ./

# DESPUÉS — remover completamente estas líneas
# Las credenciales se montan en runtime, no se copian en la imagen.
# Ver docs/FIREBASE_SETUP.md para las opciones de runtime.
```

Agregar `service-account.json` y `client_secret.json` a `.dockerignore` para asegurar que nunca entren al contexto de build incluso por error.

### Interfaces afectadas

- `Dockerfile`: eliminar las 2 líneas de COPY
- `.dockerignore`: agregar las 2 entradas (crear el archivo si no existe)
- `docs/FIREBASE_SETUP.md`: documentar las opciones de runtime

---

## Variables de entorno nuevas

| Variable | Tipo | Default | Required | Descripción | Dónde se agrega |
|---|---|---|---|---|---|
| `LLM_TIMEOUT_MS` | `number` | `30000` | No | Timeout en ms para llamadas a Gemini, Groq y OpenRouter | `src/config/index.ts`: `z.string().default('30000').transform(Number)` |
| `TERMINAL_SANDBOX_DIR` | `string` | `{cwd}/workspace` | No | Directorio raíz para comandos de lectura de archivos | `src/config/index.ts`: `z.string().default(path.join(process.cwd(), 'workspace'))` |
| `WHATSAPP_APP_SECRET` | `string` | — | Sí (si WhatsApp habilitado) | App Secret de Meta para validar firma HMAC del webhook | `src/config/index.ts`: `z.string().optional()` |
| `WHATSAPP_ALLOWED_NUMBERS` | `string[]` | — | No (si ausente, bloquea todo) | Lista de números autorizados separados por coma | `src/config/index.ts`: `z.string().optional().transform(val => val ? val.split(',').map(s => s.trim()) : [])` |
| `MEMORY_MAX_EMBEDDINGS` | `number` | `500` | No | Límite de embeddings por usuario en SQLite | `src/config/index.ts`: `z.string().default('500').transform(Number)` |

---

## Dependencias nuevas

| Package | Versión | Tipo | Motivo |
|---|---|---|---|
| `express-rate-limit` | `^7.x` | `dependencies` | Rate limiting para el webhook de WhatsApp (ITEM-05) |
| `@types/express-rate-limit` | N/A | — | No necesario — el package incluye sus propios tipos desde v6 |

`crypto` es built-in de Node.js 22 — no requiere instalación.

---

## Archivos afectados (resumen)

| Archivo | Acción | Items |
|---|---|---|
| `.env.example` | Modify | ITEM-01 |
| `src/config/index.ts` | Modify | ITEM-02, 03, 04, 06, 07 |
| `src/llm/index.ts` | Modify | ITEM-02 |
| `src/tools/terminal.ts` | Modify | ITEM-03 |
| `src/whatsapp/index.ts` | Modify | ITEM-04, 05, 06 |
| `src/agent/daily_digest.ts` | Modify | ITEM-08 |
| `src/database/index.ts` | Modify | ITEM-07 |
| `Dockerfile` | Modify | ITEM-10 |
| `.dockerignore` | Create/Modify | ITEM-10 |
| `docs/FIREBASE_SETUP.md` | Create | ITEM-09 |
| `package.json` | Modify | ITEM-05 (`express-rate-limit`) |

## Open Questions

- [ ] Confirmar que `@google/genai` v1.44 usa `abortSignal` (no `signal`) en el config de `generateContent`. Si no, el timeout de Gemini requiere `Promise.race()` como wrapper.
- [ ] Verificar si `WHATSAPP_VERIFY_TOKEN` debe migrarse fuera del default hardcodeado `'opengravity_webhook_2026'` (señalado como out-of-scope en la propuesta, pero el default está en `src/config/index.ts` — merece una decisión explícita).
