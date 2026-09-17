import { AuditRepository } from '../src/audit';
import { ReservationEngine } from '../src/engine';
import { CheckoutService } from '../src/checkout';
import { MockPaymentService, CircuitBreaker } from '../src/payment';
import { Seat } from '../src/types';

function setup() {
  const audit = new AuditRepository(':memory:');
  const engine = new ReservationEngine({ ttlMs: 120_000, maxSeatsPerUser: 6 }, audit);
  const payment = new MockPaymentService(42);
  const breaker = new CircuitBreaker();
  const checkout = new CheckoutService(engine, payment, breaker, audit);
  engine.loadSeats([
    { seat_id: 'A-101', section: 'G', price: 210000, currency: 'COP', status: 'AVAILABLE', hold_id: null, version: 0 },
    { seat_id: 'A-102', section: 'G', price: 210000, currency: 'COP', status: 'AVAILABLE', hold_id: null, version: 0 },
  ]);
  return { audit, engine, payment, breaker, checkout };
}

describe('Bono C - Registro de auditoría reproducible', () => {
  test('Exportar línea de tiempo completa de un HOLD', async () => {
    const { engine, audit } = setup();
    const hold = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101', 'A-102'],
    });
    if (!hold.ok) return;
    await engine.confirmHold(hold.hold.hold_id, 'payment_approved');

    const timeline = audit.exportHoldTimeline(hold.hold.hold_id);
    expect(timeline.hold_id).toBe(hold.hold.hold_id);
    // 2 asientos × 2 transiciones (HELD + SOLD) = 4
    expect(timeline.transitions.length).toBe(4);
    expect(timeline.transitions[0].from).toBe('AVAILABLE');
    expect(timeline.transitions[0].to).toBe('HELD');
    expect(timeline.transitions[2].from).toBe('HELD');
    expect(timeline.transitions[2].to).toBe('SOLD');
  });

  test('Exportar historial de un asiento (su "vida")', async () => {
    const { engine, audit } = setup();
    const hold = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'],
    });
    if (!hold.ok) return;
    await engine.confirmHold(hold.hold.hold_id, 'payment_approved');

    const history = audit.exportSeatHistory('A-101');
    expect(history.seat_id).toBe('A-101');
    expect(history.history.length).toBe(2);
    expect(history.history[0].from).toBe('AVAILABLE');
    expect(history.history[0].to).toBe('HELD');
    expect(history.history[1].from).toBe('HELD');
    expect(history.history[1].to).toBe('SOLD');
  });

  test('Reconstruir estado de un asiento y verificar consistencia', async () => {
    const { engine, audit } = setup();
    const hold = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'],
    });
    if (!hold.ok) return;
    await engine.confirmHold(hold.hold.hold_id, 'payment_approved');

    const recon = audit.reconstructSeatState('A-101');
    expect(recon.seat_id).toBe('A-101');
    expect(recon.final_state).toBe('SOLD');
    expect(recon.transitions).toBe(2);
    expect(recon.consistent).toBe(true);
    expect(recon.issues.length).toBe(0);
  });

  test('Reconstruir detecta inconsistencias', async () => {
    const audit = new AuditRepository(':memory:');
    // Insertar transiciones inconsistentes manualmente
    audit.log({
      hold_id: 'h1', user_id: 'u1', seat_id: 'S-1',
      from_state: 'AVAILABLE', to_state: 'HELD',
      reason: 'test', timestamp: Date.now(),
    });
    audit.log({
      hold_id: 'h1', user_id: 'u1', seat_id: 'S-1',
      from_state: 'AVAILABLE', to_state: 'SOLD', // from debería ser HELD
      reason: 'test', timestamp: Date.now() + 1,
    });
    const recon = audit.reconstructSeatState('S-1');
    expect(recon.consistent).toBe(false);
    expect(recon.issues.length).toBeGreaterThan(0);
  });

  test('Exportar CSV reproducible', async () => {
    const { engine, audit } = setup();
    await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'],
    });
    const csv = audit.exportCSV();
    const lines = csv.split('\n');
    expect(lines[0]).toContain('id,timestamp,hold_id');
    expect(lines.length).toBeGreaterThan(1); // header + al menos 1 fila
    expect(csv).toContain('A-101');
    expect(csv).toContain('AVAILABLE');
    expect(csv).toContain('HELD');
  });

  test('Ciclo completo: AVAILABLE → HELD → SOLD es trazable y reproducible', async () => {
    const { engine, audit, payment, breaker } = setup();
    const checkout = new CheckoutService(engine, payment, breaker, audit);
    const hold = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'],
    });
    if (!hold.ok) return;
    (payment as any).authorize = async () => ({
      result: 'APPROVED', durationMs: 50, transaction_id: 'txn_ok',
    });
    await checkout.confirm({ hold_id: hold.hold.hold_id, payment_token: 'tok' });

    // Verificar trazabilidad completa
    const timeline = audit.exportHoldTimeline(hold.hold.hold_id);
    const history = audit.exportSeatHistory('A-101');
    const recon = audit.reconstructSeatState('A-101');

    // La línea de tiempo muestra AVAILABLE → HELD → SOLD
    expect(timeline.transitions.length).toBeGreaterThanOrEqual(2);
    expect(history.history.length).toBeGreaterThanOrEqual(2);
    expect(recon.final_state).toBe('SOLD');
    expect(recon.consistent).toBe(true);
  });

  test('Ciclo con expiración: AVAILABLE → HELD → AVAILABLE es trazable', async () => {
    const audit = new AuditRepository(':memory:');
    const engine = new ReservationEngine({ ttlMs: 50, maxSeatsPerUser: 6 }, audit);
    engine.loadSeats([
      { seat_id: 'A-101', section: 'G', price: 210000, currency: 'COP', status: 'AVAILABLE', hold_id: null, version: 0 },
    ]);
    const hold = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'],
    });
    if (!hold.ok) return;
    await new Promise((r) => setTimeout(r, 100));
    engine.expireHolds();

    const recon = audit.reconstructSeatState('A-101');
    expect(recon.final_state).toBe('AVAILABLE');
    expect(recon.transitions).toBe(2);
    expect(recon.consistent).toBe(true);
  });
});
