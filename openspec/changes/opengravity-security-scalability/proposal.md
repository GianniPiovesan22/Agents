---
change: opengravity-security-scalability
phase: proposal
date: 2026-03-15
status: approved
---

# Propuesta: OpenGravity Security & Scalability Refactor

## Intent

OpenGravity tiene múltiples vectores de riesgo activos en producción: API keys reales en el working tree de git, un webhook de WhatsApp sin autenticación ni rate limiting, llamadas a LLMs sin timeout que pueden colgar indefinidamente, una terminal tool que puede leer archivos arbitrarios del sistema, y una memoria semántica que crece sin límite degradando performance con el tiempo. Este change cierra los 10 riesgos de mayor impacto antes de cualquier escalado o apertura del bot a más usuarios.

---

## Scope

### In scope (Wave 1 — Seguridad Crítica)

1. **Rotar `.env.example`** — Revertir el working tree a placeholders descriptivos (el commit inicial `12f64cf` los tenía correctos). Nunca debe haber valores reales en este archivo. Agregar `.env` a `.gitignore` si no está ya cubierto. Revocar externamente las claves expuestas (GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, ELEVENLABS_API_KEY, TELEGRAM_BOT_TOKEN).

2. **LLM Timeouts** — Agregar `AbortSignal.timeout(ms)` con `Promise.race()` en los 3 providers: Gemini (`generateContent`), Groq (`chat.completions.create`), y OpenRouter (`chat.completions.create`). El timeout default será 30 segundos, configurable por variable de entorno `LLM_TIMEOUT_MS`. El `AbortError` debe ser capturado explícitamente y relanzado como error no-retriable para que `pRetry` no lo reintente.

3. **Terminal Sandbox** — Los comandos de lectura de archivos (`cat`, `type`, `head`, `tail`) se mantienen en la allowlist pero con restricción de paths. Antes de ejecutar, se resolverá el path absoluto con `path.resolve()` y se validará que comience con `TERMINAL_SANDBOX_DIR` (variable de entorno configurable). Default: `process.cwd() + '/workspace'`. Si el path resuelto no comienza con el sandbox dir, el comando es rechazado con error descriptivo. El directorio sandbox se crea si no existe en el bootstrap.

4. **WhatsApp HMAC Validation** — Validar el header `x-hub-signature-256` en cada POST al webhook usando la nueva variable `WHATSAPP_APP_SECRET`. La validación usa `crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')` y compara con el header usando `crypto.timingSafeEqual()` para evitar timing attacks. Si la variable no está configurada, el webhook rechaza todas las requests con 401 y un log de error claro. Se necesita `express.raw()` como middleware para acceder al body sin parsear.

5. **WhatsApp Rate Limiting** — Agregar `express-rate-limit` con límite de 100 requests por minuto por IP. Se aplica solo a la ruta `POST /webhook`. Responde 429 con header `Retry-After` cuando se supera el límite. Sin persistencia de estado entre reinicios (in-memory store es suficiente para este caso de uso).

6. **WhatsApp User Whitelist** — Aplicar la misma lógica de whitelist de Telegram al handler de WhatsApp. Leer `TELEGRAM_ALLOWED_USER_IDS` (reutilizar la variable existente, los IDs de WhatsApp son números de teléfono prefijados con `wa_`). Agregar nueva variable `WHATSAPP_ALLOWED_NUMBERS` como alternativa específica para WhatsApp. Si ninguna está configurada, rechazar todos los mensajes entrantes con log de warning. Si alguna está configurada, solo procesar mensajes de números en la lista.

7. **Bounded Semantic Memory** — Agregar parámetro `MEMORY_MAX_EMBEDDINGS` (default: 500) que limita el total de registros en `memory_embeddings` por usuario. En `getAllEmbeddings`, agregar `LIMIT` a la query SQLite ordenada por `createdAt DESC` para retornar solo los N más recientes. En `saveEmbedding`, después de guardar, ejecutar `DELETE FROM memory_embeddings WHERE userId = ? AND id NOT IN (SELECT id FROM memory_embeddings WHERE userId = ? ORDER BY createdAt DESC LIMIT ?)` para enforcer el límite. Política: se preservan los más recientes (relevancia temporal > relevancia histórica para un asistente personal).

8. **Daily Digest temp file cleanup** — Mover el `fs.unlinkSync(audioPath)` de `daily_digest.ts` a un bloque `finally` garantizado. Patrón: declarar `let audioPath: string | null = null` antes del try, asignar dentro del try, y limpiar en finally con `if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath)`. Este es el mismo patrón ya implementado correctamente en `bot/index.ts`.

9. **Firebase Index Documentation** — Crear `docs/FIREBASE_SETUP.md` documentando los dos índices compuestos requeridos: (1) colección `messages`: campos `userId ASC` + `timestamp DESC`; (2) colección `reminders`: campos `sent ASC` + `remindAt ASC`. Incluir el JSON de `firestore.indexes.json` listo para deployar y el comando `firebase deploy --only firestore:indexes`. También documentar las variables de entorno requeridas y el setup de la service account.

