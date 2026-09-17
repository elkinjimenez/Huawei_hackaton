# 🎟️ NEXUS LIVE // Motor de Reservas de Alta Concurrencia

**Reto 3 — Hackathon Huawei Colombia MaaS**
**Equipo:** Elkin Omar Jimenez Garcia — Grupo 3

---

## 📦 Stack seleccionado

- **Lenguaje:** TypeScript (Node.js)
- **Framework:** Express.js
- **Persistencia:** En memoria (asientos y reservas) + SQLite (trazabilidad/auditoría)
- **Testing:** Jest + ts-jest
- **UI:** HTML/CSS/JS vanilla (servida por Express)

---

## 🏗️ Arquitectura

```
┌──────────────────────────────────────────────────┐
│                 NEXUS LIVE                        │
│                                                   │
│  ┌─────────┐    ┌──────────────┐    ┌─────────┐  │
│  │  UI Web │◄──►│  Express API │◄──►│ Engine  │  │
│  │(Control │    │  (REST)      │    │(Locks)  │  │
│  │  Room)  │    │              │    │         │  │
│  └─────────┘    └──────┬───────┘    └────┬────┘  │
│                        │                 │       │
│                 ┌──────▼───────┐  ┌──────▼────┐  │
│                 │  Checkout    │  │  Audit    │  │
│                 │  Service     │  │ (SQLite)  │  │
│                 └──────┬───────┘  └───────────┘  │
│                        │                         │
│              ┌─────────▼─────────┐               │
│              │  Circuit Breaker  │               │
│              │  + Mock Payment   │               │
│              └───────────────────┘               │
└──────────────────────────────────────────────────┘
```

### Componentes

| Archivo | Responsabilidad |
|---|---|
| `src/types.ts` | Tipos del dominio (Seat, Hold, estados, etc.) |
| `src/engine.ts` | Motor de reservas con concurrencia segura e idempotencia |
| `src/payment.ts` | Mock de pagos + Circuit Breaker |
| `src/checkout.ts` | Servicio de checkout (HELD→SOLD) con manejo de fallos |
| `src/audit.ts` | Repositorio de trazabilidad en SQLite |
| `src/app.ts` | Configuración de Express + rutas API + simulación |
| `src/server.ts` | Punto de entrada del servidor |
| `src/public/index.html` | Interfaz web (Control Room) |

---

## 🚀 Cómo instalar y ejecutar

### Prerrequisitos

- Node.js 18+
- npm

### Instalación

```bash
cd elkin-jimenez-g3/codigo
npm install
```

### Iniciar el sistema

```bash
# Desarrollo (con ts-node)
npm run dev

# Producción
npm run build
npm start
```

El servidor inicia en `http://localhost:3000`.

### Variables de entorno (opcionales)

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | 3000 | Puerto del servidor |
| `TTL_MS` | 120000 | TTL del HOLD en ms |
| `MAX_SEATS` | 6 | Máximo de asientos por usuario |

---

## 🧪 Cómo ejecutar pruebas

```bash
# Todos los tests
npm test

# Solo prueba de concurrencia (Bono B)
npm run test:concurrency
```

**Resultado:** 30 tests, 4 suites, todos pasan.

---

## 🖥️ Cómo abrir la interfaz

1. Iniciar el servidor: `npm run dev`
2. Abrir `http://localhost:3000` en el navegador

La interfaz permite:
- Visualizar asientos con estados (🟢 AVAILABLE, 🟡 HELD, 🔴 SOLD)
- Seleccionar asientos y crear HOLDs
- Ver información de la reserva (hold_id, total, tiempo restante)
- Confirmar compra con payment_token
- Simular carrera de concurrencia (N usuarios por 1 asiento)
- Configurar TTL y límite de asientos
- Forzar estado del Circuit Breaker
- Ver bitácora de eventos en tiempo real

---

## ⚡ Cómo simular concurrencia

### Desde la interfaz

1. Ir a la sección "Simular Carrera de Concurrencia"
2. Especificar asiento objetivo y número de usuarios
3. Click "SIMULAR CARRERA"
4. Ver resultado: 1 ganador, N-1 rechazadas, 0 overselling

### Desde la API

```bash
curl -X POST http://localhost:3000/api/simulate/race \
  -H "Content-Type: application/json" \
  -d '{"seat_id":"VIP-A-001","users":100}'
```

### Desde los tests automatizados

```bash
npm run test:concurrency
```

---

## 🔁 Estrategia de idempotencia

Se implementa mediante el header `Idempotency-Key`:

1. **Replay:** Si la misma key + mismo payload se repite, se retorna el resultado cacheado (mismo `hold_id`).
2. **Conflicto:** Si la misma key se reusa con un payload diferente, se retorna `IDEMPOTENCY_CONFLICT`.

