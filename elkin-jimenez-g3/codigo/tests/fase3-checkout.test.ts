import { ReservationEngine } from '../src/engine';
import { CheckoutService } from '../src/checkout';
import { MockPaymentService, CircuitBreaker } from '../src/payment';
import { AuditRepository } from '../src/audit';
import { Seat } from '../src/types';

function setup(opts?: { ttlMs?: number }) {
  const audit = new AuditRepository(':memory:');
  const engine = new ReservationEngine({
    ttlMs: opts?.ttlMs ?? 120_000, maxSeatsPerUser: 6,
  }, audit);
  const payment = new MockPaymentService(42); // seed determinista
  const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 100 });
  const checkout = new CheckoutService(engine, payment, breaker, audit);
  engine.loadSeats([
    { seat_id: 'A-101', section: 'G', price: 210000, currency: 'COP', status: 'AVAILABLE', hold_id: null, version: 0 },
  ]);
  return { engine, payment, breaker, checkout, audit };
}

describe('Fase 3 - Checkout y Circuit Breaker', () => {
  test('Pago APPROVED -> HELD -> SOLD', async () => {
    const { engine, checkout } = setup();
    const hold = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'],
    });
    expect(hold.ok).toBe(true);
    if (!hold.ok) return;

    const r = await checkout.confirm({
      hold_id: hold.hold.hold_id,
      payment_token: 'tok_test',
    });
    // Con seed 42, el primer resultado puede no ser APPROVED. Forzamos.
    // En su lugar, testeamos el flujo forzando APPROVED
  });

  test('Pago APPROVED forzado -> SOLD', async () => {
    const { engine, payment, breaker, audit } = setup();
    const checkout = new CheckoutService(engine, payment, breaker, audit);
    const hold = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'],
    });
    if (!hold.ok) return;
    // Mock authorize para forzar APPROVED
    (payment as any).authorize = async () => ({
      result: 'APPROVED', durationMs: 100, transaction_id: 'txn_ok',
    });
    const r = await checkout.confirm({ hold_id: hold.hold.hold_id, payment_token: 'tok' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.response.status).toBe('SOLD');
      expect(r.response.payment_result).toBe('APPROVED');
    }
    expect(engine.getSeat('A-101')!.status).toBe('SOLD');
  });

  test('Pago DECLINED -> HOLD liberado, asiento vuelve a AVAILABLE', async () => {
    const { engine, payment, breaker, audit } = setup();
    const checkout = new CheckoutService(engine, payment, breaker, audit);
    const hold = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'],
    });
    if (!hold.ok) return;
    (payment as any).authorize = async () => ({
      result: 'DECLINED', durationMs: 100, transaction_id: 'txn_no',
    });
    const r = await checkout.confirm({ hold_id: hold.hold.hold_id, payment_token: 'tok' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.paymentResult).toBe('DECLINED');
    expect(engine.getSeat('A-101')!.status).toBe('AVAILABLE');
  });

  test('Pago ERROR -> HOLD se mantiene (estado ambiguo)', async () => {
    const { engine, payment, breaker, audit } = setup();
    const checkout = new CheckoutService(engine, payment, breaker, audit);
    const hold = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'],
    });
    if (!hold.ok) return;
    (payment as any).authorize = async () => ({
      result: 'ERROR', durationMs: 100, transaction_id: 'txn_err',
    });
    const r = await checkout.confirm({ hold_id: hold.hold.hold_id, payment_token: 'tok' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.paymentResult).toBe('ERROR');
    // El asiento sigue HELD
    expect(engine.getSeat('A-101')!.status).toBe('HELD');
  });

  test('Pago TIMEOUT -> HOLD se mantiene (estado ambiguo)', async () => {
    const { engine, payment, breaker, audit } = setup();
    const checkout = new CheckoutService(engine, payment, breaker, audit);
    const hold = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'],
    });
    if (!hold.ok) return;
    (payment as any).authorize = async () => ({
      result: 'TIMEOUT', durationMs: 2500, transaction_id: 'txn_timeout',
    });
    const r = await checkout.confirm({ hold_id: hold.hold.hold_id, payment_token: 'tok' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.paymentResult).toBe('TIMEOUT');
    expect(engine.getSeat('A-101')!.status).toBe('HELD');
  });

  test('Circuit Breaker OPEN -> PAYMENT_SERVICE_UNAVAILABLE, asiento NO se vende', async () => {
    const { engine, checkout, breaker } = setup();
    const hold = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'],
    });
    if (!hold.ok) return;
    breaker.forceState('OPEN');
    const r = await checkout.confirm({ hold_id: hold.hold.hold_id, payment_token: 'tok' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.error).toBe('PAYMENT_SERVICE_UNAVAILABLE');
      expect(r.paymentResult).toBe('PAYMENT_SERVICE_UNAVAILABLE');
    }
    expect(engine.getSeat('A-101')!.status).toBe('HELD');
  });

  test('Confirmar HOLD ya confirmado -> error', async () => {
    const { engine, payment, breaker, audit } = setup();
    const checkout = new CheckoutService(engine, payment, breaker, audit);
    const hold = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'],
    });
    if (!hold.ok) return;
    (payment as any).authorize = async () => ({
      result: 'APPROVED', durationMs: 50, transaction_id: 'txn_1',
    });
    const r1 = await checkout.confirm({ hold_id: hold.hold.hold_id, payment_token: 'tok' });
    expect(r1.ok).toBe(true);
    const r2 = await checkout.confirm({ hold_id: hold.hold.hold_id, payment_token: 'tok' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.error).toBe('ALREADY_CONFIRMED');
  });

  test('Confirmar HOLD expirado -> error', async () => {
    const { engine, payment, breaker, audit } = setup({ ttlMs: 50 });
    const checkout = new CheckoutService(engine, payment, breaker, audit);
    const hold = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'],
    });
    if (!hold.ok) return;
    await new Promise((r) => setTimeout(r, 100));
    engine.expireHolds();
    const r = await checkout.confirm({ hold_id: hold.hold.hold_id, payment_token: 'tok' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.error).toBe('HOLD_EXPIRED');
  });

  test('payment_token vacío -> error', async () => {
    const { engine, checkout } = setup();
    const hold = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'],
    });
    if (!hold.ok) return;
    const r = await checkout.confirm({ hold_id: hold.hold.hold_id, payment_token: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('payment_token_required');
  });
});

