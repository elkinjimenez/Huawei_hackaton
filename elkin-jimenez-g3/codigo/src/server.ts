import { createApp } from './app';

const PORT = parseInt(process.env.PORT || '3000');

const app = createApp({
  ttlMs: parseInt(process.env.TTL_MS || '120000'),
  maxSeatsPerUser: parseInt(process.env.MAX_SEATS || '6'),
});

const server = app.listen(PORT, () => {
  console.log(`╔════════════════════════════════════════════════════╗`);
  console.log(`║          NEXUS LIVE // CONTROL ROOM                 ║`);
  console.log(`╠════════════════════════════════════════════════════╣`);
  console.log(`║  Servidor:   http://localhost:${PORT}                    ║`);
  console.log(`║  API:        http://localhost:${PORT}/api/health         ║`);
  console.log(`║  Interfaz:   http://localhost:${PORT}                    ║`);
  console.log(`╚════════════════════════════════════════════════════╝`);
});

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
