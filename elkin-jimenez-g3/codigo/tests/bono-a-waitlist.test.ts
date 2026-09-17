import { Waitlist } from '../src/waitlist';

describe('Bono A - Sala de espera justa (Waitlist)', () => {
  test('Un usuario se une y es admitido si hay cupo', () => {
    const wl = new Waitlist({ maxConcurrentAdmissions: 5, admissionTimeoutMs: 30_000 });
    const { entry, admitted } = wl.join('usr_1', 'evt_1');
    expect(entry.user_id).toBe('usr_1');
    expect(entry.status).toBe('ADMITTED');
    expect(admitted).toBe(true);
  });

  test('Fairness: un usuario no puede entrar dos veces', () => {
    const wl = new Waitlist({ maxConcurrentAdmissions: 1, admissionTimeoutMs: 30_000 });
    const r1 = wl.join('usr_1', 'evt_1');
    const r2 = wl.join('usr_1', 'evt_1');
    expect(r1.entry.ticket_id).toBe(r2.entry.ticket_id);
  });

  test('Cola FIFO: el segundo usuario espera si no hay cupo', () => {
    const wl = new Waitlist({ maxConcurrentAdmissions: 1, admissionTimeoutMs: 30_000 });
    const r1 = wl.join('usr_1', 'evt_1');
    const r2 = wl.join('usr_2', 'evt_1');
    expect(r1.admitted).toBe(true);
    expect(r2.admitted).toBe(false);
    expect(r2.entry.status).toBe('WAITING');
    expect(r2.entry.position).toBe(2);
  });

  test('Cuando un usuario libera, el siguiente es admitido', () => {
    const wl = new Waitlist({ maxConcurrentAdmissions: 1, admissionTimeoutMs: 30_000 });
    const r1 = wl.join('usr_1', 'evt_1');
    const r2 = wl.join('usr_2', 'evt_1');
    expect(r2.admitted).toBe(false);
    // usr_1 libera
    wl.release(r1.entry.ticket_id);
    // usr_2 debería ser admitido ahora
    const queue = wl.getQueue('evt_1');
    const usr2 = queue.find((e) => e.user_id === 'usr_2');
    expect(usr2?.status).toBe('ADMITTED');
  });

  test('Expiración: si un usuario admitido no crea HOLD a tiempo, pierde el turno', () => {
    const wl = new Waitlist({ maxConcurrentAdmissions: 1, admissionTimeoutMs: 50 });
    const r1 = wl.join('usr_1', 'evt_1');
    const r2 = wl.join('usr_2', 'evt_1');
    expect(r2.admitted).toBe(false);
    // Esperar a que expire la admisión de usr_1
    const now = Date.now() + 100;
    wl.processExpirations(now);
    // usr_2 debería ser admitido
    const queue = wl.getQueue('evt_1');
    const usr2 = queue.find((e) => e.user_id === 'usr_2');
    expect(usr2?.status).toBe('ADMITTED');
  });

  test('Abandonar cola: el usuario se remueve', () => {
    const wl = new Waitlist({ maxConcurrentAdmissions: 1, admissionTimeoutMs: 30_000 });
    const r1 = wl.join('usr_1', 'evt_1');
    const r2 = wl.join('usr_2', 'evt_1');
    // usr_2 abandona
    const left = wl.leave(r2.entry.ticket_id);
    expect(left).not.toBeNull();
    expect(left!.status).toBe('LEFT');
    // La cola solo tiene a usr_1
    const queue = wl.getQueue('evt_1');
    expect(queue.length).toBe(1);
    expect(queue[0].user_id).toBe('usr_1');
  });

  test('Orden de atención respeta timestamp de llegada', () => {
    const wl = new Waitlist({ maxConcurrentAdmissions: 1, admissionTimeoutMs: 30_000 });
    const base = Date.now();
    wl.join('usr_A', 'evt_1', base);
    wl.join('usr_B', 'evt_1', base + 100);
    wl.join('usr_C', 'evt_1', base + 200);
    const queue = wl.getQueue('evt_1');
    // usr_A admitido primero
    expect(queue[0].user_id).toBe('usr_A');
    expect(queue[0].status).toBe('ADMITTED');
    // usr_B y usr_C esperando en orden
    expect(queue[1].user_id).toBe('usr_B');
    expect(queue[2].user_id).toBe('usr_C');
  });

  test('No monopoliza: un usuario con un ticket no puede obtener otro', () => {
    const wl = new Waitlist({ maxConcurrentAdmissions: 2, admissionTimeoutMs: 30_000 });
    const r1 = wl.join('usr_1', 'evt_1');
    const r2 = wl.join('usr_1', 'evt_1'); // mismo usuario
    expect(r1.entry.ticket_id).toBe(r2.entry.ticket_id);
    // Solo hay 1 entrada en la cola
    expect(wl.getQueue('evt_1').length).toBe(1);
  });

  test('Stats de la cola', () => {
    const wl = new Waitlist({ maxConcurrentAdmissions: 2, admissionTimeoutMs: 30_000 });
    wl.join('usr_1', 'evt_1');
    wl.join('usr_2', 'evt_1');
    wl.join('usr_3', 'evt_1'); // este espera
    const stats = wl.getStats('evt_1');
    expect(stats.admitted).toBe(2);
    expect(stats.waiting).toBe(1);
  });
});
