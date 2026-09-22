/* ═══════════════════════════════════════════════════════════
   💬 CHAT X·STREAM — servidor propio (sin Firebase, sin terceros)
   Vercel serverless + el repo de GitHub como almacén.

   Modelo de concurrencia: leer → mutar → escribir; ante choque de sha
   (dos escrituras a la vez), se relee, se re-aplica y se reintenta.

   Autenticación de admin: firma ECDSA del propio dispositivo admin
   (la misma clave con la que publicas el catálogo — la clave pública
   está embebida aquí). Cero tokens compartidos.

     GET  ?op=state&after=<id>&room=<id>&me=<uid>  → msgs+dms nuevos, presence, meta
     GET  ?op=presence                             → usuarios en línea
     GET  ?op=dm-list&me=<uid>                     → bandeja de privados
     GET  ?op=unfurl&url=<u>                       → tarjeta de enlace
     POST { op:'beat', uid, name, role, room }     → presencia + asigna sala
     POST { op:'sent', room, uid, name, role, text }→ mensaje sala
     POST { op:'dm', to, uid, name, role, text }   → mensaje privado
     POST { op:'fav'|'unfav', uid, msgId }         → ❤ enlaces (persisten)
     POST { op:'favList', uid }                    → mis favoritos
     POST { op:'dmRead', uid, peer }               → marca leídos
     POST { op:'meta'|'bgUpload'|'bgClear', ..., adminSig } → ajustes

   Env: GH_TOKEN (contents:write del repo).
   ═══════════════════════════════════════════════════════════ */
'use strict';

const GH_API = 'https://api.github.com';
const REPO = process.env.GH_REPO || 'Dcardkevein15/pelisfull';
const BRANCH = 'main';
const PATH = 'chat.json';
const MAX_MSGS_KEPT = 400;
const MAX_TXT = 2000;
const ONLINE_MS = 90 * 1000;

/* 🔐 clave pública del admin (la misma que firma catalog.json) */
const ADMIN_PUB_B64 = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEkO2b+Vm4MNlm+97FaZdXilRkF8KCr0XfqjhtQ00wc8SCsUAz6zA60rxYqnHuRIY7fNJCL6rCYDP5W5DOaNnorA==';

const toB64 = s => Buffer.from(s, 'utf8').toString('base64');
const fromB64 = s => Buffer.from(s, 'base64').toString('utf8');
const uidOk = u => /^[\w-]{3,60}$/.test(String(u || ''));
const SHORT_ID = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

async function gh(tk, method, path, body) {
  const r = await fetch(GH_API + path, {
    method,
    headers: { Authorization: 'token ' + tk, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 404) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.message || ('GitHub HTTP ' + r.status)); e.status = r.status; throw e; }
  return j;
}

