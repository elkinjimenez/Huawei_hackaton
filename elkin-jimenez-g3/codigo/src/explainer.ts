import { AuditRepository } from './audit';
import { TransitionLog } from './types';

/**
 * Bono D — GLM 5.2 dentro del producto.
 *
 * Este módulo recibe el historial de una reserva (transiciones de estado,
 * eventos de pago, cambios y errores) y genera una explicación operacional
 * estructurada usando GLM 5.2 vía API.
 *
 * Maneja explícitamente:
 *  - timeout de la API
 *  - respuesta vacía
 *  - error de API (HTTP no-2xx)
 *  - formato inesperado (JSON inválido o sin campos esperados)
 */

export interface GlmConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface OperationalExplanation {
  hold_id: string;
  summary: string;
  timeline_narrative: string[];
  final_state: string;
  risk_assessment: string;
  recommendation: string;
  generated_at: string;
  source: 'glm' | 'fallback';
}

export class GlmExplainer {
  private audit: AuditRepository;
  private config: GlmConfig | null;

  constructor(audit: AuditRepository, config?: Partial<GlmConfig>) {
    this.audit = audit;
    this.config = this.resolveConfig(config);
  }

  private resolveConfig(config?: Partial<GlmConfig>): GlmConfig | null {
    const apiUrl = config?.apiUrl || process.env.GLM_API_URL || '';
    const apiKey = config?.apiKey || process.env.GLM_API_KEY || '';
    if (!apiUrl || !apiKey) {
      return null; // GLM no configurado — se usará fallback
    }
    return {
      apiUrl,
      apiKey,
      model: config?.model || process.env.GLM_MODEL || 'glm-4-flash',
      timeoutMs: config?.timeoutMs ?? 10_000,
    };
  }

  isConfigured(): boolean {
    return this.config !== null;
  }

  /**
   * Genera una explicación operacional del historial de un HOLD.
   */
  async explainHold(holdId: string): Promise<OperationalExplanation> {
    const transitions = this.audit.getByHold(holdId);
    if (transitions.length === 0) {
      return this.fallbackExplanation(holdId, [], 'Sin transiciones registradas para esta reserva.');
    }

    const prompt = this.buildPrompt(holdId, transitions);

    if (!this.config) {
      return this.fallbackExplanation(holdId, transitions, 'GLM no configurado. Usando análisis local.');
    }

    try {
      const response = await this.callGlm(prompt);
      return this.parseGlmResponse(holdId, transitions, response);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return this.fallbackExplanation(holdId, transitions, `Error al consultar GLM: ${errMsg}`);
    }
  }

  /**
   * Genera una explicación del historial completo de un asiento.
   */
  async explainSeat(seatId: string): Promise<OperationalExplanation> {
    const transitions = this.audit.getBySeat(seatId);
    if (transitions.length === 0) {
      return this.fallbackExplanation(seatId, [], 'Sin transiciones registradas para este asiento.');
    }

    const prompt = this.buildSeatPrompt(seatId, transitions);

    if (!this.config) {
      return this.fallbackExplanation(seatId, transitions, 'GLM no configurado. Usando análisis local.');
    }

    try {
      const response = await this.callGlm(prompt);
      return this.parseGlmResponse(seatId, transitions, response);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return this.fallbackExplanation(seatId, transitions, `Error al consultar GLM: ${errMsg}`);
    }
  }

  // ---------- GLM API ----------

  private buildPrompt(holdId: string, transitions: TransitionLog[]): string {
    const timeline = transitions.map((t, i) => {
      const ts = new Date(t.timestamp).toISOString();
      return `  ${i + 1}. [${ts}] ${t.seat_id}: ${t.from_state} → ${t.to_state} (razón: ${t.reason})`;
    }).join('\n');

    return `Eres un analista operacional de NEXUS LIVE, un sistema de reservas de entradas.

Analiza el siguiente historial de transiciones de la reserva ${holdId} y genera una explicación operacional estructurada.

Transiciones:
${timeline}

Responde EXACTAMENTE en este formato JSON (sin texto adicional):
{
  "summary": "resumen breve de qué ocurrió",
  "timeline_narrative": ["paso 1 narrado", "paso 2 narrado", ...],
  "final_state": "estado final del asiento",
  "risk_assessment": "evaluación de riesgos o anomalías detectadas",
  "recommendation": "recomendación operacional"
}`;
  }

  private buildSeatPrompt(seatId: string, transitions: TransitionLog[]): string {
    const timeline = transitions.map((t, i) => {
      const ts = new Date(t.timestamp).toISOString();
      const hold = t.hold_id ? ` (reserva: ${t.hold_id})` : '';
      return `  ${i + 1}. [${ts}] ${t.from_state} → ${t.to_state} (razón: ${t.reason})${hold}`;
    }).join('\n');

    return `Eres un analista operacional de NEXUS LIVE, un sistema de reservas de entradas.

Analiza el historial completo del asiento ${seatId} y genera una explicación operacional estructurada.

Historial del asiento:
${timeline}

Responde EXACTAMENTE en este formato JSON (sin texto adicional):
{
  "summary": "resumen breve de la vida del asiento",
  "timeline_narrative": ["evento 1 narrado", "evento 2 narrado", ...],
  "final_state": "estado final del asiento",
  "risk_assessment": "evaluación de riesgos o anomalías",
  "recommendation": "recomendación operacional"
}`;
  }

