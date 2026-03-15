---
change: opengravity-security-scalability
phase: spec
date: 2026-03-15
---

# Specs: OpenGravity Security & Scalability Refactor

---

## ITEM-01: Rotar `.env.example`

### Descripción

El archivo `.env.example` actualmente contiene valores reales de producción commiteados en el working tree de git (`TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `ELEVENLABS_API_KEY`, entre otros). El sistema DEBE reemplazar todos esos valores por placeholders descriptivos. El archivo `.env` DEBE estar cubierto por `.gitignore`. Las claves expuestas DEBEN ser revocadas externamente.

### Requirement: Placeholders en .env.example

El archivo `.env.example` MUST contener únicamente placeholders descriptivos (ej: `your-telegram-bot-token`) en lugar de valores reales para todas las variables sensibles.

#### Scenario 1: Verificación de placeholders post-rotación

- GIVEN el archivo `.env.example` fue editado con valores placeholder
- WHEN se inspecciona cada línea del archivo
- THEN ninguna línea contiene un token, API key, o secret real — todos los valores son strings descriptivos que empiezan por `your-` o tienen formato `<descripcion>`
- AND el archivo puede ser commiteado sin riesgo de exponer credenciales

#### Scenario 2: `.env` está cubierto por `.gitignore`

- GIVEN el archivo `.gitignore` del repositorio
- WHEN se verifica la lista de patrones ignorados
- THEN el patrón `.env` (o `.env*`) está presente en el archivo
- AND `git status` no muestra `.env` como untracked ni staged

#### Scenario 3: Claves previamente expuestas son inoperativas

- GIVEN las claves `TELEGRAM_BOT_TOKEN=8383891169:AAE...`, `GEMINI_API_KEY=AIzaSyAU...`, `OPENROUTER_API_KEY=sk-or-v1-ccb...`, `ELEVENLABS_API_KEY=sk_98c6...` estaban commiteadas
- WHEN se intenta usar esas claves exactas contra sus respectivas APIs
- THEN las APIs responden con error de autenticación (401/403) o "invalid key"
- AND las nuevas claves funcionales existen solo en `.env` local de producción, nunca en el repo

### Criterios de aceptación

- [ ] `git show HEAD:.env.example` (o el estado actual del archivo) no contiene ningún valor que coincida con el patrón de las claves conocidas expuestas
- [ ] `git grep -r "AIzaSy\|sk-or-v1\|8383891169\|sk_98c6"` no retorna ningún resultado en el working tree
- [ ] `.gitignore` incluye cobertura para `.env`
- [ ] El commit que cierra este ítem incluye en el mensaje de commit una referencia a que las claves fueron revocadas

### Casos de borde

- **Variable sin valor (vacía)**: Una variable como `WHATSAPP_ACCESS_TOKEN=""` es aceptable en `.env.example` siempre que no sea un valor real — una cadena vacía es un placeholder válido para variables opcionales
- **Variables no sensibles**: Variables como `WEBHOOK_PORT=3000`, `OPENROUTER_MODEL="openrouter/free"`, `FIREBASE_PROJECT_ID="opengravity63"` son valores de configuración no secretos — pueden mantenerse como valores reales en `.env.example` ya que no son credenciales
- **Historial de git**: Las claves siguen existiendo en el commit `12f64cf`. Revocar las claves mitiga el riesgo aunque el historial no se reescriba. Este spec NO requiere reescribir historial (operación destructiva con alto riesgo en repos compartidos)
- **`WHATSAPP_VERIFY_TOKEN`**: Actualmente hardcodeado en el código fuente como default (`'opengravity_webhook_2026'`). Este spec MUST reemplazarlo por placeholder en `.env.example` pero la centralización del default queda en Wave 2

---

## ITEM-02: LLM Timeouts

### Descripción

Las tres funciones de completion — `geminiCompletion`, `groqCompletion`, `openRouterCompletion` — realizan llamadas a APIs externas sin ningún mecanismo de timeout. Una llamada colgada bloquea el loop del agente indefinidamente. El sistema MUST agregar `AbortSignal.timeout(ms)` con valor configurable via `LLM_TIMEOUT_MS` (default: `30000`). El `AbortError`/`TimeoutError` MUST ser detectado en el catch de `pRetry` y relanzado como `pRetry.AbortError` para detener reintentos.

### Requirement: Timeout aplicado a los tres providers

Cada función de completion MUST aceptar y pasar un `AbortSignal` a la llamada de red subyacente. El timeout MUST dispararse a los `LLM_TIMEOUT_MS` milisegundos desde el inicio de la llamada.

#### Scenario 1: Gemini responde dentro del timeout

- GIVEN `LLM_TIMEOUT_MS=30000` y el cliente Gemini está configurado
- WHEN `geminiCompletion()` llama a `generateContent()` y la API responde en 5 segundos
- THEN la función retorna el resultado normalmente
- AND el AbortSignal no fue disparado

#### Scenario 2: Gemini excede el timeout

- GIVEN `LLM_TIMEOUT_MS=5000` y el endpoint de Gemini no responde (fake/lento)
- WHEN `geminiCompletion()` llama a `generateContent()` y la API no responde en 5 segundos
- THEN el AbortSignal dispara y la llamada es abortada
- AND se lanza un error cuyo `name` es `'AbortError'` o `'TimeoutError'`

#### Scenario 3: AbortError no es reintentado por pRetry

- GIVEN `pRetry` está configurado con `{ retries: 2 }` en `getCompletion()`
- WHEN `geminiCompletion()` lanza un `AbortError` (timeout expirado)
- THEN el catch dentro del pRetry callback detecta `error.name === 'AbortError' || error.name === 'TimeoutError'`
- AND relanza el error wrapeado en `new pRetry.AbortError(error.message)`
- AND `pRetry` NO ejecuta más reintentos — propaga el error inmediatamente

#### Scenario 4: Error de red normal sí es reintentado

- GIVEN `pRetry` está configurado con `{ retries: 2 }` en `getCompletion()`
- WHEN Gemini lanza un error de red (ej: `ECONNRESET`, `500 Internal Server Error`)
- THEN ese error NO es un `AbortError`
- AND `pRetry` ejecuta hasta 2 reintentos antes de propagar

#### Scenario 5: Groq respeta el timeout

- GIVEN `LLM_TIMEOUT_MS=5000` y el groq SDK acepta `signal` como opción
- WHEN `groqCompletion()` llama a `chat.completions.create()` con un endpoint que no responde
- THEN la llamada es abortada a los 5 segundos
- AND se lanza un error con `name === 'AbortError'` o `'TimeoutError'`

#### Scenario 6: OpenRouter respeta el timeout

- GIVEN `LLM_TIMEOUT_MS=5000` y el openai-compatible SDK acepta `signal`
- WHEN `openRouterCompletion()` llama a `chat.completions.create()` con endpoint lento
- THEN la llamada es abortada a los 5 segundos
- AND se lanza un error con `name === 'AbortError'` o `'TimeoutError'`

#### Scenario 7: Timeout durante retry legítimo

- GIVEN `pRetry` está en su segundo intento (primer intento falló con error de red)
- WHEN el segundo intento a Groq excede `LLM_TIMEOUT_MS`
- THEN el AbortSignal del segundo intento dispara independientemente del primero
- AND `pRetry` detecta el `AbortError` y detiene los reintentos inmediatamente
- AND el error propagado tiene `name === 'AbortError'`

#### Scenario 8: `LLM_TIMEOUT_MS` no configurada — usa default

- GIVEN la variable de entorno `LLM_TIMEOUT_MS` no está definida
- WHEN `getCompletion()` es invocado
- THEN el timeout aplicado a cada provider es de 30000ms (30 segundos)

### Criterios de aceptación

- [ ] Una llamada a un endpoint que nunca responde no dura más de `LLM_TIMEOUT_MS + 500ms` (margen de scheduling)
- [ ] `pRetry` no ejecuta reintentos cuando el error es `AbortError` o `TimeoutError`
- [ ] `pRetry` sí ejecuta reintentos para errores de red que no sean abort
- [ ] `LLM_TIMEOUT_MS` está documentada en `.env.example` con valor default `30000`

### Casos de borde

- **AbortError vs TimeoutError**: `AbortSignal.timeout()` en Node.js 22 lanza `TimeoutError` (subclase de `DOMException` con `name === 'TimeoutError'`), no `AbortError`. El handler MUST verificar ambos nombres: `error.name === 'AbortError' || error.name === 'TimeoutError'`
- **SDK que no acepta `signal`**: Si alguna versión del SDK de Gemini no acepta `signal` directamente en la llamada, se debe usar `Promise.race([apiCall, new Promise((_, rej) => setTimeout(() => rej(new DOMException('timeout', 'TimeoutError')), ms))])` como alternativa equivalente
- **Timeout = 0**: Si `LLM_TIMEOUT_MS=0`, el comportamiento es indefinido — la implementación SHOULD tratar 0 como "usar default" o documentar que 0 deshabilita el timeout explícitamente
- **Llamada ya completada antes del abort**: Si la API responde justo cuando el timer dispara (race condition), el resultado exitoso prevalece — `AbortSignal.timeout` no cancela promesas ya resueltas

---

## ITEM-03: Terminal Sandbox

### Descripción

La terminal tool actualmente permite ejecutar `cat`, `type`, `head`, `tail` sobre cualquier path del sistema de archivos sin restricción. Un LLM podría leer `/etc/passwd`, `~/.ssh/id_rsa`, o archivos de configuración fuera del directorio de trabajo. El sistema MUST validar el path resuelto contra `TERMINAL_SANDBOX_DIR` antes de ejecutar cualquier comando de lectura de archivos.

### Requirement: Validación de path contra sandbox

Los comandos `cat`, `type`, `head`, `tail` MUST validar que el path del archivo argumento, resuelto con `path.resolve()`, comienza con el path absoluto del sandbox. Si no cumple, la ejecución MUST ser rechazada con un error descriptivo. Ningún otro comando de la allowlist requiere validación de path.

#### Scenario 1: Lectura de archivo dentro del sandbox (happy path)

- GIVEN `TERMINAL_SANDBOX_DIR=/app/workspace` y el directorio existe
- WHEN el LLM invoca `run_terminal_command` con `command: "cat workspace/report.txt"`
- THEN `path.resolve('/app/workspace', 'workspace/report.txt')` se resuelve dentro del sandbox
- AND el comando se ejecuta normalmente y retorna el contenido del archivo

#### Scenario 2: Path traversal con `../`

- GIVEN `TERMINAL_SANDBOX_DIR=/app/workspace`
- WHEN el LLM invoca `run_terminal_command` con `command: "cat ../../../etc/passwd"`
- THEN `path.resolve('/app/workspace', '../../../etc/passwd')` resuelve a `/etc/passwd`
- AND `/etc/passwd` no comienza con `/app/workspace`
- AND la ejecución es rechazada con error: "Path fuera del sandbox permitido"
- AND el archivo `/etc/passwd` NO es leído

#### Scenario 3: Path absoluto fuera del sandbox

- GIVEN `TERMINAL_SANDBOX_DIR=/app/workspace`
- WHEN el LLM invoca `run_terminal_command` con `command: "cat /etc/passwd"`
- THEN `path.resolve('/etc/passwd')` retorna `/etc/passwd`
- AND `/etc/passwd` no comienza con `/app/workspace`
- AND la ejecución es rechazada con error descriptivo

#### Scenario 4: Path traversal URL-encoded (`%2e%2e`)

- GIVEN `TERMINAL_SANDBOX_DIR=/app/workspace`
- WHEN el LLM invoca `run_terminal_command` con `command: "cat %2e%2e%2fetc%2fpasswd"`
- THEN el path es pasado tal cual al shell — el shell puede o no decodificarlo
- AND la implementación MUST pasar el argumento por `path.resolve()` antes de validar, lo que normaliza el path
- AND si `path.resolve()` no decodifica URL encoding, el path no resolverá a un path válido fuera del sandbox — la validación `.startsWith()` igualmente lo bloqueará porque el path resuelto no comenzará con el sandbox dir

#### Scenario 5: Path traversal con encoding doble o mixto

- GIVEN `TERMINAL_SANDBOX_DIR=/app/workspace`
- WHEN el LLM invoca `run_terminal_command` con `command: "cat ....//....//etc/passwd"`
- THEN `path.resolve()` normaliza los `..` y `/` redundantes
- AND el path resuelto no comienza con el sandbox dir
- AND la ejecución es rechazada

#### Scenario 6: Path absoluto dentro del sandbox

- GIVEN `TERMINAL_SANDBOX_DIR=/app/workspace`
- WHEN el LLM invoca `run_terminal_command` con `command: "cat /app/workspace/data.json"`
- THEN `path.resolve('/app/workspace/data.json')` retorna `/app/workspace/data.json`
- AND `/app/workspace/data.json` comienza con `/app/workspace`
- AND el comando se ejecuta normalmente

#### Scenario 7: Directorio sandbox creado en bootstrap si no existe

- GIVEN `TERMINAL_SANDBOX_DIR=/app/workspace` y el directorio `/app/workspace` no existe
- WHEN la aplicación arranca (bootstrap/init)
- THEN el sistema crea el directorio `workspace/` automáticamente
- AND no se lanza ningún error de arranque

#### Scenario 8: Comando no-file de la allowlist no es afectado

- GIVEN `TERMINAL_SANDBOX_DIR=/app/workspace`
- WHEN el LLM invoca `run_terminal_command` con `command: "ls"` o `"ipconfig"` o `"ping 8.8.8.8"`
- THEN la validación de sandbox NO se aplica (estos comandos no leen paths arbitrarios)
- AND el comando se ejecuta normalmente

#### Scenario 9: `TERMINAL_SANDBOX_DIR` no configurada — usa default

- GIVEN la variable `TERMINAL_SANDBOX_DIR` no está definida en el entorno
- WHEN el sistema valida un path de comando de lectura
- THEN el sandbox efectivo es `path.resolve(process.cwd(), 'workspace')`
- AND la validación procede contra ese path default

#### Scenario 10: Path que es prefijo del sandbox dir (bypass attempt)

- GIVEN `TERMINAL_SANDBOX_DIR=/app/workspace`
- WHEN el LLM invoca con path que resuelve a `/app/workspaceMalicious/secret.txt`
- THEN `/app/workspaceMalicious/secret.txt`.startsWith(`/app/workspace`) es `true` en naive check
- AND la implementación MUST usar `path.resolve(sandboxDir) + path.sep` como prefijo (con trailing separator) para evitar este bypass
- AND la ejecución es rechazada

### Criterios de aceptación

- [ ] `cat /etc/passwd` (o su equivalente Windows `type C:\Windows\System32\drivers\etc\hosts`) ejecutado a través de la terminal tool retorna error de sandbox, no el contenido del archivo
- [ ] `cat ../../../etc/passwd` retorna error de sandbox
- [ ] `cat workspace/cualquier-archivo.txt` retorna el contenido si el archivo existe
- [ ] El directorio `workspace/` es creado en bootstrap si no existe
- [ ] `TERMINAL_SANDBOX_DIR` está documentada en `.env.example`

### Casos de borde

- **Symlinks**: `path.resolve()` en Node.js NO sigue symlinks — `fs.realpathSync()` sí lo hace. Si un symlink dentro del sandbox apunta fuera, `path.resolve()` no lo detectará. Este edge case está explícitamente fuera del scope de Wave 1 (documentado en propuesta como "parcialmente" cubierto)
- **Windows vs Unix paths**: En Windows, `path.resolve()` retorna paths con `C:\` — la validación `.startsWith()` debe usar `path.sep` correcto. En Windows el separator es `\`, no `/`
- **Comando `type` en Windows**: `type` en Windows acepta paths — la validación aplica igual que para `cat` en Unix
- **Argumento con espacios**: `cat "my file.txt"` — el parser de argumento del comando debe extraer correctamente el filename incluyendo comillas y espacios antes de pasarlo a `path.resolve()`

---

## ITEM-04: WhatsApp HMAC Validation

### Descripción

El endpoint `POST /webhook` no valida la autenticidad de las requests entrantes. Cualquier actor puede enviar payloads arbitrarios al endpoint. El sistema MUST validar el header `x-hub-signature-256` usando HMAC-SHA256 sobre el raw body con `WHATSAPP_APP_SECRET`. La comparación MUST usar `crypto.timingSafeEqual()`. El middleware `express.raw()` MUST capturar el body sin parsear exclusivamente para esta ruta.

### Requirement: Validación HMAC en POST /webhook

Cada request a `POST /webhook` MUST ser autenticada verificando que `x-hub-signature-256` corresponde al HMAC-SHA256 del body raw firmado con `WHATSAPP_APP_SECRET`. Requests sin firma válida MUST ser rechazadas con HTTP 401.

#### Scenario 1: Request legítima con firma válida (happy path)

- GIVEN `WHATSAPP_APP_SECRET=mysecret` configurado
- AND Meta envía un POST con body `{"object":"whatsapp_business_account",...}`
- AND el header `x-hub-signature-256: sha256=<hmac_correcto>` está presente
- WHEN el middleware de validación procesa la request
- THEN `crypto.timingSafeEqual(expectedHmac, receivedHmac)` retorna `true`
- AND la request continúa al handler de mensajes
- AND se responde 200

#### Scenario 2: Header `x-hub-signature-256` ausente

- GIVEN `WHATSAPP_APP_SECRET=mysecret` configurado
- AND se recibe un POST sin el header `x-hub-signature-256`
- WHEN el middleware de validación procesa la request
- THEN el header no existe en `req.headers`
- AND la request es rechazada con HTTP 401
- AND se loguea un warning: "Missing x-hub-signature-256 header"
- AND el handler de mensajes nunca es invocado

#### Scenario 3: Firma inválida (body tampered)

- GIVEN `WHATSAPP_APP_SECRET=mysecret` configurado
- AND se recibe un POST con `x-hub-signature-256: sha256=<hmac_de_body_diferente>`
- AND el body actual fue modificado en tránsito
- WHEN el middleware recomputa el HMAC del body recibido
- THEN el HMAC calculado NO coincide con el header
- AND `crypto.timingSafeEqual()` retorna `false`
- AND la request es rechazada con HTTP 401

#### Scenario 4: Header con prefijo `sha256=` ausente o malformado

- GIVEN `WHATSAPP_APP_SECRET=mysecret` configurado
- AND se recibe un POST con header `x-hub-signature-256: invalidhex` (sin prefijo `sha256=`)
- WHEN el middleware intenta parsear la firma
- THEN el parse falla al intentar extraer el hex digest
- AND la request es rechazada con HTTP 401

#### Scenario 5: `WHATSAPP_APP_SECRET` no configurada

- GIVEN la variable `WHATSAPP_APP_SECRET` NO está definida en el entorno
- WHEN se recibe cualquier POST al webhook (con o sin firma)
- THEN el sistema rechaza la request con HTTP 401
- AND se loguea un error: "WHATSAPP_APP_SECRET not configured — rejecting all webhook requests"
- AND ningún mensaje es procesado

#### Scenario 6: Timing attack prevention

- GIVEN `WHATSAPP_APP_SECRET=mysecret` configurado
- AND dos requests: una con firma correcta y otra con firma incorrecta de un byte
- WHEN el middleware compara las firmas
- THEN AMBAS comparaciones usan `crypto.timingSafeEqual()` — nunca comparación con `===`
- AND el tiempo de respuesta NO varía en función de cuántos bytes de la firma son correctos

#### Scenario 7: Body raw vs body parseado — compatibilidad con express.json()

- GIVEN `express.json()` está configurado como middleware global
- AND el middleware `express.raw({ type: '*/*' })` está configurado exclusivamente para `POST /webhook`
- WHEN llega un POST al webhook
- THEN `req.body` en el handler es un `Buffer` (body sin parsear)
- AND la validación HMAC usa ese `Buffer` directamente
- AND el handler parsea manualmente con `JSON.parse(req.body.toString())` para procesar el payload
- AND otras rutas siguen recibiendo `req.body` como objeto JSON (el middleware global no se rompe)

#### Scenario 8: Body vacío

- GIVEN `WHATSAPP_APP_SECRET=mysecret` configurado
- AND se recibe un POST con body vacío y un header de firma (HMAC de string vacío)
- WHEN el middleware calcula el HMAC del body vacío
- THEN el cálculo no falla (HMAC de string vacío es un valor válido)
- AND si la firma coincide, la request pasa al handler
- AND el handler procesa el payload vacío gracefully (sin mensajes que procesar)

### Criterios de aceptación

- [ ] Un POST sin header `x-hub-signature-256` retorna 401
- [ ] Un POST con header correcto retorna 200 y procesa el mensaje
- [ ] Un POST con body modificado (firma no coincide) retorna 401
- [ ] Si `WHATSAPP_APP_SECRET` no está configurada, todos los POSTs retornan 401 con log de error
- [ ] El código fuente usa `crypto.timingSafeEqual()` — no `===` para comparar firmas
- [ ] `WHATSAPP_APP_SECRET` está documentada en `.env.example` como requerida

### Casos de borde

- **Buffer encoding en timingSafeEqual**: `crypto.timingSafeEqual()` requiere que ambos buffers tengan el mismo `byteLength`. Si el header contiene una firma de longitud diferente al HMAC esperado (64 hex chars = 32 bytes), la comparación debe hacerse en hex string convertida a Buffer, o se debe retornar 401 antes de llamar a `timingSafeEqual` si las longitudes difieren
- **Header case sensitivity**: HTTP headers son case-insensitive. `req.headers['x-hub-signature-256']` en Express siempre retorna el header en lowercase — no hay riesgo de case mismatch en el acceso, pero la verificación debe ser robusta
- **Body excesivamente grande**: Un atacante podría enviar un body de varios GB para consumir memoria. Esto queda fuera del scope de este item (el rate limiter de ITEM-05 mitiga parcialmente)
- **Meta envía múltiples entries en un batch**: El body puede contener múltiples entradas. La validación HMAC se hace sobre el body completo, no entrada por entrada — esto es correcto según la spec de Meta

---

## ITEM-05: WhatsApp Rate Limiting

### Descripción

El endpoint `POST /webhook` no tiene rate limiting. Un atacante puede enviar miles de requests por segundo, consumiendo recursos del servidor y del agente. El sistema MUST aplicar rate limiting de 100 requests por minuto por IP usando `express-rate-limit`. El rate limiting MUST ser exclusivo para `POST /webhook`. Al superar el límite se responde 429 con header `Retry-After`.

### Requirement: Rate limit en POST /webhook

El sistema MUST limitar a 100 requests por minuto por IP. El store es in-memory (sin persistencia entre reinicios). Los contadores MUST resetearse automáticamente después de 1 minuto.

#### Scenario 1: IP dentro del límite (happy path)

- GIVEN rate limit de 100 requests/minuto configurado para `POST /webhook`
- WHEN una IP envía 50 POSTs en 30 segundos
- THEN todos los requests son procesados normalmente
- AND ninguno recibe respuesta 429

#### Scenario 2: IP supera el límite

- GIVEN rate limit de 100 requests/minuto
- WHEN una IP envía el request número 101 dentro de la ventana de 1 minuto
- THEN el servidor responde HTTP 429
- AND la respuesta incluye el header `Retry-After` con el número de segundos hasta que la ventana se resetea
- AND los requests 1-100 fueron procesados normalmente

#### Scenario 3: Rate limit aplica solo a POST /webhook

- GIVEN rate limit de 100 requests/minuto configurado
- WHEN una IP envía 200 GETs a `/webhook` (verificación de Meta) en 1 minuto
- THEN ningún GET recibe respuesta 429 — el rate limiter no aplica a GET
- WHEN la misma IP envía GET a `/health`
- THEN tampoco recibe 429

#### Scenario 4: Ventana deslizante se resetea

- GIVEN una IP usó 100 requests en el minuto M
- WHEN comienza el minuto M+1
- THEN el contador se resetea a 0
- AND la IP puede volver a enviar hasta 100 requests

#### Scenario 5: Rate limit por IP — IPs diferentes no comparten límite

- GIVEN rate limit de 100 requests/minuto
- WHEN IP-A envía 100 requests (en el límite)
- AND IP-B envía 50 requests simultáneamente
- THEN IP-A está en el límite pero no bloqueada (el request 100 pasa)
- AND IP-B está al 50% del límite — continúa sin problemas
- AND el límite de IP-A no afecta a IP-B

#### Scenario 6: Reset del servidor limpia el store in-memory

- GIVEN una IP usó 80 requests en la ventana actual
- WHEN el proceso de Node.js se reinicia
- THEN el store in-memory es destruido
- AND el contador de esa IP vuelve a 0 después del reinicio

### Criterios de aceptación

- [ ] El request 101 en un mismo minuto desde la misma IP recibe HTTP 429
- [ ] La respuesta 429 incluye el header `Retry-After`
- [ ] El rate limiter usa `express-rate-limit` (documentado en `package.json`)
- [ ] El rate limiter está aplicado exclusivamente a la ruta `POST /webhook`, no a GET ni a `/health`

### Casos de borde

- **IP detrás de proxy/load balancer**: Si hay un proxy, `req.ip` puede ser la IP del proxy, no del cliente real. `express-rate-limit` con `trustProxy: true` usa `X-Forwarded-For`. Este scope no requiere configuración de proxy — se documenta como limitación conocida
- **IPv6 vs IPv4**: Un cliente puede conectarse tanto por IPv4 (`127.0.0.1`) como IPv6 (`::1`) — se tratan como IPs diferentes. No es un riesgo real en este contexto
- **Meta reintenta requests**: Meta reintenta requests que reciben 429. Si el límite es demasiado estricto, Meta puede quedar bloqueada. El límite de 100/min es ampliamente superior al rate de mensajes legítimos de un bot personal

---

## ITEM-06: WhatsApp User Whitelist

### Descripción

El handler de WhatsApp procesa mensajes de cualquier número sin restricción. Cualquier persona que conozca el número del webhook puede interactuar con el agente. El sistema MUST aplicar una whitelist de números autorizados via `WHATSAPP_ALLOWED_NUMBERS`. Si no está configurada, MUST rechazar todos los mensajes. Si está configurada, MUST procesar solo mensajes de números en la lista.

### Requirement: Whitelist de números de WhatsApp

El sistema MUST verificar que el número de teléfono (`from`) del mensaje entrante está en `WHATSAPP_ALLOWED_NUMBERS` antes de invocar `runAgent()`. Los mensajes de números no autorizados MUST ser ignorados silenciosamente (sin respuesta al remitente, con log de warning).

#### Scenario 1: Número autorizado en whitelist (happy path)

- GIVEN `WHATSAPP_ALLOWED_NUMBERS=5491112345678,5491187654321`
- WHEN llega un mensaje de `from: "5491112345678"`
- THEN el número está en la whitelist
- AND `runAgent()` es invocado con el userId `wa_5491112345678`
- AND el agente responde normalmente

#### Scenario 2: Número no autorizado — ignorado

- GIVEN `WHATSAPP_ALLOWED_NUMBERS=5491112345678`
- WHEN llega un mensaje de `from: "5499999999999"`
- THEN el número NO está en la whitelist
- AND `runAgent()` NO es invocado
- AND NO se envía ninguna respuesta al remitente (no se delata que el bot existe)
- AND se loguea un warning: "Unauthorized WhatsApp sender: 5499999999999"

#### Scenario 3: `WHATSAPP_ALLOWED_NUMBERS` no configurada — rechaza todo

- GIVEN la variable `WHATSAPP_ALLOWED_NUMBERS` no está definida
- AND `TELEGRAM_ALLOWED_USER_IDS` tampoco aplica a WhatsApp en esta implementación
- WHEN llega cualquier mensaje de WhatsApp
- THEN el mensaje es ignorado
- AND se loguea un warning: "WHATSAPP_ALLOWED_NUMBERS not configured — all WhatsApp messages rejected"

#### Scenario 4: Whitelist con espacios alrededor de los números

- GIVEN `WHATSAPP_ALLOWED_NUMBERS=" 5491112345678 , 5491187654321 "` (con espacios)
- WHEN llega un mensaje de `from: "5491112345678"`
- THEN el parser de la variable hace trim de cada número
- AND el número es reconocido como autorizado
- AND `runAgent()` es invocado

#### Scenario 5: Número en whitelist con prefijo de país diferente

- GIVEN `WHATSAPP_ALLOWED_NUMBERS=5491112345678`
- WHEN llega un mensaje de `from: "541112345678"` (sin el `9` de Argentina)
- THEN el número NO coincide exactamente con el de la whitelist
- AND el mensaje es rechazado con log de warning

### Criterios de aceptación

- [ ] Un número no incluido en `WHATSAPP_ALLOWED_NUMBERS` no desencadena `runAgent()`
- [ ] Si `WHATSAPP_ALLOWED_NUMBERS` no está configurada, todos los mensajes son rechazados con log de warning
- [ ] La variable está documentada en `.env.example`
- [ ] La comparación es por igualdad exacta de string (no regex, no partial match)

### Casos de borde

- **Lista con un solo número sin coma**: `WHATSAPP_ALLOWED_NUMBERS=5491112345678` — el split por coma retorna un array de un elemento, debe funcionar correctamente
- **Lista vacía**: `WHATSAPP_ALLOWED_NUMBERS=""` — equivalente a no configurada, todos los mensajes son rechazados
- **Número `0` o string no-numérico en lista**: El sistema no valida el formato de los números en la whitelist — la comparación es por igualdad de string, por lo que un número inválido en la whitelist simplemente nunca matchea

---

## ITEM-07: Bounded Semantic Memory

### Descripción

La función `saveEmbedding()` inserta registros en `memory_embeddings` sin límite. `getAllEmbeddings()` retorna todos los registros sin LIMIT. Con el tiempo el costo de búsqueda semántica crece O(n). El sistema MUST limitar el total de embeddings por usuario a `MEMORY_MAX_EMBEDDINGS` (default: 500), preservando los más recientes. El cleanup MUST ocurrir inline en `saveEmbedding()` después de insertar.

### Requirement: Límite de embeddings por usuario

El sistema MUST mantener como máximo `MEMORY_MAX_EMBEDDINGS` registros por usuario en la tabla `memory_embeddings`. Al superar el límite, los registros más antiguos MUST ser eliminados automáticamente. `getAllEmbeddings()` MUST retornar como máximo `MEMORY_MAX_EMBEDDINGS` registros, ordenados por `timestamp DESC`.

#### Scenario 1: Guardar embedding cuando hay espacio disponible (happy path)

- GIVEN usuario `u1` tiene 50 embeddings y `MEMORY_MAX_EMBEDDINGS=500`
- WHEN `saveEmbedding('u1', content, vector)` es invocado
- THEN el nuevo registro es insertado
- AND la query de cleanup DELETE se ejecuta pero no borra nada (hay 51 ≤ 500)
- AND `getAllEmbeddings('u1')` retorna 51 registros

#### Scenario 2: Guardar el embedding N+1 (límite exacto)

- GIVEN usuario `u1` tiene exactamente 500 embeddings y `MEMORY_MAX_EMBEDDINGS=500`
- WHEN `saveEmbedding('u1', content, vector)` es invocado
- THEN el nuevo registro es insertado (ahora hay 501)
- AND la query de cleanup elimina el registro más antiguo de `u1`
- AND el total de embeddings de `u1` vuelve a ser exactamente 500
- AND `getAllEmbeddings('u1')` retorna exactamente 500 registros

#### Scenario 3: Insert simultáneo de dos embeddings (concurrencia)

- GIVEN usuario `u1` tiene 499 embeddings y `MEMORY_MAX_EMBEDDINGS=500`
- WHEN dos llamadas a `saveEmbedding('u1', ...)` se ejecutan concurrentemente (race condition en SQLite)
- THEN ambos registros son insertados (SQLite serializa writes)
- AND el total llega a 501
- AND la query de cleanup en cada call elimina los excedentes
- AND el resultado final es ≤ 500 registros para `u1`
- AND no hay corrupción de datos ni deadlock (SQLite WAL mode serializa las escrituras)

#### Scenario 4: Cleanup NO afecta embeddings de otro usuario

- GIVEN usuario `u1` tiene 500 embeddings y usuario `u2` tiene 300 embeddings
- WHEN `saveEmbedding('u1', content, vector)` dispara el cleanup
- THEN ONLY los embeddings de `u1` son considerados para eliminación
- AND los 300 embeddings de `u2` no son tocados

#### Scenario 5: getAllEmbeddings respeta el límite

- GIVEN usuario `u1` tiene 600 embeddings en la DB (estado pre-migración o bug)
- WHEN `getAllEmbeddings('u1')` es invocado
- THEN la query SQLite tiene `ORDER BY timestamp DESC LIMIT 500`
- AND retorna exactamente 500 registros (los más recientes)
- AND no retorna los 100 más antiguos

#### Scenario 6: `MEMORY_MAX_EMBEDDINGS` no configurada — usa default

- GIVEN la variable `MEMORY_MAX_EMBEDDINGS` no está definida en el entorno
- WHEN se insertan embeddings
- THEN el límite efectivo es 500
- AND el comportamiento es idéntico al Scenario 2 con N=500

#### Scenario 7: Cleanup con exactamente N+1 embeddings después del insert

- GIVEN `MEMORY_MAX_EMBEDDINGS=500` y usuario `u1` tiene 500 registros
- WHEN se inserta el embedding 501
- THEN la query DELETE es: `DELETE FROM memory_embeddings WHERE user_id = ? AND id NOT IN (SELECT id FROM memory_embeddings WHERE user_id = ? ORDER BY timestamp DESC LIMIT 500)`
- AND exactamente 1 registro es eliminado (el más antiguo)
- AND el total queda en 500

### Criterios de aceptación

- [ ] Después de 501 inserciones del mismo usuario, `getAllEmbeddings` retorna máximo 500 registros
- [ ] La DB SQLite no contiene más de `MEMORY_MAX_EMBEDDINGS` registros por usuario en `memory_embeddings`
- [ ] Los registros retenidos son los más recientes (por `timestamp DESC`)
- [ ] El cleanup aplica solo al usuario que insertó, no a otros usuarios
- [ ] `MEMORY_MAX_EMBEDDINGS` está documentada en `.env.example`

### Casos de borde

- **`MEMORY_MAX_EMBEDDINGS=1`**: Caso extremo válido — cada nuevo insert reemplaza al anterior para ese usuario. La query de cleanup elimina todo excepto el más reciente
- **Usuario con 0 embeddings**: El insert crea el primer registro, el cleanup no elimina nada (1 ≤ límite)
- **Timestamp tie (mismo segundo)**: Si dos embeddings tienen el mismo `timestamp`, el orden entre ellos es indeterminado. La política de retención usa `id DESC` como tiebreaker implícito si `timestamp` es idéntico (SQLite retorna en orden de inserción para valores iguales de ORDER BY)
- **`NOT IN` con subquery grande**: Para valores de `MEMORY_MAX_EMBEDDINGS` muy altos (ej: 10000), la subquery `NOT IN (SELECT ... LIMIT 10000)` puede ser lenta. Para Wave 1 con 500 como default esto no es un problema de performance

---

## ITEM-08: Daily Digest Temp File Cleanup

### Descripción

En `daily_digest.ts`, `fs.unlinkSync(audioPath)` está dentro del bloque `try` principal. Si `bot.api.sendVoice()` lanza una excepción, el bloque `catch` es ejecutado y el cleanup nunca ocurre, dejando archivos `.mp3` huérfanos en `/tmp`. El sistema MUST mover el cleanup a un bloque `finally` garantizado.

### Requirement: Cleanup garantizado de archivo de audio temporal

El archivo de audio generado por `textToSpeech()` MUST ser eliminado en todos los casos (éxito, error de send, error de Telegram) usando un bloque `finally`.

#### Scenario 1: Daily digest completa exitosamente (happy path)

- GIVEN `textToSpeech()` genera `/tmp/tts_1234567890.mp3`
- AND `bot.api.sendVoice()` envía el audio exitosamente a todos los usuarios
- WHEN el bloque `finally` es ejecutado
- THEN `fs.existsSync(audioPath)` retorna `true`
- AND `fs.unlinkSync(audioPath)` elimina el archivo
- AND `/tmp/tts_1234567890.mp3` no existe después de la ejecución

#### Scenario 2: Error durante sendVoice — cleanup igual ocurre

- GIVEN `textToSpeech()` genera `/tmp/tts_1234567890.mp3`
- AND `bot.api.sendVoice()` lanza una excepción (ej: timeout de Telegram, 403 del bot)
- WHEN la excepción es capturada y el bloque `finally` es ejecutado
- THEN `fs.unlinkSync(audioPath)` es llamado igualmente
- AND `/tmp/tts_1234567890.mp3` no existe después de la ejecución

#### Scenario 3: Error durante textToSpeech — no hay archivo que limpiar

- GIVEN `textToSpeech()` lanza una excepción antes de crear el archivo
- AND `audioPath` sigue siendo `null` (declarado como `let audioPath: string | null = null` antes del try)
- WHEN el bloque `finally` es ejecutado
- THEN `if (audioPath !== null)` es `false`
- AND `fs.unlinkSync` NO es llamado
- AND no se lanza `TypeError: argument must be a string` por intentar unlink de null

#### Scenario 4: Proceso interrumpido (SIGKILL)

- GIVEN `textToSpeech()` generó el archivo pero el proceso recibe SIGKILL antes del sendVoice
- WHEN el proceso es terminado abruptamente
- THEN el bloque `finally` NO es ejecutado (SIGKILL no da oportunidad de cleanup)
- AND el archivo `/tmp/tts_1234567890.mp3` puede quedar huérfano — este es un caso aceptado (SIGKILL es force-kill)
- AND SIGTERM sí permite cleanup via finally (graceful shutdown)

#### Scenario 5: `fs.existsSync` verifica antes de unlinkSync

- GIVEN el archivo fue creado por `textToSpeech()`
- AND por alguna razón el archivo fue eliminado externamente antes del finally
- WHEN el bloque `finally` ejecuta `if (audioPath && fs.existsSync(audioPath))`
- THEN `fs.existsSync()` retorna `false`
- AND `fs.unlinkSync()` NO es llamado
- AND no se lanza `ENOENT` error

### Criterios de aceptación

- [ ] Matar el proceso con SIGTERM durante `sendVoice()` no deja archivos `.mp3` huérfanos en `/tmp`
- [ ] El patrón `let audioPath: string | null = null` antes del try + `if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath)` en finally está implementado
- [ ] La variable `audioPath` está declarada fuera del bloque try para ser accesible en finally

### Casos de borde

- **`textToSpeech()` retorna path pero el archivo no fue creado**: `fs.existsSync()` retorna false, unlinkSync no es llamado — sin error
- **Multiple sendVoice en loop**: El archivo es creado una vez, enviado a N usuarios, y eliminado una sola vez en finally — el loop de send no debe llamar a unlink individualmente

---

## ITEM-09: Firebase Index Documentation

### Descripción

Los índices compuestos de Firestore requeridos por las queries de `getHistory()` y `getPendingReminders()` no están documentados ni versionados. Las colecciones `messages` y `reminders` requieren índices que deben ser creados manualmente en la consola de Firebase o via `firestore.indexes.json`. El sistema MUST crear `docs/FIREBASE_SETUP.md` con la documentación completa.

### Requirement: Documentación de índices y setup de Firebase

El archivo `docs/FIREBASE_SETUP.md` MUST existir y contener: definición de los dos índices compuestos requeridos, el JSON de `firestore.indexes.json` listo para deployar, el comando `firebase deploy --only firestore:indexes`, las variables de entorno requeridas, y las instrucciones de setup de service account.

#### Scenario 1: Documento existe con contenido completo

- GIVEN el archivo `docs/FIREBASE_SETUP.md` ha sido creado
- WHEN un desarrollador lo lee para configurar Firebase desde cero
- THEN el documento incluye los dos índices compuestos:
  - Colección `messages`: campos `userId ASC` + `timestamp DESC`
  - Colección `reminders`: campos `sent ASC` + `remindAt ASC`
- AND el documento incluye el JSON completo de `firestore.indexes.json`
- AND el documento incluye el comando exacto `firebase deploy --only firestore:indexes`

#### Scenario 2: Índice de messages previene el error "requires an index"

- GIVEN el índice `messages(userId ASC, timestamp DESC)` fue deployado
- WHEN `getHistory(userId)` ejecuta la query con `.where().orderBy().limit()`
- THEN Firestore ejecuta la query usando el índice compuesto
- AND no se lanza el error "The query requires an index"

#### Scenario 3: Índice de reminders previene el error "requires an index"

- GIVEN el índice `reminders(sent ASC, remindAt ASC)` fue deployado
- WHEN `getPendingReminders()` ejecuta la query con `.where('sent', '==', false).where('remindAt', '<=', ...)`
- THEN Firestore ejecuta la query usando el índice compuesto
- AND no se lanza el error "The query requires an index"

#### Scenario 4: `firestore.indexes.json` es deployable directamente

- GIVEN el JSON incluido en `docs/FIREBASE_SETUP.md` es copiado a `firestore.indexes.json` en la raíz del proyecto
- WHEN se ejecuta `firebase deploy --only firestore:indexes`
- THEN el comando completa sin errores
- AND los dos índices aparecen como "READY" en la consola de Firebase

### Criterios de aceptación

- [ ] El archivo `docs/FIREBASE_SETUP.md` existe
- [ ] Contiene la definición de ambos índices compuestos
- [ ] Contiene el bloque JSON de `firestore.indexes.json`
- [ ] Contiene el comando `firebase deploy --only firestore:indexes`
- [ ] Contiene la lista de variables de entorno requeridas (`FIREBASE_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS`)
- [ ] Contiene instrucciones para obtener y configurar el service account

### Casos de borde

- **Firebase en modo local (SQLite)**: La documentación MUST clarificar que si `service-account.json` no existe, el sistema opera en modo SQLite y Firebase no es requerido — los índices son solo necesarios en modo Firebase
- **Índices ya existentes**: `firebase deploy --only firestore:indexes` con índices ya creados es idempotente — no los recrea ni borra
- **Firebase free tier**: El free tier de Firestore (Spark) no permite la misma cantidad de índices que Blaze. La documentación SHOULD mencionar que ambos índices están dentro del límite del free tier

---

## ITEM-10: Dockerfile Credentials Fix

### Descripción

El `Dockerfile` contiene `COPY service-account.json* ./` y `COPY client_secret.json* ./`. Esto copia credenciales privadas de Google dentro de la imagen Docker, donde pueden ser extraídas por cualquiera con acceso a la imagen. El sistema MUST remover esas líneas del Dockerfile y documentar las alternativas de runtime.

### Requirement: Remover credenciales del Dockerfile

Las instrucciones `COPY service-account.json*` y `COPY client_secret.json*` MUST ser removidas del Dockerfile. Los archivos MUST ser agregados a `.dockerignore`. La documentación MUST describir las alternativas de runtime para proveer las credenciales.

#### Scenario 1: Build de imagen sin credenciales embebidas

- GIVEN el Dockerfile tiene removidas las líneas de COPY de credenciales
- WHEN se ejecuta `docker build -t opengravity .`
- THEN la build completa exitosamente
- AND la imagen resultante no contiene `service-account.json` ni `client_secret.json`
- AND `docker run opengravity cat /app/service-account.json` retorna "No such file or directory"

#### Scenario 2: Runtime con bind mount (alternativa A)

- GIVEN la imagen fue buildeada sin credenciales
- AND el host tiene `service-account.json` en `/home/user/secrets/service-account.json`
- WHEN se ejecuta `docker run -v /home/user/secrets/service-account.json:/app/service-account.json:ro opengravity`
- THEN el archivo es montado como read-only dentro del contenedor
- AND `database/index.ts` encuentra `service-account.json` en `process.cwd()/service-account.json`
- AND Firebase se inicializa correctamente

#### Scenario 3: Runtime con variable de entorno GOOGLE_APPLICATION_CREDENTIALS (alternativa B)

- GIVEN la imagen fue buildeada sin credenciales
- AND el host tiene `service-account.json` en `/home/user/secrets/service-account.json`
- WHEN se ejecuta `docker run -e GOOGLE_APPLICATION_CREDENTIALS=/app/service-account.json -v /home/user/secrets/service-account.json:/app/service-account.json:ro opengravity`
- THEN `GOOGLE_APPLICATION_CREDENTIALS` apunta al path del archivo montado
- AND Firebase Admin SDK puede leer las credenciales desde esa variable de entorno

#### Scenario 4: `.dockerignore` previene COPY accidental

- GIVEN `service-account.json` y `client_secret.json` están en `.dockerignore`
- AND alguien agrega accidentalmente `COPY . .` al Dockerfile
- WHEN se ejecuta `docker build`
- THEN Docker ignora esos archivos durante el COPY
- AND las credenciales no son incluidas en la imagen incluso con `COPY . .`

#### Scenario 5: Build en CI sin credenciales presentes

- GIVEN el Dockerfile no tiene `COPY service-account.json*`
- AND en el ambiente de CI los archivos `service-account.json` y `client_secret.json` no existen
- WHEN se ejecuta `docker build`
- THEN la build completa exitosamente (ya no depende de la presencia de esos archivos)
- AND el bot arranca en modo SQLite (Firebase degraded mode) si las credenciales no son montadas

### Criterios de aceptación

- [ ] `docker build` completa sin copiar `service-account.json` ni `client_secret.json` en la imagen
- [ ] `docker run` con bind mount de credenciales funciona correctamente
- [ ] `.dockerignore` incluye `service-account.json` y `client_secret.json`
- [ ] `docs/FIREBASE_SETUP.md` (de ITEM-09) documenta ambas alternativas de runtime
- [ ] El Dockerfile resultante no contiene ninguna línea `COPY` que referencie archivos de credenciales

### Casos de borde

- **`COPY service-account.json* ./` con glob `*`**: El `*` hace que el COPY sea opcional (no falla si el archivo no existe). Al remover la línea, el comportamiento cambia: ahora el archivo simplemente no está en la imagen. El código en `database/index.ts` ya maneja `fs.existsSync(serviceAccountPath)` gracefully — retorna a modo SQLite sin error fatal
- **Múltiples service accounts**: Si en el futuro se necesitan múltiples archivos de credenciales (ej: diferentes proyectos Firebase), la solución de bind mount escala bien — múltiples `-v` flags
- **Docker Swarm / Kubernetes secrets**: El approach de bind mount es adecuado para desarrollo local. En producción con orquestadores, se SHOULD usar Docker Secrets o Kubernetes Secrets — esto queda fuera del scope de Wave 1 pero la documentación SHOULD mencionarlo
