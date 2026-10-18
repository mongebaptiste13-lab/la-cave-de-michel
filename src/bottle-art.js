// Illustration d'une bouteille de référence, dessinée à partir de la fiche (type, région, nom, millésime).
// Aucune image à stocker : elle se redessine toute seule quand la fiche change.
let uid = 0;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const SHAPES = {
  bordeaux: { d: "M44 6H56V50C56 62 74 72 74 96V224Q74 232 66 232H34Q26 232 26 224V96C26 72 44 62 44 50Z", x0: 26, x1: 74, cap: 30, label: { x: 30, w: 40, y: 120, h: 78 }, fs: 1 },
  bourgogne: { d: "M44 6H56V56C56 82 76 96 76 130V224Q76 232 68 232H32Q24 232 24 224V130C24 96 44 82 44 56Z", x0: 24, x1: 76, cap: 34, label: { x: 28, w: 44, y: 140, h: 66 }, fs: 1 },
  champagne: { d: "M43 6H57V70C57 100 80 116 80 150V224Q80 232 72 232H28Q20 232 20 224V150C20 116 43 100 43 70Z", x0: 20, x1: 80, cap: 68, label: { x: 26, w: 48, y: 150, h: 64 }, fs: 1 },
  flute: { d: "M45 6H55V84C55 96 67 106 67 120V224Q67 232 59 232H41Q33 232 33 224V120C33 106 45 96 45 84Z", x0: 33, x1: 67, cap: 26, label: { x: 36, w: 28, y: 134, h: 70 }, fs: 0.75 },
};
const GLASS = { rouge: "#26322a", blanc: "#9bb06d", rose: "#dcaeb0", bulles: "#2f3d32", liquoreux: "#bd8a35", autre: "#74848a" };
const CAP = { rouge: "#6b1427", blanc: "#cdb95a", rose: "#d98a8a", bulles: "#c9a54a", liquoreux: "#a8671a", autre: "#8c8588" };

export function bottleShape(b) {
  if (b.type === "bulles") return "champagne";
  if (b.type === "liquoreux") return "flute";
  const hay = String(b.region || "") + " " + String(b.name || "");
  if (/bourgogne|burgundy|beaujolais|chablis|meursault|pommard|nuits|volnay|rh[oô]ne|ch[aâ]teauneuf|hermitage|loire|sancerre|pinot/i.test(hay)) return "bourgogne";
  return "bordeaux";
}

function wrap(text, max, lines) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  const out = [];
  let cur = "";
  let i = 0;
  for (; i < words.length; i++) {
    const w = words[i].length > max ? words[i].slice(0, max - 1) + "…" : words[i];
    const next = cur ? cur + " " + w : w;
    if (next.length <= max) { cur = next; continue; }
    if (out.length + 1 >= lines) break;
    out.push(cur);
    cur = w;
  }
  if (cur) out.push(cur);
  if (i < words.length && out.length) {
    const l = out[out.length - 1];
    out[out.length - 1] = l.length >= max ? l.slice(0, max - 1) + "…" : l + "…";
  }
  return out.slice(0, lines);
}

export function bottleSVG(b) {
  const id = "bt" + ++uid;
  const type = GLASS[b.type] ? b.type : "autre";
  const s = SHAPES[bottleShape({ ...b, type })];
  const L = s.label, fs = s.fs;
  const maxChars = Math.max(6, Math.floor(L.w / (4.8 * fs * 0.55)));
  const cx = L.x + L.w / 2;
  const vint = b.vintage ? String(b.vintage) : "NV";
  const y0 = L.y + 15 * fs;
  let t = `<text x="${cx}" y="${y0}" text-anchor="middle" font-family="Young Serif, Georgia, serif" font-size="${(11 * fs).toFixed(1)}" fill="#6b1427">${esc(vint)}</text>`;
  wrap(b.name || "", maxChars, 3).forEach((ln, i) => {
    t += `<text x="${cx}" y="${(y0 + 9 * fs + i * 6 * fs).toFixed(1)}" text-anchor="middle" font-family="Figtree, system-ui, sans-serif" font-size="${(4.8 * fs).toFixed(1)}" font-weight="600" fill="#2a1a1e">${esc(ln)}</text>`;
  });
  if (b.domaine) {
    const dm = wrap(b.domaine, maxChars + 2, 1)[0] || "";
    t += `<text x="${cx}" y="${L.y + L.h - 5}" text-anchor="middle" font-family="Figtree, system-ui, sans-serif" font-size="${(3.6 * fs).toFixed(1)}" fill="#7a6a6e">${esc(dm)}</text>`;
  }
  const hy = Math.max(60, L.y - 24);
  return `<svg viewBox="0 0 100 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Illustration de la bouteille ${esc(b.name || "")}">`
    + `<defs><clipPath id="${id}"><path d="${s.d}"/></clipPath></defs>`
    + `<ellipse cx="50" cy="236" rx="${(s.x1 - s.x0) / 2 + 4}" ry="2.2" fill="#000" opacity=".12"/>`
    + `<path d="${s.d}" fill="${GLASS[type]}" stroke="rgba(0,0,0,.28)" stroke-width=".8"/>`
    + `<g clip-path="url(#${id})"><rect x="0" y="6" width="100" height="${s.cap - 6}" fill="${CAP[type]}"/>`
    + `<rect x="0" y="${s.cap - 2}" width="100" height="2.2" fill="#000" opacity=".18"/>`
    + `<rect x="${s.x0 + 5}" y="${hy}" width="4" height="${224 - hy}" fill="#fff" opacity=".16"/></g>`
    + `<rect x="${L.x}" y="${L.y}" width="${L.w}" height="${L.h}" rx="1.6" fill="#fffdfb" stroke="#d9cdd0" stroke-width=".6"/>`
    + t + `</svg>`;
}