  /**
   * Llama a la API de GLM con manejo de timeout.
   */
  private async callGlm(prompt: string): Promise<unknown> {
    if (!this.config) throw new Error('GLM no configurado');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const res = await fetch(this.config.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 1000,
        }),
        signal: controller.signal,
      });

      // Error de API (HTTP no-2xx)
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`API error ${res.status}: ${errText.slice(0, 200)}`);
      }

      // Respuesta vacía
      const text = await res.text();
      if (!text || text.trim() === '') {
        throw new Error('Respuesta vacía del API');
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        // Formato inesperado: no es JSON válido
        throw new Error('Formato inesperado: respuesta no es JSON válido');
      }

      return json;
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))) {
        throw new Error('Timeout: la API no respondió en el tiempo esperado');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Parsea la respuesta de GLM manejando formato inesperado.
   */
  private parseGlmResponse(
    id: string,
    transitions: TransitionLog[],
    raw: unknown
  ): OperationalExplanation {
    // Extraer el contenido del mensaje (formato OpenAI-compatible)
    let content: string = '';

    try {
      // Formato: { choices: [{ message: { content: "..." } }] }
      if (typeof raw === 'object' && raw !== null) {
        const obj = raw as Record<string, unknown>;
        const choices = obj.choices as Array<Record<string, unknown>> | undefined;
        if (choices && choices.length > 0) {
          const message = choices[0].message as Record<string, unknown> | undefined;
          if (message && typeof message.content === 'string') {
            content = message.content;
          }
        }
        // Alternativa: { content: "..." } o { response: "..." }
        if (!content) {
          if (typeof obj.content === 'string') content = obj.content;
          else if (typeof obj.response === 'string') content = obj.response;
          else if (typeof obj.output === 'string') content = obj.output;
        }
      }
    } catch {
      // Formato inesperado — usar fallback
      return this.fallbackExplanation(id, transitions, 'Formato inesperado en respuesta de GLM');
    }

    if (!content || content.trim() === '') {
      return this.fallbackExplanation(id, transitions, 'Respuesta vacía de GLM');
    }

    // Intentar parsear el JSON del contenido
    let parsed: Record<string, unknown>;
    try {
      // Limpiar markdown code fences si existen
      let clean = content.trim();
      if (clean.startsWith('```json')) clean = clean.slice(7);
      else if (clean.startsWith('```')) clean = clean.slice(3);
      if (clean.endsWith('```')) clean = clean.slice(0, -3);
      clean = clean.trim();

      parsed = JSON.parse(clean);
    } catch {
      // El contenido no es JSON — usarlo como summary
      return this.fallbackExplanation(id, transitions, content.slice(0, 500));
    }

    // Construir explicación con campos validados
    const finalState = transitions.length > 0
      ? transitions[transitions.length - 1].to_state
      : 'UNKNOWN';

    return {
      hold_id: id,
      summary: typeof parsed.summary === 'string' ? parsed.summary : 'Sin resumen disponible',
      timeline_narrative: Array.isArray(parsed.timeline_narrative)
        ? parsed.timeline_narrative.filter((s): s is string => typeof s === 'string')
        : [],
      final_state: typeof parsed.final_state === 'string' ? parsed.final_state : finalState,
      risk_assessment: typeof parsed.risk_assessment === 'string'
        ? parsed.risk_assessment
        : 'Sin evaluación de riesgos',
      recommendation: typeof parsed.recommendation === 'string'
        ? parsed.recommendation
        : 'Sin recomendación',
      generated_at: new Date().toISOString(),
      source: 'glm',
    };
  }

  /**
   * Explicación de fallback cuando GLM no está disponible o falla.
   * Genera un análisis local determinista a partir de las transiciones.
   */
  private fallbackExplanation(
    id: string,
    transitions: TransitionLog[],
    note: string
  ): OperationalExplanation {
    const finalState = transitions.length > 0
      ? transitions[transitions.length - 1].to_state
      : 'UNKNOWN';

    // Construir narrativa local
    const narrative = transitions.map((t, i) => {
      const ts = new Date(t.timestamp).toLocaleTimeString('es-CO');
      return `Paso ${i + 1} [${ts}]: El asiento ${t.seat_id} cambió de ${t.from_state} a ${t.to_state} debido a: ${t.reason}.`;
    });

    // Análisis básico
    const hasHold = transitions.some((t) => t.to_state === 'HELD');
    const hasSold = transitions.some((t) => t.to_state === 'SOLD');
    const hasExpire = transitions.some((t) => t.reason.includes('expired'));
    const hasPaymentError = transitions.some((t) =>
      t.reason.includes('ERROR') || t.reason.includes('TIMEOUT') || t.reason.includes('error')
    );

    let risk = 'No se detectaron anomalías significativas.';
    if (hasPaymentError) {
      risk = '⚠️ Se detectaron eventos de pago con errores o timeouts. El HOLD pudo quedar en estado ambiguo.';
    }
    if (hasExpire && !hasSold) {
      risk = 'La reserva expiró sin completar la compra. Los asientos volvieron a estar disponibles.';
    }

    let recommendation = 'Operación normal. Sin acción requerida.';
    if (hasPaymentError) {
      recommendation = 'Revisar el estado del HOLD y determinar si el pago fue procesado. El cliente puede reintentar.';
    }
    if (hasExpire && !hasSold) {
      recommendation = 'La reserva expiró. Si el cliente aún desea comprar, debe crear una nueva reserva.';
    }

    return {
      hold_id: id,
      summary: note || `La reserva ${id} tuvo ${transitions.length} transiciones. Estado final: ${finalState}.`,
      timeline_narrative: narrative,
      final_state: finalState,
      risk_assessment: risk,
      recommendation,
      generated_at: new Date().toISOString(),
      source: 'fallback',
    };
  }
}