10. **Dockerfile credentials fix** — Remover las líneas `COPY service-account.json ./` y `COPY client_secret.json ./` del Dockerfile. En su lugar, documentar dos alternativas: (a) montar como Docker bind mount en runtime (`-v /path/to/service-account.json:/app/service-account.json:ro`); (b) usar variable de entorno `GOOGLE_APPLICATION_CREDENTIALS` apuntando al path del archivo en el host. Agregar ambos archivos a `.dockerignore` si no están ya incluidos.

---

### Out of scope (Wave 2 — Calidad)

- **Logging estructurado** (pino/winston) — Reemplazar todos los `console.log/error` con logger con correlation IDs, log levels configurables, y JSON output para producción. Esfuerzo medio-alto, no es un riesgo de seguridad inmediato.
- **Eliminar `any` types** — Refactor de type safety en `llm/index.ts`, `tools/index.ts`, `database/index.ts`, `bot/index.ts`. Mejora la base para testing pero no es crítico.
- **Test suite** — Agregar Vitest con tests para `cosineSimilarity()`, `getCompletion()` fallback logic, `executeTool()` dispatch, y validaciones de security del terminal tool.
- **Prompt injection hardening** — Sanitización de inputs antes de inyectar en el system prompt. Bajo impacto en contexto single-user actual.
- **`WHATSAPP_VERIFY_TOKEN` centralización** — Eliminar el default hardcodeado y unificar en config schema.
- **Historial por tokens** — Truncación del historial de conversación por longitud total en lugar de solo por número de mensajes.

---

## Approach

### Decisiones técnicas clave

**LLM Timeouts con AbortSignal**: La forma más limpia en Node.js 22 es `AbortSignal.timeout(ms)`. Se pasa al SDK de Gemini como `{ signal: AbortSignal.timeout(LLM_TIMEOUT_MS) }`. Para Groq y OpenRouter (que usan la interfaz OpenAI-compatible), se pasa como opción `signal`. El `Promise.race()` es un wrapper alternativo si el SDK no acepta signal nativamente. Crítico: en el bloque catch de `pRetry`, detectar `error.name === 'AbortError' || error.name === 'TimeoutError'` y relanzar con `pRetry.AbortError` para detener los reintentos.

**Terminal Sandbox con path.resolve()**: La validación es simple y robusta: `path.resolve(sandboxDir, userPath).startsWith(path.resolve(sandboxDir))`. Esto cubre path traversal (`../../../etc/passwd`), paths absolutos fuera del sandbox, y symlinks (parcialmente). No se usa regex porque es frágil. La extracción del path desde el comando ejecutado requiere un parser básico del string de comando para aislar el argumento file.

**WhatsApp HMAC con raw body**: El problema clásico es que Express parsea el body antes de que podamos acceder al raw bytes. La solución es usar `express.raw({ type: '*/*' })` como middleware exclusivo para la ruta del webhook, antes del `express.json()` global. El body raw se usa para el HMAC y luego se parsea manualmente con `JSON.parse(req.body.toString())`.

**Bounded memory con política de retención**: Se elige retención de los N más recientes en lugar de TTL porque es predecible y no borra memorias valiosas de eventos únicos (ej: "el 15 de marzo firmamos el contrato con X"). El cleanup se ejecuta inline en `saveEmbedding` — no requiere job separado.

**WhatsApp whitelist**: Se agrega `WHATSAPP_ALLOWED_NUMBERS` como variable separada de `TELEGRAM_ALLOWED_USER_IDS` para evitar acoplar los dos canales. El formato es idéntico: lista de números separados por coma.

---

## Impacto en arquitectura

| Componente | Cambio | Descripción |
|---|---|---|
| `src/llm/index.ts` | Modificado | AbortSignal + detección de AbortError en pRetry |
| `src/tools/terminal.ts` | Modificado | Validación de sandbox path antes de ejecutar comandos de lectura |
| `src/whatsapp/index.ts` | Modificado | HMAC validation middleware, rate limiting, whitelist de usuarios |
| `src/agent/daily_digest.ts` | Modificado | Cleanup de temp file en bloque finally |
| `src/database/index.ts` | Modificado | LIMIT en getAllEmbeddings + cleanup automático en saveEmbedding |
| `.env.example` | Modificado | Solo placeholders, sin valores reales |
| `Dockerfile` | Modificado | Remover COPY de credenciales |
| `docs/FIREBASE_SETUP.md` | Nuevo | Documentación de índices y setup |
| `package.json` | Modificado | Agregar `express-rate-limit` como dependencia |

No hay cambios de arquitectura macro. Todos los cambios son aditivos o correctivos dentro de los módulos existentes. El flujo principal `Telegram/WhatsApp → agent → LLM → tools` no cambia.

---

## Nuevas variables de entorno

