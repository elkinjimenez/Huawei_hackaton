import { v4 as uuidv4 } from 'uuid';
import { AuditRepository } from './audit';
import {
  Seat, Hold, SeatStatus, HoldStatus,
  HoldResponse, ApiError,
} from './types';

export interface ReservationConfig {
  ttlMs: number;          // tiempo de expiración del HOLD
  maxSeatsPerUser: number; // límite de asientos por usuario
}

export type HoldResult =
  | { ok: true; hold: Hold }
  | { ok: false; error: ApiError };

/**
 * Motor de reservas NEXUS LIVE.
 *
 * Concurrencia segura:
 *  - El mapa de asientos usa un lock global (mutex) para serializar
 *    operaciones críticas (createHold, release, confirm).
 *  - Cada asiento tiene `version` para optimistic locking, aunque el
 *    lock global ya garantiza atomicidad. El version se expone para
 *    trazabilidad y futura escalabilidad.
 *
 * En Node.js (single-threaded event loop) el lock se implementa con
 * una cola de promesas para garantizar que las operaciones async
 * (como pagos) no entrelacen secciones críticas.
 */
export class ReservationEngine {
  private seats = new Map<string, Seat>();
  private holds = new Map<string, Hold>();
  private userActiveSeats = new Map<string, Set<string>>(); // userId -> holdIds
  private idempotencyCache = new Map<string, { payloadHash: string; result: HoldResult }>();

  private config: ReservationConfig;
  private audit: AuditRepository;

  // Mutex simple basado en cola de promesas
  private lockQueue: Promise<unknown> = Promise.resolve();

  constructor(config: Partial<ReservationConfig> = {}, audit: AuditRepository) {
    this.config = {
      ttlMs: config.ttlMs ?? 120_000,
      maxSeatsPerUser: config.maxSeatsPerUser ?? 6,
    };
    this.audit = audit;
  }

  // ---------- Lock ----------
  private async acquireLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const prev = this.lockQueue;
    let release!: () => void;
    this.lockQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  // ---------- Catálogo ----------
  loadSeats(seats: Seat[]): void {
    for (const s of seats) {
      this.seats.set(s.seat_id, { ...s, version: s.version ?? 0 });
    }
  }

  getSeat(seatId: string): Seat | undefined {
    const s = this.seats.get(seatId);
    return s ? { ...s } : undefined;
  }

  getAllSeats(): Seat[] {
    return Array.from(this.seats.values()).map((s) => ({ ...s }));
  }

  getSeatMap(): Map<string, Seat> {
    return new Map(this.seats);
  }

  // ---------- Expiración ----------
  /**
   * Expira los HOLDs vencidos. Debe llamarse periódicamente.
   * Retorna los hold_ids expirados.
   */
  expireHolds(now: number = Date.now()): string[] {
    const expired: string[] = [];
    for (const [holdId, hold] of this.holds) {
      if (hold.status === 'ACTIVE' && hold.expires_at <= now) {
        this.releaseHoldInternal(holdId, 'expired', now);
        expired.push(holdId);
      }
    }
    return expired;
  }

  private releaseHoldInternal(holdId: string, reason: string, now: number): void {
    const hold = this.holds.get(holdId);
    if (!hold) return;
    if (hold.status !== 'ACTIVE') return;

    hold.status = reason === 'expired' ? 'EXPIRED' : 'RELEASED';

    for (const seatId of hold.seat_ids) {
      const seat = this.seats.get(seatId);
      if (seat && seat.status === 'HELD' && seat.hold_id === holdId) {
        const prev = seat.status;
        seat.status = 'AVAILABLE';
        seat.hold_id = null;
        seat.version++;
        this.audit.log({
          hold_id: holdId,
          user_id: hold.user_id,
          seat_id: seatId,
          from_state: prev,
          to_state: 'AVAILABLE',
          reason,
          timestamp: now,
        });
      }
    }

    // limpiar contador de usuario
    const userHolds = this.userActiveSeats.get(hold.user_id);
    if (userHolds) {
      userHolds.delete(holdId);
      if (userHolds.size === 0) this.userActiveSeats.delete(hold.user_id);
    }
  }

  // ---------- Idempotencia ----------
  private hashPayload(payload: unknown): string {
    return JSON.stringify(payload);
  }

