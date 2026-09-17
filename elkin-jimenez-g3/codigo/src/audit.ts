import Database from 'better-sqlite3';
import { TransitionLog } from './types';

/**
 * Repositorio de trazabilidad en SQLite.
 * Guarda cada transición de estado de asientos y reservas.
 */
export class AuditRepository {
  private db: Database.Database;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hold_id TEXT,
        user_id TEXT,
        seat_id TEXT NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        reason TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_transitions_hold ON transitions(hold_id);
      CREATE INDEX IF NOT EXISTS idx_transitions_seat ON transitions(seat_id);
      CREATE INDEX IF NOT EXISTS idx_transitions_ts ON transitions(timestamp);
    `);
  }

  log(entry: Omit<TransitionLog, 'id'>): void {
    const stmt = this.db.prepare(
      `INSERT INTO transitions (hold_id, user_id, seat_id, from_state, to_state, reason, timestamp, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      entry.hold_id,
      entry.user_id,
      entry.seat_id,
      entry.from_state,
      entry.to_state,
      entry.reason,
      entry.timestamp,
      entry.metadata ?? null
    );
  }

  getByHold(holdId: string): TransitionLog[] {
    const stmt = this.db.prepare(
      `SELECT * FROM transitions WHERE hold_id = ? ORDER BY timestamp ASC`
    );
    return stmt.all(holdId) as TransitionLog[];
  }

  getBySeat(seatId: string): TransitionLog[] {
    const stmt = this.db.prepare(
      `SELECT * FROM transitions WHERE seat_id = ? ORDER BY timestamp ASC`
    );
    return stmt.all(seatId) as TransitionLog[];
  }

  getAll(limit: number = 100): TransitionLog[] {
    const stmt = this.db.prepare(
      `SELECT * FROM transitions ORDER BY timestamp DESC LIMIT ?`
    );
    return stmt.all(limit) as TransitionLog[];
  }

  close(): void {
    this.db.close();
  }
}
