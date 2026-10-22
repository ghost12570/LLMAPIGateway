export class SettingsService {
  constructor(db) {
    this.db = db;
    this.cache = new Map();
    this.reload();
  }

  reload() {
    this.cache.clear();
    for (const row of this.db.all('SELECT key, value FROM settings')) {
      this.cache.set(row.key, row.value);
    }
  }

  get(key, fallback = '') {
    return this.cache.has(key) ? this.cache.get(key) : fallback;
  }

  getNumber(key, fallback = 0) {
    const n = Number(this.get(key, fallback));
    return Number.isFinite(n) ? n : fallback;
  }

  getBool(key, fallback = false) {
    const v = this.get(key, fallback ? 'true' : 'false');
    return /^(1|true|yes|on)$/i.test(String(v));
  }

  getJSON(key, fallback = null) {
    const raw = this.cache.get(key);
    if (raw === undefined) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  set(key, value) {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    this.db.run(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      key, str, Date.now(),
    );
    this.cache.set(key, str);
  }

  setMany(values) {
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(values)) this.set(key, value);
    });
  }

  all() {
    const out = {};
    for (const [key, value] of this.cache) out[key] = value;
    return out;
  }
}
