/* ═══════════════════════════════════════════════════════════
   📩 Buzón de propuestas de moderadores — X·STREAM
   Vercel serverless function (repo acortador).

   Rutas (todas con cabecera  x-prop-key: <PROP_KEY>):
     POST   { by, n, payload }  → guarda una propuesta nueva
     GET                        → lista resumida (id, by, at, n)
     GET    ?id=<id>            → propuesta completa
     DELETE { id }              → elimina (tras aprobar/descartar)

   Env vars en Vercel:
     PROP_KEY  — clave compartida (solo admin y moderadores)
     GH_TOKEN  — token fine-grained "contents:write" del repo del catálogo
     GH_REPO   — opcional, por defecto Dcardkevein15/pelisfull
   ═══════════════════════════════════════════════════════════ */
'use strict';

const GH_API = 'https://api.github.com';
const TG_API = 'https://api.telegram.org';
const REPO = process.env.GH_REPO || 'Dcardkevein15/pelisfull';
const DIR = 'propuestas';
const BRANCH = 'main';
const MAX_KEEP = 10;
const MAX_BYTES = 3 * 1024 * 1024; /* techo duro por propuesta (3 MB) */

const ghHeaders = tk => ({
  Authorization: 'token ' + tk,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
});
const toB64 = s => Buffer.from(s, 'utf8').toString('base64');
const fromB64 = s => Buffer.from(s, 'base64').toString('utf8');
const sanitize = s => String(s || 'anon').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'anon';

/* validación mínima anti-basura (la fina la hace el admin al aprobar) */
function payloadValido(p) {
  return !!p && typeof p === 'object' && !Array.isArray(p)
    && Array.isArray(p.series) && p.series.length > 0 && p.series.length <= 5000
    && p.series.every(s => s && typeof s === 'object' && !Array.isArray(s)
      && typeof s.id === 'string' && typeof s.t === 'string' && Array.isArray(s.episodes));
}

async function gh(tk, method, path, body) {
  const r = await fetch(GH_API + path, { method, headers: ghHeaders(tk), body: body ? JSON.stringify(body) : undefined });
  if (r.status === 404) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || ('GitHub HTTP ' + r.status));
  return j;
}

/* lista la carpeta (null si no existe) */
async function ghList(tk) {
  const j = await gh(tk, 'GET', `/repos/${REPO}/contents/${DIR}?ref=${BRANCH}`);
  return Array.isArray(j) ? j : [];
}

/* tras guardar, deja solo las MAX_KEEP más recientes (orden por nombre = ts) */
async function ghTrim(tk) {
  const files = (await ghList(tk)).filter(f => f.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name));
  for (const f of files.slice(0, Math.max(0, files.length - MAX_KEEP))) {
    await gh(tk, 'DELETE', `/repos/${REPO}/contents/${encodeURIComponent(f.path)}`, { message: '🧹 buzón: limpieza', sha: f.sha, branch: BRANCH });
  }
}

