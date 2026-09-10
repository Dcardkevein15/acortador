/* ═══════════════════════════════════════════════════════════
   🔔 Webhook de Telegram — X·STREAM
   Recibe los eventos del bot:
     · /start  → responde con el chat-id (para configurar TG_ADMIN_CHAT)
     · botón "🔔 Avísame si suma capítulos" (callback f:<id>) → suscribe
     · botón "🔕 Dejar de seguir" (callback u:<id>)             → desuscribe

   Estado: tg-subs.json en el repo del catálogo (misma caja fuerte que
   el buzón). Env: TG_BOT_TOKEN + GH_TOKEN (+ opcional TG_SECRET).
   ═══════════════════════════════════════════════════════════ */
'use strict';

const GH_API = 'https://api.github.com';
const TG_API = 'https://api.telegram.org';
const REPO = process.env.GH_REPO || 'Dcardkevein15/pelisfull';
const BRANCH = 'main';
const SUBS_PATH = 'tg-subs.json';

const ghHeaders = tk => ({
  Authorization: 'token ' + tk, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json',
});
const toB64 = s => Buffer.from(s, 'utf8').toString('base64');
const fromB64 = s => Buffer.from(s, 'base64').toString('utf8');

async function gh(tk, method, path, body) {
  const r = await fetch(GH_API + path, { method, headers: ghHeaders(tk), body: body ? JSON.stringify(body) : undefined });
  if (r.status === 404) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || ('GitHub HTTP ' + r.status));
  return j;
}
async function tg(tk, method, body) {
  const r = await fetch(`${TG_API}/bot${tk}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.description || ('Telegram HTTP ' + r.status));
  return j;
}
/* leer el archivo de suscripciones (lossy-cache 60s por invocación) */
let _cache = { at: 0, data: null, sha: null };
async function subsRead(tk) {
  if (Date.now() - _cache.at < 60000 && _cache.data) return _cache;
  const f = await gh(tk, 'GET', `/repos/${REPO}/contents/${SUBS_PATH}?ref=${BRANCH}`);
  const data = f ? JSON.parse(fromB64(f.content)) : {};
  _cache = { at: Date.now(), data, sha: f ? f.sha : null };
  return _cache;
}
async function subsWrite(tk) {
  await gh(tk, 'PUT', `/repos/${REPO}/contents/${SUBS_PATH}`, {
    message: '🔔 tg-subs update', branch: BRANCH,
    content: toB64(JSON.stringify(_cache.data)),
    ...(_cache.sha ? { sha: _cache.sha } : {}),
  });
  _cache.at = 0; /* re-lectura la próxima vez */
}

/* buscar el título de una serie por su id (catalog.json del repo, público) */
let _catCache = { at: 0, map: null };
async function tituloDe(id) {
  if (Date.now() - _catCache.at > 5 * 60000 || !_catCache.map) {
    const r = await fetch(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/catalog.json?t=${Date.now()}`);
    const cat = r.ok ? await r.json() : { series: [] };
    _catCache = { at: Date.now(), map: new Map((cat.series || []).map(s => [s.id, s.t])) };
  }
  return _catCache.map.get(id) || null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-telegram-bot-api-secret-token');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'solo POST de Telegram' });

  /* clave de seguridad del webhook (si la configuraste) */
  const sec = process.env.TG_SECRET;
  if (sec && req.headers['x-telegram-bot-api-secret-token'] !== sec) {
    return res.status(403).json({ ok: false, error: 'token de webhook no válido' });
  }
  const tk = process.env.TG_BOT_TOKEN;
  if (!tk) return res.status(500).json({ ok: false, error: 'falta TG_BOT_TOKEN en Vercel' });

  const upd = req.body || {};

  try {
    /* ── /start: le contesto su chat-id (para poner TG_ADMIN_CHAT) ── */
    if (upd.message) {
      const chat = String(upd.message.chat.id);
      const nombre = ((upd.message.from && upd.message.from.first_name) || 'amigo');
      await tg(tk, 'sendMessage', {
        chat_id: upd.message.chat.id,
        text: `👋 <b>Hola ${nombre.replace(/</g, '&lt;')}</b> — soy el bot de X·STREAM.\n\n` +
          `Tu chat id es <code>${chat}</code> (guárdalo si eres el admin).`,
        parse_mode: 'HTML',
      });
      return res.status(200).json({ ok: true });
    }

    /* ── tap en botón de una publicación del canal ── */
    if (upd.callback_query) {
      const cq = upd.callback_query;
      const data = String(cq.data || '');
      const id = data.slice(2);
      const chat = String(cq.from.id);

      if (!/^f:./.test(data) && !/^u:./.test(data) || !id) {
        await tg(tk, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Ese botón ya caducó' });
        return res.status(200).json({ ok: true });
      }

      await subsRead(tk);
      const porTi = _cache.data[chat] = _cache.data[chat] || {};
      const titulo = await tituloDe(id) || id;
      let texto;

      if (data[0] === 'f') {
        if (porTi[id]) { texto = `🔔 Ya estabas siguiendo «${titulo}» — vuelve a tocar para dejarla`; }
        else { porTi[id] = { t: titulo, at: Date.now() }; texto = `🔔 Listo — te aviso cuando ${titulo} sume capítulos`; }
      } else {
        if (porTi[id]) { delete porTi[id]; texto = `🔕 Vale — dejaste de seguir «${titulo}»`; }
        else { texto = `Ya no la seguías`; }
      }
      /* si se quedó sin series, limpiar la entrada */
      if (!Object.keys(porTi).length) delete _cache.data[chat];
      await subsWrite(tk);

      await tg(tk, 'answerCallbackQuery', { callback_query_id: cq.id, text: texto, show_alert: false });
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true }); /* otros updates: ignorar */
  } catch (e) {
    return res.status(200).json({ ok: true, note: String(e && e.message || e) }); /* nunca 500 a Telegram */
  }
};
