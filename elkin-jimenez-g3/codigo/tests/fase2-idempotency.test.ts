import { ReservationEngine } from '../src/engine';
import { AuditRepository } from '../src/audit';
import { Seat } from '../src/types';

function makeAudit(): AuditRepository {
  return new AuditRepository(':memory:');
}

function makeSeats(ids: string[], price = 210000): Seat[] {
  return ids.map((id) => ({
    seat_id: id, section: 'General', price, currency: 'COP',
    status: 'AVAILABLE' as const, hold_id: null, version: 0,
  }));
}

describe('ReservationEngine - Fase 2: Idempotencia', () => {
  let engine: ReservationEngine;

  beforeEach(() => {
    const audit = makeAudit();
    engine = new ReservationEngine({ ttlMs: 120_000, maxSeatsPerUser: 6 }, audit);
    engine.loadSeats(makeSeats(['A-101', 'A-102', 'A-103']));
  });

  test('Replay con misma Idempotency-Key y mismo payload retorna mismo hold_id', async () => {
    const payload = { user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'] };
    const r1 = await engine.createHold(payload, 'key-001');
    expect(r1.ok).toBe(true);
    const r2 = await engine.createHold(payload, 'key-001');
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r2.hold.hold_id).toBe(r1.hold.hold_id);
    }
  });

  test('Conflicto: misma key con payload diferente', async () => {
    const r1 = await engine.createHold(
      { user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'] }, 'key-002'
    );
    expect(r1.ok).toBe(true);
    const r2 = await engine.createHold(
      { user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-102'] }, 'key-002'
    );
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.error).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('Sin idempotency key, se crean holds distintos', async () => {
    const payload = { user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'] };
    const r1 = await engine.createHold(payload);
    expect(r1.ok).toBe(true);
    // Liberar para poder reservar de nuevo
    if (r1.ok) await engine.releaseHold(r1.hold.hold_id);
    const r2 = await engine.createHold(payload);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r2.hold.hold_id).not.toBe(r1.hold.hold_id);
    }
  });
});