  // ---------- Crear HOLD ----------
  async createHold(
    params: { user_id: string; event_id: string; seat_ids: string[] },
    idempotencyKey?: string
  ): Promise<HoldResult> {
    // Validaciones básicas
    if (!params.user_id || params.user_id.trim() === '') {
      return { ok: false, error: { error: 'INVALID_REQUEST', reason: 'user_id_required' } };
    }
    if (!params.seat_ids || params.seat_ids.length === 0) {
      return { ok: false, error: { error: 'INVALID_REQUEST', reason: 'seat_ids_empty' } };
    }
    // duplicados en la misma solicitud
    const unique = new Set(params.seat_ids);
    if (unique.size !== params.seat_ids.length) {
      return { ok: false, error: { error: 'INVALID_REQUEST', reason: 'duplicate_seat_ids' } };
    }

    // Idempotency: replay
    if (idempotencyKey) {
      const cached = this.idempotencyCache.get(idempotencyKey);
      if (cached) {
        if (cached.payloadHash !== this.hashPayload(params)) {
          return {
            ok: false,
            error: { error: 'IDEMPOTENCY_CONFLICT', reason: 'same_key_different_payload' },
          };
        }
        return cached.result;
      }
    }

    const result = await this.acquireLock(() => this.createHoldInternal(params));

    if (idempotencyKey) {
      this.idempotencyCache.set(idempotencyKey, {
        payloadHash: this.hashPayload(params),
        result,
      });
    }

    return result;
  }

  private createHoldInternal(params: {
    user_id: string; event_id: string; seat_ids: string[];
  }): HoldResult {
    const now = Date.now();

    // Expirar antes de operar (best-effort)
    this.expireHolds(now);

    // Verificar límite de asientos por usuario
    const userHolds = this.userActiveSeats.get(params.user_id) ?? new Set();
    let currentActiveSeats = 0;
    for (const hid of userHolds) {
      const h = this.holds.get(hid);
      if (h && h.status === 'ACTIVE') currentActiveSeats += h.seat_ids.length;
    }
    if (currentActiveSeats + params.seat_ids.length > this.config.maxSeatsPerUser) {
      return {
        ok: false,
        error: {
          error: 'LIMIT_EXCEEDED',
          reason: 'max_seats_per_user',
          detail: { limit: this.config.maxSeatsPerUser, current: currentActiveSeats },
        },
      };
    }

    // Verificar que todos los asientos existen y están AVAILABLE (todo-o-nada)
    for (const seatId of params.seat_ids) {
      const seat = this.seats.get(seatId);
      if (!seat) {
        return { ok: false, error: { error: 'NOT_FOUND', reason: 'seat_not_found', detail: { seat_id: seatId } } };
      }
      if (seat.status !== 'AVAILABLE') {
        return {
          ok: false,
          error: { error: 'REJECTED', reason: 'seat_not_available', detail: { seat_id: seatId, status: seat.status } },
        };
      }
    }

    // Crear el HOLD
    const holdId = `hold_${uuidv4().slice(0, 8).toUpperCase()}`;
    const expiresAt = now + this.config.ttlMs;

    let total = 0;
    let currency = 'COP';
    for (const seatId of params.seat_ids) {
      const seat = this.seats.get(seatId)!;
      const prev = seat.status;
      seat.status = 'HELD';
      seat.hold_id = holdId;
      seat.version++;
      total += seat.price;
      currency = seat.currency;
      this.audit.log({
        hold_id: holdId,
        user_id: params.user_id,
        seat_id: seatId,
        from_state: prev,
        to_state: 'HELD',
        reason: 'hold_created',
        timestamp: now,
      });
    }

    const hold: Hold = {
      hold_id: holdId,
      user_id: params.user_id,
      event_id: params.event_id,
      seat_ids: [...params.seat_ids],
      created_at: now,
      expires_at: expiresAt,
      status: 'ACTIVE',
      total,
      currency,
    };
    this.holds.set(holdId, hold);

    if (!this.userActiveSeats.has(params.user_id)) {
      this.userActiveSeats.set(params.user_id, new Set());
    }
    this.userActiveSeats.get(params.user_id)!.add(holdId);

    return { ok: true, hold };
  }

  // ---------- Consultar HOLD ----------
  getHold(holdId: string): Hold | undefined {
    const h = this.holds.get(holdId);
    if (!h) return undefined;
    // Check expiración lazy
    if (h.status === 'ACTIVE' && h.expires_at <= Date.now()) {
      this.releaseHoldInternal(holdId, 'expired', Date.now());
      return this.holds.get(holdId);
    }
    return { ...h };
  }