```bash
# Primera solicitud
curl -X POST http://localhost:3000/api/holds \
  -H "Idempotency-Key: reserve-usr1-001" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"usr_1","event_id":"evt","seat_ids":["A-101"]}'

# Repetir con misma key y payload -> mismo hold_id
```

---

## 🛡️ Estrategia para evitar overselling

El motor usa un **mutex basado en cola de promesas** que serializa todas las operaciones críticas:

- `createHold` — verifica que todos los asientos estén AVAILABLE antes de reservar (todo-o-nada).
- `confirmHold` — verifica que el HOLD siga activo y los asientos sigan HELD antes de marcar SOLD.
- `releaseHold` — libera asientos solo si están HELD por el HOLD correcto.

El lock garantiza que dos operaciones concurrentes nunca se ejecuten simultáneamente sobre el estado compartido. En Node.js (single-threaded), el lock previene que operaciones async (como pagos) entrelacen secciones críticas.

Además, cada asiento tiene un campo `version` para optimistic locking (preparado para futura escalabilidad distribuida).

---

## ⏳ Manejo de expiración de HOLDs

- Cada HOLD tiene `expires_at = created_at + ttlMs`.
- Un intervalo periódico (cada 1s) llama a `expireHolds()`.
- Al expirar: `HELD → AVAILABLE` para los asientos no vendidos.
- La expiración también se verifica de forma lazy al consultar un HOLD.
- El TTL es configurable vía API o variable de entorno.

---

## 💳 Estrategia ante fallos del proveedor de pagos

| Resultado | Acción |
|---|---|
| `APPROVED` | `HELD → SOLD`, se crea confirmación |
| `DECLINED` | Se libera el HOLD, asientos vuelven a `AVAILABLE` |
| `ERROR` | **No se libera ni confirma.** El HOLD sigue activo. El cliente puede reintentar. |
| `TIMEOUT` | Igual que ERROR. Estado ambiguo, no se asume rechazo ni aprobación. |

**Circuit Breaker:**
- 3 fallos consecutivos → `OPEN`
- 15s sin llamadas → `HALF_OPEN`
- 1 llamada de prueba → `CLOSED` (éxito) o `OPEN` (fallo)
- En `OPEN`: se retorna `PAYMENT_SERVICE_UNAVAILABLE` sin llamar al proveedor. El asiento **NO** se marca como `SOLD`.

---

## 📊 Trazabilidad

Cada cambio de estado se registra en SQLite con:
- `hold_id`, `user_id`, `seat_id`
- `from_state`, `to_state`
- `reason`, `timestamp`, `metadata`

Endpoints:
- `GET /api/audit` — últimas transiciones
- `GET /api/audit/hold/:id` — historial de un HOLD
- `GET /api/audit/seat/:id` — historial de un asiento

---

## 🎁 Bonos implementados

### 🥈 Bono B — Prueba de concurrencia real (+8 puntos)

Tests automatizados en `tests/concurrency.test.ts`:

- **100 usuarios concurrentes por 1 asiento → exactamente 1 ganador**
- 200 usuarios concurrentes → 1 ganador
- 50 usuarios por 3 asientos (todo-o-nada) → 1 ganador, 0 overselling
- 30 usuarios por cada uno de 3 asientos → 1 ganador por asiento

Verificado con `Promise.all()` (concurrencia real en el event loop de Node.js).

---

## 📁 Estructura del proyecto

```
elkin-jimenez-g3/
├── README.md
├── requerimientos.txt
├── prompt_usado.txt
└── codigo/
    ├── package.json
    ├── tsconfig.json
    ├── src/
    │   ├── types.ts
    │   ├── engine.ts
    │   ├── payment.ts
    │   ├── checkout.ts
    │   ├── audit.ts
    │   ├── app.ts
    │   ├── server.ts
    │   └── public/
    │       └── index.html
    └── tests/
        ├── fase1.test.ts
        ├── fase2-idempotency.test.ts
        ├── fase3-checkout.test.ts
        └── concurrency.test.ts
```

---

## 🧪 Escenarios verificables

| Escenario | Descripción | Estado |
|---|---|---|
| A | Reserva normal (AVAILABLE→HELD→SOLD) | ✅ |
| B | Reserva expirada (HELD→AVAILABLE tras TTL) | ✅ |
| C | Concurrencia (20+ solicitudes, 1 HOLD) | ✅ |
| D | Reintento idempotente (misma key = mismo resultado) | ✅ |
| E | Conflicto de idempotencia (misma key, payload distinto) | ✅ |
| F | Pago degradado (Circuit Breaker OPEN, asiento no se vende) | ✅ |
