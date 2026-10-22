import { config } from '../config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function write(level, msg, fields) {
  if (LEVELS[level] < threshold) return;
  const entry = { ts: new Date().toISOString(), level, msg };
  if (fields && typeof fields === 'object') Object.assign(entry, fields);
  let line;
  try {
    line = JSON.stringify(entry);
  } catch {
    line = JSON.stringify({ ts: entry.ts, level, msg, extra: String(fields) });
  }
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const logger = {
  debug: (msg, fields) => write('debug', msg, fields),
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
};