  toHoldResponse(hold: Hold): HoldResponse {
    const now = Date.now();
    return {
      hold_id: hold.hold_id,
      user_id: hold.user_id,
      event_id: hold.event_id,
      seat_ids: hold.seat_ids,
      status: hold.status,
      total: hold.total,
      currency: hold.currency,
      expires_at: new Date(hold.expires_at).toISOString(),
      created_at: new Date(hold.created_at).toISOString(),
      remaining_ms: Math.max(0, hold.expires_at - now),
    };
  }

  // ---------- Liberar HOLD ----------
  async releaseHold(holdId: string, reason: string = 'manual_release'): Promise<boolean> {
    return this.acquireLock(() => {
      this.releaseHoldInternal(holdId, reason, Date.now());
      return this.holds.get(holdId)?.status === 'RELEASED' || this.holds.get(holdId)?.status === 'EXPIRED';
    });
  }

  // ---------- Confirmar (HELD -> SOLD) ----------
  /**
   * Marca los asientos de un HOLD como SOLD.
   * Debe llamarse solo después de que el pago fue aprobado.
   */
  async confirmHold(holdId: string, reason: string = 'payment_approved'): Promise<{
    ok: boolean;
    hold?: Hold;
    error?: ApiError;
  }> {
    return this.acquireLock(() => {
      const now = Date.now();
      const hold = this.holds.get(holdId);
      if (!hold) {
        return { ok: false, error: { error: 'NOT_FOUND', reason: 'hold_not_found' } };
      }
      if (hold.status === 'CONFIRMED') {
        return { ok: false, error: { error: 'ALREADY_CONFIRMED', reason: 'hold_already_sold' } };
      }
      if (hold.status === 'EXPIRED' || hold.status === 'RELEASED') {
        return { ok: false, error: { error: 'HOLD_EXPIRED', reason: 'hold_no_longer_valid' } };
      }
      if (hold.status !== 'ACTIVE') {
        return { ok: false, error: { error: 'INVALID_STATE', reason: `hold_status_${hold.status}` } };
      }
      // Verificar que no haya expirado
      if (hold.expires_at <= now) {
        this.releaseHoldInternal(holdId, 'expired', now);
        return { ok: false, error: { error: 'HOLD_EXPIRED', reason: 'hold_expired_before_confirm' } };
      }

      // Marcar asientos como SOLD
      for (const seatId of hold.seat_ids) {
        const seat = this.seats.get(seatId);
        if (!seat || seat.status !== 'HELD' || seat.hold_id !== holdId) {
          // Estado inconsistente - abortar
          return { ok: false, error: { error: 'INCONSISTENT_STATE', reason: 'seat_not_held', detail: { seat_id: seatId } } };
        }
      }
      for (const seatId of hold.seat_ids) {
        const seat = this.seats.get(seatId)!;
        const prev = seat.status;
        seat.status = 'SOLD';
        seat.hold_id = null;
        seat.version++;
        this.audit.log({
          hold_id: holdId,
          user_id: hold.user_id,
          seat_id: seatId,
          from_state: prev,
          to_state: 'SOLD',
          reason,
          timestamp: now,
        });
      }

      hold.status = 'CONFIRMED';
      // limpiar contador de usuario
      const userHolds = this.userActiveSeats.get(hold.user_id);
      if (userHolds) {
        userHolds.delete(holdId);
        if (userHolds.size === 0) this.userActiveSeats.delete(hold.user_id);
      }

      return { ok: true, hold };
    });
  }

  // ---------- Stats ----------
  getStats() {
    let available = 0, held = 0, sold = 0;
    for (const s of this.seats.values()) {
      if (s.status === 'AVAILABLE') available++;
      else if (s.status === 'HELD') held++;
      else sold++;
    }
    return {
      total_seats: this.seats.size,
      available,
      held,
      sold,
      active_holds: Array.from(this.holds.values()).filter((h) => h.status === 'ACTIVE').length,
      config: this.config,
    };
  }

  getConfig(): ReservationConfig {
    return { ...this.config };
  }

  setConfig(partial: Partial<ReservationConfig>): void {
    this.config = { ...this.config, ...partial };
  }
}
