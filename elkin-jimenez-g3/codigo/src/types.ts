// Tipos centrales del dominio de reservas NEXUS LIVE

export type SeatStatus = 'AVAILABLE' | 'HELD' | 'SOLD';
export type HoldStatus = 'ACTIVE' | 'EXPIRED' | 'CONFIRMED' | 'RELEASED';
export type PaymentResult = 'APPROVED' | 'DECLINED' | 'ERROR' | 'TIMEOUT';
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface Seat {
  seat_id: string;
  section: string;
  price: number;
  currency: string;
  status: SeatStatus;
  hold_id: string | null;
  version: number; // optimistic locking
}

export interface Hold {
  hold_id: string;
  user_id: string;
  event_id: string;
  seat_ids: string[];
  created_at: number; // epoch ms
  expires_at: number; // epoch ms
  status: HoldStatus;
  total: number;
  currency: string;
}

export interface TransitionLog {
  id?: number;
  hold_id: string | null;
  user_id: string | null;
  seat_id: string;
  from_state: SeatStatus;
  to_state: SeatStatus;
  reason: string;
  timestamp: number;
  metadata?: string;
}

// Respuestas de la API
export interface HoldResponse {
  hold_id: string;
  user_id: string;
  event_id: string;
  seat_ids: string[];
  status: HoldStatus;
  total: number;
  currency: string;
  expires_at: string; // ISO
  created_at: string; // ISO
  remaining_ms: number;
}

export interface ApiError {
  error: string;
  reason: string;
  detail?: unknown;
}

export interface ConfirmResponse {
  hold_id: string;
  status: SeatStatus;
  payment_result: PaymentResult | 'PAYMENT_SERVICE_UNAVAILABLE';
  confirmation_id?: string;
  seats: { seat_id: string; status: SeatStatus }[];
  total: number;
  currency: string;
}
