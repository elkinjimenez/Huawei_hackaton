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
| `src/waitlist.ts` | Bono A: Sala de espera justa (cola FIFO con fairness) |
| `src/explainer.ts` | Bono D: GLM 5.2 dentro del producto (explicación operacional) |
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

### Variables de entorno

Crea un archivo `.env` en `codigo/` con las siguientes variables:

```env
# Puerto del servidor (default: 3000)
PORT=3000

# TTL del HOLD en milisegundos (default: 120000 = 2 minutos)
TTL_MS=120000

# Máximo de asientos por usuario (default: 6)
MAX_SEATS=6

# --- Bono D: GLM 5.2 ---
# URL del endpoint de GLM (formato OpenAI-compatible)
GLM_API_URL=http://149.232.135.126:4000/v1/chat/completions

# API key de GLM (¡NO subir a git!)
GLM_API_KEY=tu-api-key-aqui

# Modelo a usar (opcional, default: glm-4-flash)
GLM_MODEL=glm-4-flash
```

> ⚠️ **Importante:** El archivo `.env` ya está en `.gitignore` y **no se sube a git**.
> Nunca pongas credenciales directamente en el código.

Si no configuras `GLM_API_URL` y `GLM_API_KEY`, el Bono D funciona con **análisis local (fallback)** en lugar de GLM.

---

## 🧪 Cómo ejecutar pruebas

```bash
# Todos los tests
npm test

# Solo prueba de concurrencia (Bono B)
npm run test:concurrency
```

**Resultado:** 56 tests, 7 suites, todos pasan.

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

### � Bono A — Sala de espera justa (+8 puntos)

Implementado en `src/waitlist.ts` con endpoints en la API y panel en la UI.

**Estrategia:**
- **Orden de atención:** Cola FIFO estricta por orden de llegada (timestamp).
- **Fairness:** Un usuario no puede monopolizar: tiene exactamente 1 slot por evento. Si ya está en la cola o admitido, no puede reentrar.
- **Admisión controlada:** `maxConcurrentAdmissions` (default: 5) usuarios admitidos a la vez. Los demás esperan en orden.
- **Timeout de admisión:** Si un usuario admitido no crea su HOLD en `admissionTimeoutMs` (default: 30s), pierde su turno y entra el siguiente.
- **Abandono:** Un usuario puede abandonar explícitamente (`leave`), liberando su slot.

Endpoints:
- `POST /api/waitlist/join` — unirse a la cola
- `POST /api/waitlist/release` — liberar slot tras crear HOLD
- `POST /api/waitlist/leave` — abandonar la cola
- `GET /api/waitlist/:eventId` — ver cola de un evento
- `GET /api/waitlist/check/:ticketId` — verificar si está admitido

### 🥈 Bono B — Prueba de concurrencia real (+8 puntos)

Tests automatizados en `tests/concurrency.test.ts`:

- **100 usuarios concurrentes por 1 asiento → exactamente 1 ganador**
- 200 usuarios concurrentes → 1 ganador
- 50 usuarios por 3 asientos (todo-o-nada) → 1 ganador, 0 overselling
- 30 usuarios por cada uno de 3 asientos → 1 ganador por asiento

Verificado con `Promise.all()` (concurrencia real en el event loop de Node.js).

### 🥉 Bono C — Registro de auditoría reproducible (+7 puntos)

Implementado en `src/audit.ts` con métodos de exportación y verificación.

**Capacidades:**
- **Línea de tiempo de un HOLD:** secuencia ordenada de transiciones con timestamps ISO.
- **Historial de un asiento:** toda la "vida" del asiento (AVAILABLE → HELD → SOLD → ...).
- **Verificación de consistencia:** reconstruye el estado final desde el log y detecta transiciones inválidas.
- **Exportación CSV:** descarga completa del log en formato CSV reproducible.

Endpoints:
- `GET /api/audit/export/hold/:id` — línea de tiempo de una reserva
- `GET /api/audit/export/seat/:id` — historial completo de un asiento
- `GET /api/audit/reconstruct/seat/:id` — verificar consistencia del log
- `GET /api/audit/export/csv` — descargar CSV completo

**Total bonos: +30 puntos (A + B + C + D)**

### 🧠 Bono D — GLM 5.2 dentro del producto (+7 puntos)

Implementado en `src/explainer.ts`. Un módulo de operaciones que recibe el historial
de una reserva (transiciones de estado, eventos de pago, cambios y errores) y genera
una **explicación operacional estructurada** usando GLM 5.2.

**Capacidades:**
- Analiza el historial completo de un HOLD o de un asiento.
- Genera: resumen, narrativa paso a paso, estado final, evaluación de riesgos, recomendación.
- Usa GLM 5.2 vía API (formato OpenAI-compatible).

**Manejo robusto de casos límite:**
- **Timeout:** Si la API no responde en `timeoutMs` (default 10s), usa análisis local (fallback).
- **Respuesta vacía:** Detecta respuestas sin contenido y usa fallback.
- **Error de API:** HTTP no-2xx → fallback con mensaje de error.
- **Formato inesperado:** JSON inválido o sin campos esperados → fallback.
- **Fallback determinista:** Genera análisis local útil a partir de las transiciones, sin GLM.

**Configuración (variables de entorno):**
```bash
export GLM_API_URL="https://api.tu-glm-endpoint.com/v1/chat/completions"
export GLM_API_KEY="tu-api-key"
export GLM_MODEL="glm-4-flash"  # opcional
```

Endpoints:
- `GET /api/explainer/status` — verificar si GLM está configurado
- `GET /api/explainer/hold/:id` — explicar reserva con GLM
- `GET /api/explainer/seat/:id` — explicar asiento con GLM

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
