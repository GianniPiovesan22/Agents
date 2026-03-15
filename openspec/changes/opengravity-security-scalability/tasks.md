---
change: opengravity-security-scalability
phase: tasks
date: 2026-03-15
---

# Tasks: OpenGravity Security & Scalability Refactor

---

## Phase 1: Credentials & Secrets (Foundation)

These tasks eliminate the most critical security risks first — exposed credentials and files baked into Docker images. Zero code changes, maximum blast-radius reduction.

- [x] TASK-01: Replace all real API key values in `.env.example` with descriptive placeholders
  - **Files**: `.env.example`
  - **Done when**: `git grep -r "AIzaSy\|sk-or-v1\|8383891169\|sk_98c6"` returns no matches in the working tree. Every sensitive variable has a `your-*` or `<description>` placeholder. Non-secret config values (ports, model names, project IDs) may keep real values. (Spec ITEM-01 — Scenario 1)
  - **Depends on**: none

- [x] TASK-02: Verify `.env` is covered by `.gitignore`
  - **Files**: `.gitignore`
  - **Done when**: `.env` or `.env*` pattern is present in `.gitignore`. `git status` does not show `.env` as untracked or staged. (Spec ITEM-01 — Scenario 2)
  - **Depends on**: none

- [x] TASK-03: Remove credential COPY lines from Dockerfile and add `.dockerignore` entries
  - **Files**: `Dockerfile`, `.dockerignore` (create if missing)
  - **Done when**: `Dockerfile` contains no `COPY service-account.json*` or `COPY client_secret.json*` lines. `.dockerignore` includes both `service-account.json` and `client_secret.json`. `docker build` completes without copying those files into the image. (Spec ITEM-10 — Scenarios 1, 4, 5)
  - **Depends on**: none

---

## Phase 2: Documentation (No-Code Changes)

Creates the Firebase setup docs that are also referenced by ITEM-10 runtime instructions. Done before touching production code.

- [x] TASK-04: Create `docs/FIREBASE_SETUP.md` with composite index definitions, `firestore.indexes.json`, deploy command, env vars, and service account setup instructions
  - **Files**: `docs/FIREBASE_SETUP.md` (create)
  - **Done when**: File exists and contains: (a) index for `messages(userId ASC, timestamp DESC)`, (b) index for `reminders(sent ASC, remindAt ASC)`, (c) the full `firestore.indexes.json` JSON block, (d) the exact command `firebase deploy --only firestore:indexes`, (e) required env vars `FIREBASE_PROJECT_ID` and `GOOGLE_APPLICATION_CREDENTIALS`, (f) service account setup instructions, (g) note that if `service-account.json` is absent the system operates in SQLite mode, (h) bind-mount and `GOOGLE_APPLICATION_CREDENTIALS` runtime alternatives for Docker. (Spec ITEM-09 — Scenario 1; Spec ITEM-10 — Scenarios 2, 3)
  - **Depends on**: none

---

## Phase 3: Config Schema (Infrastructure for Code Changes)

Add all new env var definitions to `src/config/index.ts` before any feature code needs them. Every subsequent task depends on this being done first.

- [x] TASK-05: Add `LLM_TIMEOUT_MS` to config schema
  - **Files**: `src/config/index.ts`
  - **Done when**: Schema includes `LLM_TIMEOUT_MS: z.string().default('30000').transform(Number)`. Default is `30000`. `config.LLM_TIMEOUT_MS` is accessible as a `number`. Documented in `.env.example` with value `30000`. (Spec ITEM-02 — Scenario 8)
  - **Depends on**: none

- [x] TASK-06: Add `TERMINAL_SANDBOX_DIR` to config schema
  - **Files**: `src/config/index.ts`
  - **Done when**: Schema includes `TERMINAL_SANDBOX_DIR` with default `path.join(process.cwd(), 'workspace')`. `config.TERMINAL_SANDBOX_DIR` is accessible as a `string`. Documented in `.env.example`. (Spec ITEM-03 — Scenario 9)
  - **Depends on**: none

