import { ReservationEngine } from '../src/engine';
import { AuditRepository } from '../src/audit';
import { Seat } from '../src/types';

function makeAudit(): AuditRepository {
  return new AuditRepository(':memory:');
}

function makeSeats(ids: string[], price = 210000): Seat[] {
  return ids.map((id) => ({
    seat_id: id,
    section: 'General',
    price,
    currency: 'COP',
    status: 'AVAILABLE',
    hold_id: null,
    version: 0,
  }));
}

describe('ReservationEngine - Fase 1: Motor de reservas', () => {
  let engine: ReservationEngine;

  beforeEach(() => {
    const audit = makeAudit();
    engine = new ReservationEngine({ ttlMs: 120_000, maxSeatsPerUser: 6 }, audit);
    engine.loadSeats(makeSeats(['A-101', 'A-102', 'A-103']));
  });

  test('Crear HOLD exitoso', async () => {
    const r = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101', 'A-102'],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.hold.seat_ids).toEqual(['A-101', 'A-102']);
      expect(r.hold.status).toBe('ACTIVE');
      expect(r.hold.total).toBe(420000);
    }
  });

  test('Reserva todo-o-nada: si un asiento no está disponible, falla completo', async () => {
    // Primera reserva exitosa
    await engine.createHold({ user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'] });
    // Segunda reserva incluye A-101 (ya HELD) y A-102 (AVAILABLE)
    const r = await engine.createHold({
      user_id: 'usr_2', event_id: 'evt', seat_ids: ['A-101', 'A-102'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.reason).toBe('seat_not_available');
    }
    // A-102 debe seguir AVAILABLE (no se reservó parcialmente)
    expect(engine.getSeat('A-102')!.status).toBe('AVAILABLE');
  });

  test('Segundo usuario no puede reservar asiento en HELD', async () => {
    await engine.createHold({ user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'] });
    const r = await engine.createHold({ user_id: 'usr_2', event_id: 'evt', seat_ids: ['A-101'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('seat_not_available');
  });

  test('Expiración automática: HELD -> AVAILABLE tras TTL', async () => {
    const audit = makeAudit();
    const eng = new ReservationEngine({ ttlMs: 100, maxSeatsPerUser: 6 }, audit);
    eng.loadSeats(makeSeats(['A-101']));
    await eng.createHold({ user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'] });
    expect(eng.getSeat('A-101')!.status).toBe('HELD');
    await new Promise((r) => setTimeout(r, 200));
    eng.expireHolds();
    expect(eng.getSeat('A-101')!.status).toBe('AVAILABLE');
  });

  test('Límite de asientos por usuario', async () => {
    const audit = makeAudit();
    const eng = new ReservationEngine({ ttlMs: 120_000, maxSeatsPerUser: 4 }, audit);
    eng.loadSeats(makeSeats(['A-101', 'A-102', 'A-103', 'A-104', 'A-105']));
    // Reservar 4 (ok)
    const r1 = await eng.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101', 'A-102', 'A-103', 'A-104'],
    });
    expect(r1.ok).toBe(true);
    // Intentar 1 más (excede límite de 4)
    const r2 = await eng.createHold({ user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-105'] });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.reason).toBe('max_seats_per_user');
  });

  test('El precio lo controla el servidor', async () => {
    const r = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101', 'A-102'],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.hold.total).toBe(420000); // 2 * 210000
  });

  test('Validación: seat_ids vacío', async () => {
    const r = await engine.createHold({ user_id: 'usr_1', event_id: 'evt', seat_ids: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('seat_ids_empty');
  });

  test('Validación: asiento inexistente', async () => {
    const r = await engine.createHold({ user_id: 'usr_1', event_id: 'evt', seat_ids: ['X-999'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('seat_not_found');
  });

  test('Validación: duplicados en la solicitud', async () => {
    const r = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101', 'A-101'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('duplicate_seat_ids');
  });

  test('Validación: user_id vacío', async () => {
    const r = await engine.createHold({ user_id: '', event_id: 'evt', seat_ids: ['A-101'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('user_id_required');
  });
});
