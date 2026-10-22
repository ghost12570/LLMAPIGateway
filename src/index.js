import { config } from './config.js';
import { createApp } from './server.js';
import { logger } from './util/logger.js';

const { app, server, close } = await createApp();

server.listen(config.port, config.host, () => {
  logger.info('LLM Gateway listening', {
    url: `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`,
    admin: `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}/admin`,
    portal: `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}/portal`,
    db: config.dbPath,
    pid: process.pid,
  });
});

server.on('error', (err) => {
  logger.error('server error', { error: err.stack || err.message });
  process.exitCode = 1;
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal });
  const force = setTimeout(() => process.exit(1), 8000);
  force.unref();
  try {
    await close();
    logger.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error('shutdown failed', { error: err.message });
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  logger.error('unhandled rejection', { error: err?.stack || String(err) });
});
process.on('uncaughtException', (err) => {
  logger.error('uncaught exception', { error: err?.stack || String(err) });
});
