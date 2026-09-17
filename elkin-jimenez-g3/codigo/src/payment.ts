import { PaymentResult, CircuitState } from './types';

export interface CircuitBreakerConfig {
  failureThreshold: number;  // fallos consecutivos para abrir
  resetTimeoutMs: number;    // tiempo antes de half-open
  halfOpenMaxCalls: number;  // llamadas de prueba en half-open
}

export interface PaymentAuthorizeResponse {
  result: PaymentResult;
  durationMs: number;
  transaction_id: string;
}

/**
 * Servicio mock de pagos con comportamiento inestable.
 * Genera APPROVED, DECLINED, ERROR, TIMEOUT de forma configurable.
 */
export class MockPaymentService {
  private rng: () => number;

  constructor(seed?: number) {
    if (seed !== undefined) {
      // PRNG determinista para tests
      let s = seed;
      this.rng = () => {
        s = (s * 1664525 + 1013904223) % 4294967296;
        return s / 4294967296;
      };
    } else {
      this.rng = Math.random;
    }
  }

  /**
   * Simula autorización de pago.
   * Distribución por defecto: 70% approved, 10% declined, 10% error, 10% timeout.
   */
  async authorize(
    _paymentToken: string,
    _amount: number,
    options?: { forceResult?: PaymentResult; timeoutMs?: number }
  ): Promise<PaymentAuthorizeResponse> {
    const start = Date.now();

    let result: PaymentResult;
    if (options?.forceResult) {
      result = options.forceResult;
    } else {
      const r = this.rng();
      if (r < 0.7) result = 'APPROVED';
      else if (r < 0.8) result = 'DECLINED';
      else if (r < 0.9) result = 'ERROR';
      else result = 'TIMEOUT';
    }

    // Simular latencia
    let durationMs: number;
    if (result === 'TIMEOUT') {
      durationMs = options?.timeoutMs ?? 2500;
      await this.sleep(durationMs);
    } else {
      durationMs = Math.floor(this.rng() * 300) + 50;
      await this.sleep(durationMs);
    }

    return {
      result,
      durationMs: Date.now() - start,
      transaction_id: `txn_${Math.floor(this.rng() * 1e9).toString(36)}`,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Circuit breaker para el proveedor de pagos.
 *
 * Estados:
 *  CLOSED  -> llamadas pasan
 *  OPEN    -> rechaza inmediatamente
 *  HALF_OPEN -> permite N llamadas de prueba
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenCalls = 0;
  private halfOpenSuccesses = 0;
  private config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = {
      failureThreshold: config.failureThreshold ?? 3,
      resetTimeoutMs: config.resetTimeoutMs ?? 15_000,
      halfOpenMaxCalls: config.halfOpenMaxCalls ?? 1,
    };
  }

  getState(): CircuitState {
    this.maybeTransitionToHalfOpen();
    return this.state;
  }

  getStats() {
    return {
      state: this.getState(),
      failureCount: this.failureCount,
      config: this.config,
    };
  }

  /**
   * Ejecuta una operación a través del circuit breaker.
   * Retorna 'OPEN' si el circuito está abierto.
   */
  async execute<T>(fn: () => Promise<T>): Promise<
    { ok: true; result: T } | { ok: false; result: 'OPEN' }
  > {
    this.maybeTransitionToHalfOpen();

    if (this.state === 'OPEN') {
      return { ok: false, result: 'OPEN' };
    }

    if (this.state === 'HALF_OPEN') {
      if (this.halfOpenCalls >= this.config.halfOpenMaxCalls) {
        return { ok: false, result: 'OPEN' };
      }
      this.halfOpenCalls++;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return { ok: true, result };
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.config.halfOpenMaxCalls) {
        this.toClosed();
      }
    } else if (this.state === 'CLOSED') {
      this.failureCount = 0;
    }
  }

  private onFailure(): void {
    this.lastFailureTime = Date.now();
    if (this.state === 'HALF_OPEN') {
      this.toOpen();
    } else if (this.state === 'CLOSED') {
      this.failureCount++;
      if (this.failureCount >= this.config.failureThreshold) {
        this.toOpen();
      }
    }
  }

  private maybeTransitionToHalfOpen(): void {
    if (this.state === 'OPEN' &&
        Date.now() - this.lastFailureTime >= this.config.resetTimeoutMs) {
      this.state = 'HALF_OPEN';
      this.halfOpenCalls = 0;
      this.halfOpenSuccesses = 0;
    }
  }

  private toOpen(): void {
    this.state = 'OPEN';
    this.failureCount = this.config.failureThreshold;
    this.halfOpenCalls = 0;
    this.halfOpenSuccesses = 0;
  }

  private toClosed(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.halfOpenCalls = 0;
    this.halfOpenSuccesses = 0;
  }

  // Para tests: forzar estado
  forceState(state: CircuitState): void {
    this.state = state;
    if (state === 'OPEN') this.lastFailureTime = Date.now();
  }
}