/* ═══ verificación de firma del administrador ═══ */
function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
async function isAdminSig(sigB64, when) {
  /* el cliente firma "xstream-chat-admin:<hora-epoch-redondeada-a-la-hora>" */
  try {
    const key = await crypto.subtle.importKey('spki', Buffer.from(ADMIN_PUB_B64, 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const sig = Buffer.from(String(sigB64 || ''), 'base64');
    const hora = Math.floor(Date.now() / 3600000);
    for (const h of [hora, hora - 1]) {
      const data = new TextEncoder().encode('xstream-chat-admin:' + h);
      if (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, data)) return true;
    }
  } catch (e) { }
  return false;
}

function blankDb() {
  return {
    meta: { maxUsers: 50, ttlHours: 48, dmTtlHours: 48, bg: {}, bgTs: 0, updatedAt: Date.now() },
    msgs: [], dms: [], presence: {}, favs: {},
    rooms: [{ id: 'general', name: '🏠 General' }],
    roomSeq: 1,
  };
}
async function dbRead(tk, forceFresh) {
  /* si hay copia en memoria fresca (<7 s), úsala — salvo cuando se pide forzar
     (para escrituras que requieren el sha al día).                              */
  if (!forceFresh && _mem.db && (Date.now() - _mem.at) < MEM_TTL_MS) return { db: _mem.db, sha: _mem.sha };
  const f = await gh(tk, 'GET', `/repos/${REPO}/contents/${PATH}?ref=${BRANCH}&t=${Date.now()}`);
  if (!f) return { db: blankDb(), sha: null };
  let db; try { db = JSON.parse(fromB64(String(f.content || '').replace(/\s+/g, ''))); } catch (e) { db = blankDb(); }
  const blank = blankDb();
  for (const k of Object.keys(blank)) if (db[k] === undefined) db[k] = blank[k];
  db.meta = Object.assign(blank.meta, db.meta || {});
  if (!Array.isArray(db.rooms) || !db.rooms.length) db.rooms = blank.rooms;
  _mem = { at: Date.now(), db, sha: f.sha };
  return { db, sha: f.sha };
}
async function dbWrite(tk, mutate) {
  let lastErr = null;
  for (let i = 1; i <= 5; i++) {                       /* 5 intentos */
    const { db, sha } = await dbRead(tk, true);        /* 🔑 el sha FRESCO sí o sí */
    purge(db);
    db.rev = (db.rev || 0) + 1;
    const out = mutate(db);
    try {
      const resp = await gh(tk, 'PUT', `/repos/${REPO}/contents/${PATH}`, {
        message: '💬 chat', branch: BRANCH, content: toB64(JSON.stringify(db)),
        ...(sha ? { sha } : {}),
      });
      /* guardamos en memoria la base NUEVA (sha del propio PUT ya es el actual) */
      _mem = { at: Date.now(), db, sha: (resp && resp.content && resp.content.sha) || sha };
      return { db, out };
    } catch (e) {
      lastErr = e;
      if (e.status !== 409 && e.status !== 422) throw e;
      _mem.at = 0;                                     /* cache viejo → próximo intento relee */
      await new Promise(r => setTimeout(r, 300 * i));  /* respiro creciente entre reintentos */
    }
  }
  throw new Error('no se pudo guardar tras 5 intentos (' + (lastErr && lastErr.message) + ')');
}
function purge(db) {
  const now = Date.now();
  const msgTtl = (db.meta.ttlHours || 48) * 3600e3;
  const dmTtl = (db.meta.dmTtlHours || db.meta.ttlHours || 48) * 3600e3;
  db.msgs = db.msgs.filter(m => now - m.ts <= msgTtl);
  db.dms = db.dms.filter(m => now - m.ts <= dmTtl);
  if (db.msgs.length > MAX_MSGS_KEPT) db.msgs = db.msgs.slice(-MAX_MSGS_KEPT);
  if (db.dms.length > MAX_MSGS_KEPT) db.dms = db.dms.slice(-MAX_MSGS_KEPT);
  return db;
}
function onlineList(db) {
  const now = Date.now();
  return Object.entries(db.presence || {})
    .filter(([, p]) => now - p.ts < ONLINE_MS)
    .map(([uid, p]) => ({ uid, name: p.name, role: p.role || 'user', room: p.room, ts: p.ts }));
}
function pickRoom(db, preferRoom) {
  const list = onlineList(db);
  const count = id => list.filter(p => p.room === id).length;
  const maxU = Math.max(1, db.meta.maxUsers || 50);
  if (preferRoom && count(preferRoom) < maxU) return preferRoom;
  for (const r of db.rooms) if (count(r.id) < maxU) return r.id;
  db.roomSeq = (db.roomSeq || db.rooms.length) + 1;
  const nueva = { id: 'sala' + db.roomSeq, name: '💬 Sala ' + db.roomSeq };
  db.rooms.push(nueva);
  return nueva.id;
}

/* la subida al repo puede tardar más que el timeout habitual: damos margen */
module.exports.config = { maxDuration: 30 };

/* caché caliente de la base del chat por instancia — reduce MUCHO las llamadas
   a GitHub cuando hay polling frecuente (decenas de usuarios a la vez)       */
let _mem = { at: 0, db: null, sha: null };
const MEM_TTL_MS = 7000;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-chat-sig,x-chat-ts,x-chat-key');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const tk = process.env.GH_TOKEN;
  if (!tk) return res.status(500).json({ ok: false, error: 'falta GH_TOKEN en Vercel' });
  /* admin = firma ECDSA de la hora actual con tu clave privada de publicación */
  const adminOk = () => isAdminSig(req.headers['x-chat-sig'], Date.now());

  try {
    /* ═══════════ GET ═══════════ */
    if (req.method === 'GET') {
      const op = String(req.query.op || 'state');

      if (op === 'unfurl') {
        const url = String(req.query.url || '');
        if (!/^https?:\/\//i.test(url) || url.length > 2048) return res.status(400).json({ ok: false, error: 'url' });
        try {
          const ctrl = new AbortController();
          const to = setTimeout(() => ctrl.abort(), 7000);
          const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; XStreamBot/1.0)' } });
          clearTimeout(to);
          const ct = r.headers.get('content-type') || '';
          if (!r.ok || !/text\/html/i.test(ct)) return res.status(200).json({ ok: true, url, title: null });
          const html = (await r.text()).slice(0, 400000);
          const pick = re => { const m = html.match(re); return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 200) : null; };
          const title = pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)
            || pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)
            || pick(/<title[^>]*>([^<]+)<\/title>/i);
          const desc = pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)/i)
            || pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i);
          const img = pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i)
            || pick(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)/i);
          return res.status(200).json({ ok: true, url, title, desc, img });
        } catch (e) {
          return res.status(200).json({ ok: true, url, title: null });
        }
      }

      const { db } = await dbRead(tk);

      if (op === 'presence') {
        return res.status(200).json({ ok: true, online: onlineList(db), now: Date.now() });
      }

      if (op === 'dm-list') {
        const me = String(req.query.me || '');
        if (!uidOk(me)) return res.status(400).json({ ok: false, error: 'uid' });
        const threads = {};
        for (const m of db.dms) {
          if (m.from !== me && m.to !== me) continue;
          const peer = m.from === me ? m.to : m.from;
          const t = threads[peer] = threads[peer] || { peer, lastTs: 0, lastText: '', unread: 0, peerName: '' };
          if (m.ts >= t.lastTs) { t.lastTs = m.ts; t.lastText = m.text.slice(0, 80); }
          if (m.to === me && !m.read) t.unread++;
        }
        for (const t of Object.values(threads)) {
          const ult = db.dms.filter(m => (m.from === t.peer && m.to === me) || (m.from === me && m.to === t.peer))
            .sort((a, b) => b.ts - a.ts)[0];
          const p = (db.presence || {})[t.peer];
          t.peerName = (p && p.name) || (ult && ult.from === t.peer ? ult.name : '') || t.peer;
        }
        return res.status(200).json({ ok: true, threads: Object.values(threads).sort((a, b) => b.lastTs - a.lastTs) });
      }

      /* op=state — dos modos:
         · rev presente: diferencial por revisión (envidado/editado/reaccionado después de rev)
         · after (la forma antigua): mensajes con id > after (primera carga) */
      const me = String(req.query.me || '');
      const room = String(req.query.room || 'general');
      const favs = me && db.favs[me] ? db.favs[me].map(f => f.msgId) : [];
      if (req.query.rev !== undefined) {
        const rev = parseInt(String(req.query.rev), 10) || 0;
        return res.status(200).json({
          ok: true, rev: db.rev || 1,
          msgs: db.msgs.filter(m => (m.rev || 1) > rev),
          dms: me ? db.dms.filter(m => m.from === me || m.to === me).filter(m => (m.rev || 1) > rev) : [],
          deleted: (db.deleted || []).filter(d => d.rev > rev).map(d => d.id),
          presence: onlineList(db),
          meta: db.meta, rooms: db.rooms, myFavs: favs,
          now: Date.now(), room,
        });
      }
      const after = String(req.query.after || '0');
      const myDms = me ? db.dms.filter(m => m.from === me || m.to === me).filter(m => m.id > after) : [];
      return res.status(200).json({
        ok: true,
        msgs: db.msgs.filter(m => m.id > after),
        dms: myDms,
        presence: onlineList(db),
        meta: db.meta, rooms: db.rooms,
        myFavs: favs,
        rev: db.rev || 1,
        last: db.msgs.length ? db.msgs[db.msgs.length - 1].id : after,
        lastDm: db.dms.length ? db.dms[db.dms.length - 1].id : after,
        now: Date.now(), room,
      });
    }

    /* ═══════════ POST ═══════════ */
    if (req.method === 'POST') {
      const b = req.body || {};
      const op = String(b.op || 'sent');

      if (op === 'beat') {
        const uid = String(b.uid || '');
        if (!uidOk(uid)) return res.status(400).json({ ok: false, error: 'uid' });
        const { db } = await dbWrite(tk, d => {
          const prev = d.presence[uid];
          const role = (b.role === 'admin' || b.role === 'mod') ? b.role : (prev && ['admin', 'mod'].includes(prev.role) ? prev.role : 'user');
          let room = String(b.room || (prev && prev.room) || '');
          if (!room || !d.rooms.some(r => r.id === room)
            || (onlineList(d).filter(p => p.room === room).length >= (d.meta.maxUsers || 50) && room !== (prev && prev.room))) {
            room = pickRoom(d, room);
          }
          d.presence[uid] = { name: String(b.name || (prev && prev.name) || 'Anónimo').slice(0, 60), role, room, ts: Date.now() };
        });
        return res.status(200).json({ ok: true, room: db.presence[uid].room, meta: db.meta, rooms: db.rooms });
      }

      if (op === 'sent' || op === 'dm') {
        const uid = String(b.uid || '');
        if (!uidOk(uid)) return res.status(400).json({ ok: false, error: 'uid' });
        const text = String(b.text || '').slice(0, MAX_TXT).trim();
        const img = String(b.img || '');                       /* 📷 imagen incrustada (URL de assets) */
        const quote = b.quote && typeof b.quote === 'object' && !Array.isArray(b.quote) ? {
          id: String(b.quote.id || '').slice(0, 40),
          name: String(b.quote.name || '').slice(0, 60),
          text: String(b.quote.text || '').slice(0, 220),
        } : null;
        if (!text && !img) return res.status(400).json({ ok: false, error: 'vacío' });
        const name = String(b.name || 'Anónimo').slice(0, 60);
        const role = (b.role === 'admin' || b.role === 'mod') ? b.role : 'user';
        const msg = { id: SHORT_ID(), ts: Date.now(), uid, name, role, text };
        if (img) msg.img = img.slice(0, 500);
        if (quote && quote.id && quote.text) msg.quote = quote;
        /* los silenciados no escriben */
        if (op === 'sent') {
          msg.room = String(b.room || 'general');
          const { db: chk } = await dbRead(tk);
          if (chk.muted && chk.muted[uid]) return res.status(403).json({ ok: false, error: 'estás silenciado por el staff' });
          await dbWrite(tk, d => {
            if (!d.rooms.some(r => r.id === msg.room)) msg.room = d.rooms[0].id;
            msg.rev = d.rev;   /* lleva la versión: el poller la usa para diff */
            d.msgs.push(msg);
          });
        } else {
          const to = String(b.to || '');
          if (!uidOk(to) || to === uid) return res.status(400).json({ ok: false, error: 'destino inválido' });
          delete msg.room;
          msg.from = uid; msg.to = to; msg.read = false;
          const { db: chk } = await dbRead(tk);
          if (chk.muted && chk.muted[uid]) return res.status(403).json({ ok: false, error: 'estás silenciado por el staff' });
          await dbWrite(tk, d => { msg.rev = d.rev; d.dms.push(msg); });
        }
        return res.status(200).json({ ok: true, id: msg.id });
      }

      if (op === 'react') {
        /* reacción emoji: toggle — el mismo usuario quita/pone */
        const uid = String(b.uid || ''), msgId = String(b.msgId || ''), emoji = String(b.emoji || '').slice(0, 8);
        if (!uidOk(uid) || !msgId || !emoji) return res.status(400).json({ ok: false, error: 'faltan datos' });
        let out = null;
        await dbWrite(tk, d => {
          const all = d.msgs.concat(d.dms);
          const m = all.find(x => x.id === msgId);
          if (!m) return;
          m.reactions = (m.reactions && typeof m.reactions === 'object' && !Array.isArray(m.reactions)) ? m.reactions : {};
          const list = new Set(m.reactions[emoji] || []);
          if (list.has(uid)) list.delete(uid); else list.add(uid);
          if (list.size) m.reactions[emoji] = [...list]; else delete m.reactions[emoji];
          m.rev = d.rev;       /* marca el cambio para el polling por rev */
          out = m.reactions;
        });
        return res.status(200).json({ ok: true, reactions: out });
      }

      if (op === 'edit') {
        /* editar: solo el autor — queda constancia "(editado)" */
        const uid = String(b.uid || ''), msgId = String(b.msgId || '');
        const text = String(b.text || '').slice(0, MAX_TXT).trim();
        if (!uidOk(uid) || !msgId || !text) return res.status(400).json({ ok: false, error: 'faltan datos' });
        let ok = false;
        let updated = null;
        await dbWrite(tk, d => {
          const all = d.msgs.concat(d.dms);
          const m = all.find(x => x.id === msgId);
          if (!m) return;
          if (m.uid !== uid && m.from !== uid) return;
          m.text = text; m.edited = Date.now();
          m.rev = d.rev;   /* el cambio viaja en el próximo poll a todos */
          ok = true; updated = m;
        });
        if (!ok) return res.status(403).json({ ok: false, error: 'solo su autor puede editarlo' });
        return res.status(200).json({ ok: true, msg: updated });
      }

      if (op === 'uploadImg') {
        /* imagen del mensaje: se guarda como archivo del repo → URL pública */
        const uid = String(b.uid || '');
        if (!uidOk(uid)) return res.status(400).json({ ok: false, error: 'uid' });
        const { db } = await dbRead(tk);
        if (db.muted && db.muted[uid]) return res.status(403).json({ ok: false, error: 'estás silenciado por el staff' });
        const dataUrl = String(b.dataUrl || '');
        const m2 = dataUrl.match(/^data:image\/(jpeg|jpg|png|webp|gif);base64,([A-Za-z0-9+/=]+)$/i);
        if (!m2) return res.status(400).json({ ok: false, error: 'imagen no válida (jpg/png/webp/gif)' });
        const bytes = Buffer.from(m2[2], 'base64');
        if (bytes.length > 1_800_000) return res.status(413).json({ ok: false, error: 'máx 1,8 MB por imagen' });
        const filePath = `assets/chat-img/${SHORT_ID()}.jpg`;
        await gh(tk, 'PUT', `/repos/${REPO}/contents/${filePath}`, {
          message: '💬 imagen del chat', branch: BRANCH, content: m2[2],
        });
        const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${filePath}?t=${Date.now()}`;
        return res.status(200).json({ ok: true, url });
      }

      if (op === 'mute' || op === 'unmute') {
        /* silenciar un usuario: solo staff (clave del buzón) o admin (firma) */
        /* staff: la clave tiene que existir Y coincidir — nunca implícita por estar vacía */
        const pk = (process.env.PROP_KEY || '');
        const isStaff = !!pk && pk === (req.headers['x-chat-key'] || '');
        const isAdmin = await adminOk();
        if (!isStaff && !isAdmin) return res.status(403).json({ ok: false, error: 'solo el staff puede silenciar' });
        const target = String(b.uid || '');
        if (!uidOk(target)) return res.status(400).json({ ok: false, error: 'uid' });
        await dbWrite(tk, d => {
          if (op === 'mute') { d.muted = d.muted || {}; d.muted[target] = { by: String(b.by || 'staff').slice(0, 40), at: Date.now() }; }
          else if (d.muted) delete d.muted[target];
        });
        return res.status(200).json({ ok: true });
      }

      if (op === 'del') {
        /* borrar un mensaje: su autor, el admin (firma) o el staff (clave del buzón) */
        const uid = String(b.uid || ''), msgId = String(b.msgId || '');
        if (!uidOk(uid) || !msgId) return res.status(400).json({ ok: false, error: 'faltan datos' });
        const pk = (process.env.PROP_KEY || '');
        const isStaff = !!pk && pk === (req.headers['x-chat-key'] || '');
        const isAdmin = await adminOk();
        let ok = false;
        await dbWrite(tk, d => {
          const all = d.msgs.concat(d.dms);
          const orig = all.find(m => m.id === msgId);
          if (!orig) return;
          const can = isStaff || isAdmin || (orig.uid === uid) || (orig.from === uid);
          if (!can) return;
          d.msgs = d.msgs.filter(m => m.id !== msgId);
          d.dms = d.dms.filter(m => m.id !== msgId);
          /* que el cliente lo quite al instante también */
          d.deleted = d.deleted || [];
          d.deleted.push({ id: msgId, rev: d.rev });
          if (d.deleted.length > 200) d.deleted = d.deleted.slice(-200);
          ok = true;
        });
        if (!ok) return res.status(403).json({ ok: false, error: 'solo su autor o el staff pueden borrarlo' });
        return res.status(200).json({ ok: true });
      }

      if (op === 'fav' || op === 'unfav') {
        const uid = String(b.uid || ''), msgId = String(b.msgId || '');
        if (!uidOk(uid) || !msgId) return res.status(400).json({ ok: false, error: 'faltan datos' });
        await dbWrite(tk, d => {
          d.favs[uid] = d.favs[uid] || [];
          if (op === 'fav') {
            if (!d.favs[uid].some(f => f.msgId === msgId)) {
              const all = d.msgs.concat(d.dms);
              const orig = all.find(m => m.id === msgId);
              d.favs[uid].push({ msgId, at: Date.now(), snap: orig ? { text: orig.text, name: orig.name, room: orig.room || 'dm', ts: orig.ts } : null });
            }
          } else {
            d.favs[uid] = d.favs[uid].filter(f => f.msgId !== msgId);
          }
        });
        return res.status(200).json({ ok: true });
      }

      if (op === 'favList') {
        const uid = String(b.uid || '');
        if (!uidOk(uid)) return res.status(400).json({ ok: false, error: 'uid' });
        const { db } = await dbRead(tk);
        return res.status(200).json({ ok: true, favs: db.favs[uid] || [] });
      }

      if (op === 'dmRead') {
        const me = String(b.uid || ''), peer = String(b.peer || '');
        if (!uidOk(me) || !uidOk(peer)) return res.status(400).json({ ok: false, error: 'uid' });
        const { out } = await dbWrite(tk, d => {
          let n = 0;
          for (const m of d.dms) if (m.to === me && m.from === peer && !m.read) { m.read = true; n++; }
          return n;
        });
        return res.status(200).json({ ok: true, changed: out });
      }

      if (op === 'meta') {
        if (!(await adminOk())) return res.status(403).json({ ok: false, error: 'solo el administrador' });
        const m = b.meta || {};
        const { db } = await dbWrite(tk, d => {
          if (m.maxUsers !== undefined) d.meta.maxUsers = Math.min(500, Math.max(2, parseInt(m.maxUsers, 10) || 50));
          if (m.ttlHours !== undefined) d.meta.ttlHours = Math.min(24 * 30, Math.max(1, parseInt(m.ttlHours, 10) || 48));
          if (m.dmTtlHours !== undefined) d.meta.dmTtlHours = Math.min(24 * 30, Math.max(1, parseInt(m.dmTtlHours, 10) || 48));
          if (Array.isArray(m.rooms)) {
            const limpias = m.rooms.filter(r => r && typeof r.id === 'string' && typeof r.name === 'string')
              .map(r => ({ id: r.id.replace(/[^\w-]/g, '').slice(0, 30) || ('sala' + Math.random().toString(36).slice(2, 6)), name: r.name.slice(0, 60) }));
            if (limpias.length) d.rooms = limpias;
          }
          d.meta.updatedAt = Date.now();
        });
        return res.status(200).json({ ok: true, meta: db.meta, rooms: db.rooms });
      }

      /* subir imagen de fondo oficial por dispositivo (móvil/tablet/pc) */
      if (op === 'bgUpload') {
        if (!(await adminOk())) return res.status(403).json({ ok: false, error: 'solo el administrador' });
        const dev = ['movil', 'tablet', 'pc'].includes(b.dev) ? b.dev : null;
        if (!dev) return res.status(400).json({ ok: false, error: 'dev: movil | tablet | pc' });
        const dataUrl = String(b.dataUrl || '');
        const m2 = dataUrl.match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/i);
        if (!m2) return res.status(400).json({ ok: false, error: 'imagen no válida (usa jpg/png/webp)' });
        const bytes = Buffer.from(m2[2], 'base64');
        if (bytes.length > 2_500_000) return res.status(413).json({ ok: false, error: 'la imagen pasa de 2,5 MB' });
        const filePath = `assets/chat-bg-${dev}.jpg`;
        const old = await gh(tk, 'GET', `/repos/${REPO}/contents/${filePath}?ref=${BRANCH}`);
        await gh(tk, 'PUT', `/repos/${REPO}/contents/${filePath}`, {
          message: `🖼 fondo chat ${dev}`, branch: BRANCH, content: m2[2], ...(old ? { sha: old.sha } : {}),
        });
        const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${filePath}?t=${Date.now()}`;
        const { db } = await dbWrite(tk, d => {
          d.meta.bg = d.meta.bg && typeof d.meta.bg === 'object' ? d.meta.bg : {};
          d.meta.bg[dev] = url;
          d.meta.bgTs = Date.now(); d.meta.updatedAt = Date.now();
        });
        return res.status(200).json({ ok: true, url, meta: db.meta });
      }

      if (op === 'bgClear') {
        if (!(await adminOk())) return res.status(403).json({ ok: false, error: 'solo el administrador' });
        const dev = ['movil', 'tablet', 'pc'].includes(b.dev) ? b.dev : null;
        const { db } = await dbWrite(tk, d => {
          if (d.meta.bg && typeof d.meta.bg === 'object') { if (dev) delete d.meta.bg[dev]; else d.meta.bg = {}; } else d.meta.bg = {};
          d.meta.bgTs = Date.now(); d.meta.updatedAt = Date.now();
        });
        return res.status(200).json({ ok: true, meta: db.meta });
      }

      return res.status(400).json({ ok: false, error: 'op desconocida' });
    }

    return res.status(405).json({ ok: false, error: 'método no soportado' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
};
