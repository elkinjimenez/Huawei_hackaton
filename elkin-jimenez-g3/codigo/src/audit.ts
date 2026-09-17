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

  /**
   * Bono C — Exporta la trazabilidad completa de un HOLD en formato
   * reproducible: secuencia ordenada de transiciones con timestamps ISO.
   */
  exportHoldTimeline(holdId: string): {
    hold_id: string;
    transitions: Array<{
      step: number;
      seat_id: string;
      from: string;
      to: string;
      reason: string;
      timestamp: string;
      metadata?: unknown;
    }>;
  } {
    const logs = this.getByHold(holdId);
    return {
      hold_id: holdId,
      transitions: logs.map((log, i) => ({
        step: i + 1,
        seat_id: log.seat_id,
        from: log.from_state,
        to: log.to_state,
        reason: log.reason,
        timestamp: new Date(log.timestamp).toISOString(),
        metadata: log.metadata ? JSON.parse(log.metadata) : undefined,
      })),
    };
  }

  /**
   * Bono C — Exporta toda la trazabilidad de un asiento (su "vida").
   */
  exportSeatHistory(seatId: string): {
    seat_id: string;
    history: Array<{
      step: number;
      hold_id: string | null;
      user_id: string | null;
      from: string;
      to: string;
      reason: string;
      timestamp: string;
    }>;
  } {
    const logs = this.getBySeat(seatId);
    return {
      seat_id: seatId,
      history: logs.map((log, i) => ({
        step: i + 1,
        hold_id: log.hold_id,
        user_id: log.user_id,
        from: log.from_state,
        to: log.to_state,
        reason: log.reason,
        timestamp: new Date(log.timestamp).toISOString(),
      })),
    };
  }

  /**
   * Bono C — Exporta todo el log en formato CSV reproducible.
   */
  exportCSV(): string {
    const logs = this.getAll(10000);
    const header = 'id,timestamp,hold_id,user_id,seat_id,from_state,to_state,reason,metadata';
    const rows = logs.map((log) => {
      const ts = new Date(log.timestamp).toISOString();
      const meta = log.metadata ?? '';
      return [
        log.id ?? '',
        ts,
        log.hold_id ?? '',
        log.user_id ?? '',
        log.seat_id,
        log.from_state,
        log.to_state,
        log.reason,
        meta,
      ].map((v) => `"${v}"`).join(',');
    });
    return [header, ...rows].join('\n');
  }

  /**
   * Bono C — Reconstruye el estado completo de un asiento a partir del log.
   * Verifica que las transiciones sean consistentes.
   */
  reconstructSeatState(seatId: string): {
    seat_id: string;
    final_state: string;
    transitions: number;
    consistent: boolean;
    issues: string[];
  } {
    const logs = this.getBySeat(seatId);
    const issues: string[] = [];
    let currentState = 'AVAILABLE'; // estado inicial asumido
    let consistent = true;

    for (let i = 0; i < logs.length; i++) {
      const log = logs[i];
      if (log.from_state !== currentState) {
        issues.push(
          `Paso ${i + 1}: se esperaba from=${currentState} pero el log dice from=${log.from_state}`
        );
        consistent = false;
      }
      currentState = log.to_state;
    }

    return {
      seat_id: seatId,
      final_state: currentState,
      transitions: logs.length,
      consistent,
      issues,
    };
  }

  close(): void {
    this.db.close();
  }
}