| Variable | Descripción | Requerida | Default |
|---|---|---|---|
| `LLM_TIMEOUT_MS` | Timeout en ms para llamadas a Gemini, Groq, y OpenRouter | No | `30000` |
| `TERMINAL_SANDBOX_DIR` | Directorio raíz al que se restringe `cat`, `type`, `head`, `tail` | No | `{process.cwd()}/workspace` |
| `WHATSAPP_APP_SECRET` | App Secret de Meta para validar la firma HMAC del webhook | **Sí** (si WhatsApp está habilitado) | — |
| `WHATSAPP_ALLOWED_NUMBERS` | Lista de números de teléfono autorizados separados por coma (ej: `5491112345678`) | No (si no se configura, todos los mensajes son rechazados) | — |
| `MEMORY_MAX_EMBEDDINGS` | Límite máximo de embeddings en memoria semántica por usuario | No | `500` |

---

## Riesgos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| AbortError interrumpe retry legítimo de pRetry | Media | Alto | Detectar explícitamente `AbortError`/`TimeoutError` y wrappear con `pRetry.AbortError` para detener reintentos. Timeout de 30s es suficientemente largo para respuestas normales. |
| Terminal sandbox rompe use case legítimo de leer archivos | Media | Medio | El directorio `workspace/` es el lugar correcto para que el LLM opere sobre archivos. Se documenta en el system prompt y en el README. El owner puede configurar `TERMINAL_SANDBOX_DIR` a un path más amplio si necesita. |
| WhatsApp HMAC deja de funcionar si `WHATSAPP_APP_SECRET` no se configura | Alta | Alto | El webhook DEBE rechazar con 401 y log claro si la variable no está presente. Esto es intencional — fuerza la configuración correcta. Se documenta en `docs/FIREBASE_SETUP.md` y `.env.example`. |
| Cleanup de embeddings borra memorias valiosas antiguas | Baja | Medio | Se retienen los 500 más recientes. A 50 mensajes/día eso cubre ~10 días de historial completo. El valor 500 es configurable. La pérdida es gradual, no abrupta. |
| Remoción de credenciales del Dockerfile rompe build en CI | Baja | Bajo | Si hay algún pipeline de CI que depende de los archivos copiados, se debe actualizar para montar las credenciales como secret. Se documenta el nuevo approach. |
| HMAC validation requiere raw body — puede romperse con body-parser global | Media | Alto | Usar `express.raw()` exclusivamente en la ruta `/webhook` antes del middleware global. Testear con un webhook real de Meta antes de deployar en producción. |

---

## Rollback Plan

Todos los cambios son en archivos de código versionados en git. El rollback es `git revert` de los commits de este change.

Excepción: la rotación de API keys no es reversible (una vez revocadas, las claves anteriores no funcionan). El rollback en este caso implica generar nuevas claves y actualizar `.env` en producción — procedimiento idéntico al de la implementación.

La variable `WHATSAPP_APP_SECRET` es nueva y opcional en términos de configuración (el servidor inicia sin ella), pero el webhook rechaza requests sin ella. Si se necesita rollback urgente del HMAC validation, se puede hacer feature-flag con `if (WHATSAPP_APP_SECRET) { ... validate ... }` temporalmente.

---

## Definition of Done

- [ ] `.env.example` contiene solo placeholders, ningún valor real. El working tree está limpio. Las claves antiguas fueron revocadas en los portales correspondientes (Google AI Studio, Groq, OpenRouter, ElevenLabs, BotFather).
- [ ] Los 3 providers de LLM tienen timeout configurado. Una llamada a un endpoint fake/lento no cuelga más de `LLM_TIMEOUT_MS` ms. `pRetry` no reintenta un `AbortError`.
- [ ] `cat /etc/passwd` (o equivalente fuera del sandbox) ejecutado a través del terminal tool retorna error de "path fuera del sandbox" en lugar de ejecutarse.
- [ ] Un POST al webhook de WhatsApp sin `x-hub-signature-256` válido retorna 401. Un POST con firma válida es procesado normalmente.
- [ ] Más de 100 requests por minuto al webhook desde la misma IP retornan 429.
- [ ] Un número de WhatsApp no incluido en `WHATSAPP_ALLOWED_NUMBERS` no desencadena `runAgent()`.
- [ ] Después de 501 interacciones del mismo usuario, `getAllEmbeddings` retorna máximo 500 registros. La base de datos SQLite no tiene más de 500 registros por usuario en `memory_embeddings`.
- [ ] Matar el proceso durante `textToSpeech()` o `sendVoice()` en daily digest no deja archivos `.mp3` huérfanos en `/tmp`.
- [ ] `docs/FIREBASE_SETUP.md` existe con los índices documentados y el comando `firebase deploy`.
- [ ] `docker build` completa sin copiar `service-account.json` ni `client_secret.json` en la imagen. `docker run` con bind mount de credenciales funciona correctamente.
