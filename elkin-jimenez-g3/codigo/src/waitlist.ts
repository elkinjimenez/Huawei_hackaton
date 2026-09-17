import { v4 as uuidv4 } from 'uuid';

/**
 * Bono A — Sala de espera justa (Waitlist)
 *
 * Estrategia:
 *  - Cola FIFO por evento: los usuarios se atienden en orden de llegada.
 *  - Fairness: un usuario no puede monopolizar múltiples reservas. Si ya está
 *    en la cola, no puede volver a entrar hasta que sea atendido y libere su turno.
 *  - Cuando un usuario es atendido (admitido), tiene un tiempo limitado para
 *    crear su HOLD. Si no lo hace, pierde su turno (timeout) y pasa el siguiente.
 *  - Si un usuario abandona (disconnect/explicit), se remueve de la cola.
 *
 * Criterio de fairness:
 *  - Cada usuario tiene exactamente 1 slot en la cola por evento.
 *  - Se atiende en orden estricto de llegada (timestamp).
 *  - Un usuario atendido no puede reentrar hasta que su turno expire o lo libere.
 */
export interface WaitlistEntry {
  ticket_id: string;
  user_id: string;
  event_id: string;
  position: number;
  joined_at: number;     // epoch ms
  status: 'WAITING' | 'ADMITTED' | 'EXPIRED' | 'LEFT';
  admitted_at?: number;  // cuando fue admitido
  admit_expires_at?: number; // deadline para crear HOLD tras ser admitido
}

export interface WaitlistConfig {
  maxConcurrentAdmissions: number; // cuántos usuarios admitidos a la vez
  admissionTimeoutMs: number;      // tiempo para crear HOLD tras admisión
}

export class Waitlist {
  private queues = new Map<string, WaitlistEntry[]>(); // eventId -> entries
  private config: WaitlistConfig;

  constructor(config: Partial<WaitlistConfig> = {}) {
    this.config = {
      maxConcurrentAdmissions: config.maxConcurrentAdmissions ?? 5,
      admissionTimeoutMs: config.admissionTimeoutMs ?? 30_000,
    };
  }

  getConfig(): WaitlistConfig {
    return { ...this.config };
  }

