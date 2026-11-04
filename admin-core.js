// Ядро админки: чтение/запись data.json и загрузка фото в репозиторий GitHub через REST API.
// Без DOM — подключается из admin.html и проверяется тестами (tools/test-admin.mjs).

export const DEFAULT_REPO = 'neys777/dogfoodnt';
export const DEFAULT_BRANCH = 'main';
export const DATA_PATH = 'data.json';
export const CATEGORIES = [
  ['beef', 'Говядина'], ['turkey', 'Индейка'], ['duck', 'Утка'], ['chicken', 'Курица'],
  ['treat', 'Сушёные лакомства'], ['supp', 'Добавки']
];
export const UNITS = [['kg', 'за кг'], ['pcs', 'за шт'], ['g100', 'за 100 г'], ['lot', 'блок / распил (цена за кг)']];
export const STOCKS = [['ok', 'Есть'], ['low', 'Мало'], ['out', 'Нет']];
export const WEEKDAYS = [[1, 'Понедельник'], [2, 'Вторник'], [3, 'Среда'], [4, 'Четверг'], [5, 'Пятница']];

// ---------- base64 для UTF-8 и байтов ----------
export function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export const utf8ToB64 = str => bytesToB64(new TextEncoder().encode(str));
export function b64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export class ConflictError extends Error {}
export class AuthError extends Error {}

// ---------- работа с репозиторием ----------
export class GitHubStore {
  constructor({ token, repo = DEFAULT_REPO, branch = DEFAULT_BRANCH, fetchImpl = globalThis.fetch.bind(globalThis) }) {
    this.token = token; this.repo = repo; this.branch = branch; this.fetch = fetchImpl;
  }
  async api(method, path, body) {
    // ключ GitHub — только латиница, цифры и «_»; иначе заголовок запроса не собрать
    if (!/^[\x21-\x7e]+$/.test(this.token || '')) throw new AuthError('В ключе есть лишние символы или пробелы — скопируйте его заново');
    const r = await this.fetch(`https://api.github.com/${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, cache: 'no-store'
    });
    const data = r.status === 204 ? null : await r.json().catch(() => null);
    if (r.status === 401) throw new AuthError('Ключ доступа не подходит или истёк');
    if (r.status === 409 || (r.status === 422 && /sha/i.test(data?.message || ''))) throw new ConflictError('Данные уже изменил кто-то другой');
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${data?.message || 'ошибка'}`);
    return data;
  }
  // кто вошёл и можно ли ему записывать в репозиторий
  async check() {
    const [user, repo] = await Promise.all([this.api('GET', 'user'), this.api('GET', `repos/${this.repo}`)]);
    if (!repo?.permissions?.push) throw new AuthError('У этого ключа нет права записи в репозиторий сайта');
    return { login: user.login, name: user.name || user.login };
  }
  async readJson(path = DATA_PATH) {
    const f = await this.api('GET', `repos/${this.repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(this.branch)}`);
    return { data: JSON.parse(b64ToUtf8(f.content)), sha: f.sha };
  }
  async writeJson(obj, sha, message, path = DATA_PATH) {
    const res = await this.api('PUT', `repos/${this.repo}/contents/${encodeURI(path)}`, {
      message, content: utf8ToB64(JSON.stringify(obj, null, 1) + '\n'), sha, branch: this.branch
    });
    return res.content.sha;
  }
  async uploadFile(path, bytes, message) {
    await this.api('PUT', `repos/${this.repo}/contents/${encodeURI(path)}`, { message, content: bytesToB64(bytes), branch: this.branch });
    return path;
  }
}

// ---------- данные ----------
export const clone = o => JSON.parse(JSON.stringify(o));
export const newId = prefix => prefix + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
export const photoPath = id => `img/uploads/${String(id).replace(/[^a-z0-9_-]/gi, '')}-${Date.now().toString(36)}.jpg`;

export function emptyItem(cat = 'beef') {
  return { id: newId('n'), cat, name: '', price: 0, unit: 'kg', note: '', approx: 0, step: null, bulk: null, stock: 'ok', hit: false, img: 'img/tripe.jpg' };
}
export function emptyMix(data) {
  const n = Math.max(0, ...data.mixes.map(m => Number(m.n) || 0)) + 1;
  return { id: newId('m'), n, name: '', for: 'для всех пород', price: 0, pack: '0,5 кг', parts: [{ name: '', pct: 100 }], isNew: true, stock: 'ok', hit: false, img: 'img/tripe.jpg' };
}

// приводит введённые значения к нужным типам перед сохранением
export function normalize(data) {
  const num = v => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) && n >= 0 ? n : 0; };
  const d = clone(data);
  d.settings = { freeFrom: num(d.settings?.freeFrom), deliveryFee: num(d.settings?.deliveryFee), cutoffHour: Math.min(23, Math.round(num(d.settings?.cutoffHour))) };
  d.schedule = Object.fromEntries(WEEKDAYS.map(([k]) => [k, (d.schedule?.[k] || []).map(s => String(s).trim()).filter(Boolean)]));
  d.holidays = [...new Set((d.holidays || []).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x)))].sort();
  d.items = d.items.map(p => ({ ...p, name: String(p.name).trim(), note: String(p.note || '').trim(), price: num(p.price), approx: num(p.approx),
    step: num(p.step) || null, bulk: p.bulk && num(p.bulk.from) && num(p.bulk.price) ? { from: num(p.bulk.from), price: num(p.bulk.price) } : null }));
  d.mixes = d.mixes.map(m => ({ ...m, n: Math.round(num(m.n)), name: String(m.name).trim(), for: String(m.for || '').trim(), price: num(m.price),
    pack: String(m.pack || '').trim(), parts: (m.parts || []).map(p => ({ name: String(p.name).trim(), pct: num(p.pct) })).filter(p => p.name) }));
  d.updated = new Date().toISOString();
  return d;
}

// ошибки, из-за которых сохранять нельзя, и предупреждения
export function validate(data) {
  const errors = [], warnings = [];
  data.items.forEach((p, i) => {
    const label = p.name || `товар №${i + 1}`;
    if (!String(p.name).trim()) errors.push(`У товара №${i + 1} нет названия`);
    if (!(Number(p.price) > 0)) errors.push(`«${label}»: укажите цену`);
    if (p.unit === 'lot' && !(Number(p.approx) > 0)) errors.push(`«${label}»: для блока укажите примерный вес`);
  });
  data.mixes.forEach((m, i) => {
    const label = m.name ? `Микс №${m.n} «${m.name}»` : `микс №${i + 1}`;
    if (!String(m.name).trim()) errors.push(`У микса №${i + 1} нет названия`);
    if (!(Number(m.price) > 0)) errors.push(`${label}: укажите цену`);
    const sum = (m.parts || []).reduce((s, p) => s + (Number(p.pct) || 0), 0);
    if (Math.round(sum) !== 100) warnings.push(`${label}: сумма состава ${sum}%, а должна быть 100%`);
  });
  const ns = data.mixes.map(m => Number(m.n));
  if (new Set(ns).size !== ns.length) warnings.push('Номера миксов повторяются');
  return { errors, warnings };
}
