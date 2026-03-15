---
change: opengravity-security-scalability
phase: explore
date: 2026-03-15
---

# Exploración: OpenGravity Security & Scalability Refactor

## Resumen del proyecto

**OpenGravity** es un bot personal para Telegram (con soporte opcional de WhatsApp) que actúa como asistente de gestión empresarial para BrescoPack. Stack:

- **Runtime**: Node.js 22 + TypeScript (ESM modules, tsx para dev)
- **Bot**: grammy (Telegram) + Express (WhatsApp webhook)
- **LLMs**: Gemini (primario, multi-tier: fast/pro/ultra), Groq/llama-3.3-70b (fallback), OpenRouter (segundo fallback)
- **Database**: Firebase Firestore (primario) + better-sqlite3 (fallback y embeddings)
- **Herramientas**: 15 tools registradas — Google Workspace (Gmail, Calendar, Drive, Contacts, Sheets, Docs), web search, web scrape, notes, reminders, terminal, GitHub, markets, image gen, social content
- **Voice**: ElevenLabs TTS + Groq Whisper STT
- **Scheduler**: node-cron (reminders cada minuto, daily digest 08:30)
- **Auth Google**: gog CLI binary propio en `/gog-bin/`

**Flujo principal**:
```
Telegram/WhatsApp → bot/whatsapp handler → saveMessage() → getHistory()
  → runAgent() → getCompletion() [Gemini/Groq/OpenRouter]
  → executeTool() si hay tool calls (hasta MAX_ITERATIONS=3)
  → saveMessage(response) → reply al usuario
```

**Memoria semántica**: Cada interacción genera un embedding (Gemini text-embedding-004), se guarda en SQLite `memory_embeddings`. En cada request, se buscan los 3 embeddings más similares (cosine similarity > 0.65) y se inyectan como LONG TERM MEMORY en el system prompt.

---

## Hallazgos por problema

### PROBLEMA 1 — API keys reales en `.env.example` (CRÍTICO)

**Archivo**: `/c/Users/Gianni/Agents/.env.example` — todo el archivo

**Situación**: El `.env.example` está trackeado en git. En el commit inicial (`12f64cf`) las claves tenían placeholders correctos. Actualmente el working tree tiene los valores reales:

| Variable | Valor expuesto |
|---|---|
| `TELEGRAM_BOT_TOKEN` | `8383891169:AAEMwUUhl9gl7KlvL3PJSfwTNaCZgkrBMgs` |
| `TELEGRAM_ALLOWED_USER_IDS` | `7114714453` (user ID real) |
| `GROQ_API_KEY` | `gsk_z6oDLI...` (clave real) |
| `GEMINI_API_KEY` | `AIzaSyAUk...` (clave real) |
| `OPENROUTER_API_KEY` | `sk-or-v1-ccb24...` (clave real) |
| `ELEVENLABS_API_KEY` | `sk_98c65f...` (clave real) |
| `FIREBASE_PROJECT_ID` | `opengravity63` (project ID real) |

**Impacto**: Si este archivo se commitea o ya está visible, cualquier persona con acceso al repo tiene control total del bot, acceso a todos los LLMs (con sus costos), y puede interactuar con Firebase.

**Estado en git**: El último commit tiene los placeholders correctos. El working tree tiene los reales. El cambio está pendiente de staging (`M .env.example` en git status). Aún no fue commiteado — pero el riesgo está presente y el archivo debería nunca tener valores reales.

**Acción requerida**: Revertir working tree a los placeholders y agregar regla en `.gitignore` para prevención futura.

---

### PROBLEMA 2 — Sin timeout en LLM calls

**Archivo**: `/c/Users/Gianni/Agents/src/llm/index.ts`

- **Línea 211**: `await geminiClient.models.generateContent({...})` — sin timeout configurado
- **Línea 240**: `await groq.chat.completions.create({...})` — sin timeout (SDK default)
- **Línea 283**: `await openRouter.chat.completions.create({...})` — sin timeout