  setConfig(partial: Partial<WaitlistConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  /**
   * Un usuario se une a la sala de espera.
   * Si ya está esperando o admitido, retorna su entrada existente.
   */
  join(userId: string, eventId: string, now: number = Date.now()): {
    entry: WaitlistEntry;
    admitted: boolean;
  } {
    const queue = this.getOrCreateQueue(eventId);

    // Limpiar expirados
    this.cleanExpired(eventId, now);

    // ¿Ya está en la cola?
    const existing = queue.find(
      (e) => e.user_id === userId && (e.status === 'WAITING' || e.status === 'ADMITTED')
    );
    if (existing) {
      return { entry: existing, admitted: existing.status === 'ADMITTED' };
    }

    // Crear entrada
    const entry: WaitlistEntry = {
      ticket_id: `tkt_${uuidv4().slice(0, 8).toUpperCase()}`,
      user_id: userId,
      event_id: eventId,
      position: queue.filter((e) => e.status === 'WAITING' || e.status === 'ADMITTED').length + 1,
      joined_at: now,
      status: 'WAITING',
    };
    queue.push(entry);

    // Intentar admitir inmediatamente
    this.tryAdmit(eventId, now);

    const admitted = entry.status === 'ADMITTED';
    return { entry, admitted };
  }

  /**
   * Intenta admitir usuarios en espera si hay cupo.
   */
  private tryAdmit(eventId: string, now: number = Date.now()): void {
    const queue = this.queues.get(eventId);
    if (!queue) return;

    const admitted = queue.filter((e) => e.status === 'ADMITTED').length;
    const slots = this.config.maxConcurrentAdmissions - admitted;

    if (slots <= 0) return;

    const waiting = queue
      .filter((e) => e.status === 'WAITING')
      .sort((a, b) => a.joined_at - b.joined_at);

    for (let i = 0; i < Math.min(slots, waiting.length); i++) {
      const entry = waiting[i];
      entry.status = 'ADMITTED';
      entry.admitted_at = now;
      entry.admit_expires_at = now + this.config.admissionTimeoutMs;
    }

    this.recalculatePositions(eventId);
  }

  /**
   * Un usuario admite que ya terminó (creó su HOLD o abandonó).
   * Libera su slot para que entre el siguiente.
   */
  release(ticketId: string, reason: string = 'completed'): WaitlistEntry | null {
    for (const [eventId, queue] of this.queues) {
      const entry = queue.find((e) => e.ticket_id === ticketId);
      if (entry && (entry.status === 'ADMITTED' || entry.status === 'WAITING')) {
        entry.status = reason === 'left' ? 'LEFT' : 'EXPIRED';
        this.tryAdmit(eventId);
        return entry;
      }
    }
    return null;
  }

  /**
   * Un usuario abandona la sala de espera explícitamente.
   */
  leave(ticketId: string): WaitlistEntry | null {
    return this.release(ticketId, 'left');
  }

  /**
   * Limpia entradas admitidas cuyo tiempo expiró (no crearon HOLD a tiempo).
   */
  cleanExpired(eventId: string, now: number = Date.now()): void {
    const queue = this.queues.get(eventId);
    if (!queue) return;

    let changed = false;
    for (const entry of queue) {
      if (entry.status === 'ADMITTED' && entry.admit_expires_at && entry.admit_expires_at <= now) {
        entry.status = 'EXPIRED';
        changed = true;
      }
    }
    if (changed) {
      this.tryAdmit(eventId, now);
    }
  }

  /**
   * Procesa expiraciones de todos los eventos.
   */
  processExpirations(now: number = Date.now()): void {
    for (const eventId of this.queues.keys()) {
      this.cleanExpired(eventId, now);
    }
  }

  /**
   * Verifica si un usuario está admitido y puede crear un HOLD.
   */
  isAdmitted(ticketId: string, now: number = Date.now()): boolean {
    for (const queue of this.queues.values()) {
      const entry = queue.find((e) => e.ticket_id === ticketId);
      if (entry && entry.status === 'ADMITTED') {
        if (entry.admit_expires_at && entry.admit_expires_at <= now) {
          entry.status = 'EXPIRED';
          return false;
        }
        return true;
      }
    }
    return false;
  }

  /**
   * Obtiene el estado de la cola de un evento.
   */
  getQueue(eventId: string): WaitlistEntry[] {
    const queue = this.queues.get(eventId) ?? [];
    return queue
      .filter((e) => e.status === 'WAITING' || e.status === 'ADMITTED')
      .map((e) => ({ ...e }));
  }

  /**
   * Obtiene la posición de un usuario en la cola.
   */
  getPosition(ticketId: string): number | null {
    for (const queue of this.queues.values()) {
      const entry = queue.find((e) => e.ticket_id === ticketId);
      if (entry && entry.status === 'WAITING') {
        return entry.position;
      }
    }
    return null;
  }

  getStats(eventId?: string) {
    if (eventId) {
      const queue = this.getQueue(eventId);
      return {
        event_id: eventId,
        waiting: queue.filter((e) => e.status === 'WAITING').length,
        admitted: queue.filter((e) => e.status === 'ADMITTED').length,
        config: this.config,
      };
    }
    const stats: Record<string, { waiting: number; admitted: number }> = {};
    for (const [eid, queue] of this.queues) {
      const active = queue.filter((e) => e.status === 'WAITING' || e.status === 'ADMITTED');
      stats[eid] = {
        waiting: active.filter((e) => e.status === 'WAITING').length,
        admitted: active.filter((e) => e.status === 'ADMITTED').length,
      };
    }
    return { events: stats, config: this.config };
  }

  private getOrCreateQueue(eventId: string): WaitlistEntry[] {
    if (!this.queues.has(eventId)) {
      this.queues.set(eventId, []);
    }
    return this.queues.get(eventId)!;
  }

  private recalculatePositions(eventId: string): void {
    const queue = this.queues.get(eventId);
    if (!queue) return;
    let pos = 1;
    for (const entry of queue) {
      if (entry.status === 'WAITING' || entry.status === 'ADMITTED') {
        entry.position = pos++;
      }
    }
  }
}
