'use strict';
/*
 * Trip Board — a shared checklist + schedule.
 * The board lives in one JSON file in a private GitHub repo. Each device keeps a
 * queue of small edits ("ops") and replays them on top of the latest file before
 * every save, so two phones editing at once merge instead of overwriting.
 * Every op carries a unique id and the file remembers the ids it has applied
 * ("recentOps"), so an edit whose save response got lost is never applied twice.
 */
(() => {
  if (window.top !== window.self) {
    document.body.textContent = '';
    return;
  }

  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const uid = () => {
    const a = new Uint8Array(6);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  };
  const safeUrl = (u) => {
    try {
      const x = new URL(u);
      return /^https?:$/.test(x.protocol) ? x.href : '';
    } catch {
      return '';
    }
  };
  let storageBroken = false;
  const LS = {
    get(k, d) {
      try {
        const v = localStorage.getItem(k);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
        return true;
      } catch {
        storageBroken = true;
        return false;
      }
    },
    del(k) {
      try {
        localStorage.removeItem(k);
      } catch {}
    },
  };
  const KEY = { cfg: 'tb.cfg', base: 'tb.base', pending: 'tb.pending', ui: 'tb.ui', carry: 'tb.carry', old: 'tb.old' };
  const mkErr = (kind, message) => Object.assign(new Error(message), { kind });

  // ---------- dates (ISO strings, calendar math in UTC) ----------
  const pad = (n) => String(n).padStart(2, '0');
  const isISO = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  // Anything outside 2000–2099 is treated as a typo, so a bad date can't stall the agenda.
  const goodDate = (s) => isISO(s) && s >= '2000-01-01' && s <= '2099-12-31';
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const toUTC = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  };
  const addDays = (iso, n) => {
    const d = toUTC(iso);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const diffDays = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 86400000);
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const dow = (iso) => toUTC(iso).getUTCDay();
  const dayNum = (iso) => +iso.slice(8, 10);
  const monIdx = (iso) => +iso.slice(5, 7) - 1;
  const fmtDay = (iso) => `${WD[dow(iso)]} ${dayNum(iso)} ${MON[monIdx(iso)]}`;
  const fmtDM = (iso) => `${dayNum(iso)} ${MON[monIdx(iso)]}`;
  const relTime = (ts) => {
    if (!ts) return '';
    const t = new Date(ts).getTime();
    if (!t) return '';
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    const d = new Date(t);
    return `${WD[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
  };

  // ---------- document model ----------
  const DEFAULT_API = 'https://api.github.com';
  const DEFAULT_PATH = 'data/board.json';
  const KINDS = { task: 'Task', meet: 'Plan', travel: 'Travel', stay: 'Stay' };
  const OWNERS = ['p1', 'p2', 'both'];
  const DEFAULT_PEOPLE = { p1: 'Person 1', p2: 'Person 2' };
  const RECENT_OPS = 300;
  // Stays get colours in trip order so neighbouring places never look alike.
  const STAY_COLORS = ['#d9a521', '#e0604a', '#3f8fd8', '#4fa864', '#9a6fd6', '#23a3a0', '#d45d97', '#a8784a', '#6b7f99', '#7cb342'];
  const TEXT_FIELDS = ['title', 'notes', 'place', 'when', 'time', 'link', 'priority', 'section', 'dateText'];

  function emptyDoc() {
    return {
      version: 1,
      title: 'Trip Board',
      people: { ...DEFAULT_PEOPLE },
      dayLabels: {},
      sections: [
        { id: 's-p1', title: 'Person 1 — tasks', owner: 'p1', type: 'tasks', order: 10 },
        { id: 's-p2', title: 'Person 2 — tasks', owner: 'p2', type: 'tasks', order: 20 },
        { id: 's-both', title: 'Together', owner: 'both', type: 'tasks', order: 30 },
      ],
      items: [],
    };
  }

  // Still the board emptyDoc() started with: nothing anyone typed is in it.
  function untouched(doc) {
    const d = normalize(clone(doc));
    const e = emptyDoc();
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    return (
      !d.items.length &&
      !Object.keys(d.dayLabels).length &&
      ['home', 'departure', 'departureNote', 'returnDate'].every((k) => !d[k]) &&
      (d.title || e.title) === e.title &&
      same(d.people, e.people) &&
      same(d.sections, e.sections)
    );
  }

  const hashStr = (s) => {
    let h = 0;
    for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return h.toString(36);
  };
  const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

  // The file may be hand-edited on GitHub, so repair odd entries rather than drop them.
  function normalize(doc) {
    const d = isObj(doc) ? doc : {};
    d.version = d.version || 1;
    d.sections = Array.isArray(d.sections) ? d.sections.filter(isObj) : [];
    d.items = Array.isArray(d.items) ? d.items.filter(isObj) : [];
    d.people = Object.assign({ ...DEFAULT_PEOPLE }, isObj(d.people) ? d.people : {});
    for (const k of Object.keys(d.people)) d.people[k] = String(d.people[k] ?? '');
    d.dayLabels = isObj(d.dayLabels) ? d.dayLabels : {};
    d.recentOps = Array.isArray(d.recentOps) ? d.recentOps.filter((x) => typeof x === 'string').slice(-RECENT_OPS) : [];
    for (const k of ['title', 'home', 'departureNote']) if (d[k] != null) d[k] = String(d[k]);
    for (const k of ['departure', 'returnDate']) if (d[k] != null && !goodDate(d[k])) delete d[k];
    d.sections.forEach((s, idx) => {
      if (!s.id) s.id = 'h-' + hashStr(`s|${s.title}|${idx}`);
      s.id = String(s.id);
      if (!OWNERS.includes(s.owner)) s.owner = 'both';
      s.title = String(s.title ?? '');
      if (s.note != null) s.note = String(s.note);
    });
    d.items.forEach((i, idx) => {
      if (!i.id) i.id = 'h-' + hashStr(`i|${i.section}|${i.title}|${idx}`);
      i.id = String(i.id);
      if (!OWNERS.includes(i.owner)) i.owner = 'both';
      if (!KINDS[i.kind]) i.kind = 'task';
      for (const f of TEXT_FIELDS) if (i[f] != null && typeof i[f] !== 'string') i[f] = String(i[f]);
      if (i.title == null) i.title = '';
      if (i.date != null && !goodDate(i.date)) {
        i.dateText = String(i.date);
        delete i.date;
      }
      if (i.endDate != null && (!goodDate(i.endDate) || !i.date || i.endDate <= i.date)) delete i.endDate;
      if (typeof i.order !== 'number') delete i.order;
    });
    return d;
  }

  // Drop empty / false fields so the JSON file stays small and diffs stay readable.
  function compact(o) {
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (v === null || v === undefined || v === '' || v === false) continue;
      out[k] = v;
    }
    return out;
  }

  // One item per line: GitHub's history then shows exactly which item changed.
  function serialize(doc) {
    const d = normalize(clone(doc));
    const head = Object.assign({}, d);
    delete head.sections;
    delete head.items;
    let out = '{\n';
    for (const [k, v] of Object.entries(head)) out += `  ${JSON.stringify(k)}: ${JSON.stringify(v)},\n`;
    const list = (arr) => (arr.length ? '\n' + arr.map((x) => '    ' + JSON.stringify(compact(x))).join(',\n') + '\n  ' : '');
    out += `  "sections": [${list(d.sections)}],\n`;
    out += `  "items": [${list(d.items)}]\n}\n`;
    return out;
  }

  function applyOp(doc, op) {
    if (op.op === 'replace') {
      const nd = normalize(clone(op.doc));
      nd.recentOps = doc.recentOps.slice();
      return nd;
    }
    if (op.op === 'meta') {
      for (const [k, v] of Object.entries(op.fields || {})) {
        if (v === null || v === '') delete doc[k];
        else doc[k] = v;
      }
      return doc;
    }
    const list = op.kind === 'section' ? doc.sections : doc.items;
    if (op.op === 'add') {
      if (op.obj && !list.some((x) => x.id === op.obj.id)) list.push(clone(op.obj));
    } else if (op.op === 'set') {
      const x = list.find((x) => x.id === op.id);
      if (x) {
        for (const [k, v] of Object.entries(op.fields || {})) {
          if (v === null || v === '' || v === false) delete x[k];
          else x[k] = v;
        }
        x.updatedAt = op.ts;
        if (op.by) x.updatedBy = op.by;
      }
    } else if (op.op === 'del') {
      const i = list.findIndex((x) => x.id === op.id);
      if (i >= 0) list.splice(i, 1);
    }
    return doc;
  }
  // Ops whose id is already recorded in the file have landed before; skip them.
  function applyAll(doc, ops) {
    let d = normalize(clone(doc || emptyDoc()));
    const landed = new Set(d.recentOps);
    for (const op of ops) if (!op.u || !landed.has(op.u)) d = applyOp(d, op);
    return normalize(d);
  }

  // ---------- state ----------
  const S = {
    cfg: LS.get(KEY.cfg, {}) || {},
    base: LS.get(KEY.base, null), // { doc, sha, etag } from GitHub, or { local: true, doc }
    pending: LS.get(KEY.pending, []) || [],
    ui: Object.assign(
      { tab: 'list', who: 'all', hideDone: false, collapsed: {}, showPast: false, trayOpen: true, trayAll: false },
      LS.get(KEY.ui, {}) || {},
      { month: null, selected: null }
    ),
    view: null,
    viewKey: '',
    sync: { busy: false, err: null, lastOk: 0 },
    old: LS.get(KEY.old, {}) || {},
    gen: 0,
    saveTimer: 0,
    retryTimer: 0,
    retryDelay: 0,
  };
  if (!Array.isArray(S.pending)) S.pending = [];
  if (!isObj(S.cfg)) S.cfg = {};
  if (!['p1', 'p2', 'all'].includes(S.ui.who)) S.ui.who = 'all';

  const connected = () => !!(S.cfg.token && S.cfg.owner && S.cfg.repo);
  const mode = () => (connected() ? 'remote' : S.base && S.base.local ? 'local' : 'none');
  const me = () => (S.cfg.me === 'p1' || S.cfg.me === 'p2' ? S.cfg.me : null);
  const nm = (o) => (o === 'both' ? 'Both' : (S.view && S.view.people && S.view.people[o]) || DEFAULT_PEOPLE[o] || '');
  const persist = () => {
    LS.set(KEY.base, S.base);
    LS.set(KEY.pending, S.pending);
  };
  const saveUi = () => {
    const { month, selected, ...keep } = S.ui;
    LS.set(KEY.ui, keep);
  };

  // A sha we replaced with our own save; GitHub may briefly still serve it.
  function markStale(sha) {
    if (!sha) return;
    const now = Date.now();
    S.old[sha] = now;
    for (const [k, t] of Object.entries(S.old)) if (now - t > 180000) delete S.old[k];
    LS.set(KEY.old, S.old);
  }
  const isStale = (sha) => !!S.old[sha] && Date.now() - S.old[sha] < 180000;

  const placeKey = (place) => String(place || '').trim().toLowerCase();
  function recompute() {
    S.view = applyAll(S.base ? S.base.doc : emptyDoc(), S.pending);
    S.placeIdx = new Map();
    for (const st of getStays(S.view)) if (!S.placeIdx.has(placeKey(st.place))) S.placeIdx.set(placeKey(st.place), S.placeIdx.size);
  }
  const viewKeyOf = (v) => JSON.stringify([v.sections, v.items, v.title, v.home, v.departure, v.departureNote, v.returnDate, v.people, v.dayLabels]);

  // User actions re-render straight away.
  function refresh() {
    recompute();
    S.viewKey = viewKeyOf(S.view);
    render();
  }
  // Background sync only re-renders when something visible changed, and waits while someone is typing.
  function refreshQuiet() {
    recompute();
    const k = viewKeyOf(S.view);
    if (k === S.viewKey) return setSync();
    S.viewKey = k;
    render({ background: true });
  }

  function commit(ops, label) {
    const ts = new Date().toISOString();
    ops.forEach((op, i) => {
      op.u = uid();
      op.ts = ts;
      op.by = me();
      if (i === 0 && label) op.label = label;
      S.pending.push(op);
    });
    persist();
    scheduleSave(700);
    refresh();
  }

  // Drop queued ops that the latest file says have already been applied.
  function dropLanded() {
    if (!S.base || !S.base.doc) return;
    const landed = new Set(S.base.doc.recentOps || []);
    const before = S.pending.length;
    S.pending = S.pending.filter((op) => !op.u || !landed.has(op.u));
    if (S.pending.length !== before) persist();
  }

  // ---------- GitHub storage ----------
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64decode(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // fetch + read body, giving up after `ms` so a hung request can't block syncing.
  async function fetchT(url, opts, ms = 20000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const res = await fetch(url, Object.assign({}, opts, { signal: ctl.signal }));
      const text = res.status === 304 ? '' : await res.text();
      return { res, text };
    } finally {
      clearTimeout(t);
    }
  }
  const parseJSON = (t) => {
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  };

  function apiError(res, text) {
    const msg = (parseJSON(text) || {}).message || '';
    if (res.status === 401) return mkErr('auth', 'GitHub rejected the access token (expired or mistyped).');
    if (res.status === 403 || res.status === 429) {
      if (res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(msg)) return mkErr('rate', 'GitHub asked us to slow down — retrying shortly.');
      return mkErr('perm', 'The token can’t write to this repository. It needs “Contents: Read and write”.');
    }
    if (res.status === 404) return mkErr('notfound', 'Repository or data file not found. Check owner, repository and data file, and that the token was given access to this repository.');
    return mkErr('error', `GitHub error ${res.status}${msg ? `: ${msg}` : ''}`);
  }

  const gh = {
    api() {
      return (S.cfg.apiBase || DEFAULT_API).replace(/\/+$/, '');
    },
    repoUrl() {
      return `${this.api()}/repos/${encodeURIComponent(S.cfg.owner)}/${encodeURIComponent(S.cfg.repo)}`;
    },
    fileUrl() {
      const p = (S.cfg.path || DEFAULT_PATH).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
      return `${this.repoUrl()}/contents/${p}`;
    },
    headers(extra) {
      return Object.assign(
        { Authorization: `Bearer ${S.cfg.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        extra || {}
      );
    },
    async get(etag) {
      const url = `${this.fileUrl()}?ref=${encodeURIComponent(S.cfg.branch || 'main')}`;
      const { res, text } = await fetchT(url, { headers: this.headers(etag ? { 'If-None-Match': etag } : null), cache: 'no-store' });
      if (res.status === 304) return { notModified: true };
      if (!res.ok) throw apiError(res, text);
      const j = parseJSON(text);
      if (!j || Array.isArray(j) || j.type !== 'file') throw mkErr('notfound', 'The data file path points to a folder, not a file.');
      let body;
      if (j.content) body = b64decode(j.content);
      else {
        // Files over 1 MB come without inline content.
        const raw = await fetchT(url, { headers: this.headers({ Accept: 'application/vnd.github.raw+json' }), cache: 'no-store' });
        if (!raw.res.ok) throw apiError(raw.res, raw.text);
        body = raw.text;
      }
      const doc = parseJSON(body);
      if (!isObj(doc) || !(Array.isArray(doc.items) || Array.isArray(doc.sections))) {
        throw mkErr('badjson', 'The data file on GitHub isn’t a valid board. Fix it there, or restore a backup.');
      }
      return { doc, sha: j.sha, etag: res.headers.get('ETag') };
    },
    async put(doc, sha, message, keepalive) {
      const body = JSON.stringify(Object.assign({ message, content: b64encode(serialize(doc)), branch: S.cfg.branch || 'main' }, sha ? { sha } : {}));
      const opts = { method: 'PUT', headers: this.headers({ 'Content-Type': 'application/json' }), body, cache: 'no-store' };
      if (keepalive && body.length < 60000) opts.keepalive = true;
      const { res, text } = await fetchT(this.fileUrl(), opts);
      if (res.status === 409 || res.status === 422) {
        const msg = (parseJSON(text) || {}).message || text.slice(0, 160);
        if (res.status === 409 || /sha/i.test(msg)) return { conflict: true, message: msg };
        throw mkErr('error', `GitHub rejected the save: ${msg}`);
      }
      if (!res.ok) throw apiError(res, text);
      const j = parseJSON(text) || {};
      return { sha: j.content && j.content.sha };
    },
    async repoExists() {
      try {
        const { res } = await fetchT(this.repoUrl(), { headers: this.headers(), cache: 'no-store' });
        return res.ok;
      } catch {
        return false;
      }
    },
  };

  function commitMessage(ops) {
    const who = me() ? nm(me()) : 'Trip Board';
    const labels = [...new Set(ops.map((o) => o.label).filter(Boolean))];
    if (!labels.length) return `${who}: update`;
    const more = labels.length > 3 ? ` (+${labels.length - 3} more)` : '';
    return `${who}: ${labels.slice(0, 3).join('; ')}${more}`;
  }

  function acceptRemote(r) {
    if (S.base && S.base.sha && S.base.sha !== r.sha) markStale(S.base.sha);
    S.base = { doc: normalize(r.doc), sha: r.sha, etag: r.etag };
    dropLanded();
    persist();
  }

  function buildNext(baseDoc, ops) {
    const next = applyAll(baseDoc, ops);
    const landed = new Set(next.recentOps);
    for (const op of ops) if (op.u && !landed.has(op.u)) next.recentOps.push(op.u);
    next.recentOps = next.recentOps.slice(-RECENT_OPS);
    next.updatedAt = new Date().toISOString();
    if (me()) next.updatedBy = me();
    return next;
  }

  function scheduleSave(ms) {
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(save, ms);
    setSync();
  }

  async function save(opts) {
    clearTimeout(S.saveTimer);
    if (!S.pending.length) return;
    if (!connected()) {
      if (S.base && S.base.local) {
        S.base = { local: true, doc: applyAll(S.base.doc, S.pending) };
        S.pending = [];
        persist();
        refreshQuiet();
      }
      return;
    }
    if (S.sync.busy) {
      scheduleSave(600);
      return;
    }
    if (!S.base || !S.base.sha) {
      await pull(true);
      if (!S.base || !S.base.sha) return;
    }
    const gen = S.gen;
    S.sync.busy = true;
    setSync();
    let saved = false;
    let sameShaTries = 0;
    try {
      for (let attempt = 0; attempt < 6 && !saved; attempt++) {
        dropLanded();
        const ops = S.pending.slice();
        if (!ops.length) {
          saved = true;
          break;
        }
        const next = buildNext(S.base.doc, ops);
        const r = await gh.put(next, S.base.sha, commitMessage(ops), opts && opts.keepalive);
        if (gen !== S.gen) return;
        if (r.conflict) {
          // Someone else saved first: take their version and replay our edits on top.
          await sleep(250 * attempt);
          const remote = await gh.get(null);
          if (gen !== S.gen) return;
          if (remote.sha === S.base.sha || isStale(remote.sha)) {
            // The file hasn't visibly moved: GitHub is either lagging or refusing for another reason.
            if (++sameShaTries >= 3) throw mkErr('error', `GitHub refused the save: ${r.message || 'conflict'}`);
            await sleep(1200);
            continue;
          }
          acceptRemote(remote);
          continue;
        }
        markStale(S.base.sha);
        S.base = { doc: next, sha: r.sha, etag: null };
        const sent = new Set(ops.map((o) => o.u));
        S.pending = S.pending.filter((o) => !sent.has(o.u));
        persist();
        saved = true;
      }
      if (!saved) throw mkErr('conflict', 'Kept bumping into changes from the other phone — retrying.');
      S.sync.err = null;
      S.sync.lastOk = Date.now();
      S.retryDelay = 0;
    } catch (e) {
      if (gen === S.gen) handleSyncError(e);
    } finally {
      if (gen === S.gen) {
        S.sync.busy = false;
        refreshQuiet();
        if (S.pending.length && !S.sync.err) scheduleSave(300);
      }
    }
  }

  async function pull(force) {
    if (!connected() || S.sync.busy) return;
    const gen = S.gen;
    S.sync.busy = true;
    let changed = false;
    try {
      const r = await gh.get(force || !S.base ? null : S.base.etag);
      if (gen !== S.gen) return;
      if (!r.notModified) {
        if (S.base && S.base.sha === r.sha) {
          S.base.etag = r.etag;
          persist();
        } else if (!isStale(r.sha)) {
          acceptRemote(r);
          changed = true;
        }
      }
      S.sync.err = null;
      S.sync.lastOk = Date.now();
      S.retryDelay = 0;
    } catch (e) {
      if (gen === S.gen) handleSyncError(e);
    } finally {
      if (gen === S.gen) {
        S.sync.busy = false;
        if (changed) refreshQuiet();
        else setSync();
        if (S.pending.length && !S.sync.err) scheduleSave(200);
      }
    }
  }

  function handleSyncError(e) {
    const offline = !e || !e.kind ? e instanceof TypeError || (e && e.name === 'AbortError') : e.kind === 'offline';
    const kind = e && e.kind ? e.kind : offline ? 'offline' : 'error';
    S.sync.err = { kind, msg: kind === 'offline' ? 'No connection — changes are kept on this device and will be sent when you’re back online.' : (e && e.message) || String(e) };
    if (['offline', 'error', 'conflict', 'rate'].includes(kind)) scheduleRetry();
    setSync();
  }

  function scheduleRetry() {
    clearTimeout(S.retryTimer);
    S.retryDelay = Math.min(S.retryDelay ? S.retryDelay * 2 : 5000, 120000);
    S.retryTimer = setTimeout(() => {
      S.sync.err = null;
      if (S.pending.length) save();
      else pull();
    }, S.retryDelay);
  }

  // Stop everything in flight (used when switching boards or forgetting this device).
  function resetSync() {
    S.gen++;
    clearTimeout(S.saveTimer);
    clearTimeout(S.retryTimer);
    S.retryDelay = 0;
    S.sync = { busy: false, err: null, lastOk: 0 };
  }

  function setSync() {
    const btn = $('#syncBtn');
    let state = 'ok';
    let text = 'Synced';
    const m = mode();
    if (m === 'local') {
      state = 'local';
      text = 'This device only';
    } else if (m === 'none') {
      state = 'idle';
      text = 'Not connected';
    } else if (S.sync.err) {
      const k = S.sync.err.kind;
      state = k === 'offline' ? 'offline' : 'error';
      text = k === 'offline' ? (S.pending.length ? `Offline · ${S.pending.length} unsaved` : 'Offline') : k === 'rate' || k === 'conflict' || k === 'error' ? 'Retrying…' : 'Sync problem';
    } else if (!S.base) {
      state = 'saving';
      text = 'Loading…';
    } else if (S.pending.length) {
      state = 'saving';
      text = 'Saving…';
    }
    btn.dataset.state = state;
    $('#syncText').textContent = text;
    btn.title = S.sync.err ? S.sync.err.msg : text;
    renderBanner();
    if ($('#setDlg').open) renderSyncDetail();
  }

  function renderBanner() {
    const b = $('#banner');
    const m = mode();
    let html = '';
    if (storageBroken) {
      html = `<span>This browser isn’t letting the board save on the phone (private tab or blocked storage). Open it from the Home Screen icon or a normal Safari tab.</span>`;
    } else if (m === 'local' && !S.invite) {
      html = `<span>Changes are saved on this device only.</span><button type="button" class="btn" data-act="open-settings">Connect GitHub to share</button>`;
    } else if (m === 'remote' && S.sync.err && ['auth', 'perm', 'notfound', 'badjson'].includes(S.sync.err.kind)) {
      html = `<span>${esc(S.sync.err.msg)}</span><button type="button" class="btn" data-act="open-settings">Open settings</button>`;
    } else if (m === 'remote' && S.sync.err && S.sync.err.kind === 'error') {
      html = `<span>${esc(S.sync.err.msg)} — will keep retrying.</span>`;
    }
    b.innerHTML = html;
    b.hidden = !html;
  }

  // ---------- derived data ----------
  const visible = (it) => S.ui.who === 'all' || it.owner === S.ui.who || it.owner === 'both';
  const sortedSections = (d) =>
    d.sections
      .map((s, i) => ({ s, k: typeof s.order === 'number' ? s.order : i * 10 }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.s);
  const itemOrder = (list) =>
    list
      .map((it, i) => ({ it, k: typeof it.order === 'number' ? it.order : i * 10 }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.it);
  const spanEnd = (it) => (it.endDate && it.endDate > it.date ? it.endDate : it.date);
  const occurs = (it, day) => !!it.date && it.date <= day && day <= spanEnd(it);
  const placeColor = (place) => {
    const k = placeKey(place);
    let i = S.placeIdx && S.placeIdx.get(k);
    if (i === undefined) {
      i = 0;
      for (const ch of k) i = (i * 31 + ch.codePointAt(0)) >>> 0;
    }
    return STAY_COLORS[i % STAY_COLORS.length];
  };
  function getStays(d) {
    return d.items
      .filter((i) => i.kind === 'stay' && i.date)
      .map((s) => ({ ...s, endEff: s.endDate && s.endDate > s.date ? s.endDate : addDays(s.date, 1), place: s.place || s.title }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  // Where you sleep that night (latest-starting stay wins).
  const nightStay = (day, stays) => {
    let hit = null;
    for (const s of stays) if (s.date <= day && day < s.endEff) hit = s;
    return hit;
  };
  const endingStay = (day, stays) => stays.find((s) => s.endEff === day) || null;

  const WHEN_MAP = [
    [/morning|\bam\b/, 540, 'AM'],
    [/afternoon/, 840, 'PM'],
    [/after lunch/, 780, 'PM'],
    [/lunch|noon/, 720, 'noon'],
    [/evening|dinner/, 1080, 'eve'],
    [/night/, 1260, 'night'],
  ];
  function whenInfo(it) {
    const w = String(it.when || '').toLowerCase();
    for (const [re, min, short] of WHEN_MAP) if (re.test(w)) return { min, short };
    return null;
  }
  function sortMinutes(it) {
    if (it.kind === 'stay') return -2;
    if (it.time && /^\d{1,2}:\d{2}$/.test(it.time)) {
      const [h, m] = it.time.split(':').map(Number);
      return h * 60 + m;
    }
    const w = whenInfo(it);
    return w ? w.min : -1;
  }
  const timeHint = (it) => {
    const w = String(it.when || '').toLowerCase();
    if (/leave|etd/.test(w)) return 'leave';
    if (w.trim() === '~' || /approx|around/.test(w)) return 'approx';
    return '';
  };
  // The "when" note is worth showing unless it only repeats the leave/approx hint.
  const extraWhen = (it) => {
    const w = String(it.when || '').trim();
    return w && w !== '~' && !(it.time && /^(leave( home)?( \(etd\))?|etd)$/i.test(w)) ? w : '';
  };

  function bothBusy(d, day) {
    const evs = d.items.filter((i) => i.kind === 'meet' && !i.done && occurs(i, day));
    return evs.some((i) => i.owner === 'p1') && evs.some((i) => i.owner === 'p2');
  }

  // Today's month, unless today already shows in next month's grid (last days of a month).
  function defaultMonth(d) {
    const t = todayISO();
    const [y, m] = t.split('-').map(Number);
    const nextFirst = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    const nextGridStart = addDays(nextFirst, -((dow(nextFirst) + 6) % 7));
    const nm7 = nextFirst.slice(0, 7);
    if (t >= nextGridStart && d.items.some((i) => i.date && i.kind !== 'stay' && i.date.slice(0, 7) === nm7)) return nm7;
    return t.slice(0, 7);
  }

  // ---------- rendering ----------
  const ownerChip = (o, small) => `<span class="chip ${esc(o)}"${small ? ' style="padding:0 6px"' : ''}>${esc(nm(o))}</span>`;
  const prioChip = (p) => (p ? `<span class="chip prio ${esc(String(p).toLowerCase())}">${esc(p)}</span>` : '');

  let composing = false;
  let deferredRender = false;
  const typing = () => {
    const a = document.activeElement;
    return composing || !!(a && a.matches && a.matches('.quick-add input') && a.value !== '');
  };

  function labelPeople() {
    for (const b of $$('[data-who="p1"], [data-val="p1"]')) b.textContent = nm('p1');
    for (const b of $$('[data-who="p2"], [data-val="p2"]')) b.textContent = nm('p2');
  }

  function render(opts) {
    if (!S.view) recompute();
    if (opts && opts.background && typing()) {
      deferredRender = true;
      setSync();
      return;
    }
    deferredRender = false;
    const m = mode();
    const d = S.view;
    // An invite link opened on a phone that still has a board saved only on it: ask for the PIN first.
    const w = m === 'none' || (m === 'local' && !!S.invite);
    document.body.dataset.tab = S.ui.tab;
    $('#welcome').hidden = !w;
    $('#layout').hidden = w;
    $('.tabs').hidden = w;
    $('#whoFilter').hidden = w;
    $('#addBtn').hidden = w;
    $('#fab').hidden = w;
    labelPeople();
    $('#boardTitle').textContent = w ? 'Trip Board' : d.title || 'Trip Board';
    document.title = w ? 'Trip Board' : d.title || 'Trip Board';
    $('#countdown').innerHTML = w ? '' : countdownHTML(d);
    $$('#whoFilter [data-who]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.who === S.ui.who)));
    $$('.tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === S.ui.tab)));
    const tbcN = d.items.filter((i) => i.tbc && !i.done && visible(i)).length;
    $('#tabBadge').textContent = tbcN;
    $('#tabBadge').hidden = !tbcN;
    if (w) {
      renderWelcome();
      setSync();
      return;
    }
    if (!S.ui.month) S.ui.month = defaultMonth(d);
    const keep = captureInputs();
    if (m === 'remote' && !S.base) {
      const msg = S.sync.err ? esc(S.sync.err.msg) : 'Loading the board from GitHub…';
      $('#listPane').innerHTML = `<div class="card" style="padding:18px">${msg}</div>`;
      $('#schedPane').innerHTML = '';
    } else {
      $('#listPane').innerHTML = safeHTML(() => listHTML(d));
      $('#schedPane').innerHTML = safeHTML(() => schedHTML(d));
    }
    restoreInputs(keep);
    setSync();
  }

  function safeHTML(fn) {
    try {
      return fn();
    } catch (e) {
      console.error(e);
      return `<div class="card" style="padding:16px">Couldn’t show this part — something in the board data looks odd. Syncing still works; fix the item on GitHub or restore a backup.</div>`;
    }
  }

  function countdownHTML(d) {
    const t = todayISO();
    const dep = goodDate(d.departure) ? d.departure : null;
    const ret = goodDate(d.returnDate) ? d.returnDate : null;
    if (!dep) return '';
    const note = d.departureNote ? ` · ${esc(d.departureNote)}` : '';
    if (t < dep) {
      const n = diffDays(t, dep);
      const lead = n === 1 ? '<b>Tomorrow!</b>' : `<b>${n}</b> days to go`;
      return `${lead} · ✈ ${esc(fmtDay(dep))}${note}`;
    }
    if (t === dep) return `<b>Departure day</b> ✈${note}`;
    if (!ret) return `On the trip · day <b>${diffDays(dep, t) + 1}</b>`;
    if (t <= ret) return `On the trip · day <b>${diffDays(dep, t) + 1}</b> · back ${esc(fmtDay(ret))}`;
    return 'Back home';
  }

  // Remember what had focus (and typed text) so a re-render doesn't lose it.
  function focusKeyOf(el) {
    if (!el || !el.dataset) return null;
    if (el.matches('.cb[data-id]')) return { kind: 'cb', id: el.dataset.id, inSched: !!el.closest('#schedPane') };
    if (el.dataset.act) return { kind: 'act', act: el.dataset.act, id: el.dataset.id || '', date: el.dataset.date || '', sec: el.dataset.sec || '', inSched: !!el.closest('#schedPane') };
    return null;
  }
  function focusByKey(k) {
    if (!k) return false;
    const pane = $(k.inSched ? '#schedPane' : '#listPane');
    if (!pane) return false;
    const el =
      k.kind === 'cb'
        ? $$('.cb[data-id]', pane).find((x) => x.dataset.id === k.id)
        : $$('[data-act]', pane).find((x) => x.dataset.act === k.act && (x.dataset.id || '') === k.id && (x.dataset.date || '') === k.date && (x.dataset.sec || '') === k.sec);
    if (!el) return false;
    el.focus({ preventScroll: true });
    return true;
  }
  function captureInputs() {
    const a = document.activeElement;
    const vals = {};
    $$('.quick-add').forEach((f) => {
      const i = f.querySelector('input');
      if (i && i.value) vals[f.dataset.sec] = i.value;
    });
    const focus = a && a.matches && a.matches('.quick-add input') ? { sec: a.closest('form').dataset.sec, s: a.selectionStart, e: a.selectionEnd } : null;
    return { vals, focus, key: focus ? null : focusKeyOf(a), schedTop: $('#schedPane').scrollTop };
  }
  function restoreInputs(k) {
    const find = (sec) => $$('.quick-add').find((f) => f.dataset.sec === sec);
    for (const [sec, v] of Object.entries(k.vals)) {
      const f = find(sec);
      if (f) f.querySelector('input').value = v;
    }
    if (k.focus) {
      const f = find(k.focus.sec);
      const i = f && f.querySelector('input');
      if (i) {
        i.focus({ preventScroll: true });
        try {
          i.setSelectionRange(k.focus.s, k.focus.e);
        } catch {}
      }
    } else if (k.key && !$('dialog[open]')) focusByKey(k.key);
    $('#schedPane').scrollTop = k.schedTop;
  }

  // ----- checklist -----
  function listHTML(d) {
    const t = todayISO();
    const vis = d.items.filter(visible);
    const work = vis.filter((i) => i.kind === 'task' || i.kind === 'meet');
    const done = work.filter((i) => i.done).length;
    const pct = work.length ? Math.round((done / work.length) * 100) : 0;
    const openTasks = vis.filter((i) => i.kind === 'task' && !i.done).length;
    const tbcN = vis.filter((i) => i.tbc && !i.done).length;
    const weekEnd = addDays(t, 6);
    const soon = vis.filter((i) => !i.done && i.kind !== 'stay' && i.date && i.date <= weekEnd && spanEnd(i) >= t).length;

    let h = `<div class="pane-head"><h2>Checklist</h2><span class="muted">${done} of ${work.length} done</span><span class="spacer"></span>
      <label class="toggle"><input type="checkbox" id="hideDone" ${S.ui.hideDone ? 'checked' : ''}> Hide done</label></div>
      <div class="progress" role="progressbar" aria-label="Done" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>
      <div class="stats">
        <div class="stat"><b>${openTasks}</b><span>open tasks</span></div>
        <button type="button" class="stat ${tbcN ? 'warn' : ''}" data-act="goto-tray"><b>${tbcN}</b><span>need scheduling</span></button>
        <button type="button" class="stat" data-act="goto-today"><b>${soon}</b><span>in the next 7 days</span></button>
      </div>`;

    const secs = sortedSections(d);
    const ids = new Set(secs.map((s) => s.id));
    const orphans = d.items.filter((i) => !ids.has(i.section));
    const all = orphans.length ? secs.concat([{ id: '__orphan', title: 'Unsorted', owner: 'both', type: 'tasks', virtual: true }]) : secs;
    for (const s of all) {
      const raw = s.virtual ? orphans : d.items.filter((i) => i.section === s.id);
      const mine = raw.filter(visible);
      const showSec = S.ui.who === 'all' || s.owner === S.ui.who || s.owner === 'both' || mine.length;
      if (!showSec) continue;
      const ordered = itemOrder(mine);
      const open = ordered.filter((i) => !i.done);
      const closed = ordered.filter((i) => i.done);
      const rows = S.ui.hideDone ? open : open.concat(closed);
      const collapsed = isCollapsed(s);
      const count = mine.filter((i) => i.kind !== 'stay').length;
      const doneN = mine.filter((i) => i.kind !== 'stay' && i.done).length;
      const ownerC = s.owner !== 'both' || S.ui.who === 'all' ? ownerChip(s.owner) : '';
      h += `<article class="sec ${collapsed ? 'collapsed' : ''}" data-sec="${esc(s.id)}">
        <div class="sec-head">
          <button type="button" class="sec-toggle" data-act="sec-toggle" data-sec="${esc(s.id)}" aria-expanded="${!collapsed}">
            <span class="chev" aria-hidden="true"></span>${prioChip(s.priority)}
            <span class="sec-title">${esc(s.title)}</span>${ownerC}
            <span class="sec-count ${count && doneN === count ? 'all-done' : ''}">${count ? `${doneN}/${count}` : ''}</span>
          </button>
          ${s.virtual ? '' : `<button type="button" class="icon-btn" data-act="sec-edit" data-sec="${esc(s.id)}" aria-label="Edit list ${esc(s.title)}">⋯</button>`}
        </div>
        <div class="sec-bar"><span style="width:${count ? Math.round((doneN / count) * 100) : 0}%"></span></div>
        <div class="sec-body">
          ${s.note ? `<p class="sec-note">${esc(s.note)}</p>` : ''}
          ${rows.length ? `<ul class="items">${rows.map((it) => itemRow(it, s)).join('')}</ul>` : `<p class="empty-sec">${mine.length ? 'All done ✓' : 'Nothing here yet — add below.'}</p>`}
          ${s.virtual ? '' : `<form class="quick-add" data-sec="${esc(s.id)}"><input type="text" enterkeyhint="done" maxlength="200" placeholder="Add to ${esc(s.title)}…" aria-label="Add to ${esc(s.title)}"><button type="submit" class="btn">Add</button></form>`}
        </div>
      </article>`;
    }
    h += `<button type="button" class="add-section" data-act="sec-new">+ New list</button>`;
    return h;
  }

  const isCollapsed = (s) => S.ui.collapsed[s.id] ?? s.type === 'trip';

  function itemRow(it, s) {
    const meta = [];
    if (it.priority) meta.push(prioChip(it.priority));
    if (s.owner !== it.owner || s.owner === 'both') meta.push(ownerChip(it.owner));
    if (it.kind === 'travel') meta.push('<span class="chip plain">✈ travel</span>');
    if (it.kind === 'stay') meta.push('<span class="chip plain">⌂ stay</span>');
    if (it.date) {
      let txt = fmtDay(it.date);
      if (it.endDate) txt += ` – ${fmtDM(it.endDate)}`;
      if (it.time) {
        const hint = timeHint(it);
        txt += ` · ${hint === 'leave' ? 'leave ' : hint === 'approx' ? '~' : ''}${it.time}`;
      }
      meta.push(`<span class="chip date ${it.pencil ? 'pencil' : ''}" title="${it.pencil ? 'Pencilled in — flexible' : ''}">${esc(txt)}</span>`);
    } else if (it.dateText) meta.push(`<span class="chip tbc" title="Not a date the app understands">date? ${esc(it.dateText)}</span>`);
    if (it.tbc) meta.push('<span class="chip tbc">needs scheduling</span>');
    if (it.place) meta.push(`<span class="chip plain">📍 ${esc(it.place)}</span>`);
    const w = extraWhen(it);
    if (w) meta.push(`<span class="chip plain">${esc(w)}</span>`);
    const link = safeUrl(it.link);
    const notes = it.notes ? `<span class="item-notes">${esc(it.notes)}</span>` : '';
    const done = it.done && it.doneBy ? ` <span class="chip plain">✓ ${esc(nm(it.doneBy))}</span>` : '';
    return `<li class="item o-${esc(it.owner)} ${it.done ? 'done' : ''}">
      <input type="checkbox" class="cb" data-id="${esc(it.id)}" ${it.done ? 'checked' : ''} aria-label="Done: ${esc(it.title)}">
      <button type="button" class="item-main" data-act="edit" data-id="${esc(it.id)}">
        <span class="item-title">${esc(it.title)}</span>
        <span class="item-meta">${meta.join('')}${done}</span>
        ${notes}
      </button>
      ${link ? `<a class="chip link" href="${esc(link)}" target="_blank" rel="noopener noreferrer" title="${esc(link)}">Link ↗</a>` : ''}
    </li>`;
  }

  // ----- schedule -----
  function schedHTML(d) {
    return calHTML(d) + trayHTML(d) + agendaHTML(d);
  }

  function calHTML(d) {
    const month = S.ui.month || defaultMonth(d);
    const [y, m] = month.split('-').map(Number);
    const first = `${month}-01`;
    const last = `${month}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
    const gridStart = addDays(first, -((dow(first) + 6) % 7));
    const gridEnd = addDays(last, 6 - ((dow(last) + 6) % 7));
    const t = todayISO();
    const stays = getStays(d).filter(visible);
    const evs = d.items.filter((i) => i.kind !== 'stay' && i.date && visible(i));
    const inMonthStays = new Map();
    let cells = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => `<div class="cal-dow">${w}</div>`).join('');
    for (let day = gridStart; day <= gridEnd; day = addDays(day, 1)) {
      const out = day.slice(0, 7) !== month;
      const list = evs.filter((i) => occurs(i, day));
      const st = nightStay(day, stays);
      if (st && !out) inMonthStays.set(st.place, placeColor(st.place));
      const cls = ['cal-day', out && 'out', day < t && 'past', day === t && 'today', day === S.ui.selected && 'sel', (day === d.departure || day === d.returnDate) && 'dep'].filter(Boolean).join(' ');
      const dots = list
        .slice(0, 5)
        .map((i) => `<i class="dot ${esc(i.owner)} ${i.tbc ? 'tbc' : ''}"></i>`)
        .join('');
      const more = list.length > 5 ? `<span class="dot-more">+${list.length - 5}</span>` : '';
      let bar = '';
      if (st) {
        const isStart = st.date === day;
        const isEnd = addDays(day, 1) === st.endEff;
        bar = `<span class="stay-bar ${isStart ? 'start' : ''} ${isEnd ? 'end' : ''}" style="--stay-c:${placeColor(st.place)}"></span>`;
      }
      const tip = [fmtDay(day), st ? `📍 ${st.place}` : '', ...list.map((i) => `${i.time ? i.time + ' ' : ''}${i.title} (${nm(i.owner)})`)].filter(Boolean).join('\n');
      const plane = day === d.departure || day === d.returnDate ? '<span class="dep-ico" aria-hidden="true">✈</span>' : '';
      cells += `<button type="button" class="${cls}" data-act="cal-day" data-date="${day}" title="${esc(tip)}" aria-label="${esc(tip.replace(/\n/g, ', '))}">
        <span class="dnum">${dayNum(day)}</span>${plane}<span class="dots">${dots}${more}</span>${bar}</button>`;
    }
    const legend =
      [...inMonthStays].map(([p, c]) => `<span><i style="background:${c}"></i>${esc(p)}</span>`).join('') +
      `<span><i class="dot p1"></i>${esc(nm('p1'))}</span><span><i class="dot p2"></i>${esc(nm('p2'))}</span><span><i class="dot both"></i>Both</span><span><i class="dot tbc"></i>needs scheduling</span>`;
    return `<div class="card cal">
      <div class="cal-head">
        <h3>${MONTH[m - 1]} ${y}</h3>
        <button type="button" class="icon-btn" data-act="cal-prev" aria-label="Previous month">‹</button>
        <button type="button" class="link-btn" data-act="cal-today">Today</button>
        <button type="button" class="icon-btn" data-act="cal-next" aria-label="Next month">›</button>
      </div>
      <div class="cal-grid">${cells}</div>
      <div class="cal-legend">${legend}</div>
    </div>`;
  }

  function trayHTML(d) {
    const list = d.items
      .filter((i) => i.tbc && !i.done && visible(i))
      .sort((a, b) => ((a.date || '') < (b.date || '') ? -1 : (a.date || '') > (b.date || '') ? 1 : 0));
    if (!list.length) return '';
    const LIMIT = 6;
    const shown = S.ui.trayAll ? list : list.slice(0, LIMIT);
    const rows = shown
      .map(
        (i) => `<li><button type="button" class="tray-row" data-act="edit" data-id="${esc(i.id)}">
        ${ownerChip(i.owner)}
        <span class="t"><span style="display:block">${esc(i.title)}</span><span class="hint-date">${i.date ? `around ${esc(fmtDay(i.date))}${i.time ? ` · ${esc(i.time)}` : ''}` : 'no date yet'}${i.notes ? ` · ${esc(i.notes)}` : ''}</span></span>
        <span class="go">Set date ›</span></button></li>`
      )
      .join('');
    const more =
      list.length > LIMIT
        ? `<li><button type="button" class="tray-more" data-act="tray-all">${S.ui.trayAll ? 'Show fewer' : `Show all ${list.length}`}</button></li>`
        : '';
    return `<details class="card tray" id="tray" ${S.ui.trayOpen ? 'open' : ''}>
      <summary>Needs scheduling <span class="badge warn">${list.length}</span><span class="chev" aria-hidden="true"></span></summary>
      <ul>${rows}${more}</ul></details>`;
  }

  function agendaHTML(d) {
    const t = todayISO();
    const stays = getStays(d).filter(visible);
    const dated = d.items.filter((i) => i.date);
    const head = `<div class="agenda-tools"><h3>Day by day</h3>
      <button type="button" class="link-btn" data-act="toggle-past">${S.ui.showPast ? 'Hide past days' : 'Show past days'}</button>
      <button type="button" class="link-btn" data-act="goto-today">Today</button></div>`;
    if (!dated.length) return head + `<div class="card" style="padding:16px" >Nothing with a date yet. Give a task a date and it shows up here.</div>`;
    let minD = dated[0].date;
    let maxD = spanEnd(dated[0]);
    for (const i of dated) {
      if (i.date < minD) minD = i.date;
      if (spanEnd(i) > maxD) maxD = spanEnd(i);
    }
    const start = S.ui.showPast ? minD : t;
    const sel = S.ui.selected;
    const from = sel && sel < start ? sel : start;
    let to = sel && sel > maxD ? sel : maxD;
    const cap = addDays(from, 730);
    if (to > cap) to = cap;
    const dep = goodDate(d.departure) ? d.departure : null;
    const evs = dated.filter((i) => i.kind !== 'stay' && visible(i));
    const days = [];
    for (let day = from; day <= to; day = addDays(day, 1)) {
      if (day < start && day !== sel) continue;
      const items = evs.filter((i) => occurs(i, day)).sort((a, b) => sortMinutes(a) - sortMinutes(b));
      const starts = stays.filter((s) => s.date === day);
      const keep = items.length || starts.length || (dep && day <= dep) || day === sel || day === t || d.dayLabels[day];
      if (keep) days.push({ day, items, starts });
    }
    if (!days.length) return head + `<div class="card" style="padding:16px">Nothing coming up. Tap “Show past days” to look back.</div>`;
    let h = head;
    let prev = null;
    for (const g of days) {
      if (prev && diffDays(prev, g.day) > 1) {
        const gapN = diffDays(prev, g.day) - 1;
        const st = nightStay(addDays(prev, 1), stays);
        h += `<div class="gap">· · · ${gapN} quiet day${gapN > 1 ? 's' : ''}${st ? ` in ${esc(st.place)}` : ''} · · ·</div>`;
      }
      h += dayHTML(d, g, stays, t);
      prev = g.day;
    }
    return h;
  }

  function dayHTML(d, g, stays, t) {
    const { day, items, starts } = g;
    const tags = [];
    if (day === t) tags.push('<span class="tag today">Today</span>');
    if (day === d.departure) tags.push('<span class="tag today">✈ Departure</span>');
    if (day === d.returnDate) tags.push('<span class="tag today">✈ Home</span>');
    if (d.dayLabels[day]) tags.push(`<span class="tag holiday">${esc(d.dayLabels[day])}</span>`);
    const night = nightStay(day, stays);
    const ending = endingStay(day, stays);
    if (night || ending) {
      let label = ending && night && ending.place !== night.place ? `${ending.place} → ${night.place}` : (night || ending).place;
      // Leaving a stay with nowhere booked that night: before or after the big trip that means home.
      const atHome = !d.departure || day <= d.departure || (d.returnDate && day >= d.returnDate);
      if (ending && !night) label = d.home && atHome ? `${ending.place} → ${d.home}` : `${ending.place} →`;
      tags.push(`<span class="tag place" style="--stay-c:${placeColor((night || ending).place)}">📍 ${esc(label)}</span>`);
    }
    if ((!d.departure || day <= d.departure) && bothBusy(d, day)) tags.push('<span class="tag busy" title="Both of you have plans this day">both busy</span>');
    const rows = [];
    for (const s of starts) {
      const n = diffDays(s.date, s.endEff);
      rows.push(`<li class="ditem stay-row" style="--stay-c:${placeColor(s.place)}">
        <span class="dtime none">stay</span><span class="cb-spacer" aria-hidden="true">⌂</span>
        <button type="button" class="dbody" data-act="edit" data-id="${esc(s.id)}">
          <span class="dtitle">${esc(s.title)}</span>
          <span class="dmeta">until ${esc(fmtDay(s.endEff))} · ${n} night${n === 1 ? '' : 's'}${s.pencil ? ' · pencilled' : ''}${s.tbc ? ' · <span class="chip tbc">needs scheduling</span>' : ''}</span>
        </button></li>`);
    }
    for (const it of items) rows.push(dRow(it, day));
    const cls = ['day', day === t && 'is-today', day === d.departure && 'departure', (dow(day) === 0 || dow(day) === 6) && 'weekend'].filter(Boolean).join(' ');
    const body = rows.length ? `<ul class="ditems">${rows.join('')}</ul>` : `<p class="free">Free — nothing planned yet</p>`;
    return `<section class="${cls}" id="d-${day}">
      <div class="day-head">
        <span class="day-date"><span class="wd">${WD[dow(day)]}</span><b>${dayNum(day)}</b> ${MON[monIdx(day)]}</span>
        <span class="day-tags">${tags.join('')}</span>
        <button type="button" class="icon-btn day-add" data-act="day-add" data-date="${day}" aria-label="Add something on ${esc(fmtDay(day))}">+</button>
      </div>${body}</section>`;
  }

  function dRow(it, day) {
    const multi = !!it.endDate;
    const n = multi ? diffDays(it.date, day) + 1 : 0;
    const total = multi ? diffDays(it.date, it.endDate) + 1 : 0;
    let time;
    if (it.time) {
      const hint = timeHint(it);
      time = `<span class="dtime">${esc(it.time)}${hint ? `<small>${hint}</small>` : ''}</span>`;
    } else {
      const w = whenInfo(it);
      time = `<span class="dtime none">${w ? w.short : multi ? `day ${n}/${total}` : '—'}</span>`;
    }
    const meta = [ownerChip(it.owner, true)];
    if (it.place) meta.push(`<span>📍 ${esc(it.place)}</span>`);
    const w = String(it.when || '').trim();
    if (w && w !== '~') meta.push(`<span>${esc(w)}</span>`);
    if (multi && (it.time || whenInfo(it))) meta.push(`<span>day ${n} of ${total}</span>`);
    if (it.tbc) {
      meta.push('<span class="chip tbc">needs scheduling</span>');
      if (it.notes) meta.push(`<span>${esc(it.notes)}</span>`);
    } else if (it.pencil) meta.push('<span>pencilled in</span>');
    const check =
      it.kind === 'travel'
        ? '<span class="cb-spacer" aria-hidden="true">✈</span>'
        : `<input type="checkbox" class="cb" data-id="${esc(it.id)}" ${it.done ? 'checked' : ''} aria-label="Done: ${esc(it.title)}">`;
    const cls = ['ditem', `o-${it.owner}`, it.tbc && 'tbc', !it.tbc && it.pencil && 'pencil', it.done && 'done'].filter(Boolean).join(' ');
    return `<li class="${cls}">${time}${check}
      <button type="button" class="dbody" data-act="edit" data-id="${esc(it.id)}">
        <span class="dtitle">${esc(it.title)}</span>
        <span class="dmeta">${meta.join('')}</span>
      </button></li>`;
  }

  function renderWelcome() {
    if ($('#welcome').dataset.mode === (S.invite ? 'pin' : 'link')) return; // keep what's being typed
    $('#welcome').dataset.mode = S.invite ? 'pin' : 'link';
    $('#welcome').innerHTML = S.invite
      ? `<div class="card">
      <h2>Trip Board</h2>
      <p>Enter the PIN you were given to open the shared checklist and schedule. You only need it once on this phone.</p>
      <form class="pin-form" data-form="pin">
        <input name="pin" type="password" inputmode="numeric" autocomplete="off" placeholder="PIN" aria-label="PIN" required>
        <button type="submit" class="btn primary">Open the board</button>
      </form>
      <p class="hint" data-msg></p>
    </div>`
      : `<div class="card">
      <h2>Trip Board</h2>
      <p>A shared checklist and schedule. Open the <b>invite link</b> you were sent — it brings you straight here — or paste it below.</p>
      <form class="pin-form" data-form="link">
        <input name="link" type="text" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Paste the invite link" aria-label="Invite link" required>
        <button type="submit" class="btn primary">Next</button>
      </form>
      <p class="hint" data-msg></p>
      <p class="hint" style="margin-top:14px">Setting up the board? <button type="button" class="link-btn" data-act="open-settings">Connect with your GitHub token</button></p>
    </div>`;
  }

  // ---------- actions ----------
  function findItem(id) {
    return S.view.items.find((i) => i.id === id);
  }

  function toggleDone(id, checked) {
    const it = findItem(id);
    if (!it) return;
    const fields = checked ? { done: true, doneBy: me(), doneAt: new Date().toISOString() } : { done: null, doneBy: null, doneAt: null };
    commit([{ op: 'set', kind: 'item', id, fields }], `${checked ? '✓' : 'unticked'} “${it.title}”`);
    if (checked && S.ui.hideDone) undoToast(`Ticked “${it.title}”`, () => commit([{ op: 'set', kind: 'item', id, fields: { done: null, doneBy: null, doneAt: null } }], `unticked “${it.title}”`));
  }

  function nextOrder(sectionId) {
    const sib = S.view.items.filter((i) => i.section === sectionId && typeof i.order === 'number');
    return sib.length ? Math.max(...sib.map((i) => i.order)) + 10 : 10;
  }

  // Where a new item goes by default. Lists marked noDefault (Claude's suggestions) never get new items.
  function defaultSection(kind, owner) {
    const secs = sortedSections(S.view).filter((s) => !s.noDefault && !/^suggested/i.test(s.title));
    const want = kind === 'meet' ? 'meetings' : kind === 'travel' || kind === 'stay' ? 'trip' : 'tasks';
    const hit =
      secs.find((s) => s.type === want && s.owner === owner) ||
      secs.find((s) => s.owner === owner && (s.type === 'tasks' || s.type === 'meetings')) ||
      secs.find((s) => s.type === want) ||
      secs.find((s) => s.owner === owner) ||
      secs[0] ||
      sortedSections(S.view)[0];
    return hit ? hit.id : '';
  }

  const kindForSection = (s) => (s && s.type === 'meetings' ? 'meet' : s && s.type === 'trip' ? 'travel' : 'task');

  // After adding, make sure the user can see where the item went.
  function revealAdded(item) {
    const s = S.view.sections.find((x) => x.id === item.section);
    if (!visible(item)) {
      toast(`Added for ${nm(item.owner)} — tap “All” to see it`);
      return;
    }
    if (s && isCollapsed(s)) {
      S.ui.collapsed[s.id] = false;
      saveUi();
      render();
    }
    if (S.ui.tab === 'sched' && !item.date) toast(`Added to “${s ? s.title : 'the checklist'}”`);
  }

  function quickAdd(form) {
    const input = form.querySelector('input');
    const title = input.value.trim();
    if (!title) return;
    const s = S.view.sections.find((x) => x.id === form.dataset.sec);
    if (!s) return;
    const owner = s.owner === 'both' && S.ui.who !== 'all' ? S.ui.who : s.owner === 'both' ? 'both' : s.owner;
    const obj = { id: uid(), section: s.id, order: nextOrder(s.id), title, owner, kind: kindForSection(s), createdAt: new Date().toISOString(), createdBy: me() };
    input.value = '';
    commit([{ op: 'add', kind: 'item', obj: compact(obj) }], `added “${title}”`);
    revealAdded(obj);
  }

  // Swap an item (or list) with its neighbour as the user sees it, not as stored.
  function reorder(all, visibleList, id, dir) {
    const i = visibleList.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= visibleList.length) return null;
    const a = all.findIndex((x) => x.id === id);
    const b = all.findIndex((x) => x.id === visibleList[j].id);
    const list = all.slice();
    const [moved] = list.splice(a, 1);
    list.splice(b, 0, moved);
    return list;
  }

  function moveSection(id, dir) {
    const all = sortedSections(S.view);
    const shown = all.filter((s) => S.ui.who === 'all' || s.owner === S.ui.who || s.owner === 'both' || S.view.items.some((i) => i.section === s.id && visible(i)));
    const list = reorder(all, shown, id, dir);
    if (!list) return toast(dir < 0 ? 'Already at the top' : 'Already at the bottom');
    const ops = [];
    list.forEach((s, k) => {
      if (s.order !== (k + 1) * 10) ops.push({ op: 'set', kind: 'section', id: s.id, fields: { order: (k + 1) * 10 } });
    });
    if (ops.length) commit(ops, `reordered lists`);
    toast(dir < 0 ? 'Moved up' : 'Moved down');
  }

  function moveItem(id, dir) {
    const it = findItem(id);
    if (!it) return;
    const all = itemOrder(S.view.items.filter((i) => i.section === it.section));
    const shown = all.filter((x) => visible(x) && !!x.done === !!it.done);
    const list = reorder(all, shown, id, dir);
    if (!list) return toast(dir < 0 ? 'Already at the top' : 'Already at the bottom');
    const ops = [];
    list.forEach((x, k) => {
      if (x.order !== (k + 1) * 10) ops.push({ op: 'set', kind: 'item', id: x.id, fields: { order: (k + 1) * 10 } });
    });
    if (ops.length) commit(ops, `moved “${it.title}”`);
    toast(dir < 0 ? 'Moved up' : 'Moved down');
  }

  // ---------- toast ----------
  let toastTimer = 0;
  let undoFns = [];
  let undoLabel = '';
  function showToast(html, ms) {
    const el = $('#toast');
    el.innerHTML = html;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
      undoFns = [];
    }, ms);
  }
  function toast(msg) {
    if (undoFns.length) return; // don't knock an Undo off the screen
    showToast(`<span>${esc(msg)}</span>`, 2800);
  }
  // Several deletes in a row share one Undo that restores all of them.
  function undoToast(msg, fn) {
    undoFns.push(fn);
    undoLabel = undoFns.length > 1 ? `${undoFns.length} changes` : msg;
    showToast(`<span>${esc(undoLabel)}</span><button type="button" data-undo>Undo</button>`, 10000);
  }
  $('#toast').addEventListener('click', (e) => {
    if (!e.target.closest('[data-undo]')) return;
    const fns = undoFns.reverse();
    undoFns = [];
    $('#toast').hidden = true;
    fns.forEach((f) => f());
  });

  // ---------- dialogs: close safely ----------
  function guardDialog(dlg, isDirty) {
    let downOutside = false;
    const outside = (e) => {
      if (e.target !== dlg) return false;
      const r = dlg.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    dlg.addEventListener('pointerdown', (e) => (downOutside = outside(e)));
    // Only a tap that starts and ends on the backdrop closes it (not a text-selection drag).
    dlg.addEventListener('click', (e) => {
      if (downOutside && outside(e) && (!isDirty() || confirm('Discard your changes?'))) dlg.close();
      downOutside = false;
    });
    dlg.addEventListener('cancel', (e) => {
      if (isDirty() && !confirm('Discard your changes?')) e.preventDefault();
    });
  }

  // ---------- item editor ----------
  const itemDlg = $('#itemDlg');
  const itemForm = $('#itemForm');
  let editing = null;
  let returnFocus = null;

  function setRadio(form, name, val) {
    $$(`[data-radio="${name}"] button`, form).forEach((b) => {
      b.classList.toggle('on', b.dataset.val === val);
      b.setAttribute('aria-pressed', String(b.dataset.val === val));
    });
  }
  const getRadio = (form, name) => {
    const b = $(`[data-radio="${name}"] .on`, form);
    return b ? b.dataset.val : '';
  };

  function fillSectionOptions(sel, current) {
    sel.innerHTML = sortedSections(S.view)
      .map((s) => `<option value="${esc(s.id)}" ${s.id === current ? 'selected' : ''}>${esc(s.title)}</option>`)
      .join('');
  }

  function openItem(id, preset) {
    const it = id ? findItem(id) : null;
    if (id && !it) return;
    returnFocus = focusKeyOf(document.activeElement);
    const p = preset || {};
    const owner = it ? it.owner : p.owner || (S.ui.who !== 'all' ? S.ui.who : me() || 'both');
    const kind = it ? it.kind : p.kind || 'task';
    const base = it ? clone(it) : { id: uid(), title: '', owner, kind, section: p.section || defaultSection(kind, owner), date: p.date || '' };
    editing = { isNew: !it, id: base.id, orig: base, sectionTouched: !!p.section, prevDate: base.date || '' };
    const f = itemForm;
    f.reset();
    labelPeople();
    f.elements.link.setCustomValidity('');
    $('#itemDlgTitle').textContent = it ? 'Edit' : 'Add';
    f.elements.title.value = base.title || '';
    setRadio(f, 'owner', base.owner);
    f.elements.kind.value = base.kind || 'task';
    fillSectionOptions(f.elements.section, base.section);
    for (const k of ['date', 'endDate', 'time', 'when', 'place', 'priority', 'link', 'notes']) f.elements[k].value = base[k] || '';
    f.elements.tbc.checked = !!base.tbc;
    f.elements.pencil.checked = !!base.pencil;
    f.elements.done.checked = !!base.done;
    $('#itemDelete').hidden = !it;
    $('#itemMove').hidden = !it;
    const bits = [];
    if (it && it.dateText) bits.push(`The file has a date the app can’t read: “${it.dateText}”`);
    if (it && it.createdBy) bits.push(`Added by ${nm(it.createdBy)}${it.createdAt ? ` · ${relTime(it.createdAt)}` : ''}`);
    if (it && it.updatedAt) bits.push(`Last changed ${it.updatedBy ? `by ${nm(it.updatedBy)} ` : ''}${relTime(it.updatedAt)}`);
    if (it && it.done && it.doneBy) bits.push(`Done by ${nm(it.doneBy)}${it.doneAt ? ` · ${relTime(it.doneAt)}` : ''}`);
    $('#itemMeta').textContent = bits.join(' · ');
    itemDlg.showModal();
    if (!it) f.elements.title.focus();
  }

  function readItemForm() {
    const f = itemForm;
    const v = (n) => f.elements[n].value.trim();
    return {
      title: v('title'),
      owner: getRadio(f, 'owner') || 'both',
      kind: v('kind') || 'task',
      section: v('section'),
      date: v('date'),
      endDate: v('endDate'),
      time: v('time'),
      when: v('when'),
      place: v('place'),
      priority: v('priority'),
      tbc: f.elements.tbc.checked,
      pencil: f.elements.pencil.checked,
      done: f.elements.done.checked,
      link: v('link'),
      notes: f.elements.notes.value.trim(),
    };
  }

  // Fields that differ from what the editor opened with.
  function itemChanges(v) {
    const o = editing.orig;
    const changed = {};
    for (const [k, val] of Object.entries(v)) {
      const before = o[k] === undefined || o[k] === null ? (typeof val === 'boolean' ? false : '') : o[k];
      if (before !== val) changed[k] = val === '' || val === false ? null : val;
    }
    return changed;
  }
  const itemDirty = () => {
    if (!editing) return false;
    const v = readItemForm();
    if (editing.isNew) return !!(v.title || v.notes || v.place || v.link);
    return Object.keys(itemChanges(v)).length > 0;
  };

  function saveItem() {
    if (!editing) return;
    const f = itemForm;
    const v = readItemForm();
    if (!v.title) {
      f.elements.title.focus();
      return;
    }
    // No start date means not scheduled; an end before the start is dropped rather than guessed.
    if (!v.date) v.endDate = '';
    if (v.endDate && v.endDate <= v.date) v.endDate = '';
    if (v.link) {
      if (!/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(v.link)) v.link = `https://${v.link}`;
      if (!safeUrl(v.link)) {
        f.elements.link.setCustomValidity('Only web links (https://…) can be saved');
        f.elements.link.reportValidity();
        return;
      }
    }
    const ops = [];
    if (!S.view.sections.some((s) => s.id === v.section)) {
      const sid = 's-' + uid();
      ops.push({ op: 'add', kind: 'section', obj: { id: sid, title: 'Added later', owner: 'both', type: 'tasks', order: (sortedSections(S.view).length + 1) * 10 } });
      v.section = sid;
    }
    const isNew = editing.isNew;
    const id = editing.id;
    if (isNew) {
      const obj = Object.assign({ id, order: nextOrder(v.section) }, v, { createdAt: new Date().toISOString(), createdBy: me() });
      if (v.done) Object.assign(obj, { doneBy: me(), doneAt: new Date().toISOString() });
      ops.push({ op: 'add', kind: 'item', obj: compact(obj) });
      editing = null;
      itemDlg.close();
      commit(ops, `added “${v.title}”`);
      revealAdded(obj);
    } else {
      const changed = itemChanges(v);
      if ('section' in changed) changed.order = nextOrder(v.section);
      if ('done' in changed) Object.assign(changed, v.done ? { doneBy: me(), doneAt: new Date().toISOString() } : { doneBy: null, doneAt: null });
      editing = null;
      itemDlg.close();
      if (Object.keys(changed).length) {
        ops.push({ op: 'set', kind: 'item', id, fields: changed });
        const label = Object.keys(changed).length === 3 && 'done' in changed ? `${v.done ? '✓' : 'unticked'} “${v.title}”` : `edited “${v.title}”`;
        commit(ops, label);
      } else if (ops.length) commit(ops, 'added a list');
    }
    focusByKey(returnFocus);
  }

  function deleteItem(id) {
    const it = findItem(id);
    if (!it) return;
    const copy = clone(it);
    commit([{ op: 'del', kind: 'item', id }], `deleted “${it.title}”`);
    undoToast(`Deleted “${it.title}”`, () => commit([{ op: 'add', kind: 'item', obj: copy }], `restored “${copy.title}”`));
  }

  guardDialog(itemDlg, itemDirty);
  itemForm.addEventListener('submit', (e) => {
    e.preventDefault();
    saveItem();
  });
  itemForm.elements.link.addEventListener('input', (e) => e.target.setCustomValidity(''));
  itemForm.addEventListener('click', (e) => {
    const r = e.target.closest('[data-radio] button');
    if (r) {
      setRadio(itemForm, r.closest('[data-radio]').dataset.radio, r.dataset.val);
      if (editing && editing.isNew && !editing.sectionTouched) itemForm.elements.section.value = defaultSection(itemForm.elements.kind.value, r.dataset.val);
    }
    const c = e.target.closest('[data-clear]');
    if (c) {
      itemForm.elements[c.dataset.clear].value = '';
      if (c.dataset.clear === 'date') itemForm.elements.endDate.value = '';
      if (editing) editing.prevDate = itemForm.elements.date.value;
    }
    const m = e.target.closest('[data-move]');
    if (m && editing && !editing.isNew) moveItem(editing.id, +m.dataset.move);
  });
  // Moving the start date moves a multi-day item as a whole.
  itemForm.elements.date.addEventListener('change', () => {
    if (!editing) return;
    const f = itemForm.elements;
    const was = editing.prevDate;
    if (was && f.date.value && f.endDate.value) f.endDate.value = addDays(f.endDate.value, diffDays(was, f.date.value));
    if (!f.date.value) f.endDate.value = '';
    editing.prevDate = f.date.value;
  });
  // Giving a "needs scheduling" item a date or time usually means it's now scheduled.
  for (const n of ['date', 'time']) {
    itemForm.elements[n].addEventListener('change', () => {
      if (editing && editing.orig.tbc && itemForm.elements[n].value) itemForm.elements.tbc.checked = false;
    });
  }
  itemForm.elements.kind.addEventListener('change', () => {
    if (editing && editing.isNew && !editing.sectionTouched) itemForm.elements.section.value = defaultSection(itemForm.elements.kind.value, getRadio(itemForm, 'owner'));
  });
  itemForm.elements.section.addEventListener('change', () => {
    if (editing) editing.sectionTouched = true;
  });
  $('#itemDelete').addEventListener('click', () => {
    if (!editing) return;
    const id = editing.id;
    editing = null;
    itemDlg.close();
    deleteItem(id);
  });
  itemDlg.addEventListener('close', () => {
    editing = null;
  });

  // ---------- section editor ----------
  const secDlg = $('#secDlg');
  const secForm = $('#secForm');
  let editingSec = null;

  function readSecForm() {
    return {
      title: secForm.elements.title.value.trim(),
      owner: getRadio(secForm, 'owner') || 'both',
      priority: secForm.elements.priority.value,
      type: secForm.elements.type.value,
      note: secForm.elements.note.value.trim(),
    };
  }
  function secChanges(v) {
    const o = editingSec.orig;
    const changed = {};
    for (const [k, val] of Object.entries(v)) if ((o[k] || '') !== val) changed[k] = val === '' ? null : val;
    return changed;
  }
  const secDirty = () => !!editingSec && (editingSec.isNew ? !!readSecForm().title : Object.keys(secChanges(readSecForm())).length > 0);

  function openSection(id) {
    const s = id ? S.view.sections.find((x) => x.id === id) : null;
    returnFocus = focusKeyOf(document.activeElement);
    const base = s ? clone(s) : { id: 's-' + uid(), title: '', owner: S.ui.who !== 'all' ? S.ui.who : 'both', type: 'tasks', priority: '', note: '' };
    editingSec = { isNew: !s, id: base.id, orig: base };
    secForm.reset();
    labelPeople();
    $('#secDlgTitle').textContent = s ? 'Edit list' : 'New list';
    secForm.elements.title.value = base.title || '';
    setRadio(secForm, 'owner', base.owner);
    secForm.elements.priority.value = base.priority || '';
    secForm.elements.type.value = base.type || 'tasks';
    secForm.elements.note.value = base.note || '';
    $('#secDelete').hidden = !s;
    $('#secMove').hidden = !s;
    secDlg.showModal();
    if (!s) secForm.elements.title.focus();
  }

  guardDialog(secDlg, secDirty);
  secDlg.addEventListener('close', () => {
    editingSec = null;
  });
  secForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!editingSec) return;
    const v = readSecForm();
    if (!v.title) return secForm.elements.title.focus();
    const isNew = editingSec.isNew;
    const id = editingSec.id;
    const changed = isNew ? null : secChanges(v);
    editingSec = null;
    secDlg.close();
    if (isNew) {
      const order = (Math.max(0, ...S.view.sections.map((s) => (typeof s.order === 'number' ? s.order : 0))) || 0) + 10;
      commit([{ op: 'add', kind: 'section', obj: compact(Object.assign({ id, order }, v)) }], `new list “${v.title}”`);
    } else if (Object.keys(changed).length) commit([{ op: 'set', kind: 'section', id, fields: changed }], `edited list “${v.title}”`);
    focusByKey(returnFocus);
  });
  secForm.addEventListener('click', (e) => {
    const r = e.target.closest('[data-radio] button');
    if (r) setRadio(secForm, 'owner', r.dataset.val);
    const m = e.target.closest('[data-move]');
    if (m && editingSec && !editingSec.isNew) moveSection(editingSec.id, +m.dataset.move);
  });
  $('#secDelete').addEventListener('click', () => {
    if (!editingSec) return;
    const s = S.view.sections.find((x) => x.id === editingSec.id);
    if (!s) return;
    const items = S.view.items.filter((i) => i.section === s.id);
    if (!confirm(`Delete the list “${s.title}”${items.length ? ` and its ${items.length} item${items.length > 1 ? 's' : ''}` : ''}?`)) return;
    const copyS = clone(s);
    const copyI = clone(items);
    editingSec = null;
    secDlg.close();
    commit([{ op: 'del', kind: 'section', id: s.id }, ...items.map((i) => ({ op: 'del', kind: 'item', id: i.id }))], `deleted list “${s.title}”`);
    undoToast(`Deleted “${s.title}”`, () =>
      commit([{ op: 'add', kind: 'section', obj: copyS }, ...copyI.map((i) => ({ op: 'add', kind: 'item', obj: i }))], `restored list “${copyS.title}”`)
    );
  });

  // ---------- settings ----------
  const setDlg = $('#setDlg');
  const setForm = $('#setForm');

  function openSettings() {
    const c = S.cfg;
    const m = mode();
    labelPeople();
    setForm.elements.owner.value = c.owner || '';
    setForm.elements.repo.value = c.repo || '';
    setForm.elements.branch.value = c.branch || 'main';
    setForm.elements.path.value = c.path || DEFAULT_PATH;
    setForm.elements.token.value = '';
    setForm.elements.token.placeholder = c.token ? '•••••••• saved — leave empty to keep' : 'github_pat_…';
    setForm.elements.apiBase.value = c.apiBase || '';
    setForm.elements.invitePin.value = '';
    setForm.elements.inviteLink.value = '';
    $('#inviteOut').hidden = true;
    setRadio(setForm, 'me', me() || '');
    $('#meField').hidden = m === 'none';
    $('#meField').classList.toggle('need-me', m !== 'none' && !me());
    const d = S.view;
    $('#tripGroup').hidden = m === 'none';
    setForm.elements.tripTitle.value = d.title || '';
    setForm.elements.tripHome.value = d.home || '';
    setForm.elements.tripDep.value = d.departure || '';
    setForm.elements.tripDepNote.value = d.departureNote || '';
    setForm.elements.tripRet.value = d.returnDate || '';
    $('#disconnectBtn').hidden = m === 'none';
    $('#disconnectBtn').textContent = m === 'local' ? 'Delete this board…' : 'Forget on this device';
    $('#inviteGroup').hidden = !connected();
    $('#exportBtn').disabled = m === 'none';
    renderSyncDetail();
    if (!setDlg.open) setDlg.showModal();
  }

  function renderSyncDetail() {
    const el = $('#syncDetail');
    const m = mode();
    const link = $('#historyLink');
    const isGh = !S.cfg.apiBase || S.cfg.apiBase.replace(/\/+$/, '') === DEFAULT_API;
    if (m === 'remote' && isGh) {
      link.href = `https://github.com/${encodeURIComponent(S.cfg.owner)}/${encodeURIComponent(S.cfg.repo)}/commits/${encodeURIComponent(S.cfg.branch || 'main')}/${(S.cfg.path || DEFAULT_PATH).split('/').map(encodeURIComponent).join('/')}`;
      link.hidden = false;
    } else link.hidden = true;
    let html;
    if (m === 'remote') {
      html = `Connected to <b>${esc(S.cfg.owner)}/${esc(S.cfg.repo)}</b>.`;
      if (S.sync.err) html += ` <br><b>Problem:</b> ${esc(S.sync.err.msg)}`;
      else if (S.sync.lastOk) html += ` Last synced ${esc(relTime(S.sync.lastOk))}.`;
      if (S.pending.length) html += ` ${S.pending.length} change${S.pending.length > 1 ? 's' : ''} waiting to be saved.`;
    } else if (m === 'local') html = 'Saved on this device only. Connect below to share it — what you added here will be offered to the shared board.';
    else html = 'Not connected yet. Open the invite link from the other phone, or connect with an access token.';
    if (m !== 'none' && !me()) html += ' <br><b>Tap your name below</b> so changes show who made them.';
    el.innerHTML = html;
  }

  const targetKey = (c) => [c.apiBase || '', String(c.owner || '').toLowerCase(), String(c.repo || '').toLowerCase(), c.branch || 'main', c.path || DEFAULT_PATH].join('|');
  const okApiBase = (u) => !u || /^https:\/\/[^/]+/i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(u);

  function exportDoc(doc, name) {
    const blob = new Blob([serialize(doc)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name || `trip-board-${todayISO()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // Items made in "this device only" mode are kept aside until they're merged or deliberately dropped.
  function offerCarry() {
    const carry = LS.get(KEY.carry, null);
    if (!carry || !Array.isArray(carry.items) || !connected() || !S.base || !S.base.sha) return;
    const have = new Set(S.view.items.map((i) => i.id));
    const items = carry.items.filter((i) => i && i.id && !have.has(i.id));
    if (!items.length) return LS.del(KEY.carry);
    if (confirm(`Add the ${items.length} item${items.length > 1 ? 's' : ''} you made on this device to the shared board?`)) {
      const secIds = new Set(S.view.sections.map((s) => s.id));
      // Items in the starter lists go to the matching lists on the shared board instead of duplicating them.
      const starter = new Set(emptyDoc().sections.map((s) => s.id));
      for (const i of items) if (starter.has(i.section) && !secIds.has(i.section)) i.section = defaultSection(i.kind, i.owner);
      const needSecs = (carry.sections || []).filter((s) => s && !secIds.has(s.id) && items.some((i) => i.section === s.id));
      commit(
        [...needSecs.map((s) => ({ op: 'add', kind: 'section', obj: s })), ...items.map((i) => ({ op: 'add', kind: 'item', obj: i }))],
        `added ${items.length} item${items.length > 1 ? 's' : ''} from this device`
      );
    } else if (confirm('Save them as a backup file before they’re removed from this device?')) exportDoc(carry, `trip-board-this-device-${todayISO()}.json`);
    LS.del(KEY.carry);
  }

  async function connectWith(next) {
    const detail = $('#syncDetail');
    if (!next.owner || !next.repo || !next.token) {
      detail.innerHTML = '<b>Fill in owner, repository and access token.</b>';
      return;
    }
    if (!okApiBase(next.apiBase)) {
      detail.innerHTML = '<b>The API address must start with https://</b>';
      return;
    }
    const same = connected() && targetKey(next) === targetKey(S.cfg);
    if (connected() && !same && S.pending.length && !confirm(`${S.pending.length} change(s) haven’t reached ${S.cfg.owner}/${S.cfg.repo} yet and will be dropped if you switch. Switch anyway?`)) return;
    const prev = { cfg: S.cfg, base: S.base, pending: S.pending };
    const localDoc = S.base && S.base.local ? applyAll(S.base.doc, S.pending) : null;
    if (localDoc && localDoc.items.length) LS.set(KEY.carry, localDoc);
    resetSync();
    S.cfg = next;
    LS.set(KEY.cfg, S.cfg);
    if (!same) {
      // Only in memory: the stored copy is replaced once the new board has loaded.
      S.base = null;
      S.pending = [];
    }
    detail.textContent = 'Connecting…';
    refresh();
    await pull(true);
    let err = S.sync.err;
    if (err && err.kind === 'notfound' && (await gh.repoExists())) {
      const copy = localDoc || (prev.base && prev.base.doc && !prev.base.local && same ? applyAll(prev.base.doc, prev.pending) : null);
      const what = copy ? `from the board on this device (${copy.items.length} items)` : 'with an empty board';
      if (confirm(`${S.cfg.path || DEFAULT_PATH} doesn't exist in ${S.cfg.owner}/${S.cfg.repo} yet. Create it ${what}?`)) {
        S.sync.err = null;
        try {
          const doc = copy || emptyDoc();
          const r = await gh.put(doc, null, `${me() ? nm(me()) : 'Trip Board'}: create board`);
          if (r.conflict) await pull(true); // created by the other phone a moment ago
          else {
            S.base = { doc: normalize(clone(doc)), sha: r.sha, etag: null };
            S.pending = [];
            if (copy === localDoc) LS.del(KEY.carry);
          }
        } catch (e) {
          handleSyncError(e);
        }
        err = S.sync.err;
      }
    }
    if (err || !S.base) {
      // Nothing loaded, so put everything back the way it was.
      const why = err ? err.msg : 'The board didn’t load.';
      resetSync();
      S.cfg = prev.cfg;
      S.base = prev.base;
      S.pending = prev.pending;
      LS.set(KEY.cfg, S.cfg);
      persist();
      refresh();
      if (setDlg.open) openSettings();
      $('#syncDetail').innerHTML = `<b>Couldn’t connect:</b> ${esc(why)}${prev.base && prev.base.local ? '<br>Your board on this device is untouched.' : ''}`;
      if (connected()) pull(true);
      return why;
    }
    persist();
    refresh();
    offerCarry();
    if (setDlg.open) openSettings();
    if (me()) toast('Connected ✓');
    else openWho();
    return true;
  }

  // ---------- invite link + PIN ----------
  // The link carries owner/repo/token encrypted with a key derived from the PIN, so the
  // link alone is useless if it's forwarded or seen. It sits after '#', which browsers
  // never send to any server.
  const INVITE_ITER = 600000;
  const bytesToB64url = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const b64urlToBytes = (s) => {
    let b = s.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const bin = atob(b);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  async function pinKey(pin, salt) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: INVITE_ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  const isLocalApi = (u) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(u || '');
  async function makeInvite(pin) {
    const c = S.cfg;
    const payload = { o: c.owner, r: c.repo, t: c.token };
    if ((c.branch || 'main') !== 'main') payload.b = c.branch;
    if ((c.path || DEFAULT_PATH) !== DEFAULT_PATH) payload.p = c.path;
    if (isLocalApi(c.apiBase)) payload.a = c.apiBase; // only for local testing
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await pinKey(pin, salt), new TextEncoder().encode(JSON.stringify(payload))));
    const blob = new Uint8Array(1 + salt.length + iv.length + ct.length);
    blob[0] = 1;
    blob.set(salt, 1);
    blob.set(iv, 17);
    blob.set(ct, 29);
    return `${location.origin}${location.pathname}#j=${bytesToB64url(blob)}`;
  }
  async function openInvite(code, pin) {
    const blob = b64urlToBytes(code);
    if (blob[0] !== 1 || blob.length < 40) throw new Error('bad link');
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(17, 29) }, await pinKey(pin, blob.slice(1, 17)), blob.slice(29));
    const o = JSON.parse(new TextDecoder().decode(plain));
    // An API address is only honoured for local testing, so a link can't send the token elsewhere.
    return { owner: String(o.o || ''), repo: String(o.r || ''), branch: String(o.b || 'main'), path: String(o.p || DEFAULT_PATH), token: String(o.t || ''), apiBase: isLocalApi(o.a) ? o.a : '' };
  }
  const inviteFrom = (s) => {
    const m = /#j=([A-Za-z0-9_-]{40,})/.exec(String(s || ''));
    return m ? m[1] : null;
  };
  S.invite = connected() ? null : inviteFrom(location.hash);

  async function submitPin(form) {
    const msg = $('[data-msg]', form.parentNode);
    const btn = $('button', form);
    const pin = form.elements.pin.value.trim();
    if (!pin) return;
    if (!window.crypto || !crypto.subtle) {
      msg.textContent = 'This browser can’t open invite links. Try Safari or Chrome.';
      return;
    }
    btn.disabled = true;
    msg.textContent = 'Opening…';
    let cfg;
    try {
      cfg = await openInvite(S.invite, pin);
    } catch {
      btn.disabled = false;
      msg.textContent = 'That PIN doesn’t match this link. Try again.';
      return;
    }
    const res = await connectWith(Object.assign({}, S.cfg, cfg));
    btn.disabled = false;
    if (res !== true) msg.textContent = `Couldn’t open the board: ${res}`;
  }

  document.addEventListener('submit', (e) => {
    const f = e.target.closest('#welcome form');
    if (!f) return;
    e.preventDefault();
    if (f.dataset.form === 'pin') submitPin(f);
    else {
      const code = inviteFrom(f.elements.link.value);
      if (!code) {
        $('[data-msg]', f.parentNode).textContent = 'That doesn’t look like an invite link — it should end with #j=…';
        return;
      }
      S.invite = code;
      render();
      const pin = $('#welcome input[name="pin"]');
      if (pin) pin.focus();
    }
  });

  // ---------- who's using this phone ----------
  const whoDlg = $('#whoDlg');
  function openWho() {
    $$('[data-me]', whoDlg).forEach((b) => (b.textContent = nm(b.dataset.me)));
    if (!whoDlg.open) whoDlg.showModal();
  }
  whoDlg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-me]');
    if (!b) return;
    S.cfg = Object.assign({}, S.cfg, { me: b.dataset.me });
    LS.set(KEY.cfg, S.cfg);
    whoDlg.close();
    refresh();
    toast(`Hi ${nm(b.dataset.me)} — you’re all set`);
  });
  whoDlg.addEventListener('cancel', (e) => e.preventDefault());

  function readSettings() {
    const v = (n) => setForm.elements[n].value.trim();
    const apiBase = v('apiBase').replace(/\/+$/, '');
    // A saved token is only reused for the same API address.
    const keepToken = (apiBase || '') === (S.cfg.apiBase || '');
    return Object.assign({}, S.cfg, {
      owner: v('owner'),
      repo: v('repo'),
      branch: v('branch') || 'main',
      path: v('path').replace(/^\/+/, '') || DEFAULT_PATH,
      token: v('token') || (keepToken ? S.cfg.token || '' : ''),
      apiBase,
    });
  }

  setForm.addEventListener('submit', (e) => e.preventDefault());
  setForm.addEventListener('click', (e) => {
    const r = e.target.closest('[data-radio="me"] button');
    if (r) {
      setRadio(setForm, 'me', r.dataset.val);
      S.cfg = Object.assign({}, S.cfg, { me: r.dataset.val });
      LS.set(KEY.cfg, S.cfg);
      $('#meField').classList.remove('need-me');
      renderSyncDetail();
    }
  });
  $('#connectBtn').addEventListener('click', () => connectWith(readSettings()));
  $('#makeInviteBtn').addEventListener('click', async () => {
    if (!connected()) return;
    const pin = setForm.elements.invitePin.value.trim();
    if (pin.length < 6) return toast('Pick a PIN of at least 6 digits');
    $('#makeInviteBtn').disabled = true;
    try {
      setForm.elements.inviteLink.value = await makeInvite(pin);
      $('#inviteOut').hidden = false;
    } catch {
      toast('Couldn’t make the link in this browser');
    } finally {
      $('#makeInviteBtn').disabled = false;
    }
  });
  $('#copyInviteBtn').addEventListener('click', async () => {
    const link = setForm.elements.inviteLink.value;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied — send it, and tell the PIN separately');
    } catch {
      setForm.elements.inviteLink.select();
      toast('Select the link and copy it');
    }
  });
  $('#saveTripBtn').addEventListener('click', () => {
    const v = (n) => setForm.elements[n].value.trim();
    const want = { title: v('tripTitle'), home: v('tripHome'), departure: v('tripDep'), departureNote: v('tripDepNote'), returnDate: v('tripRet') };
    if (want.departure && want.returnDate && want.returnDate < want.departure) return toast('The return date is before departure');
    const fields = {};
    for (const [k, val] of Object.entries(want)) if ((S.view[k] || '') !== val) fields[k] = val || null;
    if (!Object.keys(fields).length) return toast('Nothing changed');
    commit([{ op: 'meta', fields }], 'edited trip details');
    toast('Trip details saved');
  });
  $('#disconnectBtn').addEventListener('click', () => {
    if (mode() === 'local') {
      const n = S.view.items.length;
      if (!confirm(`Delete the board on this device? It has ${n} item${n === 1 ? '' : 's'} and there is no copy on GitHub.`)) return;
      if (n && confirm('Download a backup file first?')) exportDoc(S.view);
    } else {
      const unsaved = S.pending.length ? ` ${S.pending.length} unsaved change(s) will be lost.` : '';
      if (!confirm(`Forget the connection and the copy of the board on this device?${unsaved} The board on GitHub is not touched.`)) return;
    }
    resetSync();
    S.cfg = { me: S.cfg.me };
    S.base = null;
    S.pending = [];
    S.old = {};
    LS.set(KEY.cfg, S.cfg);
    LS.del(KEY.old);
    LS.del(KEY.carry);
    persist();
    setDlg.close();
    refresh();
  });
  $('#exportBtn').addEventListener('click', () => exportDoc(S.view));
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let doc;
    try {
      doc = JSON.parse(await file.text());
      if (!isObj(doc) || !Array.isArray(doc.items) || !Array.isArray(doc.sections)) throw new Error();
    } catch {
      toast('That file isn’t a Trip Board backup');
      return;
    }
    if (mode() !== 'remote') {
      if (mode() === 'local' && !confirm(`Replace the board on this device with “${file.name}”?`)) return;
      S.base = { local: true, doc: normalize(doc) };
      S.pending = [];
      S.invite = null; // they chose this board over the invite's PIN screen
      persist();
      setDlg.close();
      refresh();
      return;
    }
    // A restore must reach GitHub straight away; queued, it could wipe the other phone's later work.
    if (S.sync.err || !navigator.onLine) return toast('Restoring needs a working connection — try again when it says Synced');
    if (!confirm(`Replace the whole board with “${file.name}” (${doc.items.length} items)? Anything changed since that backup is lost — GitHub keeps the history.`)) return;
    commit([{ op: 'replace', doc: normalize(doc) }], `restored from backup ${file.name}`);
    const u = S.pending[S.pending.length - 1].u;
    clearTimeout(S.saveTimer);
    for (let i = 0; i < 100 && S.sync.busy; i++) await sleep(200);
    await save();
    if (S.pending.some((o) => o.u === u)) {
      S.pending = S.pending.filter((o) => o.u !== u);
      persist();
      refresh();
      toast('Couldn’t restore — nothing was changed. Try again when online.');
    } else {
      setDlg.close();
      toast('Restored ✓');
    }
  });
  guardDialog(setDlg, () => false);

  // ---------- global events ----------
  function scrollToDay(day) {
    const el = document.getElementById('d-' + day);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  document.addEventListener('click', (e) => {
    const close = e.target.closest('[data-close]');
    if (close) {
      const dlg = close.closest('dialog');
      const dirty = dlg === itemDlg ? itemDirty() : dlg === secDlg ? secDirty() : false;
      if (!dirty || confirm('Discard your changes?')) dlg.close();
      return;
    }
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    switch (act) {
      case 'edit':
        openItem(t.dataset.id);
        break;
      case 'sec-toggle': {
        const s = S.view.sections.find((x) => x.id === t.dataset.sec);
        S.ui.collapsed[t.dataset.sec] = !(s ? isCollapsed(s) : S.ui.collapsed[t.dataset.sec]);
        saveUi();
        render();
        break;
      }
      case 'sec-edit':
        openSection(t.dataset.sec);
        break;
      case 'sec-new':
        openSection(null);
        break;
      case 'cal-prev':
      case 'cal-next': {
        const [y, m] = (S.ui.month || defaultMonth(S.view)).split('-').map(Number);
        const d = new Date(Date.UTC(y, m - 1 + (act === 'cal-next' ? 1 : -1), 1));
        S.ui.month = d.toISOString().slice(0, 7);
        render();
        break;
      }
      case 'cal-today':
        S.ui.month = defaultMonth(S.view);
        S.ui.selected = null;
        render();
        scrollToDay(todayISO());
        break;
      case 'cal-day':
        S.ui.selected = t.dataset.date;
        render();
        scrollToDay(t.dataset.date);
        break;
      case 'day-add':
        openItem(null, { date: t.dataset.date, kind: 'meet' });
        break;
      case 'toggle-past':
        S.ui.showPast = !S.ui.showPast;
        saveUi();
        render();
        break;
      case 'tray-all':
        S.ui.trayAll = !S.ui.trayAll;
        saveUi();
        render();
        break;
      case 'goto-today':
        S.ui.tab = 'sched';
        saveUi();
        render();
        scrollToDay(todayISO());
        break;
      case 'goto-tray':
        S.ui.tab = 'sched';
        S.ui.trayOpen = true;
        saveUi();
        render();
        {
          const tray = $('#tray');
          if (tray) tray.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        break;
      case 'open-settings':
        openSettings();
        break;
    }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('.cb[data-id]')) toggleDone(t.dataset.id, t.checked);
    else if (t.id === 'hideDone') {
      S.ui.hideDone = t.checked;
      saveUi();
      render();
    }
  });
  document.addEventListener('submit', (e) => {
    const f = e.target.closest('.quick-add');
    if (f) {
      e.preventDefault();
      quickAdd(f);
    }
  });
  document.addEventListener(
    'toggle',
    (e) => {
      if (e.target.id === 'tray') {
        S.ui.trayOpen = e.target.open;
        saveUi();
      }
    },
    true
  );
  // Japanese input: never rebuild the list in the middle of composing a word.
  document.addEventListener('compositionstart', () => (composing = true));
  document.addEventListener('compositionend', () => {
    composing = false;
    if (deferredRender) setTimeout(() => !typing() && render(), 0);
  });
  document.addEventListener('focusout', (e) => {
    if (deferredRender && e.target.matches && e.target.matches('.quick-add input')) setTimeout(() => !typing() && render(), 0);
  });

  $('#whoFilter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-who]');
    if (!b) return;
    S.ui.who = b.dataset.who;
    saveUi();
    render();
  });
  $('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    S.ui.tab = b.dataset.tab;
    S.ui.selected = null;
    saveUi();
    render();
    window.scrollTo({ top: 0 });
  });
  $('#syncBtn').addEventListener('click', () => openSettings());
  const addFromHeader = () => openItem(null, {});
  $('#addBtn').addEventListener('click', addFromHeader);
  $('#fab').addEventListener('click', addFromHeader);

  // Keep the sticky header height in a CSS variable for the schedule column.
  const top = $('.top');
  const setTopH = () => {
    document.documentElement.style.setProperty('--top-h', `${top.offsetHeight}px`);
    document.documentElement.style.setProperty('--tabs-h', `${$('.tabs').offsetHeight || 0}px`);
  };
  if (window.ResizeObserver) new ResizeObserver(setTopH).observe(top);
  setTopH();

  // ---------- another tab on this device ----------
  window.addEventListener('storage', (e) => {
    if (e.key === KEY.pending) {
      // No board here to apply them to; persisting would wipe the other tab's board on this device.
      if (!connected() && !S.base) return;
      const theirs = parseJSON(e.newValue) || [];
      const have = new Set(S.pending.map((o) => o.u));
      const extra = Array.isArray(theirs) ? theirs.filter((o) => o && o.u && !have.has(o.u)) : [];
      if (!extra.length) return;
      S.pending = S.pending.concat(extra).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
      dropLanded();
      persist();
      refreshQuiet();
      if (connected()) scheduleSave(800);
    } else if (e.key === KEY.base) {
      const b = parseJSON(e.newValue);
      const mine = S.base && S.base.doc && S.base.doc.updatedAt;
      if (S.sync.busy || !b || !b.sha || !b.doc || (S.base && b.sha === S.base.sha) || isStale(b.sha)) return;
      if (mine && !(b.doc.updatedAt > mine)) return;
      S.base = { doc: normalize(b.doc), sha: b.sha, etag: b.etag || null };
      dropLanded();
      refreshQuiet();
    } else if (e.key === KEY.cfg) {
      S.cfg = parseJSON(e.newValue) || {};
      refresh();
    }
  });

  // ---------- sync triggers ----------
  setInterval(() => {
    if (document.visibilityState === 'visible' && connected() && !S.sync.busy && !S.pending.length && !S.sync.err) pull();
  }, 25000);
  // Send edits before the phone puts the page to sleep.
  const flush = () => {
    if (connected() && S.pending.length && !S.sync.busy && S.base && S.base.sha) save({ keepalive: true });
  };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') return flush();
    if (connected() && !S.sync.busy) {
      if (S.sync.err && ['offline', 'rate', 'conflict', 'error'].includes(S.sync.err.kind)) S.sync.err = null;
      if (S.pending.length) save();
      else pull();
    }
    render({ background: true });
  });
  window.addEventListener('online', () => {
    if (!connected()) return;
    S.sync.err = null;
    if (S.pending.length) save();
    else pull();
  });
  // Midnight rollover: re-render so "today" moves.
  let lastDay = todayISO();
  setInterval(() => {
    if (todayISO() !== lastDay) {
      lastDay = todayISO();
      S.ui.month = null;
      render({ background: true });
    }
  }, 60000);

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // ---------- start ----------
  // "This device only" is no longer offered. A board left untouched from trying it would hide the welcome screen.
  if (!connected() && S.base && S.base.local && untouched(applyAll(S.base.doc, S.pending))) {
    S.base = null;
    S.pending = [];
    persist();
  }
  refresh();
  if (connected()) {
    (S.pending.length ? save() : pull(true)).then(() => offerCarry());
  } else if (S.pending.length && S.base && S.base.local) save();
})();
