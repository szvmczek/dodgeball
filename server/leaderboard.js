// Leaderboard with optional SQLite. Falls back to in-memory if better-sqlite3 unavailable.
import fs from 'node:fs';
import path from 'node:path';

let Database = null;
try {
  ({ default: Database } = await import('better-sqlite3'));
} catch (e) {
  Database = null;
}

export class Leaderboard {
  constructor(dataDir) {
    this.dataDir = dataDir || './data';
    this.memory = new Map();   // nick → {nick, wins, hits, catches}
    this.db = null;
    if (Database) {
      try {
        fs.mkdirSync(this.dataDir, { recursive: true });
        const dbPath = path.join(this.dataDir, 'leaderboard.db');
        this.db = new Database(dbPath);
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS players (
            nick TEXT PRIMARY KEY,
            wins INTEGER NOT NULL DEFAULT 0,
            hits INTEGER NOT NULL DEFAULT 0,
            catches INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0
          )
        `);
      } catch (e) {
        console.warn('[leaderboard] sqlite init failed, falling back to memory:', e.message);
        this.db = null;
      }
    } else {
      console.warn('[leaderboard] better-sqlite3 not installed, using in-memory store');
    }
  }

  recordWin(nick) {
    if (!nick) return;
    const now = Date.now();
    if (this.db) {
      const upsert = this.db.prepare(`
        INSERT INTO players (nick, wins, updated_at) VALUES (?, 1, ?)
        ON CONFLICT(nick) DO UPDATE SET wins = wins + 1, updated_at = excluded.updated_at
      `);
      upsert.run(nick, now);
    } else {
      const r = this.memory.get(nick) || { nick, wins: 0, hits: 0, catches: 0 };
      r.wins++;
      this.memory.set(nick, r);
    }
  }

  recordStats(nick, hits, catches) {
    if (!nick) return;
    const now = Date.now();
    hits = hits | 0;
    catches = catches | 0;
    if (this.db) {
      const upsert = this.db.prepare(`
        INSERT INTO players (nick, hits, catches, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(nick) DO UPDATE SET hits = hits + excluded.hits, catches = catches + excluded.catches, updated_at = excluded.updated_at
      `);
      upsert.run(nick, hits, catches, now);
    } else {
      const r = this.memory.get(nick) || { nick, wins: 0, hits: 0, catches: 0 };
      r.hits += hits;
      r.catches += catches;
      this.memory.set(nick, r);
    }
  }

  top(n = 20) {
    if (this.db) {
      return this.db.prepare(`
        SELECT nick, wins, hits, catches FROM players
        ORDER BY wins DESC, hits DESC, catches DESC
        LIMIT ?
      `).all(n);
    }
    return [...this.memory.values()]
      .sort((a, b) => b.wins - a.wins || b.hits - a.hits || b.catches - a.catches)
      .slice(0, n);
  }
}
