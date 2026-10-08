// Express 4 doesn't forward rejected promises to the error handler; this does.
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A tiny standalone page (used by the sign-in confirmation screen).
export function simplePage(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${esc(title)} — StormOfShadowss</title>
<style>body{font-family:system-ui,sans-serif;background:#CDD9ED;color:#040404;margin:0;display:grid;place-items:center;min-height:100vh}
.card{background:#fff;border-radius:12px;padding:28px;max-width:420px;width:calc(100% - 32px);box-shadow:0 6px 24px rgba(0,0,0,.12)}
h1{font-size:1.2rem;margin:0 0 10px}button{background:#820F03;color:#fff;border:0;border-radius:8px;padding:12px 18px;font-size:1rem;cursor:pointer;width:100%}
a{color:#820F03}p{line-height:1.5}</style></head><body><div class="card"><h1>${esc(title)}</h1>${bodyHtml}</div></body></html>`;
}
