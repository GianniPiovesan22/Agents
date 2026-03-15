---
change: opengravity-security-scalability
phase: apply-progress
date: 2026-03-15
---

# Apply Progress: OpenGravity Security & Scalability Refactor

## Status

**24/24 tasks complete. Ready for verify.**

---

## Completed Tasks

- [x] TASK-01: Replaced all real API keys in `.env.example` with descriptive placeholders
- [x] TASK-02: `.env` already in `.gitignore` (line 8) — no change needed
- [x] TASK-03: Removed `COPY service-account.json` and `COPY client_secret.json` from Dockerfile; added both to `.dockerignore`; added mount comment to Dockerfile
- [x] TASK-04: Created `docs/FIREBASE_SETUP.md` with both indexes, full `firestore.indexes.json` JSON block, deploy command, env vars, service account setup, Docker runtime options (bind mount, GOOGLE_APPLICATION_CREDENTIALS, BuildKit secret)
- [x] TASK-05: Added `LLM_TIMEOUT_MS: z.string().default('30000').transform(Number)` to config schema
- [x] TASK-06: Added `TERMINAL_SANDBOX_DIR: z.string().default(path.join(process.cwd(), 'workspace'))` to config schema; added `path` import
- [x] TASK-07: Added `WHATSAPP_APP_SECRET: z.string().optional()` to config schema
- [x] TASK-08: Added `WHATSAPP_ALLOWED_NUMBERS: z.string().optional().transform(val => val ? val.split(',').map(s => s.trim()) : [])` to config schema
- [x] TASK-09: Added `MEMORY_MAX_EMBEDDINGS: z.string().default('500').transform(Number)` to config schema
- [x] TASK-10: Moved `fs.unlinkSync(audioPath)` to `finally` block in `sendDailyDigest`; declared `let audioPath: string | null = null` before inner try
- [x] TASK-11: Updated `getAllEmbeddings` query to `SELECT content, embedding FROM memory_embeddings WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?` using `config.MEMORY_MAX_EMBEDDINGS`
- [x] TASK-12: Added DELETE cleanup in `saveEmbedding` after INSERT with `NOT IN (SELECT id ... ORDER BY timestamp DESC LIMIT ?)` scoped to inserting user
- [x] TASK-13: Added `abortSignal: AbortSignal.timeout(config.LLM_TIMEOUT_MS)` to Gemini `generateContent` config spread
- [x] TASK-14: Added `{ signal: AbortSignal.timeout(config.LLM_TIMEOUT_MS) }` as second argument to Groq `chat.completions.create`
- [x] TASK-15: Added `{ signal: AbortSignal.timeout(config.LLM_TIMEOUT_MS) }` as second argument to OpenRouter `chat.completions.create`
- [x] TASK-16: Added AbortError/TimeoutError detection in all three catch blocks inside `getCompletion`'s pRetry callback; each re-throws `new pRetry.AbortError(...)`
- [x] TASK-17: Added `FILE_READ_COMMANDS = ['cat', 'type', 'head', 'tail']` constant; added sandbox path validation block in execute; imports `path` and `fs`; validates with `resolvedPath.startsWith(sandboxDir + path.sep)`
- [x] TASK-18: `fs.mkdirSync(sandboxDir, { recursive: true })` inside the sandbox validation block, runs when sandboxDir does not exist
- [x] TASK-19: Added `app.use('/webhook', express.raw({ type: '*/*' }))` before `app.use(express.json())` in `createWhatsAppServer`
- [x] TASK-20: Implemented full HMAC-SHA256 validation at top of `POST /webhook` handler: APP_SECRET check, signature header presence check, HMAC computation, length-safe `timingSafeEqual` comparison, manual JSON.parse of Buffer body
- [x] TASK-21: Ran `npm install express-rate-limit@^7 --save`; package added at `^7.5.1`
- [x] TASK-22: Created `webhookLimiter` with `windowMs: 60000, max: 100, standardHeaders: true, legacyHeaders: false`; applied as middleware only to `app.post('/webhook', webhookLimiter, ...)`; GET routes unaffected
- [x] TASK-23: Added whitelist check at top of `handleIncomingMessage`: empty list → warn and return; number not in list → warn and return; `runAgent()` only called for authorized numbers
- [x] TASK-24: All 5 new env vars added to `.env.example` in TASK-01 (done together): `LLM_TIMEOUT_MS`, `TERMINAL_SANDBOX_DIR`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ALLOWED_NUMBERS`, `MEMORY_MAX_EMBEDDINGS` — each with descriptive comment

---

## Files Changed

| File | Action | What Changed |
|------|--------|--------------|
| `.env.example` | Modified | All real credentials replaced with placeholders; 5 new vars added with comments |
| `.dockerignore` | Modified | Added `service-account.json` and `client_secret.json` entries |
| `Dockerfile` | Modified | Removed `COPY service-account.json ./` and `COPY client_secret.json ./`; added mount comment |
| `docs/FIREBASE_SETUP.md` | Created | Full Firebase setup guide with indexes, JSON, deploy command, Docker options |
| `src/config/index.ts` | Modified | Added `path` import; added 5 new env var definitions to schema |
| `src/agent/daily_digest.ts` | Modified | Moved audio temp file cleanup to `finally` block |
| `src/database/index.ts` | Modified | `saveEmbedding`: added cleanup DELETE after INSERT; `getAllEmbeddings`: added ORDER BY + LIMIT |
| `src/llm/index.ts` | Modified | Added AbortSignal.timeout to all 3 providers; added pRetry.AbortError wrapping for timeout errors |
| `src/tools/terminal.ts` | Modified | Added `path`, `fs`, `config` imports; added `FILE_READ_COMMANDS` constant; added sandbox path validation block |
| `src/whatsapp/index.ts` | Modified | Added `crypto` and `rateLimit` imports; raw body middleware; HMAC validation; rate limiter; whitelist check |
| `package.json` | Modified | Added `express-rate-limit: ^7.5.1` to dependencies |
| `package-lock.json` | Modified | Updated by npm install |

---

## Deviations from Design

- **TASK-02**: `.gitignore` already had `.env` on line 8. No edit was needed. Confirmed by reading the file.
- **TASK-04**: The tasks.md specified `reminders(sent ASC, remindAt ASC)` but the orchestrator's guide mentioned `messages(userId ASC + timestamp DESC)` and `memory(userId ASC + timestamp DESC)`. Used the spec.md definition which is authoritative: `messages` and `reminders` indexes (not `memory`). The `memory` table is SQLite-only and does not need Firestore indexes.
- **TASK-10**: The inner `finally` block is nested inside the outer `try/catch` that wraps the full `sendDailyDigest` function. The `audioPath` variable is declared in the scope of the outer try, which is the correct place for it to be accessible in the inner finally.

---

## Issues Found

- **FIREBASE_PROJECT_ID in .env.example**: The original had `"opengravity63"` as the value. Per spec ITEM-01, non-secret config values like project IDs "may keep real values". However, since it's a specific project identifier, it was replaced with `"your-firebase-project-id"` for consistency. No functional impact.
- **ELEVENLABS_VOICE_ID in .env.example**: The original had a real voice ID `p7AwDmKvTdoHTBuueGvP`. This was replaced with a placeholder since it's a user-specific resource identifier.

---

## Remaining Tasks

None. All 24 tasks complete.
