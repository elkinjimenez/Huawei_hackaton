import express from 'express';
import path from 'path';
import { ReservationEngine } from './engine';
import { CheckoutService } from './checkout';
import { MockPaymentService, CircuitBreaker } from './payment';
import { AuditRepository } from './audit';
import { Seat } from './types';

export function createApp(options?: {
  ttlMs?: number;
  maxSeatsPerUser?: number;
  dbPath?: string;
}) {
  const app = express();
  app.use(express.json());

  const audit = new AuditRepository(options?.dbPath ?? ':memory:');
  const engine = new ReservationEngine(
    { ttlMs: options?.ttlMs, maxSeatsPerUser: options?.maxSeatsPerUser },
    audit
  );
  const payment = new MockPaymentService();
  const breaker = new CircuitBreaker();
  const checkout = new CheckoutService(engine, payment, breaker, audit);

  // Cargar asientos iniciales de demo
  const initialSeats = generateDemoSeats();
  engine.loadSeats(initialSeats);

  // Expiración periódica
  const expiryInterval = setInterval(() => engine.expireHolds(), 1000);

  // ---------- API ----------

  // Health
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Config
  app.get('/api/config', (_req, res) => {
    res.json(engine.getConfig());
  });

  app.put('/api/config', (req, res) => {
    const { ttlMs, maxSeatsPerUser } = req.body;
    const cfg: Partial<{ ttlMs: number; maxSeatsPerUser: number }> = {};
    if (typeof ttlMs === 'number') cfg.ttlMs = ttlMs;
    if (typeof maxSeatsPerUser === 'number') cfg.maxSeatsPerUser = maxSeatsPerUser;
    engine.setConfig(cfg);
    res.json(engine.getConfig());
  });

  // Asientos
  app.get('/api/seats', (_req, res) => {
    res.json(engine.getAllSeats());
  });

  app.get('/api/seats/:id', (req, res) => {
    const seat = engine.getSeat(req.params.id);
    if (!seat) return res.status(404).json({ error: 'NOT_FOUND', reason: 'seat_not_found' });
    res.json(seat);
  });

  // Crear HOLD
  app.post('/api/holds', async (req, res) => {
    const idempotencyKey = req.get('Idempotency-Key') || undefined;
    const result = await engine.createHold(req.body, idempotencyKey);
    if (!result.ok) {
      return res.status(400).json(result.error);
    }
    res.status(201).json(engine.toHoldResponse(result.hold));
  });

  // Consultar HOLD
  app.get('/api/holds/:id', (req, res) => {
    const hold = engine.getHold(req.params.id);
    if (!hold) return res.status(404).json({ error: 'NOT_FOUND', reason: 'hold_not_found' });
    res.json(engine.toHoldResponse(hold));
  });

  // Liberar HOLD
  app.post('/api/holds/:id/release', async (req, res) => {
    const ok = await engine.releaseHold(req.params.id, 'manual_release');
    res.json({ released: ok });
  });

  // Confirmar (checkout)
  app.post('/api/holds/:id/confirm', async (req, res) => {
    const idempotencyKey = req.get('Idempotency-Key') || undefined;
    const result = await checkout.confirm(
      { hold_id: req.params.id, payment_token: req.body.payment_token },
      idempotencyKey
    );
    if (!result.ok) {
      const status = result.error.error === 'PAYMENT_SERVICE_UNAVAILABLE' ? 503 : 400;
      return res.status(status).json(result.error);
    }
    res.json(result.response);
  });

  // Simular carrera de concurrencia
  app.post('/api/simulate/race', async (req, res) => {
    const { seat_id, users } = req.body as { seat_id: string; users: number };
    if (!seat_id || !users) {
      return res.status(400).json({ error: 'INVALID_REQUEST', reason: 'seat_id_and_users_required' });
    }
    const results = await runRace(engine, seat_id, users);
    res.json(results);
  });

  // Trazabilidad
  app.get('/api/audit/hold/:id', (req, res) => {
    res.json(audit.getByHold(req.params.id));
  });

  app.get('/api/audit/seat/:id', (req, res) => {
    res.json(audit.getBySeat(req.params.id));
  });

  app.get('/api/audit', (req, res) => {
    const limit = parseInt(req.query.limit as string) || 100;
    res.json(audit.getAll(limit));
  });

  // Circuit breaker
  app.get('/api/breaker', (_req, res) => {
    res.json(checkout.getBreakerStats());
  });

  app.post('/api/breaker/force', (req, res) => {
    const { state } = req.body as { state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' };
    checkout.forceBreakerState(state);
    res.json(checkout.getBreakerStats());
  });

  // Stats
  app.get('/api/stats', (_req, res) => {
    res.json({ ...engine.getStats(), breaker: checkout.getBreakerStats() });
  });

  // ---------- UI ----------
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // Cleanup
  app.locals.audit = audit;
  app.locals.expiryInterval = expiryInterval;

  return app;
}

// ---------- Helpers ----------

function generateDemoSeats(): Seat[] {
  const seats: Seat[] = [];
  const sections = [
    { prefix: 'VIP-A', section: 'VIP-A', price: 850000, count: 10 },
    { prefix: 'VIP-B', section: 'VIP-B', price: 750000, count: 10 },
    { prefix: 'A', section: 'General-A', price: 210000, count: 20 },
    { prefix: 'B', section: 'General-B', price: 180000, count: 20 },
  ];
  for (const sec of sections) {
    for (let i = 1; i <= sec.count; i++) {
      const id = `${sec.prefix}-${String(i).padStart(3, '0')}`;
      seats.push({
        seat_id: id,
        section: sec.section,
        price: sec.price,
        currency: 'COP',
        status: 'AVAILABLE',
        hold_id: null,
        version: 0,
      });
    }
  }
  return seats;
}

async function runRace(engine: ReservationEngine, seatId: string, users: number) {
  const promises: Promise<{ user: string; ok: boolean; hold_id?: string; error?: string }>[] = [];
  for (let i = 0; i < users; i++) {
    const userId = `usr_race_${i}`;
    promises.push(
      engine.createHold({
        user_id: userId,
        event_id: 'aurora-bogota-2026',
        seat_ids: [seatId],
      }).then((r) => ({
        user: userId,
        ok: r.ok,
        hold_id: r.ok ? r.hold.hold_id : undefined,
        error: r.ok ? undefined : r.error.reason,
      }))
    );
  }
  const results = await Promise.all(promises);
  const winners = results.filter((r) => r.ok);
  const rejected = results.filter((r) => !r.ok);
  return {
    seat_id: seatId,
    total_requests: users,
    winners: winners.length,
    rejected: rejected.length,
    winner: winners[0] ?? null,
    details: results,
  };
}