El wrapper `pRetry` (línea 307) tiene `{ retries: 2 }` pero sin `maxRetryTime` ni timeout de operación. Si Gemini cuelga, la request puede vivir indefinidamente.

El único lugar con timeout es la herramienta terminal (`execPromise` con 15000ms, línea 52 de `terminal.ts`) y `runGog` (30000ms).

**Impacto**: Una LLM call colgada bloquea el handler de Telegram indefinidamente. En WhatsApp el webhook devuelve 200 inmediatamente (línea 167 de `whatsapp/index.ts`), pero el `runAgent()` que corre async puede acumular promesas sin resolver. Potencial agotamiento de memoria/file descriptors en producción.

**Dependencias**: Este fix debe ir antes del fix de logging estructurado (facilita observabilidad de timeouts).

---

### PROBLEMA 3 — Sin protección contra prompt injection

**Archivo**: `/c/Users/Gianni/Agents/src/agent/loop.ts`

- **Línea 24-65**: System prompt del agente construido en string template
- **Línea 55**: `Fecha/hora actual: ${new Date().toISOString()}` — esto está en el system prompt, no es vector de inyección
- **Línea 96**: `messages = messages.concat(history)` — el historial del usuario se concatena directamente sin sanitización
- **Línea 84-88**: LONG TERM MEMORY se inyecta desde SQLite al system prompt sin validación

**Vector real de inyección**: Si un atacante logra persistir texto como nota o en el historial de conversación con formato `SYSTEM:` o `INSTRUCCIÓN IMPORTANTE:`, ese texto se inyecta en el contexto del LLM en futuras conversaciones a través de `topMemories` o `history`.

**Herramientas que escriben a storage sin validación**:
- `save_note` — guarda texto libre del usuario en SQLite
- `saveMessage` — guarda cada mensaje del usuario en SQLite/Firebase
- `saveEmbedding` — guarda el par pregunta-respuesta como memoria semántica

**Impacto**: Bajo en contexto single-user (el bot es personal, solo Gianni lo usa según whitelist). Pero si el whitelist se amplía o hay bypass, un usuario malicioso podría persistir instrucciones que afecten futuras sesiones.

---

### PROBLEMA 4 — Terminal tool demasiado permisivo (regex frágil)

**Archivo**: `/c/Users/Gianni/Agents/src/tools/terminal.ts`

**Línea 8-13 — ALLOWED_COMMANDS allowlist**:
```typescript
const ALLOWED_COMMANDS = [
    'dir', 'ls', 'ipconfig', 'ifconfig', 'netstat', 'tasklist', 'ps',
    'whoami', 'ping', 'systeminfo', 'hostname', 'date', 'time',
    'echo', 'type', 'cat', 'head', 'tail', 'wc', 'df', 'free',
    'uname', 'uptime', 'nslookup', 'tracert', 'traceroute',
];
```

