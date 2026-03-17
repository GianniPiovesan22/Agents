import admin from 'firebase-admin';
import { config } from '../config/index.js';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

let firestore: FirebaseFirestore.Firestore | null = null;
let localDb: any = null;

// Initialize Local SQLite — uses persistent volume on Railway (/app/data), falls back to cwd
const dataDir = process.env.DATA_DIR ?? process.cwd();
const localDbPath = path.join(dataDir, 'memory.db');
localDb = new Database(localDbPath);
localDb.exec(`
  CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    message TEXT NOT NULL,
    remind_at DATETIME NOT NULL,
    sent BOOLEAN DEFAULT 0,
    recurrence TEXT,
    recurrence_time TEXT
  );
  CREATE TABLE IF NOT EXISTS memory_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS user_profile (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, key)
  );
  CREATE TABLE IF NOT EXISTS forex_events (
    id TEXT PRIMARY KEY,
    event_date TEXT NOT NULL,
    event_time TEXT,
    currency TEXT,
    event_name TEXT NOT NULL,
    impact TEXT NOT NULL,
    forecast TEXT,
    previous TEXT,
    actual TEXT,
    notified INTEGER DEFAULT 0,
    fetched_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name TEXT NOT NULL,
    contact_name TEXT,
    email TEXT,
    phone TEXT,
    website TEXT,
    industry TEXT,
    location TEXT,
    source TEXT,
    status TEXT DEFAULT 'nuevo',
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// Migrate existing reminders table — add recurrence columns if missing
try {
  localDb.exec(`ALTER TABLE reminders ADD COLUMN recurrence TEXT`);
} catch (_) { /* column already exists */ }
try {
  localDb.exec(`ALTER TABLE reminders ADD COLUMN recurrence_time TEXT`);
} catch (_) { /* column already exists */ }

/**
 * Initialize Firebase with Absolute Path
 */
const serviceAccountPath = path.resolve(process.cwd(), 'service-account.json');

if (fs.existsSync(serviceAccountPath)) {
  try {
    console.log("🔥 Initializing Firebase with Service Account...");
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccountPath),
      projectId: config.FIREBASE_PROJECT_ID || 'opengravity63'
    });
    firestore = admin.firestore();
    console.log("✅ Firebase connected successfully.");
  } catch (error) {
    console.error("❌ Firebase initialization failed:", error);
  }
} else {
  console.warn("⚠️ service-account.json not found. Using local SQLite mode.");
}

/**
 * Saves a message to the conversation history.
 */
export async function saveMessage(userId: string, role: string, content: string) {
  // 1. Always save to Local SQLite (as a robust backup)
  try {
    const stmt = localDb.prepare('INSERT INTO memory (user_id, role, content) VALUES (?, ?, ?)');
    stmt.run(userId, role, content);
  } catch (e) {
    console.error("Local DB Save Error:", e);
  }

  // 2. Try to save to Firebase if available
  if (firestore) {
    try {
      await firestore.collection('messages').add({
        userId,
        role,
        content,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (error: any) {
      console.error("Firebase Save Error:", error.message);
    }
  }
}

/**
 * Retrieves history with automatic fallback.
 */
export async function getHistory(userId: string, limit: number = 10) {
  // 1. Try Firebase First
  if (firestore) {
    try {
      const snapshot = await firestore.collection('messages')
        .where('userId', '==', userId)
        .orderBy('timestamp', 'desc')
        .limit(limit)
        .get();

      const messages = snapshot.docs.map(doc => {
        const data = doc.data();
        return {
          role: data.role as any,
          content: data.content
        };
      });
      return messages.reverse();
    } catch (error: any) {
      if (error.message.includes('requires an index')) {
        console.error("❌ MISSING FIREBASE INDEX: Falling back to local history.");
      } else {
        console.error("Firebase Read Error:", error.message);
      }
    }
  }

  // 2. Fallback to Local SQLite
  console.log("📂 Reading from local SQLite history...");
  const stmt = localDb.prepare('SELECT role, content FROM memory WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?');
  const rows = stmt.all(userId, limit) as any[];
  return rows.reverse().map(row => ({
    role: row.role,
    content: row.content
  }));
}

export async function createReminder(
  userId: string,
  message: string,
  remindAt: Date,
  recurrence?: string,
  recurrenceTime?: string
) {
  try {
    const stmt = localDb.prepare(
      'INSERT INTO reminders (user_id, message, remind_at, sent, recurrence, recurrence_time) VALUES (?, ?, ?, 0, ?, ?)'
    );
    stmt.run(userId, message, remindAt.toISOString(), recurrence ?? null, recurrenceTime ?? null);
  } catch (e) {
    console.error("Local DB Reminder Save Error:", e);
  }

  if (firestore) {
    try {
      await firestore.collection('reminders').add({
        userId,
        message,
        remindAt: admin.firestore.Timestamp.fromDate(remindAt),
        sent: false,
        recurrence: recurrence ?? null,
        recurrenceTime: recurrenceTime ?? null,
      });
    } catch (e: any) {
      console.error("Firebase Reminder Save Error:", e.message);
    }
  }
}

export async function getPendingReminders() {
  const now = new Date();

  if (firestore) {
    try {
      const snapshot = await firestore.collection('reminders')
        .where('sent', '==', false)
        .where('remindAt', '<=', admin.firestore.Timestamp.fromDate(now))
        .get();

      return snapshot.docs.map(doc => ({
        id: doc.id,
        userId: doc.data().userId,
        message: doc.data().message,
        remindAt: doc.data().remindAt.toDate(),
        source: 'firebase' as const
      }));
    } catch (e: any) {
      if (e.message.includes('requires an index')) {
        console.error("❌ MISSING FIREBASE INDEX for reminders: Falling back to local db.");
      } else {
        console.log("Firebase get pending reminders error:", e.message);
      }
    }
  }

  // Local fallback
  const stmt = localDb.prepare('SELECT * FROM reminders WHERE sent = 0 AND remind_at <= ?');
  const rows = stmt.all(now.toISOString()) as any[];
  return rows.map(r => ({
    id: r.id,
    userId: r.user_id,
    message: r.message,
    remindAt: new Date(r.remind_at),
    source: 'local' as const
  }));
}

export async function markReminderSent(id: string | number, source: 'firebase' | 'local') {
  if (source === 'firebase' && firestore) {
    await firestore.collection('reminders').doc(id as string).update({ sent: true });
  } else {
    const stmt = localDb.prepare('UPDATE reminders SET sent = 1 WHERE id = ?');
    stmt.run(id);
  }
}

export interface RecurringReminder {
  id: number;
  userId: string;
  message: string;
  remindAt: Date;
  recurrence: string;
  recurrenceTime: string;
}

export function getRecurringReminders(): RecurringReminder[] {
  try {
    const stmt = localDb.prepare(
      'SELECT id, user_id, message, remind_at, recurrence, recurrence_time FROM reminders WHERE recurrence IS NOT NULL AND sent = 0'
    );
    const rows = stmt.all() as any[];
    return rows.map(r => ({
      id: r.id,
      userId: r.user_id,
      message: r.message,
      remindAt: new Date(r.remind_at),
      recurrence: r.recurrence,
      recurrenceTime: r.recurrence_time,
    }));
  } catch (e) {
    console.error("getRecurringReminders error:", e);
    return [];
  }
}

export function updateReminderNextFire(id: number, nextFireAt: Date): void {
  try {
    const stmt = localDb.prepare('UPDATE reminders SET remind_at = ?, sent = 0 WHERE id = ?');
    stmt.run(nextFireAt.toISOString(), id);
  } catch (e) {
    console.error("updateReminderNextFire error:", e);
  }
}

export async function saveEmbedding(userId: string, content: string, embedding: number[]) {
  try {
    const insertStmt = localDb.prepare('INSERT INTO memory_embeddings (user_id, content, embedding) VALUES (?, ?, ?)');
    insertStmt.run(userId, content, JSON.stringify(embedding));

    // Cleanup: keep only the MEMORY_MAX_EMBEDDINGS most recent embeddings per user
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

export async function getAllEmbeddings(userId: string): Promise<{ content: string, embedding: number[] }[]> {
  try {
    const stmt = localDb.prepare('SELECT content, embedding FROM memory_embeddings WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?');
    const rows = stmt.all(userId, config.MEMORY_MAX_EMBEDDINGS) as any[];
    return rows.map(r => ({
      content: r.content,
      embedding: JSON.parse(r.embedding)
    }));
  } catch (e) {
    console.error("Local DB Embedding Read Error:", e);
    return [];
  }
}

export function setUserProfile(userId: string, key: string, value: string): void {
  try {
    const stmt = localDb.prepare(
      'INSERT INTO user_profile (user_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    );
    stmt.run(userId, key, value, Date.now());
  } catch (e) {
    console.error("User Profile Save Error:", e);
  }
}

export function getUserProfile(userId: string): Record<string, string> {
  try {
    const stmt = localDb.prepare('SELECT key, value FROM user_profile WHERE user_id = ?');
    const rows = stmt.all(userId) as { key: string; value: string }[];
    const profile: Record<string, string> = {};
    for (const row of rows) {
      profile[row.key] = row.value;
    }
    return profile;
  } catch (e) {
    console.error("User Profile Read Error:", e);
    return {};
  }
}

export interface ForexEvent {
  id: string;
  event_date: string;
  event_time?: string;
  currency?: string;
  event_name: string;
  impact: string;
  forecast?: string;
  previous?: string;
  actual?: string;
  fetched_at: string;
}

export function saveForexEvents(events: ForexEvent[]): void {
  try {
    const stmt = localDb.prepare(`
      INSERT OR REPLACE INTO forex_events
        (id, event_date, event_time, currency, event_name, impact, forecast, previous, actual, notified, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `);
    for (const e of events) {
      stmt.run(
        e.id,
        e.event_date,
        e.event_time ?? null,
        e.currency ?? null,
        e.event_name,
        e.impact,
        e.forecast ?? null,
        e.previous ?? null,
        e.actual ?? null,
        e.fetched_at
      );
    }
  } catch (err) {
    console.error("saveForexEvents error:", err);
  }
}

export function getUpcomingHighImpactEvents(minutesAhead: number): ForexEvent[] {
  try {
    const now = new Date();
    const future = new Date(now.getTime() + minutesAhead * 60 * 1000);
    // Events where event_date + event_time falls within [now, now+minutesAhead]
    // Stored as ISO strings or "HH:MM" time on a date string — we compare concatenated datetime
    const stmt = localDb.prepare(`
      SELECT * FROM forex_events
      WHERE impact = 'High'
        AND notified = 0
        AND (event_date || 'T' || COALESCE(event_time, '00:00') || ':00') >= ?
        AND (event_date || 'T' || COALESCE(event_time, '00:00') || ':00') <= ?
    `);
    return stmt.all(now.toISOString(), future.toISOString()) as ForexEvent[];
  } catch (err) {
    console.error("getUpcomingHighImpactEvents error:", err);
    return [];
  }
}

export function markForexEventNotified(id: string): void {
  try {
    const stmt = localDb.prepare('UPDATE forex_events SET notified = 1 WHERE id = ?');
    stmt.run(id);
  } catch (err) {
    console.error("markForexEventNotified error:", err);
  }
}

export interface Lead {
  id: number;
  company_name: string;
  contact_name?: string;
  email?: string;
  phone?: string;
  website?: string;
  industry?: string;
  location?: string;
  source?: string;
  status: string;
  notes?: string;
  created_at: string;
  updated_at: string;
}

export function saveLead(lead: Omit<Lead, 'id' | 'created_at' | 'updated_at'>): number {
  try {
    const now = new Date().toISOString();
    const stmt = localDb.prepare(`
      INSERT INTO leads (company_name, contact_name, email, phone, website, industry, location, source, status, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      lead.company_name,
      lead.contact_name ?? null,
      lead.email ?? null,
      lead.phone ?? null,
      lead.website ?? null,
      lead.industry ?? null,
      lead.location ?? null,
      lead.source ?? null,
      lead.status ?? 'nuevo',
      lead.notes ?? null,
      now,
      now
    );
    return result.lastInsertRowid as number;
  } catch (e) {
    console.error("saveLead error:", e);
    return -1;
  }
}

