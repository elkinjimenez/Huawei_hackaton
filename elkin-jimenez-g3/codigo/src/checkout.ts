import { v4 as uuidv4 } from 'uuid';
import { ReservationEngine } from './engine';
import { MockPaymentService, CircuitBreaker } from './payment';
import { AuditRepository } from './audit';
import {
  ConfirmResponse, ApiError, PaymentResult,
} from './types';

export type ConfirmResult =
  | { ok: true; response: ConfirmResponse }
  | { ok: false; error: ApiError; paymentResult?: PaymentResult | 'PAYMENT_SERVICE_UNAVAILABLE' };

/**
 * Servicio de checkout.
 *
 * Estrategia ante fallos del proveedor de pagos:
 *  - APPROVED  -> HELD -> SOLD, confirmación creada.
 *  - DECLINED  -> se libera el HOLD inmediatamente (asientos vuelven a AVAILABLE).
 *  - ERROR     -> NO se libera el HOLD. Se marca el pago como fallido pero el
 *                  HOLD sigue activo hasta expirar. El cliente puede reintentar.
 *                  Razón: un error ambiguo no implica rechazo.
 *  - TIMEOUT   -> igual que ERROR. No se libera ni se confirma. El cliente puede
 *                  reintentar con la misma idempotency-key. Si el pago realmente
 *                  se procesó, el reintento detectará que ya fue aprobado (futuro).
 *
 * El circuit breaker protege contra proveedor caído:
 *  - OPEN -> no se llama al proveedor, se retorna PAYMENT_SERVICE_UNAVAILABLE.
 *            El HOLD NO se marca como SOLD. El cliente puede reintentar más tarde.
 */
export class CheckoutService {
  private engine: ReservationEngine;
  private payment: MockPaymentService;
  private breaker: CircuitBreaker;
  private audit: AuditRepository;

  // Idempotencia de confirmación: key -> resultado
  private confirmCache = new Map<string, ConfirmResult>();

  constructor(
    engine: ReservationEngine,
    payment: MockPaymentService,
    breaker: CircuitBreaker,
    audit: AuditRepository
  ) {
    this.engine = engine;
    this.payment = payment;
    this.breaker = breaker;
    this.audit = audit;
  }

  async confirm(
    params: { hold_id: string; payment_token: string },
    idempotencyKey?: string
  ): Promise<ConfirmResult> {
    if (!params.payment_token || params.payment_token.trim() === '') {
      return { ok: false, error: { error: 'INVALID_REQUEST', reason: 'payment_token_required' } };
    }

    // Idempotency replay
    if (idempotencyKey) {
      const cached = this.confirmCache.get(idempotencyKey);
      if (cached) return cached;
    }

    const result = await this.confirmInternal(params);
    if (idempotencyKey) {
      this.confirmCache.set(idempotencyKey, result);
    }
    return result;
  }

  private async confirmInternal(params: {
    hold_id: string; payment_token: string;
  }): Promise<ConfirmResult> {
    const hold = this.engine.getHold(params.hold_id);
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

    // Circuit breaker
    const breakerState = this.breaker.getState();
    if (breakerState === 'OPEN') {
      return {
        ok: false,
        error: { error: 'PAYMENT_SERVICE_UNAVAILABLE', reason: 'circuit_breaker_open' },
        paymentResult: 'PAYMENT_SERVICE_UNAVAILABLE',
      };
    }

    // Llamar al proveedor a través del circuit breaker
    let paymentResult: PaymentResult;
    let txnId: string;
    try {
      const exec = await this.breaker.execute(() =>
        this.payment.authorize(params.payment_token, hold.total)
      );
      if (!exec.ok) {
        return {
          ok: false,
          error: { error: 'PAYMENT_SERVICE_UNAVAILABLE', reason: 'circuit_breaker_open' },
          paymentResult: 'PAYMENT_SERVICE_UNAVAILABLE',
        };
      }
      paymentResult = exec.result.result;
      txnId = exec.result.transaction_id;
    } catch {
      // El breaker lanzó excepción (transición a OPEN)
      return {
        ok: false,
        error: { error: 'PAYMENT_SERVICE_UNAVAILABLE', reason: 'circuit_breaker_open' },
        paymentResult: 'PAYMENT_SERVICE_UNAVAILABLE',
      };
    }

    // Procesar según resultado
    const now = Date.now();

    if (paymentResult === 'APPROVED') {
      const confirm = await this.engine.confirmHold(params.hold_id, 'payment_approved');
      if (!confirm.ok) {
        return {
          ok: false,
          error: confirm.error!,
          paymentResult,
        };
      }
      const confirmationId = `conf_${uuidv4().slice(0, 8).toUpperCase()}`;
      // Log de auditoría adicional
      for (const seatId of hold.seat_ids) {
        this.audit.log({
          hold_id: params.hold_id,
          user_id: hold.user_id,
          seat_id: seatId,
          from_state: 'HELD',
          to_state: 'SOLD',
          reason: `payment_approved:${txnId}`,
          timestamp: now,
          metadata: JSON.stringify({ confirmation_id: confirmationId, txn: txnId }),
        });
      }
      return {
        ok: true,
        response: {
          hold_id: params.hold_id,
          status: 'SOLD',
          payment_result: 'APPROVED',
          confirmation_id: confirmationId,
          seats: hold.seat_ids.map((s) => ({ seat_id: s, status: 'SOLD' as const })),
          total: hold.total,
          currency: hold.currency,
        },
      };
    }

    if (paymentResult === 'DECLINED') {
      // Liberar el HOLD: pago rechazado -> asientos vuelven a AVAILABLE
      await this.engine.releaseHold(params.hold_id, 'payment_declined');
      for (const seatId of hold.seat_ids) {
        this.audit.log({
          hold_id: params.hold_id,
          user_id: hold.user_id,
          seat_id: seatId,
          from_state: 'HELD',
          to_state: 'AVAILABLE',
          reason: `payment_declined:${txnId}`,
          timestamp: now,
        });
      }
      return {
        ok: false,
        error: { error: 'PAYMENT_DECLINED', reason: 'payment_rejected', detail: { txn: txnId } },
        paymentResult: 'DECLINED',
      };
    }

    // ERROR o TIMEOUT: no liberar, no confirmar. Estado ambiguo.
    // El HOLD sigue activo. El cliente puede reintentar.
    for (const seatId of hold.seat_ids) {
      this.audit.log({
        hold_id: params.hold_id,
        user_id: hold.user_id,
        seat_id: seatId,
        from_state: 'HELD',
        to_state: 'HELD',
        reason: `payment_${paymentResult.toLowerCase()}:${txnId}`,
        timestamp: now,
        metadata: JSON.stringify({ txn: txnId, ambiguous: true }),
      });
    }
    return {
      ok: false,
      error: {
        error: `PAYMENT_${paymentResult}`,
        reason: 'ambiguous_outcome_hold_retained',
        detail: {
          txn: txnId,
          message: 'El resultado del pago es ambiguo. El HOLD sigue activo. Puede reintentar.',
        },
      },
      paymentResult,
    };
  }

  getBreakerStats() {
    return this.breaker.getStats();
  }

  forceBreakerState(state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'): void {
    this.breaker.forceState(state);
  }
}