- [x] TASK-07: Add `WHATSAPP_APP_SECRET` to config schema
  - **Files**: `src/config/index.ts`
  - **Done when**: Schema includes `WHATSAPP_APP_SECRET: z.string().optional()`. Documented in `.env.example` as required when WhatsApp is enabled. (Spec ITEM-04 — Scenario 5)
  - **Depends on**: none

- [x] TASK-08: Add `WHATSAPP_ALLOWED_NUMBERS` to config schema
  - **Files**: `src/config/index.ts`
  - **Done when**: Schema includes `WHATSAPP_ALLOWED_NUMBERS` parsed as `z.string().optional().transform(val => val ? val.split(',').map(s => s.trim()) : [])`. Config value is a `string[]`. Handles comma-separated numbers, trims spaces, returns empty array when unset. Documented in `.env.example`. (Spec ITEM-06 — Scenarios 3, 4)
  - **Depends on**: none

- [x] TASK-09: Add `MEMORY_MAX_EMBEDDINGS` to config schema
  - **Files**: `src/config/index.ts`
  - **Done when**: Schema includes `MEMORY_MAX_EMBEDDINGS: z.string().default('500').transform(Number)`. Default is `500`. `config.MEMORY_MAX_EMBEDDINGS` is accessible as a `number`. Documented in `.env.example`. (Spec ITEM-07 — Scenario 6)
  - **Depends on**: none

---

## Phase 4: Core Implementation

Feature changes in production code. Each task is a single logical unit in one file (or closely related files).

- [x] TASK-10: Move `fs.unlinkSync(audioPath)` to a `finally` block in `sendDailyDigest`
  - **Files**: `src/agent/daily_digest.ts`
  - **Done when**: `audioPath` is declared as `let audioPath: string | null = null` before the `try` block. The `finally` block contains `if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath)`. The `unlinkSync` call is removed from inside the `try`. If `textToSpeech()` throws before creating the file, `finally` runs without calling `unlinkSync`. (Spec ITEM-08 — Scenarios 1, 2, 3, 5)
  - **Depends on**: none

- [x] TASK-11: Add `LIMIT` and `ORDER BY timestamp DESC` to `getAllEmbeddings` query
  - **Files**: `src/database/index.ts`
  - **Done when**: The SELECT in `getAllEmbeddings` is `SELECT content, embedding FROM memory_embeddings WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?` and uses `config.MEMORY_MAX_EMBEDDINGS` as the limit param. Returns at most `MEMORY_MAX_EMBEDDINGS` records, most recent first. (Spec ITEM-07 — Scenario 5)
  - **Depends on**: TASK-09

- [x] TASK-12: Add inline cleanup DELETE to `saveEmbedding` after insert
  - **Files**: `src/database/index.ts`
  - **Done when**: After the INSERT, a `DELETE FROM memory_embeddings WHERE user_id = ? AND id NOT IN (SELECT id FROM memory_embeddings WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?)` is executed with `config.MEMORY_MAX_EMBEDDINGS`. Cleanup is scoped to the inserting user only. After 501 inserts for the same user, `getAllEmbeddings` returns exactly 500 records. Retained records are the most recent by `timestamp`. (Spec ITEM-07 — Scenarios 2, 4, 7)
  - **Depends on**: TASK-09, TASK-11

- [x] TASK-13: Add `AbortSignal.timeout()` to `geminiCompletion` call
  - **Files**: `src/llm/index.ts`
  - **Done when**: `generateContent` call includes `abortSignal: AbortSignal.timeout(config.LLM_TIMEOUT_MS)` inside the `config` object. A fake-slow Gemini endpoint aborts the call within `LLM_TIMEOUT_MS + 500ms`. The error thrown has `name === 'AbortError'` or `name === 'TimeoutError'`. (Spec ITEM-02 — Scenarios 1, 2)
  - **Depends on**: TASK-05

- [x] TASK-14: Add `{ signal: AbortSignal.timeout() }` to `groqCompletion` call
  - **Files**: `src/llm/index.ts`
  - **Done when**: `groq.chat.completions.create(params, { signal: AbortSignal.timeout(config.LLM_TIMEOUT_MS) })`. A fake-slow endpoint aborts within `LLM_TIMEOUT_MS + 500ms` and throws with `name === 'AbortError'` or `name === 'TimeoutError'`. (Spec ITEM-02 — Scenario 5)
  - **Depends on**: TASK-05

