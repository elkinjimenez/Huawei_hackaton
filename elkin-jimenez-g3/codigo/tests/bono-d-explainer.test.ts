import { AuditRepository } from '../src/audit';
import { ReservationEngine } from '../src/engine';
import { GlmExplainer, OperationalExplanation } from '../src/explainer';

describe('Bono D - GLM 5.2 dentro del producto', () => {
  function setup() {
    const audit = new AuditRepository(':memory:');
    const engine = new ReservationEngine({ ttlMs: 120_000, maxSeatsPerUser: 6 }, audit);
    engine.loadSeats([
      { seat_id: 'A-101', section: 'G', price: 210000, currency: 'COP', status: 'AVAILABLE', hold_id: null, version: 0 },
    ]);
    return { audit, engine };
  }

  test('Fallback cuando GLM no está configurado (sin API key)', async () => {
    const { audit, engine } = setup();
    // Asegurar que no hay env vars
    delete process.env.GLM_API_URL;
    delete process.env.GLM_API_KEY;
    const explainer = new GlmExplainer(audit);
    expect(explainer.isConfigured()).toBe(false);

    const hold = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'],
    });
    if (!hold.ok) return;
    const explanation = await explainer.explainHold(hold.hold.hold_id);
    expect(explanation.source).toBe('fallback');
    expect(explanation.timeline_narrative.length).toBeGreaterThan(0);
    expect(explanation.final_state).toBe('HELD');
  });

  test('Fallback genera narrativa útil sin GLM', async () => {
    const { audit, engine } = setup();
    const explainer = new GlmExplainer(audit);
    const hold = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'],
    });
    if (!hold.ok) return;
    await engine.confirmHold(hold.hold.hold_id, 'payment_approved');
    const explanation = await explainer.explainHold(hold.hold.hold_id);
    expect(explanation.source).toBe('fallback');
    expect(explanation.timeline_narrative.length).toBe(2); // HELD + SOLD
    expect(explanation.final_state).toBe('SOLD');
    expect(explanation.summary.length).toBeGreaterThan(0);
  });

  test('Fallback detecta expiración en evaluación de riesgos', async () => {
    const audit = new AuditRepository(':memory:');
    const engine = new ReservationEngine({ ttlMs: 50, maxSeatsPerUser: 6 }, audit);
    engine.loadSeats([
      { seat_id: 'A-101', section: 'G', price: 210000, currency: 'COP', status: 'AVAILABLE', hold_id: null, version: 0 },
    ]);
    const explainer = new GlmExplainer(audit);
    const hold = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'],
    });
    if (!hold.ok) return;
    await new Promise((r) => setTimeout(r, 100));
    engine.expireHolds();
    const explanation = await explainer.explainHold(hold.hold.hold_id);
    expect(explanation.final_state).toBe('AVAILABLE');
    expect(explanation.risk_assessment).toContain('expir');
  });

  test('Explicación de asiento sin transiciones', async () => {
    const { audit } = setup();
    const explainer = new GlmExplainer(audit);
    const explanation = await explainer.explainSeat('A-101');
    expect(explanation.source).toBe('fallback');
    expect(explanation.summary).toContain('Sin transiciones');
  });

  test('Maneja timeout de la API de GLM', async () => {
    const { audit, engine } = setup();
    const hold = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'],
    });
    if (!hold.ok) return;

    // Configurar GLM con un URL que no responde (timeout corto)
    const explainer = new GlmExplainer(audit, {
      apiUrl: 'http://192.0.2.1:9999/v1/chat/completions', // IP inalcanzable
      apiKey: 'test-key',
      timeoutMs: 500,
    });
    expect(explainer.isConfigured()).toBe(true);

    const explanation = await explainer.explainHold(hold.hold.hold_id);
    // Debe caer en fallback por timeout
    expect(explanation.source).toBe('fallback');
    expect(explanation.summary).toMatch(/Timeout|AbortError|aborted/i);
  });

  test('Maneja error HTTP de la API de GLM', async () => {
    const { audit, engine } = setup();
    const hold = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'],
    });
    if (!hold.ok) return;

    // Usar httpbin para simular error 500
    const explainer = new GlmExplainer(audit, {
      apiUrl: 'https://httpbin.org/status/500',
      apiKey: 'test-key',
      timeoutMs: 10_000,
    });

    const explanation = await explainer.explainHold(hold.hold.hold_id);
    expect(explanation.source).toBe('fallback');
    expect(explanation.summary).toContain('Error');
  });

  test('Maneja respuesta vacía de GLM', async () => {
    const { audit, engine } = setup();
    const hold = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'],
    });
    if (!hold.ok) return;

    // httpbin retorna respuesta vacía con status 200
    const explainer = new GlmExplainer(audit, {
      apiUrl: 'https://httpbin.org/status/204',
      apiKey: 'test-key',
      timeoutMs: 10_000,
    });

    const explanation = await explainer.explainHold(hold.hold.hold_id);
    expect(explanation.source).toBe('fallback');
  });

  test('Maneja formato inesperado (JSON sin campos esperados)', async () => {
    const { audit, engine } = setup();
    const hold = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'],
    });
    if (!hold.ok) return;

    // httpbin retorna JSON arbitrario
    const explainer = new GlmExplainer(audit, {
      apiUrl: 'https://httpbin.org/json',
      apiKey: 'test-key',
      timeoutMs: 10_000,
    });

    const explanation = await explainer.explainHold(hold.hold.hold_id);
    // Debe caer en fallback por formato inesperado
    expect(explanation.source).toBe('fallback');
  });

  test('Configuración desde variables de entorno', () => {
    const audit = new AuditRepository(':memory:');
    process.env.GLM_API_URL = 'https://api.example.com/v1/chat/completions';
    process.env.GLM_API_KEY = 'test-env-key';
    const explainer = new GlmExplainer(audit);
    expect(explainer.isConfigured()).toBe(true);
    delete process.env.GLM_API_URL;
    delete process.env.GLM_API_KEY;
  });

  test('Explicación siempre tiene campos válidos', async () => {
    const { audit, engine } = setup();
    const explainer = new GlmExplainer(audit);
    const hold = await engine.createHold({
      user_id: 'usr_1', event_id: 'evt', seat_ids: ['A-101'],
    });
    if (!hold.ok) return;
    const explanation = await explainer.explainHold(hold.hold.hold_id);

    // Todos los campos deben estar presentes y ser del tipo correcto
    expect(typeof explanation.hold_id).toBe('string');
    expect(typeof explanation.summary).toBe('string');
    expect(Array.isArray(explanation.timeline_narrative)).toBe(true);
    expect(typeof explanation.final_state).toBe('string');
    expect(typeof explanation.risk_assessment).toBe('string');
    expect(typeof explanation.recommendation).toBe('string');
    expect(typeof explanation.generated_at).toBe('string');
    expect(['glm', 'fallback']).toContain(explanation.source);
  });
});
