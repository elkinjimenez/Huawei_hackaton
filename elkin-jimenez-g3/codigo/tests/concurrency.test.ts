import { ReservationEngine } from '../src/engine';
import { AuditRepository } from '../src/audit';
import { Seat } from '../src/types';

function makeAudit(): AuditRepository {
  return new AuditRepository(':memory:');
}

function makeSeats(ids: string[], price = 850000): Seat[] {
  return ids.map((id) => ({
    seat_id: id, section: 'VIP', price, currency: 'COP',
    status: 'AVAILABLE' as const, hold_id: null, version: 0,
  }));
}

describe('Bono B - Prueba de concurrencia real', () => {
  test('100 usuarios concurrentes por 1 asiento -> exactamente 1 ganador', async () => {
    const audit = makeAudit();
    const engine = new ReservationEngine({ ttlMs: 120_000, maxSeatsPerUser: 6 }, audit);
    engine.loadSeats(makeSeats(['VIP-A-001']));

    const N = 100;
    const promises: Promise<{ ok: boolean; hold_id?: string }>[] = [];

    for (let i = 0; i < N; i++) {
      promises.push(
        engine.createHold({
          user_id: `usr_${i}`,
          event_id: 'aurora-bogota-2026',
          seat_ids: ['VIP-A-001'],
        }).then((r) => ({ ok: r.ok, hold_id: r.ok ? r.hold.hold_id : undefined }))
      );
    }

    const results = await Promise.all(promises);
    const winners = results.filter((r) => r.ok);
    const rejected = results.filter((r) => !r.ok);

    expect(winners.length).toBe(1);
    expect(rejected.length).toBe(99);
    expect(engine.getSeat('VIP-A-001')!.status).toBe('HELD');
  });

  test('200 usuarios concurrentes por 1 asiento -> exactamente 1 ganador', async () => {
    const audit = makeAudit();
    const engine = new ReservationEngine({ ttlMs: 120_000, maxSeatsPerUser: 6 }, audit);
    engine.loadSeats(makeSeats(['VIP-B-001']));

    const N = 200;
    const promises: Promise<{ ok: boolean }>[] = [];
    for (let i = 0; i < N; i++) {
      promises.push(
        engine.createHold({
          user_id: `usr_${i}`, event_id: 'evt', seat_ids: ['VIP-B-001'],
        }).then((r) => ({ ok: r.ok }))
      );
    }
    const results = await Promise.all(promises);
    const winners = results.filter((r) => r.ok).length;
    expect(winners).toBe(1);
  });

  test('Concurrencia por múltiples asientos: sin overselling', async () => {
    const audit = makeAudit();
    const engine = new ReservationEngine({ ttlMs: 120_000, maxSeatsPerUser: 10 }, audit);
    engine.loadSeats(makeSeats(['S-1', 'S-2', 'S-3']));

    // 50 usuarios intentan reservar los 3 asientos simultáneamente
    const N = 50;
    const promises: Promise<{ ok: boolean; seats?: string[] }>[] = [];
    for (let i = 0; i < N; i++) {
      promises.push(
        engine.createHold({
          user_id: `usr_${i}`, event_id: 'evt', seat_ids: ['S-1', 'S-2', 'S-3'],
        }).then((r) => ({ ok: r.ok, seats: r.ok ? r.hold.seat_ids : undefined }))
      );
    }
    const results = await Promise.all(promises);
    const winners = results.filter((r) => r.ok);
    expect(winners.length).toBe(1);
    // Los 3 asientos deben estar HELD por el mismo hold
    expect(engine.getSeat('S-1')!.status).toBe('HELD');
    expect(engine.getSeat('S-2')!.status).toBe('HELD');
    expect(engine.getSeat('S-3')!.status).toBe('HELD');
  });

  test('Carrera con asientos diferentes: cada asiento tiene 1 ganador', async () => {
    const audit = makeAudit();
    const engine = new ReservationEngine({ ttlMs: 120_000, maxSeatsPerUser: 10 }, audit);
    engine.loadSeats(makeSeats(['D-1', 'D-2', 'D-3']));

    // 30 usuarios por cada asiento (90 total)
    const promises: Promise<{ ok: boolean; seat: string }>[] = [];
    for (const seat of ['D-1', 'D-2', 'D-3']) {
      for (let i = 0; i < 30; i++) {
        promises.push(
          engine.createHold({
            user_id: `usr_${seat}_${i}`, event_id: 'evt', seat_ids: [seat],
          }).then((r) => ({ ok: r.ok, seat }))
        );
      }
    }
    const results = await Promise.all(promises);
    for (const seat of ['D-1', 'D-2', 'D-3']) {
      const winners = results.filter((r) => r.ok && r.seat === seat).length;
      expect(winners).toBe(1);
    }
  });
});