- [x] TASK-15: Add `{ signal: AbortSignal.timeout() }` to `openRouterCompletion` call
  - **Files**: `src/llm/index.ts`
  - **Done when**: `openRouter.chat.completions.create(params, { signal: AbortSignal.timeout(config.LLM_TIMEOUT_MS) })`. A fake-slow endpoint aborts within `LLM_TIMEOUT_MS + 500ms` and throws with `name === 'AbortError'` or `name === 'TimeoutError'`. (Spec ITEM-02 — Scenario 6)
  - **Depends on**: TASK-05

- [x] TASK-16: Wrap `AbortError`/`TimeoutError` as `pRetry.AbortError` in `getCompletion`
  - **Files**: `src/llm/index.ts`
  - **Done when**: Each `catch` block inside the `pRetry` callback checks `error.name === 'AbortError' || error.name === 'TimeoutError'` and re-throws `new pRetry.AbortError(...)`. `pRetry` does NOT retry when a timeout fires. `pRetry` DOES retry on `ECONNRESET` or `500` errors. (Spec ITEM-02 — Scenarios 3, 4, 7)
  - **Depends on**: TASK-13, TASK-14, TASK-15

- [x] TASK-17: Add sandbox path validation to `run_terminal_command` for file-read commands
  - **Files**: `src/tools/terminal.ts`
  - **Done when**: A `FILE_READ_COMMANDS = ['cat', 'type', 'head', 'tail']` constant is defined. For those commands, the file argument is extracted, resolved with `path.resolve(sandboxDir, filePart)`, and validated with `.startsWith(sandboxDir + path.sep)`. Paths outside the sandbox return a descriptive error string, never execute. `ls`, `ipconfig`, `ping` are not affected. (Spec ITEM-03 — Scenarios 1, 2, 3, 5, 6, 8, 10)
  - **Depends on**: TASK-06

- [x] TASK-18: Create `workspace/` directory at bootstrap if it does not exist
  - **Files**: `src/tools/terminal.ts`
  - **Done when**: Inside the sandbox validation block (or tool initialization), `if (!fs.existsSync(sandboxDir)) fs.mkdirSync(sandboxDir, { recursive: true })` is present. The app starts without error when `workspace/` does not exist. (Spec ITEM-03 — Scenario 7)
  - **Depends on**: TASK-17

- [x] TASK-19: Register `express.raw({ type: '*/*' })` for `/webhook` route before `express.json()`
  - **Files**: `src/whatsapp/index.ts`
  - **Done when**: `app.use('/webhook', express.raw({ type: '*/*' }))` is registered before `app.use(express.json())` in `createWhatsAppServer`. The `POST /webhook` handler receives `req.body` as a `Buffer`. All other routes still receive `req.body` as a parsed JSON object. (Spec ITEM-04 — Scenario 7)
  - **Depends on**: TASK-07

- [x] TASK-20: Implement HMAC-SHA256 validation middleware for `POST /webhook`
  - **Files**: `src/whatsapp/index.ts`
  - **Done when**: At the top of the `POST /webhook` handler: (a) if `WHATSAPP_APP_SECRET` is absent → 401 + error log; (b) if `x-hub-signature-256` header is absent → 401 + warning log; (c) HMAC is computed over the raw `Buffer` body with `crypto.createHmac('sha256', APP_SECRET)`; (d) `sigBuffer.length !== expectedBuffer.length` check runs before `crypto.timingSafeEqual()`; (e) mismatch → 401; (f) valid signature → continues to handler which parses body manually with `JSON.parse(rawBody.toString('utf-8'))`. No `===` comparison is used for signature comparison. (Spec ITEM-04 — Scenarios 1, 2, 3, 4, 5, 6, 8)
  - **Depends on**: TASK-07, TASK-19