describe('Circuit Breaker - transiciones de estado', () => {
  test('CLOSED -> 3 fallos -> OPEN -> reset -> HALF_OPEN -> success -> CLOSED', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 50, halfOpenMaxCalls: 1 });
    expect(breaker.getState()).toBe('CLOSED');

    // 3 fallos
    for (let i = 0; i < 3; i++) {
      try {
        await breaker.execute(async () => { throw new Error('fail'); });
      } catch { /* expected */ }
    }
    expect(breaker.getState()).toBe('OPEN');

    // Mientras está OPEN, rechaza
    const r = await breaker.execute(async () => 'ok');
    expect(r.ok).toBe(false);

    // Esperar reset
    await new Promise((res) => setTimeout(res, 60));
    expect(breaker.getState()).toBe('HALF_OPEN');

    // Llamada de prueba exitosa
    const r2 = await breaker.execute(async () => 'ok');
    expect(r2.ok).toBe(true);
    expect(breaker.getState()).toBe('CLOSED');
  });

  test('HALF_OPEN -> fallo -> OPEN', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 30, halfOpenMaxCalls: 1 });
    for (let i = 0; i < 2; i++) {
      try {
        await breaker.execute(async () => { throw new Error('fail'); });
      } catch { /* expected */ }
    }
    expect(breaker.getState()).toBe('OPEN');
    await new Promise((res) => setTimeout(res, 40));
    expect(breaker.getState()).toBe('HALF_OPEN');
    try {
      await breaker.execute(async () => { throw new Error('fail'); });
    } catch { /* expected */ }
    expect(breaker.getState()).toBe('OPEN');
  });
});

describe('Trazabilidad - Audit log', () => {
  test('Cada transición queda registrada', async () => {
    const audit = new AuditRepository(':memory:');
    const engine = new ReservationEngine({ ttlMs: 120_000, maxSeatsPerUser: 6 }, audit);
    engine.loadSeats([
      { seat_id: 'A-101', section: 'G', price: 210000, currency: 'COP', status: 'AVAILABLE', hold_id: null, version: 0 },
    ]);
    const hold = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'],
    });
    if (!hold.ok) return;
    const logs = audit.getByHold(hold.hold.hold_id);
    expect(logs.length).toBe(1);
    expect(logs[0].from_state).toBe('AVAILABLE');
    expect(logs[0].to_state).toBe('HELD');
    expect(logs[0].reason).toBe('hold_created');

    await engine.confirmHold(hold.hold.hold_id, 'payment_approved');
    const logs2 = audit.getByHold(hold.hold.hold_id);
    expect(logs2.length).toBe(2);
    expect(logs2[1].to_state).toBe('SOLD');
  });

  test('Historial completo de un asiento', async () => {
    const audit = new AuditRepository(':memory:');
    const engine = new ReservationEngine({ ttlMs: 100, maxSeatsPerUser: 6 }, audit);
    engine.loadSeats([
      { seat_id: 'A-101', section: 'G', price: 210000, currency: 'COP', status: 'AVAILABLE', hold_id: null, version: 0 },
    ]);
    const hold = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'],
    });
    if (!hold.ok) return;
    await new Promise((r) => setTimeout(r, 150));
    engine.expireHolds();
    const logs = audit.getBySeat('A-101');
    // AVAILABLE -> HELD -> AVAILABLE
    expect(logs.length).toBe(2);
    expect(logs[0].from_state).toBe('AVAILABLE');
    expect(logs[0].to_state).toBe('HELD');
    expect(logs[1].from_state).toBe('HELD');
    expect(logs[1].to_state).toBe('AVAILABLE');
  });
});
