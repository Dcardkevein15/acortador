/* ═══════════════════════════════════════════════════════════
   💬 CHAT X·STREAM — servidor propio (sin Firebase, sin terceros)
   Vercel serverless + el repo de GitHub como almacén (mismo patrón
   que el buzón de propuestas). Un solo archivo JSON = la base de
   datos del chat; se bloquea con sha y reintenta si hay choque.

   Todo el tráfico pasa por /api/chat (CORS abierto):

     GET  ?op=state&after=<id>&room=<id>&me=<uid>
              → { msgs, last, presence, meta, favs, lastMeta }
     GET  ?op=unfurl&url=<u>  → preview del enlace (título/desc/img)
     GET  ?op=dm-list&me=<uid> → conversaciones privadas recientes
     POST { op:'sent', room, uid, name, role, text }       → mensaje sala
     POST { op:'dm', to, uid, name, role, text }           → mensaje privado
     POST { op:'beat', uid, name, role, room }             → presencia (heartbeat)
     POST { op:'fav',  uid, msgId }                        → ♥ en un enlace
     POST { op:'unfav', uid, msgId }                       → quitar ♥
     POST { op:'meta', ... }  (clave admin) → configuración global:
           { maxUsers, ttlHours, dmTtlHours, bg, rooms:[{id,name}] }

   Env vars en Vercel:
     GH_TOKEN  — token con contents:write del repo
     GH_REPO   — opcional, por defecto Dcardkevein15/pelisfull
     PROP_KEY  — clave maestra (la misma del buzón)
   ═══════════════════════════════════════════════════════════ */
'use strict';

const GH_API = 'https://api.github.com';
const REPO = process.env.GH_REPO || 'Dcardkevein15/pelisfull';
const BRANCH = 'main';
const PATH = 'chat.json';
const MAX_MSGS_KEPT = 400;      /* techo duro de historial (además del TTL) */
const MAX_TXT = 2000;
const ONLINE_MS = 90 * 1000;    /* presencia: quien no da señal en 90 s = offline */

