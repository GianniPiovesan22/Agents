# Firebase Setup Guide

This document describes how to configure Firebase Firestore for OpenGravity.

> **Note:** Firebase is optional. If `service-account.json` is absent, the system operates in SQLite mode automatically. Firebase is only required for multi-device sync or persistent cloud storage.

---

## Required Composite Indexes

Firestore requires composite indexes for queries that combine `where` and `orderBy` on different fields. Without these indexes, queries fall back to local SQLite with a warning in the logs.

### Index 1 — `messages` collection

| Collection | Field | Order |
|------------|-------|-------|
| `messages` | `userId` | Ascending |
| `messages` | `timestamp` | Descending |

Used by: `getHistory(userId)` — queries messages filtered by userId ordered by timestamp.

### Index 2 — `reminders` collection

| Collection | Field | Order |
|------------|-------|-------|
| `reminders` | `sent` | Ascending |
| `reminders` | `remindAt` | Ascending |

Used by: `getPendingReminders()` — queries reminders where `sent == false` and `remindAt <= now`.

---

## firestore.indexes.json

Copy this file to the root of your project and deploy with the Firebase CLI.

```json
{
  "indexes": [
    {
      "collectionGroup": "messages",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "userId", "order": "ASCENDING" },
        { "fieldPath": "timestamp", "order": "DESCENDING" }
      ]
    },
    {
      "collectionGroup": "reminders",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "sent", "order": "ASCENDING" },
        { "fieldPath": "remindAt", "order": "ASCENDING" }
      ]
    }
  ],
  "fieldOverrides": []
}
```

### Deploy indexes

```bash
firebase deploy --only firestore:indexes
```

Both indexes are within the Firestore free tier (Spark plan) limits.

---

## Required Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FIREBASE_PROJECT_ID` | Yes (Firebase mode) | Your Firebase project ID (e.g. `my-project-63`) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Optional | Absolute path to `service-account.json`. If not set, the app looks for `service-account.json` in the working directory. |

---

## Service Account Setup

1. Go to [Firebase Console](https://console.firebase.google.com) → Project Settings → Service Accounts
2. Click **Generate new private key**
3. Save the downloaded JSON as `service-account.json`
4. **Never commit this file to git** — it is already in `.gitignore`

---

## Runtime Options for Docker

Since credentials are not baked into the Docker image (see `Dockerfile`), you must provide them at runtime.

### Option A — Bind mount (recommended for local dev)

```bash
docker run \
  -v ./service-account.json:/app/service-account.json:ro \
  -e FIREBASE_PROJECT_ID=your-project-id \
  opengravity
```

### Option B — GOOGLE_APPLICATION_CREDENTIALS env var

```bash
docker run \
  -v /host/path/service-account.json:/app/creds/service-account.json:ro \
  -e GOOGLE_APPLICATION_CREDENTIALS=/app/creds/service-account.json \
  -e FIREBASE_PROJECT_ID=your-project-id \
  opengravity
```

### Option C — Docker BuildKit secret (CI/CD, advanced)

```dockerfile
# syntax=docker/dockerfile:1
RUN --mount=type=secret,id=sa,target=/app/service-account.json \
    node dist/index.js
```

```bash
docker build --secret id=sa,src=./service-account.json .
```

> For Kubernetes/Docker Swarm, use native Secrets objects instead of bind mounts.

---

## SQLite Fallback Mode

If `service-account.json` is not found at startup, the system logs:

```
⚠️ service-account.json not found. Using local SQLite mode.
```

All data is stored in `memory.db` locally. The Firebase indexes above are only needed when running in Firebase mode.