- [x] TASK-21: Install `express-rate-limit` dependency
  - **Files**: `package.json`
  - **Done when**: `express-rate-limit` appears in `dependencies` in `package.json` at `^7.x`. `npm install` completes without error. (Spec ITEM-05 — acceptance criteria)
  - **Depends on**: none

- [x] TASK-22: Apply `express-rate-limit` middleware (100 req/min/IP) exclusively to `POST /webhook`
  - **Files**: `src/whatsapp/index.ts`
  - **Done when**: A `webhookLimiter` is created with `windowMs: 60 * 1000`, `max: 100`, `standardHeaders: true`, `legacyHeaders: false`. It is applied only to the `POST /webhook` route, not to `GET /webhook` or `GET /health`. The 101st POST from the same IP within a 1-minute window receives HTTP 429 with a `Retry-After` header. GET requests to the same IP are not rate-limited. (Spec ITEM-05 — Scenarios 1, 2, 3)
  - **Depends on**: TASK-20, TASK-21

- [x] TASK-23: Add whitelist check in `handleIncomingMessage` before calling `runAgent()`
  - **Files**: `src/whatsapp/index.ts`
  - **Done when**: At the start of `handleIncomingMessage`, if `config.WHATSAPP_ALLOWED_NUMBERS` is empty or unset → log warning and `return`. If `from` is not in the allowed list → log warning `"Unauthorized WhatsApp sender: {from}"` and `return`. `runAgent()` is never called for unauthorized numbers. Comparison is exact string equality. Numbers with extra spaces in env var are trimmed. (Spec ITEM-06 — Scenarios 1, 2, 3, 4, 5)
  - **Depends on**: TASK-08, TASK-22

---

## Phase 5: Cleanup & Verification

Confirm all env var placeholders are in `.env.example` and review for missed coverage.

- [x] TASK-24: Add all new env var entries to `.env.example` with placeholders and defaults
  - **Files**: `.env.example`
  - **Done when**: `.env.example` contains documented entries for `LLM_TIMEOUT_MS=30000`, `TERMINAL_SANDBOX_DIR=./workspace`, `WHATSAPP_APP_SECRET=your-whatsapp-app-secret`, `WHATSAPP_ALLOWED_NUMBERS=your-whatsapp-number`, `MEMORY_MAX_EMBEDDINGS=500`. Each entry has a comment or descriptive placeholder. No real credentials are present anywhere in the file. (Spec ITEM-01 acceptance criteria; all items with env var requirements)
  - **Depends on**: TASK-01, TASK-05, TASK-06, TASK-07, TASK-08, TASK-09

---

## Task Dependency Summary

```
TASK-01 ──────────────────────────────────────────────────────► TASK-24
TASK-02 (independent)
TASK-03 (independent)
TASK-04 (independent)
TASK-05 ──► TASK-13 ──► TASK-16
TASK-05 ──► TASK-14 ──► TASK-16
TASK-05 ──► TASK-15 ──► TASK-16
TASK-05 ──────────────────────────────────────────────────────► TASK-24
TASK-06 ──► TASK-17 ──► TASK-18
TASK-06 ──────────────────────────────────────────────────────► TASK-24
TASK-07 ──► TASK-19 ──► TASK-20 ──► TASK-22 ──► TASK-23
TASK-07 ──────────────────────────────────────────────────────► TASK-24
TASK-08 ──► TASK-23
TASK-08 ──────────────────────────────────────────────────────► TASK-24
TASK-09 ──► TASK-11 ──► TASK-12
TASK-09 ──────────────────────────────────────────────────────► TASK-24
TASK-10 (independent)
TASK-21 ──► TASK-22
```

## Total Tasks by Phase

| Phase | Tasks | Focus |
|-------|-------|-------|
| Phase 1 | 3 (TASK-01 to TASK-03) | Credentials & Secrets |
| Phase 2 | 1 (TASK-04) | Documentation |
| Phase 3 | 5 (TASK-05 to TASK-09) | Config Schema |
| Phase 4 | 14 (TASK-10 to TASK-23) | Core Implementation |
| Phase 5 | 1 (TASK-24) | Cleanup & Verification |
| **Total** | **24** | |
