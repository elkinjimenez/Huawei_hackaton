import express from 'express';
import path from 'path';
import { ReservationEngine } from './engine';
import { CheckoutService } from './checkout';
import { MockPaymentService, CircuitBreaker } from './payment';
import { AuditRepository } from './audit';
import { Waitlist } from './waitlist';
import { GlmExplainer } from './explainer';
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
  const waitlist = new Waitlist();
  const explainer = new GlmExplainer(audit);

  // Cargar asientos iniciales de demo
  const initialSeats = generateDemoSeats();
  engine.loadSeats(initialSeats);

  // Expiración periódica
  const expiryInterval = setInterval(() => {
    engine.expireHolds();
    waitlist.processExpirations();
  }, 1000);

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

  // ---------- Bono A: Sala de espera (Waitlist) ----------
  app.post('/api/waitlist/join', (req, res) => {
    const { user_id, event_id } = req.body;
    if (!user_id || !event_id) {
      return res.status(400).json({ error: 'INVALID_REQUEST', reason: 'user_id_and_event_id_required' });
    }
    const result = waitlist.join(user_id, event_id);
    res.json(result);
  });

  app.post('/api/waitlist/release', (req, res) => {
    const { ticket_id } = req.body;
    const entry = waitlist.release(ticket_id);
    res.json({ released: !!entry, entry });
  });

  app.post('/api/waitlist/leave', (req, res) => {
    const { ticket_id } = req.body;
    const entry = waitlist.leave(ticket_id);
    res.json({ left: !!entry, entry });
  });

  app.get('/api/waitlist/:eventId', (req, res) => {
    res.json(waitlist.getQueue(req.params.eventId));
  });

  app.get('/api/waitlist', (_req, res) => {
    res.json(waitlist.getStats());
  });

  app.get('/api/waitlist/check/:ticketId', (req, res) => {
    res.json({ admitted: waitlist.isAdmitted(req.params.ticketId) });
  });

  // ---------- Bono C: Exportación de auditoría ----------
  app.get('/api/audit/export/hold/:id', (req, res) => {
    res.json(audit.exportHoldTimeline(req.params.id));
  });

  app.get('/api/audit/export/seat/:id', (req, res) => {
    res.json(audit.exportSeatHistory(req.params.id));
  });

  app.get('/api/audit/reconstruct/seat/:id', (req, res) => {
    res.json(audit.reconstructSeatState(req.params.id));
  });

  app.get('/api/audit/export/csv', (_req, res) => {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="nexus_audit.csv"');
    res.send(audit.exportCSV());
  });

  // ---------- Bono D: GLM 5.2 dentro del producto ----------
  app.get('/api/explainer/status', (_req, res) => {
    res.json({ configured: explainer.isConfigured() });
  });

  app.get('/api/explainer/hold/:id', async (req, res) => {
    try {
      const explanation = await explainer.explainHold(req.params.id);
      res.json(explanation);
    } catch (err) {
      res.status(500).json({ error: 'EXPLAINER_ERROR', reason: String(err) });
    }
  });

  app.get('/api/explainer/seat/:id', async (req, res) => {
    try {
      const explanation = await explainer.explainSeat(req.params.id);
      res.json(explanation);
    } catch (err) {
      res.status(500).json({ error: 'EXPLAINER_ERROR', reason: String(err) });
    }
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