export function updateLeadStatus(id: number, status: string, notes?: string): void {
  try {
    const now = new Date().toISOString();
    if (notes !== undefined) {
      const stmt = localDb.prepare('UPDATE leads SET status = ?, notes = ?, updated_at = ? WHERE id = ?');
      stmt.run(status, notes, now, id);
    } else {
      const stmt = localDb.prepare('UPDATE leads SET status = ?, updated_at = ? WHERE id = ?');
      stmt.run(status, now, id);
    }
  } catch (e) {
    console.error("updateLeadStatus error:", e);
  }
}

export function getLeads(status?: string): Lead[] {
  try {
    if (status) {
      const stmt = localDb.prepare('SELECT * FROM leads WHERE status = ? ORDER BY created_at DESC');
      return stmt.all(status) as Lead[];
    }
    const stmt = localDb.prepare('SELECT * FROM leads ORDER BY created_at DESC');
    return stmt.all() as Lead[];
  } catch (e) {
    console.error("getLeads error:", e);
    return [];
  }
}

export function searchLeads(query: string): Lead[] {
  try {
    const q = `%${query}%`;
    const stmt = localDb.prepare('SELECT * FROM leads WHERE company_name LIKE ? OR industry LIKE ? OR location LIKE ? ORDER BY created_at DESC');
    return stmt.all(q, q, q) as Lead[];
  } catch (e) {
    console.error("searchLeads error:", e);
    return [];
  }
}

export function deleteLead(id: number): void {
  try {
    const stmt = localDb.prepare('DELETE FROM leads WHERE id = ?');
    stmt.run(id);
  } catch (e) {
    console.error("deleteLead error:", e);
  }
}

export default { firestore, localDb };