**Línea 16 — DANGEROUS_PATTERNS regex**:
```typescript
const DANGEROUS_PATTERNS = /[;&|`$(){}[\]<>!\\]|(\bsudo\b)|(\brm\b)|(\bdel\b)|...
```

**Vulnerabilidades**:

1. **`echo` está en la allowlist** — `echo` puede ser usado para escribir archivos en Windows si se usa con redirección, pero el regex bloquea `>`. Sin embargo, en PowerShell `echo` tiene equivalencias peligrosas. `echo` en sí podría servir para exfiltración de info del sistema.

2. **`type` está en la allowlist** — En Windows, `type archivo.txt` lee archivos arbitrarios. El LLM podría decidir leer `service-account.json`, `.env`, etc. No hay restricción de paths.

3. **`cat` está en la allowlist** — Mismo problema que `type` en Linux.

4. **`head`/`tail` están en la allowlist** — Leen fragmentos de archivos arbitrarios.

5. **El regex no cubre todos los casos**: El patrón bloquea `|` y `;`, pero en Windows hay otros separadores como `&&` (ampersand doble). La regex tiene `[;&|...]` pero `&&` tiene dos `&` sin `;` ni `|`. Verificación: `&&` contiene `&` que sí está en el character class `[;&|...]`. OK en este caso concreto.

6. **`ping` sin límite de paquetes**: `ping -t <ip>` en Windows hace ping infinito hasta timeout de 15s. Riesgo menor pero existe.

7. **`nslookup` + `traceroute` / `tracert`**: Pueden revelar topología de red interna si el bot corre en un servidor.

**Impacto**: El LLM podría ser instruido (o decidir por su cuenta) para leer archivos sensibles del sistema usando `cat`, `type`, `head` o `tail`. El archivo `service-account.json` con credenciales de Firebase está en el directorio de trabajo.

---

### PROBLEMA 5 — Sin rate limiting en webhooks

**Archivo**: `/c/Users/Gianni/Agents/src/whatsapp/index.ts`

- **Línea 144-227**: `createWhatsAppServer()` crea un Express app sin ningún middleware de rate limiting
- **Línea 166**: El POST `/webhook` no valida la autenticidad de la request más allá de `body.object !== 'whatsapp_business_account'` (línea 173) — cualquiera puede enviar un POST válido
- **Línea 167**: `res.sendStatus(200)` antes de procesar — Meta recomienda esto, pero significa que el procesamiento async puede acumularse sin límite

**Ausencia de**:
- `express-rate-limit` o equivalente
- Validación de firma HMAC de Meta (la spec de WhatsApp Cloud API incluye header `X-Hub-Signature-256`)
- Límite de concurrencia en `handleIncomingMessage`

**Impacto**: Un atacante puede enviar requests masivas al webhook, saturando el procesamiento async y potencialmente incurriendo en costos de API (cada request al webhook desencadena `runAgent()` que llama a Gemini/Groq).

**Nota**: La verificación HMAC de Meta usa `X-Hub-Signature-256: sha256=<hash>` con el app secret como clave. No está implementada.

---

### PROBLEMA 6 — `any` types en bot/index.ts

**Archivo**: `/c/Users/Gianni/Agents/src/bot/index.ts`

- **Línea 52**: `ctx: any` — parámetro de `handleResponse`
- **Línea 68**: `const history = await getHistory(userId) as any[]` — cast a any[]
- **Línea 71**: `const lastUserMsg = history[history.length - 1]` — acceso sin type check

**Otros `any` en el proyecto**:
- `src/llm/index.ts` líneas 115, 116, 117, 118, 119, 120, 122, 127, 129, 132, 136, 139, 144 — `convertSchemaForGemini` usa `any` extensivamente
- `src/llm/index.ts` línea 203: `const geminiConfig: any = {}`
- `src/tools/index.ts` línea 6: `execute: (args: any) => Promise<string>`
- `src/database/index.ts` línea 8: `let localDb: any = null`

**Impacto**: No es un problema de seguridad directo. Sí impide que TypeScript detecte errores en tiempo de compilación, especialmente en el acceso a `history` y en la ejecución de tools donde `args` es `any`.

---

### PROBLEMA 7 — Sin tests (0 coverage)

**Estado actual**:
- `test.ts` en raíz: script manual para testear image generation (14 líneas, no es un test automatizado)
- `test_agent.ts` en raíz: probablemente script manual también
- `test_updates.ts` en raíz: idem
- Sin framework de testing (no hay vitest, jest, mocha en `package.json`)
- Sin scripts `test` en `package.json`

**Áreas críticas sin tests**:
- `cosineSimilarity()` en `loop.ts` — función matemática pura, trivial de testear
- `getCompletion()` — lógica de fallback entre proveedores
- `executeTool()` — registro y dispatch de tools
- Validaciones de seguridad en `terminal.ts` (allowlist + regex)
- `splitMessage()` en `whatsapp/index.ts` — lógica de chunking

**Impacto**: Cada cambio en el refactor de seguridad no puede ser verificado automáticamente. Riesgo alto de regresiones.

---

### PROBLEMA 8 — Sin logging estructurado (todo console.log)

**Distribución de logs en el proyecto**:

| Archivo | Logs |
|---|---|
| `src/agent/loop.ts` | `console.log` (tool calls), `console.error` (semantic memory) |
| `src/bot/index.ts` | `console.warn` (unauthorized), `console.error` (varios), `console.log` (bot start) |
| `src/llm/index.ts` | `console.log` (model tier), `console.error` (fallbacks) |
| `src/database/index.ts` | `console.error`, `console.warn`, `console.log` — múltiples |
| `src/whatsapp/index.ts` | `console.log`, `console.error` |
| `src/index.ts` | `console.log`, `console.error` |
| `src/tools/terminal.ts` | `console.log` (⚠️ EXECUTING) |
| Todos los tools | `console.log` al registrarse |

**Problemas específicos**:
- No hay correlation ID para trazar una request a través de bot → agent → tools → LLM
- No hay log levels configurables (sin forma de bajar verbosidad en producción)
- Logs de tools al iniciar (`🔌 Tool registered`) van a stdout de producción
- `console.log` en `loop.ts` línea 113 imprime el argumento completo de cada tool call — puede loguear datos sensibles del usuario (contenido de emails, queries de búsqueda)

---

### PROBLEMA 9 — Semantic memory puede crecer infinito

**Archivo**: `/c/Users/Gianni/Agents/src/database/index.ts` + `src/agent/loop.ts`

**Código de escritura** (`loop.ts` líneas 138-149):
```typescript
const memoryText = `User asked: ${lastQuery}\nBot answered: ${finalContent}`;
const memoryEmb = await getEmbedding(memoryText);
if (memoryEmb.length > 0) {
    await saveEmbedding(userId, memoryText, memoryEmb);
}
```

**Problema**: Se guarda UNA entrada en `memory_embeddings` por CADA interacción que supere MAX_ITERATIONS (que en realidad siempre ejecuta). No hay:
- Límite de registros por usuario
- TTL / expiración
- Deduplicación
- Vacuume / compactación

**Código de lectura** (`loop.ts` línea 74): `const pastEmbeddings = await getAllEmbeddings(userId)` — carga TODOS los embeddings del usuario en memoria RAM de una vez para calcular cosine similarity.

**Tamaño de un embedding**: `text-embedding-004` genera vectores de 768 dimensiones. Almacenado como JSON string: ~4KB por registro. Con 1000 interacciones: ~4MB en RAM por request. Con 10.000: ~40MB por request.

**Impacto**: Degradación de performance progresiva. En uso intensivo (digamos 50 mensajes/día × 365 días = 18.250 registros), `getAllEmbeddings` cargaría ~73MB por request y la cosine similarity correría sobre 18K vectores en cada consulta.

---

### PROBLEMA 10 — Archivo temporal huérfano en daily_digest

**Archivo**: `/c/Users/Gianni/Agents/src/agent/daily_digest.ts`

**Línea 52**: `const audioPath = await textToSpeech(response.content)`

**Línea 64**: `if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath)`

**Problema**: El cleanup del archivo temporal está dentro del `try` principal. Si alguna de las llamadas a `bot.api.sendVoice()` (línea 57) falla para algunos usuarios pero no para otros, el bucle continúa. Pero si el `textToSpeech` falla o cualquier error ocurre antes de la línea 64, el archivo temporal en `os.tmpdir()` queda huérfano.

**Comparación con bot/index.ts**: En `handleResponse` (líneas 86-95 y 102-111) el cleanup está en bloque `finally`, que es la forma correcta. En `daily_digest.ts` no hay `finally`.

**Impacto**: Acumulación de archivos `.mp3` en `/tmp` en producción. En un servidor con espacio limitado puede causar problemas. En Docker el tmpdir se borra al restart, pero en procesos long-running no.

---

### PROBLEMA 11 — Firebase indexes no documentados

**Archivo**: `/c/Users/Gianni/Agents/src/database/index.ts`

**Líneas 91-96** (getHistory): query con `.where('userId', ...)` + `.orderBy('timestamp', 'desc')` — requiere índice compuesto en Firestore.

**Líneas 151-155** (getPendingReminders): query con `.where('sent', '==', false)` + `.where('remindAt', '<=', ...)` — requiere índice compuesto en Firestore.

**Evidencia del problema** en `bot/index.ts` línea 121:
```typescript
if (errMsgStr.includes('index')) {
    errorMsg = "⚠️ Firebase necesita un índice. Revisa la consola del bot para el enlace de creación.";
}
```

Y en `database/index.ts` línea 107:
```typescript
if (error.message.includes('requires an index')) {
    console.error("❌ MISSING FIREBASE INDEX: Falling back to local history.");
}
```

**Problema**: No existe un archivo `firestore.indexes.json` en el proyecto. Los índices se crean manualmente o siguiendo el link de error en consola. Si se deploya en un nuevo proyecto Firebase, el bot falla silenciosamente al historial (hace fallback a SQLite) y los reminders no funcionan hasta que alguien crea los índices.

**Impacto**: Operational — no es un problema de seguridad pero sí de escalabilidad y reproducibilidad del deployment.

---

### PROBLEMA 12 — Error messages que revelan info sensible

**Archivo**: `/c/Users/Gianni/Agents/src/bot/index.ts`

**Línea 125**:
```typescript
} else if (errMsgStr.includes('elevenlabs')) {
    errorMsg = "🎙️ Error con ElevenLabs. Revisa tu API Key.";
```

**Línea 126-127**:
```typescript
} else if (errMsgStr.includes('402') || errMsgStr.includes('billing') || errMsgStr.includes('spend limit')) {
    errorMsg = "💳 Tu saldo en OpenRouter se ha agotado...";
```

**Línea 128-129**:
```typescript
} else if (errMsgStr.includes('quota') || errMsgStr.includes('rate limit') || errMsgStr.includes('429')) {
    errorMsg = "⏳ ¡Límite de peticiones alcanzado! Gemini y Groq llegaron a su límite gratuito...";
```

**Análisis**: Estos mensajes revelan a cualquier usuario del bot (aunque la whitelist limita esto a Gianni mismo) qué tecnología está usando internamente, el estado de las cuentas y el hecho de que usa planes gratuitos. En el contexto de un bot personal single-user, el impacto es bajo.

**El problema real** está en el `catch` genérico que lleva al `console.error("Response Error:", error)` en línea 116 — el error completo (incluyendo stack traces con paths internos) va a stdout. Si stdout está siendo capturado o logueado externamente (ej. Doppler, Datadog), esa info podría estar expuesta.

**El error message al usuario** (`"Ups, no pude procesar eso correctamente."`) es inofensivo por default.

---

## Mapa de dependencias

```
[1] API keys en .env.example
    └── Fix independiente, no bloquea nada, PRIORIDAD MÁXIMA

[2] Timeout en LLM calls
    └── Prerequisito recomendado para [8] (logging estructurado lo hace observable)
    └── Independiente de otros

[3] Prompt injection
    └── Depende conceptualmente de [7] tests (para validar la sanitización)
    └── Puede hacerse sin tests como medida de mitigación básica

[4] Terminal tool permisos
    └── Fix independiente
    └── Relacionado con [3] (el terminal tool es el vector más peligroso de inyección)

[5] Rate limiting webhook
    └── Fix independiente (agregar middleware Express)
    └── Relacionado con [2] (si hay timeout, el rate limiting lo complementa)

[6] any types
    └── Fix incremental, no bloquea ni depende de nada
    └── Mejora la base para [7] tests

[8] Logging estructurado
    └── Depende de [2] (para loguear timeouts correctamente)
    └── Prerequisito para observabilidad en producción

[9] Semantic memory crecimiento
    └── Fix independiente (agregar LIMIT + TTL en queries)
    └── Impacta performance de [runAgent], no de seguridad

[10] Archivo temporal daily_digest
    └── Fix trivial independiente (mover a finally)

[11] Firebase indexes
    └── Fix de infraestructura, independiente
    └── Prerequisito para deployment confiable

[12] Error messages
    └── Bajo impacto en single-user, fix cosmético
    └── Mejora con [8] logging estructurado
```

**Orden de implementación recomendado**:
1. `[1]` — Revocar claves y actualizar .env.example (URGENTE, hoy)
2. `[4]` — Terminal tool (mayor superficie de ataque)
3. `[5]` — Rate limiting + HMAC WhatsApp
4. `[2]` — Timeouts LLM
5. `[9]` — Semantic memory bounded
6. `[10]` — Daily digest cleanup
7. `[11]` — Firebase indexes documentados
8. `[8]` — Logging estructurado
9. `[3]` — Prompt injection (mitigación básica)
10. `[6]` — any types (refactor de tipo, bajo riesgo)
11. `[7]` — Tests (infraestructura nueva, mayor esfuerzo)
12. `[12]` — Error messages (cosmético)

---

## Riesgos de refactor

### Riesgos altos

**R1 — Semantic memory migration**: Si se agrega un TTL o LIMIT a `memory_embeddings`, las memorias existentes del usuario se pierden o se truncan. Gianni puede notar que el bot "olvidó" contexto previo. Estrategia: migración con timestamp-based LIMIT (preservar los N más recientes).

**R2 — Terminal tool — romper funcionalidad legítima**: Si se remueve `cat`/`type`/`head`/`tail` de la allowlist, Gianni pierde la capacidad de leer archivos del sistema a través del bot. Requiere decisión explícita del owner sobre el tradeoff seguridad/funcionalidad.

**R3 — WhatsApp HMAC validation**: Agregar validación de `X-Hub-Signature-256` requiere tener el `APP_SECRET` de Meta configurado. Si no se agrega la variable de entorno correctamente, el webhook dejará de funcionar. Deploy con feature flag o variable de entorno opcional.

**R4 — LLM timeouts y pRetry**: Agregar `AbortSignal` a las llamadas de Gemini + signal de timeout puede afectar la lógica de retry de pRetry. Hay que asegurarse de que el AbortError no sea tratado como error retriable.

### Riesgos medios

**R5 — Structured logging**: Reemplazar `console.log/error` con un logger estructurado (pino, winston) implica cambios en todos los archivos. Si hay algún console.log capturando output de herramientas y ese output es usado como retorno (poco probable pero posible en algún edge case), podría romperse. Revisar que no haya ningún test o script que parsee stdout.

**R6 — TypeScript strict typing**: Eliminar `any` types puede descubrir bugs existentes que TypeScript estaba ignorando. Tratar como oportunidad, no como riesgo.

### Riesgos bajos

**R7 — Firebase indexes**: Agregar `firestore.indexes.json` no afecta el runtime. Es un artefacto de configuración que mejora el deployment.

**R8 — Daily digest finally**: Cambio trivial, riesgo cero de regresión.

---

## Oportunidades adicionales

### OPP-1 — Historial de conversación sin límite efectivo

**Archivo**: `src/database/index.ts` línea 88: `getHistory(userId, limit: number = 20)`

El `limit: 20` existe, pero en `bot/index.ts` se llama sin argumento (`getHistory(userId)`). 20 mensajes es razonable, pero si el contenido de los mensajes es extenso (documentos PDF, CSVs, respuestas largas del agente), el historial puede superar el context window del LLM.

No hay truncación por tokens, solo por número de mensajes. Recomendación: agregar truncación por longitud total de caracteres o implementar sliding window.

### OPP-2 — WhatsApp no tiene whitelist de usuarios

**Archivo**: `src/whatsapp/index.ts` línea 117: `const userId = \`wa_${from}\``

El handler de WhatsApp no implementa ninguna whitelist equivalente a la del bot de Telegram. Cualquier número de WhatsApp que conozca el número del business puede enviar mensajes y el bot los procesará con el agente completo.

`src/bot/index.ts` líneas 14-22 implementa whitelist correctamente. El equivalente debe agregarse en WhatsApp.

### OPP-3 — Dockerfile incluye credenciales sensibles

**Archivo**: `Dockerfile` líneas 18-20:
```dockerfile
COPY service-account.json ./
COPY client_secret.json ./
```

Estas credenciales quedan embebidas en la imagen Docker. Si la imagen se pushea a un registry público o se comparte, las credenciales están expuestas. Mejor práctica: montar como secret en runtime (Docker secrets, k8s secrets, variable de entorno con el contenido JSON).

### OPP-4 — `WHATSAPP_VERIFY_TOKEN` hardcodeado como default

**Archivo**: `src/config/index.ts` línea 22: `.default("opengravity_webhook_2026")`
**Archivo**: `src/whatsapp/index.ts` línea 148: `|| 'opengravity_webhook_2026'`

El verify token tiene un valor default público hardcodeado en dos lugares. Si se rota, hay que actualizar en dos sitios. Peor: está en el código fuente del repo.

### OPP-5 — `MAX_ITERATIONS = 3` sin observabilidad

**Archivo**: `src/agent/loop.ts` línea 18

El límite de 3 iteraciones es razonable, pero no hay métrica de cuántas veces se alcanza el límite. Cuando se alcanza, la respuesta es el último mensaje del asistente (que puede ser una respuesta parcial o el mensaje de la tool, no una respuesta final). Sin logging estructurado, este caso silencioso es difícil de detectar.

### OPP-6 — `tool_calls` sin rollback / transacción

Si un tool call escribe datos (save_note, create_reminder, gmail_send) y el LLM en la iteración siguiente decide que fue un error, no hay forma de deshacer. No es un problema crítico para el scope actual, pero es un gap de diseño del agente.

### OPP-7 — GOG_ACCOUNT en env vs. en config schema

**Archivo**: `src/google/gog.ts` línea 7: `const GOG_ACCOUNT = process.env.GOG_ACCOUNT || ''`

Accede a `process.env` directamente en lugar de usar el `config` object validado por Zod. Si `GOG_ACCOUNT` no está en el env, falla silenciosamente con string vacío en lugar de usar el valor del schema. `src/config/index.ts` línea 19 lo incluye como `z.string().optional()`, pero `gog.ts` bypasea esa validación.

---

## Recomendación de scope

### INCLUIR en este refactor (MVP de seguridad)

| # | Problema | Esfuerzo | Impacto |
|---|---|---|---|
| 1 | Revocar API keys + fix .env.example | Bajo | CRÍTICO |
| 4 | Terminal tool — remover cat/type/head/tail de allowlist | Bajo | Alto |
| 5 | Rate limiting + HMAC WhatsApp webhook | Medio | Alto |
| 2 | Timeouts en LLM calls (AbortSignal) | Medio | Alto |
| 9 | Semantic memory — agregar LIMIT + índice SQLite | Bajo | Medio |
| 10 | Daily digest — mover cleanup a finally | Trivial | Bajo |
| 11 | Firebase indexes — agregar firestore.indexes.json | Bajo | Medio |
| OPP-2 | WhatsApp whitelist de usuarios | Bajo | Alto |

### INCLUIR como segundo wave (calidad y observabilidad)

| # | Problema | Esfuerzo | Impacto |
|---|---|---|---|
| 8 | Logging estructurado (pino) | Medio-Alto | Alto |
| 6 | Eliminar any types críticos | Medio | Medio |
| 7 | Tests para lógica crítica (cosineSimilarity, tool dispatch, terminal security) | Alto | Alto |
| OPP-3 | Dockerfile sin credenciales embebidas | Medio | Medio |
| OPP-4 | Centralizar WHATSAPP_VERIFY_TOKEN | Trivial | Bajo |

### DEJAR PARA DESPUÉS (post-MVP)

| # | Problema | Justificación |
|---|---|---|
| 3 | Prompt injection completa | Single-user, whitelist robusta. Mitigación básica es suficiente ahora. |
| 12 | Error messages sensibles | Impacto real casi nulo en contexto single-user. |
| OPP-1 | Historial por tokens | Bajo riesgo actual con 20 mensajes de límite. |
| OPP-5 | MAX_ITERATIONS observabilidad | Se resuelve parcialmente con logging estructurado. |
| OPP-6 | Tool rollback | Cambio arquitectónico mayor, fuera del scope de seguridad. |
| OPP-7 | GOG_ACCOUNT bypass config | Bajo impacto funcional. |
