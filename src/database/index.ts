import admin from 'firebase-admin';
import { config } from '../config/index.js';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

let firestore: FirebaseFirestore.Firestore | null = null;
let localDb: any = null;

// Initialize Local SQLite Fallback
const localDbPath = path.resolve(process.cwd(), 'memory.db');
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
    sent BOOLEAN DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS memory_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

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
export async function getHistory(userId: string, limit: number = 20) {
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

export async function createReminder(userId: string, message: string, remindAt: Date) {
  try {
    const stmt = localDb.prepare('INSERT INTO reminders (user_id, message, remind_at, sent) VALUES (?, ?, ?, 0)');
    stmt.run(userId, message, remindAt.toISOString());
  } catch (e) {
    console.error("Local DB Reminder Save Error:", e);
  }

  if (firestore) {
    try {
      await firestore.collection('reminders').add({
        userId,
        message,
        remindAt: admin.firestore.Timestamp.fromDate(remindAt),
        sent: false
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

export async function saveEmbedding(userId: string, content: string, embedding: number[]) {
  try {
    const stmt = localDb.prepare('INSERT INTO memory_embeddings (user_id, content, embedding) VALUES (?, ?, ?)');
    stmt.run(userId, content, JSON.stringify(embedding));
  } catch (e) {
    console.error("Local DB Embedding Save Error:", e);
  }
}

export async function getAllEmbeddings(userId: string): Promise<{ content: string, embedding: number[] }[]> {
  try {
    const stmt = localDb.prepare('SELECT content, embedding FROM memory_embeddings WHERE user_id = ?');
    const rows = stmt.all(userId) as any[];
    return rows.map(r => ({
      content: r.content,
      embedding: JSON.parse(r.embedding)
    }));
  } catch (e) {
    console.error("Local DB Embedding Read Error:", e);
    return [];
  }
}

export default { firestore, localDb };