module.exports = async function handler(req, res) {
  /* CORS abierto: la app vive en otro dominio */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-prop-key');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    /* diagnóstico claro: no es lo mismo "falta configurarla" que "no coincide" */
    if (!process.env.PROP_KEY) {
      return res.status(500).json({ ok: false, error: 'PROP_KEY no está creada en Vercel — Settings → Environment Variables → Redeploy' });
    }
    if ((req.headers['x-prop-key'] || '') !== process.env.PROP_KEY) {
      return res.status(403).json({ ok: false, error: 'clave de propuestas incorrecta' });
    }
    const tk = process.env.GH_TOKEN;
    if (!tk) return res.status(500).json({ ok: false, error: 'buzón sin GH_TOKEN (configúralo en Vercel)' });

    /* ── GET lista o lectura completa ── */
    if (req.method === 'GET') {
      const id = req.query && req.query.id;
      if (!id) {
        const files = (await ghList(tk)).filter(f => f.name.endsWith('.json')).sort((a, b) => b.name.localeCompare(a.name));
        const items = files.map(f => {
          const m = f.name.match(/^p-(\d+)-(.+)\.json$/);
          return { id: f.name.replace(/\.json$/, ''), at: m ? new Date(+m[1]).toISOString() : null, by: m ? m[2].replace(/-/g, ' ') : f.name, size: f.size };
        });
        return res.status(200).json({ ok: true, items });
      }
      const f = await gh(tk, 'GET', `/repos/${REPO}/contents/${DIR}/${encodeURIComponent(id)}.json?ref=${BRANCH}`);
      if (!f) return res.status(404).json({ ok: false, error: 'no existe' });
      /* ⚠ GitHub Contents API devuelve `content` VACÍO para archivos >1 MB.
         En ese caso bajamos el archivo por su download_url (o por blob). */
      let text = '';
      if (f.content && String(f.content).trim()) {
        text = fromB64(String(f.content).replace(/\s+/g, ''));
      } else if (f.download_url) {
        const rr = await fetch(f.download_url, { headers: { Authorization: 'token ' + tk } });
        if (!rr.ok) throw new Error('descarga del archivo: HTTP ' + rr.status);
        text = await rr.text();
      } else if (f.sha) {
        const blob = await gh(tk, 'GET', `/repos/${REPO}/git/blobs/${f.sha}`);
        text = blob && blob.content ? fromB64(String(blob.content).replace(/\s+/g, '')) : '';
      }
      let item;
      try { item = JSON.parse(text); }
      catch (e) { return res.status(500).json({ ok: false, error: 'propuesta ilegible (contenido roto al leer)' }); }
      return res.status(200).json({ ok: true, item });
    }

    /* ── POST: guardar propuesta ── */
    if (req.method === 'POST') {
      const { by, n, payload } = req.body || {};
      if (!payloadValido(payload)) return res.status(400).json({ ok: false, error: 'payload inválido' });
      const raw = JSON.stringify({ by: String(by || 'moderador').slice(0, 60), at: new Date().toISOString(), n: n || payload.series.length, payload });
      if (Buffer.byteLength(raw) > MAX_BYTES) return res.status(413).json({ ok: false, error: 'demasiado grande' });
      const id = `p-${Date.now()}-${sanitize(by)}`;
      await gh(tk, 'PUT', `/repos/${REPO}/contents/${DIR}/${id}.json`, {
        message: `📩 propuesta de ${String(by || 'moderador').slice(0, 40)}`,
        content: toB64(raw), branch: BRANCH,
      });
      await ghTrim(tk);

      /* 📬 aviso directo al admin por Telegram (nunca rompe el POST) */
      const tgTk = process.env.TG_BOT_TOKEN;
      const adminChat = process.env.TG_ADMIN_CHAT;
      if (tgTk && adminChat) {
        try {
          await fetch(`${TG_API}/bot${tgTk}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: adminChat, parse_mode: 'HTML',
              text: `📩 <b>Nueva propuesta</b> de <b>${String(by || 'moderador').slice(0, 50).replace(/</g, '&lt;')}</b>\n· ${n || (payload.series || []).length} entradas\n\nRevísala en tu app → Perfil → 📩 Propuestas.`,
            }),
          });
        } catch (e) { /* silencio: la propuesta ya está en el buzón de todas formas */ }
      }
      return res.status(200).json({ ok: true, id });
    }

    /* ── DELETE: aprobar/descartar ── */
    if (req.method === 'DELETE') {
      const id = (req.body && req.body.id) || '';
      if (!/^p-\d+-[\w-]+$/.test(id)) return res.status(400).json({ ok: false, error: 'id inválido' });
      const f = await gh(tk, 'GET', `/repos/${REPO}/contents/${DIR}/${encodeURIComponent(id)}.json?ref=${BRANCH}`);
      if (!f) return res.status(404).json({ ok: false, error: 'no existe' });
      await gh(tk, 'DELETE', `/repos/${REPO}/contents/${DIR}/${encodeURIComponent(id)}.json`, { message: '🗑 propuesta gestionada', sha: f.sha, branch: BRANCH });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'método no soportado' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
};
