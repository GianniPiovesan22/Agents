---
change: opengravity-security-scalability
phase: verify
date: 2026-03-15
status: PARTIAL
---

# Verify Report: OpenGravity Security & Scalability Refactor

## Summary

**PARTIAL** — 9/10 items pass static correctness. 1 item (ITEM-02: LLM Timeouts) has a CRITICAL runtime bug: `pRetry.AbortError` does not exist on the default export of `p-retry` v7. This causes both a TypeScript compile error and a runtime failure. Additionally, there are no project-level tests — all spec scenarios are UNTESTED behaviorally.

**Tasks completeness**: 24/24 tasks marked complete in apply-progress.
**Build (tsc --noEmit)**: FAIL — 4 errors.
**Tests**: No test suite exists in the project.

---

## Por item

### ITEM-01: Rotar .env.example
- **Status**: PASS
- **Evidence**: Every sensitive variable in `.env.example` uses `"your-*"` placeholders (`TELEGRAM_BOT_TOKEN="your-telegram-bot-token"`, `GEMINI_API_KEY="your-gemini-api-key"`, etc.). Non-secret values like `WEBHOOK_PORT=3000` and `OPENROUTER_MODEL="openrouter/free"` are kept as real values — correct per spec. All 5 new env vars (`LLM_TIMEOUT_MS`, `TERMINAL_SANDBOX_DIR`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ALLOWED_NUMBERS`, `MEMORY_MAX_EMBEDDINGS`) are documented with comments. `.gitignore` contains `.env` on line 8.
- **Scenarios covered**: Scenario 1 (placeholders), Scenario 2 (.env in .gitignore). Scenario 3 (key revocation) is external/operational — cannot be verified statically.
- **Issues**: None.

---

### ITEM-02: LLM Timeouts
- **Status**: FAIL
- **Evidence**:
  - `AbortSignal.timeout(config.LLM_TIMEOUT_MS)` is correctly passed to all three providers:
    - Gemini: `abortSignal: AbortSignal.timeout(config.LLM_TIMEOUT_MS)` inside `config` spread (`src/llm/index.ts` line 216)
    - Groq: `{ signal: AbortSignal.timeout(config.LLM_TIMEOUT_MS) }` as second arg (`src/llm/index.ts` line 250)
    - OpenRouter: `{ signal: AbortSignal.timeout(config.LLM_TIMEOUT_MS) }` as second arg (`src/llm/index.ts` line 295)
  - The catch blocks correctly detect `error.name === 'AbortError' || error.name === 'TimeoutError'`.
  - **CRITICAL BUG**: `new pRetry.AbortError(...)` is called on lines 322, 332, and 339 — but `pRetry` is the **default export** of `p-retry` v7 (a function), and `AbortError` is a **named export**, not a property on the default function. `pRetry.AbortError` is `undefined` at runtime. Calling `new undefined(...)` throws `TypeError: pRetry.AbortError is not a constructor`, crashing the entire `getCompletion()` call instead of stopping retries gracefully.
  - TypeScript confirms this: `tsc --noEmit` produces 3 errors: `Property 'AbortError' does not exist on type '<T>(input: ...) => Promise<T>'` (lines 322, 332, 339).
  - The fix is to import `AbortError` as a named export: `import pRetry, { AbortError } from 'p-retry'` and use `new AbortError(...)`.
- **Scenarios covered**: Scenarios 1, 5, 6 (timeout signal is set up correctly). Scenarios 3, 4, 7 (pRetry abort behavior) FAIL at runtime.
- **Issues**: **CRITICAL** — `pRetry.AbortError is not a constructor`. Build fails with 3 TypeScript errors on this.

---

### ITEM-03: Terminal Sandbox
- **Status**: PASS (with minor warning)
- **Evidence**:
  - `FILE_READ_COMMANDS = ['cat', 'type', 'head', 'tail']` defined at module level (`src/tools/terminal.ts` line 22).
  - Sandbox dir resolved via `path.resolve(config.TERMINAL_SANDBOX_DIR)` (line 57).
  - Directory created with `fs.mkdirSync(sandboxDir, { recursive: true })` if missing (lines 60-62).
  - Path validation: `!resolvedPath.startsWith(sandboxDir + path.sep) && resolvedPath !== sandboxDir` (line 70) — correctly uses `path.sep` as trailing separator, preventing the prefix-bypass attack (Scenario 10).
  - Non-file commands (`ls`, `ipconfig`, `ping`) skip the block entirely (Scenario 8).
- **Scenarios covered**: 1, 2, 3, 5, 6, 7, 8, 9, 10.
- **Issues**: **WARNING** — `tsc --noEmit` reports `error TS7006: Parameter 'p' implicitly has an 'any' type` on line 66 (`parts.slice(1).find(p => !p.startsWith('-'))`). This is a TypeScript strictness issue, not a runtime bug, but the build fails. The fix is to type `p` explicitly: `find((p: string) => !p.startsWith('-'))`.

---

### ITEM-04: WhatsApp HMAC Validation
- **Status**: PASS
- **Evidence**:
  - `express.raw({ type: '*/*' })` registered before `express.json()` (lines 162-163) — `req.body` is a `Buffer` for POST /webhook.
  - APP_SECRET check: if `!APP_SECRET` → log error + `res.sendStatus(401)` (lines 197-200). Log message matches spec: `"WHATSAPP_APP_SECRET not configured — rejecting all webhook requests"`.
  - Missing header check: `if (!signature)` → log warning + 401 (lines 202-206). Log message: `"Missing x-hub-signature-256 header"` — matches spec.
  - HMAC computed via `crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')` (lines 209-212).
  - **Timing-safe comparison**: `sigBuffer.length !== expectedBuffer.length` pre-check before `crypto.timingSafeEqual(sigBuffer, expectedBuffer)` (lines 215-221) — correctly handles length mismatch (edge case from spec). No `===` used for signature comparison.
  - Body parsed manually: `JSON.parse(rawBody.toString('utf-8'))` (line 226).
- **Scenarios covered**: 1, 2, 3, 4, 5, 6, 7, 8.
- **Issues**: None.

---

### ITEM-05: WhatsApp Rate Limiting
- **Status**: PASS
- **Evidence**:
  - `express-rate-limit@^7.5.1` in `package.json` dependencies (confirmed).
  - `webhookLimiter` created with `windowMs: 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false` (lines 169-175).
  - Applied **exclusively** to `app.post('/webhook', webhookLimiter, ...)` (line 195). `GET /webhook` and `GET /health` are not rate-limited.
  - `standardHeaders: true` causes `express-rate-limit` to emit `RateLimit-*` headers including `Retry-After` on 429 responses.
- **Scenarios covered**: 1, 2, 3, 4, 5, 6.
- **Issues**: None.

---

### ITEM-06: WhatsApp User Whitelist
- **Status**: PASS
- **Evidence**:
  - `handleIncomingMessage` starts with whitelist check (lines 113-122).
  - Empty list guard: `if (!allowedNumbers || allowedNumbers.length === 0)` → warn + return (lines 115-118). Log message matches spec.
  - Unauthorized sender: `if (!allowedNumbers.includes(from))` → warn + return (lines 119-122). Log message: `"Unauthorized WhatsApp sender: ${from}"` — matches spec.
  - Config uses `.split(',').map(s => s.trim())` — handles spaces around numbers (Scenario 4).
  - Comparison is `includes(from)` — exact string equality, not regex (Scenario 5).
  - `runAgent()` is only called after passing both checks.
- **Scenarios covered**: 1, 2, 3, 4, 5.
- **Issues**: None.

---

### ITEM-07: Bounded Semantic Memory
- **Status**: PASS
- **Evidence**:
  - `getAllEmbeddings` query: `SELECT content, embedding FROM memory_embeddings WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?` with `config.MEMORY_MAX_EMBEDDINGS` as limit param (lines 218-219). Satisfies Scenario 5.
  - `saveEmbedding` cleanup DELETE after INSERT:
    ```sql
    DELETE FROM memory_embeddings
    WHERE user_id = ?
      AND id NOT IN (
        SELECT id FROM memory_embeddings
        WHERE user_id = ?
        ORDER BY timestamp DESC
        LIMIT ?
      )
    ```
    Executed with `(userId, userId, config.MEMORY_MAX_EMBEDDINGS)` (lines 200-210). Satisfies Scenarios 2, 4, 7.
  - Cleanup is scoped to the inserting `userId` only — does not affect other users.
  - Config `MEMORY_MAX_EMBEDDINGS: z.string().default('500').transform(Number)` provides default of 500 (Scenario 6).
- **Scenarios covered**: 1, 2, 3, 4, 5, 6, 7.
- **Issues**: None.

---

### ITEM-08: Daily Digest Temp File Cleanup
- **Status**: PASS
- **Evidence**:
  - `let audioPath: string | null = null` declared before inner `try` block (line 52).
  - `finally` block with guard: `if (audioPath && fs.existsSync(audioPath)) { fs.unlinkSync(audioPath); }` (lines 64-68).
  - `unlinkSync` removed from inside the `try`.
  - If `textToSpeech()` throws before setting `audioPath`, `audioPath` remains `null` and `finally` skips the unlink — no `TypeError` (Scenario 3).
  - If `sendVoice()` throws, the `finally` still executes and cleans the file (Scenario 2).
- **Scenarios covered**: 1, 2, 3, 5.
- **Issues**: None.

---

### ITEM-09: Firebase Index Documentation
- **Status**: PASS
- **Evidence**:
  - `docs/FIREBASE_SETUP.md` exists and contains:
    - Index 1: `messages(userId ASC, timestamp DESC)` — documented in table and in JSON.
    - Index 2: `reminders(sent ASC, remindAt ASC)` — documented in table and in JSON.
    - Full `firestore.indexes.json` JSON block with both indexes and `"fieldOverrides": []`.
    - Exact command: `firebase deploy --only firestore:indexes`.
    - Required env vars: `FIREBASE_PROJECT_ID` and `GOOGLE_APPLICATION_CREDENTIALS` in table.
    - Service account setup instructions (steps 1-4).
    - SQLite fallback note (last section).
    - Docker runtime options A (bind mount) and B (GOOGLE_APPLICATION_CREDENTIALS) and C (BuildKit secret).
- **Scenarios covered**: 1, 2, 3, 4.
- **Issues**: None.

---

### ITEM-10: Dockerfile Credentials Fix
- **Status**: PASS
- **Evidence**:
  - `Dockerfile` has no `COPY service-account.json*` or `COPY client_secret.json*` lines. A comment documents the bind-mount pattern at runtime (lines 19-20).
  - `.dockerignore` contains both `service-account.json` (line 11) and `client_secret.json` (line 12) — prevents accidental inclusion via `COPY . .`.
  - `database/index.ts` already uses `fs.existsSync(serviceAccountPath)` — gracefully falls back to SQLite when credentials are absent (Scenario 5).
  - Runtime documentation is in `docs/FIREBASE_SETUP.md` (ITEM-09).
- **Scenarios covered**: 1, 4, 5.
- **Issues**: None.

---

## Issues encontrados

### CRITICAL (must fix before archive)

**ISSUE-01 — `pRetry.AbortError` does not exist at runtime** (`src/llm/index.ts` lines 322, 332, 339)

`p-retry` v7 exports `AbortError` as a named export, not as a property on the default function. The code calls `new pRetry.AbortError(...)` which is `new undefined(...)` at runtime — throws `TypeError: pRetry.AbortError is not a constructor`. This means ANY timeout during an LLM call crashes `getCompletion()` instead of stopping retries gracefully. TypeScript confirms this with 3 compile errors.

**Fix required**:
```ts
// Change the import from:
import pRetry from 'p-retry';
// To:
import pRetry, { AbortError } from 'p-retry';

// Then replace all three throw sites:
throw new pRetry.AbortError(...)  →  throw new AbortError(...)
```

### WARNING (should fix)

**ISSUE-02 — TypeScript error on `terminal.ts` line 66** (`src/tools/terminal.ts`)

`parts.slice(1).find(p => !p.startsWith('-'))` has an implicit `any` type on parameter `p`. TypeScript raises `error TS7006`. Not a runtime bug (JS doesn't enforce it) but the build fails, which blocks `docker build` (which runs `npx tsc`).

**Fix required**:
```ts
const filePart = parts.slice(1).find((p: string) => !p.startsWith('-'));
```

### SUGGESTION

**ISSUE-03 — No project-level test suite**

All 10 items have zero behavioral test coverage. Every spec scenario is UNTESTED in the behavioral sense. The sdd-verify skill requires runtime execution evidence for compliance. All scenarios are marked ❌ UNTESTED. This is an architectural gap — the project has no test runner configured in `package.json`.

---

## Spec Compliance Matrix

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| ITEM-01: .env placeholders | Scenario 1: placeholders | (none) | ❌ UNTESTED |
| ITEM-01: .env placeholders | Scenario 2: .gitignore | (none) | ❌ UNTESTED |
| ITEM-01: .env placeholders | Scenario 3: keys revoked | (external) | ➖ N/A |
| ITEM-02: LLM Timeouts | Scenario 1: Gemini within timeout | (none) | ❌ UNTESTED |
| ITEM-02: LLM Timeouts | Scenario 2: Gemini exceeds timeout | (none) | ❌ UNTESTED |
| ITEM-02: LLM Timeouts | Scenario 3: AbortError stops pRetry | (none) | ❌ UNTESTED + CRITICAL BUG |
| ITEM-02: LLM Timeouts | Scenario 4: network error retried | (none) | ❌ UNTESTED |
| ITEM-02: LLM Timeouts | Scenario 5: Groq timeout | (none) | ❌ UNTESTED |
| ITEM-02: LLM Timeouts | Scenario 6: OpenRouter timeout | (none) | ❌ UNTESTED |
| ITEM-02: LLM Timeouts | Scenario 7: timeout during retry | (none) | ❌ UNTESTED + CRITICAL BUG |
| ITEM-02: LLM Timeouts | Scenario 8: default 30000ms | (none) | ❌ UNTESTED |
| ITEM-03: Terminal Sandbox | Scenario 1: file inside sandbox | (none) | ❌ UNTESTED |
| ITEM-03: Terminal Sandbox | Scenario 2: path traversal ../ | (none) | ❌ UNTESTED |
| ITEM-03: Terminal Sandbox | Scenario 3: absolute path outside | (none) | ❌ UNTESTED |
| ITEM-03: Terminal Sandbox | Scenario 6: absolute path inside | (none) | ❌ UNTESTED |
| ITEM-03: Terminal Sandbox | Scenario 7: workspace dir created | (none) | ❌ UNTESTED |
| ITEM-03: Terminal Sandbox | Scenario 8: non-file cmds unaffected | (none) | ❌ UNTESTED |
| ITEM-03: Terminal Sandbox | Scenario 9: default sandbox dir | (none) | ❌ UNTESTED |
| ITEM-03: Terminal Sandbox | Scenario 10: prefix bypass blocked | (none) | ❌ UNTESTED |
| ITEM-04: HMAC Validation | Scenario 1: valid signature | (none) | ❌ UNTESTED |
| ITEM-04: HMAC Validation | Scenario 2: missing header | (none) | ❌ UNTESTED |
| ITEM-04: HMAC Validation | Scenario 3: invalid signature | (none) | ❌ UNTESTED |
| ITEM-04: HMAC Validation | Scenario 5: no APP_SECRET | (none) | ❌ UNTESTED |
| ITEM-04: HMAC Validation | Scenario 6: timingSafeEqual used | (none) | ❌ UNTESTED |
| ITEM-05: Rate Limiting | Scenario 1: within limit | (none) | ❌ UNTESTED |
| ITEM-05: Rate Limiting | Scenario 2: 101st request → 429 | (none) | ❌ UNTESTED |
| ITEM-05: Rate Limiting | Scenario 3: GET not rate-limited | (none) | ❌ UNTESTED |
| ITEM-06: Whitelist | Scenario 1: authorized number | (none) | ❌ UNTESTED |
| ITEM-06: Whitelist | Scenario 2: unauthorized rejected | (none) | ❌ UNTESTED |
| ITEM-06: Whitelist | Scenario 3: env unset rejects all | (none) | ❌ UNTESTED |
| ITEM-06: Whitelist | Scenario 4: trim spaces | (none) | ❌ UNTESTED |
| ITEM-07: Bounded Memory | Scenario 1: insert with space | (none) | ❌ UNTESTED |
| ITEM-07: Bounded Memory | Scenario 2: N+1 triggers cleanup | (none) | ❌ UNTESTED |
| ITEM-07: Bounded Memory | Scenario 4: cleanup scoped to user | (none) | ❌ UNTESTED |
| ITEM-07: Bounded Memory | Scenario 5: getAllEmbeddings LIMIT | (none) | ❌ UNTESTED |
| ITEM-08: Digest Cleanup | Scenario 1: successful cleanup | (none) | ❌ UNTESTED |
| ITEM-08: Digest Cleanup | Scenario 2: cleanup after sendVoice error | (none) | ❌ UNTESTED |
| ITEM-08: Digest Cleanup | Scenario 3: null audioPath safe | (none) | ❌ UNTESTED |

**Behavioral compliance: 0/36 scenarios with passing tests (no test suite exists)**
**Static/structural compliance: 9/10 items correct (ITEM-02 has critical runtime bug)**

---

## Build & Type Check

**Build command**: `npx tsc --noEmit`
**Result**: FAIL (exit code 1)

```
src/llm/index.ts(322,38): error TS2339: Property 'AbortError' does not exist on type '<T>(input: (attemptNumber: number) => T | PromiseLike<T>, options?: Options | undefined) => Promise<T>'.
src/llm/index.ts(332,34): error TS2339: Property 'AbortError' does not exist on type '<T>(input: ...) => Promise<T>'.
src/llm/index.ts(339,38): error TS2339: Property 'AbortError' does not exist on type '<T>(input: ...) => Promise<T>'.
src/tools/terminal.ts(66,54): error TS7006: Parameter 'p' implicitly has an 'any' type.
```

Because `docker build` runs `npx tsc`, the Docker image build also fails with the current code.

**Tests**: Not configured — no test script in `package.json`, no test files in `src/`.
**Coverage**: Not configured.

---

## Recomendación

**Needs fixes** — DO NOT merge yet.

Two TypeScript build errors must be fixed before this can be archived:

1. **CRITICAL**: Import `AbortError` as named export from `p-retry` and replace all 3 `new pRetry.AbortError(...)` calls with `new AbortError(...)`. Without this fix, any LLM timeout crashes `getCompletion()` instead of aborting retries.

2. **WARNING**: Add `: string` type annotation to the `find` callback parameter in `terminal.ts` line 66 to resolve the implicit `any` TypeScript error.

Both fixes are 1-line changes. Once applied, `tsc --noEmit` should pass and `docker build` will succeed. The structural implementation across all 10 items is otherwise correct and well-executed.