const toB64 = s => Buffer.from(s, 'utf8').toString('base64');
const fromB64 = s => Buffer.from(s, 'base64').toString('utf8');
const esc = s => String(s == null ? '' : s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
const uidOk = u => /^[\w-]{3,60}$/.test(String(u || ''));
const SHORT_ID = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

async function gh(tk, method, path, body) {
  const r = await fetch(GH_API + path, { method, headers: { Authorization: 'token ' + tk, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 404) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.message || ('GitHub HTTP ' + r.status)); e.status = r.status; throw e; }
  return j;
}

/* ── base por defecto si aún no existe ── */
function blankDb() {
  return {
    meta: {
      maxUsers: 50,
      ttlHours: 48,
      dmTtlHours: 48,
      bg: '',
      rooms: [{ id: 'general', name: '🏠 General' }],
      updatedAt: Date.now(),
    },
    msgs: [],      /* {id, room, uid, name, role, text, ts} */
    dms: [],       /* {id, from, to, name, role, text, ts} */
    presence: {},  /* uid → {name, role, room, ts} */
    favs: {},      /* uid → [{msgId, snap:{text,name,room,ts}, at}] */
    roomSeq: 1,    /* para auto-crear “Sala N” */
  };
}

/* lee chat.json con reintento (devuelve {db, sha}) */
async function dbRead(tk) {
  const f = await gh(tk, 'GET', `/repos/${REPO}/contents/${PATH}?ref=${BRANCH}&t=${Date.now()}`);
  if (!f) return { db: blankDb(), sha: null };
  const text = fromB64(String(f.content || '').replace(/\s+/g, ''));
  let db; try { db = JSON.parse(text); } catch (e) { db = blankDb(); }
  /* asegura campos */
  const blank = blankDb();
  for (const k of Object.keys(blank)) if (db[k] === undefined) db[k] = blank[k];
  db.meta = Object.assign(blank.meta, db.meta || {});
  if (!Array.isArray(db.rooms)) db.rooms = blank.rooms;
  if (!db.rooms.length) db.rooms = blank.rooms;
  return { db, sha: f.sha };
}

/* escribe con reintento ante choque de sha (concurrencia) */
async function dbWrite(tk, db, sha, intentos = 3) {
  const body = { message: '💬 chat', branch: BRANCH, content: toB64(JSON.stringify(db)), ...(sha ? { sha } : {}) };
  for (let i = 1; i <= intentos; i++) {
    try { await gh(tk, 'PUT', `/repos/${REPO}/contents/${PATH}`, body); return; }
    catch (e) {
      if (e.status !== 409 && e.status !== 422) throw e;
      /* choque: re-leer el sha y volver a intentar (el llamador hace merge) */
      const f = await gh(tk, 'GET', `/repos/${REPO}/contents/${PATH}?ref=${BRANCH}`);
      body.sha = f ? f.sha : undefined;
    }
  }
  throw new Error('no se pudo escribir (sha ocupado)');
}

/* purga por TTL viejo + techo de tamaño */
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

/* usuarios activos por sala (para reparto/auto-creación) */
function onlineList(db) {
  const now = Date.now();
  return Object.entries(db.presence || {})
    .filter(([, p]) => now - p.ts < ONLINE_MS)
    .map(([uid, p]) => ({ uid, name: p.name, role: p.role || 'user', room: p.room, ts: p.ts }));
}

/* elige sala para un usuario nuevo/heartbeat sin sala asignada */
function pickRoom(db, preferRoom) {
  const list = onlineList(db);
  const count = id => list.filter(p => p.room === id).length;
  const maxU = Math.max(1, db.meta.maxUsers || 50);
  if (preferRoom && count(preferRoom) < maxU) return preferRoom;
  /* primera sala con hueco */
  for (const r of db.rooms) if (count(r.id) < maxU) return r.id;
  /* todas llenas → auto-crear la siguiente */
  db.roomSeq = (db.roomSeq || db.rooms.length) + 1;
  const nueva = { id: 'sala' + db.roomSeq, name: '💬 Sala ' + db.roomSeq };
  db.rooms.push(nueva);
  return nueva.id;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-chat-key');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const tk = process.env.GH_TOKEN;
  if (!tk) return res.status(500).json({ ok: false, error: 'falta GH_TOKEN en Vercel' });

  const keyOk = (req.headers['x-chat-key'] || '') && (req.headers['x-chat-key'] === (process.env.PROP_KEY || ''));

  try {
    /* ═══════════ GET ═══════════ */
    if (req.method === 'GET') {
      const op = String(req.query.op || 'state');

      /* ── vista previa de enlaces (lado servidor: sin lío de CORS) ── */
      if (op === 'unfurl') {
        const url = String(req.query.url || '');
        if (!/^https?:\/\//i.test(url) || url.length > 2048) return res.status(400).json({ ok: false, error: 'url' });
        try {
          const controller = new AbortController();
          const to = setTimeout(() => controller.abort(), 7000);
          const r = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; XStreamBot/1.0)' } });
          clearTimeout(to);
          const ct = r.headers.get('content-type') || '';
          if (!r.ok || !/text\/html/i.test(ct)) return res.status(200).json({ ok: true, url, title: null });
          const html = (await r.text()).slice(0, 400000);
          const pick = (re) => { const m = html.match(re); return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 200) : null; };
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

      /* acceso a datos */
      const { db } = await dbRead(tk);

      if (op === 'presence') {
        return res.status(200).json({ ok: true, online: onlineList(db), now: Date.now() });
      }

      if (op === 'dm-list') {
        const me = String(req.query.me || '');
        if (!uidOk(me)) return res.status(400).json({ ok: false, error: 'uid' });
        /* bandeja de conversaciones privadas del usuario: último mensaje por peer + sin leer */
        const threads = {};
        for (const m of db.dms) {
          if (m.from !== me && m.to !== me) continue;
          const peer = m.from === me ? m.to : m.from;
          const t = threads[peer] = threads[peer] || { peer, lastTs: 0, lastText: '', unread: 0, peerName: '' };
          if (m.ts > t.lastTs) { t.lastTs = m.ts; t.lastText = m.text.slice(0, 80); }
          if (m.to === me && !m.read) t.unread++;
        }
        for (const t of Object.values(threads)) {
          const p = (db.presence || {})[t.peer];
          if (p && p.name) t.peerName = p.name;
        }
        return res.status(200).json({ ok: true, threads: Object.values(threads).sort((a, b) => b.lastTs - a.lastTs) });
      }

      /* op=state: todo lo del chat (mensajes nuevos desde `after`, presence, meta, favs) */
      const after = req.query.after || '0';
      const me = String(req.query.me || '');
      const room = String(req.query.room || 'general');
      const newMsgs = db.msgs.filter(m => m.id > after);
      /* DMs que me incumben (si me pasaron mi uid): solo mag.strToTime per-typeid */
      const myDms = me
        ? db.dms.filter(m => m.from === me || m.to === me).filter(m => m.id > after)
        : [];
      const favs = (me && db.favs[me]) ? db.favs[me].map(f => f.msgId) : [];
      return res.status(200).json({
        ok: true, msgs: newMsgs, dms: myDms,
        presence: onlineList(db), meta: db.meta, myFavs: favs,
        last: db.msgs.length ? db.msgs[db.msgs.length - 1].id : after,
        lastDm: db.dms.length ? db.dms[db.dms.length - 1].id : after,
        now: Date.now(), room,
      });
    }

    /* ═══════════ POST ═══════════ */
    if (req.method === 'POST') {
      const b = req.body || {};
      const op = String(b.op || 'sent');

      /* abrir cerradura: leer, mutar, escribir con reintento */
      let working = await dbRead(tk);
      let db = working.db; let sha = working.sha;
      purge(db);

      if (op === 'beat') {
        /* heartbeat de presencia — también asigna sala si no trae una válida */
        const uid = String(b.uid || '');
        if (!uidOk(uid)) return res.status(400).json({ ok: false, error: 'uid' });
        const prev = db.presence[uid];
        /* admin/mod preservan rol elevado si lo mandan */
        const role = (b.role === 'admin' || b.role === 'mod') ? b.role : (prev && ['admin', 'mod'].includes(prev.role) ? prev.role : 'user');
        let room = String(b.room || (prev && prev.room) || '');
        if (!room || !db.rooms.some(r => r.id === room) || (onlineList(db).filter(p => p.room === room).length >= (db.meta.maxUsers || 50) && room !== (prev && prev.room))) {
          room = pickRoom(db, room);
        }
        db.presence[uid] = { name: String(b.name || prev?.name || 'Anónimo').slice(0, 60), role, room, ts: Date.now() };
        await dbWrite(tk, db, sha);
        return res.status(200).json({ ok: true, room, meta: db.meta });
      }

      if (op === 'sent' || op === 'dm') {
        const uid = String(b.uid || '');
        if (!uidOk(uid)) return res.status(400).json({ ok: false, error: 'uid' });
        const name = String(b.name || 'Anónimo').slice(0, 60);
        const role = (b.role === 'admin' || b.role === 'mod') ? b.role : 'user';
        const text = String(b.text || '').slice(0, MAX_TXT).trim();
        if (!text) return res.status(400).json({ ok: false, error: 'vacío' });
        const msg = {
          id: SHORT_ID(), ts: Date.now(), uid, name, role,
          text,
        };
        if (op === 'sent') {
          const room = String(b.room || db.rooms[0].id);
          msg.room = db.rooms.some(r => r.id === room) ? room : db.rooms[0].id;
          db.msgs.push(msg);
        } else {
          const to = String(b.to || '');
          if (!uidOk(to)) return res.status(400).json({ ok: false, error: 'destino inválido' });
          msg.from = uid; msg.to = to; delete msg.room;
          db.dms.push(msg);
        }
        await dbWrite(tk, db, sha);
        return res.status(200).json({ ok: true, id: msg.id });
      }

      if (op === 'fav' || op === 'unfav') {
        const uid = String(b.uid || '');
        const msgId = String(b.msgId || '');
        if (!uidOk(uid) || !msgId) return res.status(400).json({ ok: false, error: 'faltan datos' });
        db.favs[uid] = db.favs[uid] || [];
        if (op === 'fav') {
          if (!db.favs[uid].some(f => f.msgId === msgId)) {
            /* guarda una foto del mensaje para que sobreviva a su borrado */
            const all = db.msgs.concat(db.dms);
            const orig = all.find(m => m.id === msgId);
            db.favs[uid].push({
              msgId, at: Date.now(),
              snap: orig ? { text: orig.text, name: orig.name, room: orig.room || 'dm', ts: orig.ts } : null,
            });
          }
        } else {
          db.favs[uid] = db.favs[uid].filter(f => f.msgId !== msgId);
        }
        await dbWrite(tk, db, sha);
        return res.status(200).json({ ok: true });
      }

      if (op === 'favList') {
        const uid = String(b.uid || '');
        if (!uidOk(uid)) return res.status(400).json({ ok: false, error: 'uid' });
        return res.status(200).json({ ok: true, favs: db.favs[uid] || [] });
      }

      if (op === 'dmRead') {
        /* marcar como leídos los DMs que me llegaron de `peer` */
        const me = String(b.uid || ''), peer = String(b.peer || '');
        if (!uidOk(me) || !uidOk(peer)) return res.status(400).json({ ok: false, error: 'uid' });
        let changed = 0;
        for (const m of db.dms) if (m.to === me && m.from === peer && !m.read) { m.read = true; changed++; }
        if (changed) await dbWrite(tk, db, sha);
        return res.status(200).json({ ok: true, changed });
      }

      if (op === 'meta') {
        if (!keyOk) return res.status(403).json({ ok: false, error: 'solo el administrador' });
        const m = b.meta || {};
        if (m.maxUsers !== undefined) db.meta.maxUsers = Math.min(500, Math.max(2, parseInt(m.maxUsers, 10) || 50));
        if (m.ttlHours !== undefined) db.meta.ttlHours = Math.min(24 * 30, Math.max(1, parseInt(m.ttlHours, 10) || 48));
        if (m.dmTtlHours !== undefined) db.meta.dmTtlHours = Math.min(24 * 30, Math.max(1, parseInt(m.dmTtlHours, 10) || 48));
        if (m.bg !== undefined) db.meta.bg = typeof m.bg === 'string' && (m.bg === '' || /^https?:\/\//i.test(m.bg)) ? m.bg.slice(0, 700) : db.meta.bg;
        if (Array.isArray(m.rooms)) {
          const limpias = m.rooms.filter(r => r && typeof r.id === 'string' && typeof r.name === 'string')
            .map(r => ({ id: r.id.replace(/[^\w-]/g, '').slice(0, 30), name: r.name.slice(0, 60) }));
          if (limpias.length) db.rooms = limpias;
        }
        db.meta.updatedAt = Date.now();
        await dbWrite(tk, db, sha);
        return res.status(200).json({ ok: true, meta: db.meta, rooms: db.rooms });
      }

      if (op === 'invite') {
        /* abrir un DM con un aviso (para que el destino lo vea al entrar) */
        const to = String(b.to || ''), uid = String(b.uid || '');
        if (!uidOk(uid) || !uidOk(to)) return res.status(400).json({ ok: false, error: 'uid' });
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ ok: false, error: 'op desconocida' });
    }

    return res.status(405).json({ ok: false, error: 'método no soportado' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
};
