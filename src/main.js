import "./styles.css";
import jsQR from "jsqr";
import { auth, db, ai, storage, imageToBlob, blobToBase64 } from "./api.js";
import { bottleSVG } from "./bottle-art.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const YEAR = new Date().getFullYear();
const fmtEur = (n) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n || 0);
const fmtDay = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short" });
const fmtMonth = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" });

const TYPES = {
  rouge: { label: "Rouge" }, blanc: { label: "Blanc" }, rose: { label: "Rosé" },
  bulles: { label: "Bulles" }, liquoreux: { label: "Liquoreux" }, autre: { label: "Autre" },
};
const REASONS = { bu: "Bu", vendu: "Vendu", donne: "Donné", abime: "Abîmé", autre: "Autre" };

const state = {
  session: null, userId: null, cellar: null, profile: null, bottles: [], history: [],
  view: "cave", q: "", ftype: "all", sort: "recent", hfilter: "all", bLoaded: false, hLoaded: false,
};
let unsubscribe = null;

function norm(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }
const orNull = (s) => { s = String(s == null ? "" : s).trim(); return s ? s : null; };

let toastTimer = null;
function toast(msg) {
  const box = $("#toastbox");
  box.innerHTML = '<div class="toast" role="status">' + esc(msg) + "</div>";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.innerHTML = ""; }, 3600);
}
function errText(e, fallback) {
  const m = (e && e.message) || "";
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Pas de connexion. Vérifie ton réseau et réessaie.";
  return m || fallback || "Une erreur est survenue, réessaie.";
}

/* ------------------------------------------------------------------ */
/* Écrans : démarrage, connexion, accueil, application                 */
/* ------------------------------------------------------------------ */
function show(which) {
  $("#boot").hidden = which !== "boot";
  $("#auth").hidden = which !== "auth";
  $("#onboard").hidden = which !== "onboard";
  $("#app").hidden = which !== "app";
  if (which === "auth") $("#a-email").focus({ preventScroll: true });
}

/* Connexion */
let amode = "in";
function setAuthMode(m) {
  amode = m;
  $("#a-go").textContent = m === "in" ? "Se connecter" : "Créer mon compte";
  $("#a-pw").autocomplete = m === "in" ? "current-password" : "new-password";
  $("#a-reset").hidden = m !== "in";
  authMsg("");
}
function authMsg(text, ok) {
  const el = $("#a-msg");
  el.hidden = !text;
  el.textContent = text || "";
  el.className = "msg" + (ok ? " ok" : "");
}
function frAuthError(e) {
  const m = (e && e.message) || "";
  if (/Invalid login credentials/i.test(m)) return "Email ou mot de passe incorrect.";
  if (/Email not confirmed/i.test(m)) return "Confirme d'abord ton email : ouvre le message reçu dans ta boîte mail.";
  if (/already registered|already been registered/i.test(m)) return "Un compte existe déjà avec cet email. Connecte-toi.";
  if (/rate limit|too many/i.test(m)) return "Trop de tentatives ou d'emails envoyés. Attends quelques minutes puis réessaie.";
  if (/Password should be/i.test(m)) return "Mot de passe trop faible : 8 caractères minimum.";
  return errText(e, "Connexion impossible, réessaie.");
}
$$("input[name=amode]").forEach((r) => r.addEventListener("change", () => setAuthMode(r.value)));
$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#a-email").value.trim();
  const pw = $("#a-pw").value;
  if (!email || !pw) { authMsg("Renseigne ton email et ton mot de passe."); return; }
  const btn = $("#a-go");
  btn.disabled = true;
  authMsg("");
  try {
    if (amode === "in") {
      const { error } = await auth.signIn(email, pw);
      if (error) throw error;
    } else {
      if (pw.length < 8) throw new Error("Password should be at least 8 characters");
      const { data, error } = await auth.signUp(email, pw);
      if (error) throw error;
      if (!data.session) authMsg("Compte créé. Ouvre l'email de confirmation que tu viens de recevoir, puis reviens te connecter.", true);
    }
  } catch (err) {
    authMsg(frAuthError(err));
  } finally {
    btn.disabled = false;
  }
});
$("#a-reset").addEventListener("click", async () => {
  const email = $("#a-email").value.trim();
  if (!email) { authMsg("Saisis ton email ci-dessus, puis touche « Mot de passe oublié ? »."); return; }
  const { error } = await auth.reset(email);
  if (error) authMsg(frAuthError(error));
  else authMsg("Un email de réinitialisation vient d'être envoyé si ce compte existe.", true);
});

/* Accueil (aucune cave) */
$("#o-create").addEventListener("click", async () => {
  const btn = $("#o-create");
  btn.disabled = true;
  try {
    await db.createCellar($("#o-name").value.trim() || "La cave de Michel");
    await loadCellar();
  } catch (e) {
    toast(errText(e, "Création impossible."));
    btn.disabled = false;
  }
});
$("#o-reload").addEventListener("click", () => loadCellar());
$("#o-logout").addEventListener("click", () => auth.signOut());

/* Session */
async function onSession(session) {
  if (!session) {
    teardown();
    show("auth");
    return;
  }
  if (state.userId === session.user.id && state.cellar) return;
  state.session = session;
  state.userId = session.user.id;
  $("#o-email").textContent = session.user.email || "";
  await loadCellar();
}
function teardown() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  clearInterval(photoTimer);
  Object.assign(state, { session: null, userId: null, cellar: null, profile: null, bottles: [], history: [], bLoaded: false, hLoaded: false });
  chat.turns = [];
  $("#overlay").innerHTML = "";
  unlockScroll();
}
async function loadCellar() {
  try {
    const c = await db.myCellar();
    if (!c) { state.cellar = null; show("onboard"); $("#o-create").disabled = false; return; }
    state.cellar = c;
    $("#brand").textContent = c.name;
    document.title = c.name;
    show("app");
    setView("cave");
    renderAll();
    await Promise.all([refreshBottles(), refreshHistory()]);
    if (unsubscribe) unsubscribe();
    let t = null;
    unsubscribe = db.subscribe(c.id, (table) => {
      clearTimeout(t);
      t = setTimeout(() => (table === "bottles" ? refreshBottles() : refreshHistory()), 250);
    });
    loadChatTurns();
    loadProfile();
    startPhotoRefresh();
  } catch (e) {
    show("auth");
    authMsg(errText(e, "Impossible d'ouvrir la cave."));
  }
}
async function refreshBottles() {
  try {
    state.bottles = await db.bottles(state.cellar.id);
    state.bLoaded = true;
    renderAll();
    await resolvePhotos();
    renderCave();
  } catch (e) { state.bLoaded = true; renderAll(); toast(errText(e, "Lecture de la cave impossible.")); }
}
async function resolvePhotos() {
  const paths = state.bottles.map((b) => b.photo_path).filter(Boolean);
  if (paths.length) { try { await storage.urls("bottle-photos", paths); } catch (e) { /* photos pas encore activées */ } }
}
let photoTimer = null;
function startPhotoRefresh() {
  clearInterval(photoTimer);
  photoTimer = setInterval(async () => {
    await resolvePhotos();
    const p = state.profile;
    if (p && p.avatar_path) { try { await storage.urls("avatars", [p.avatar_path]); } catch (e) { /* ignore */ } }
    renderCave();
    renderMenuBtn();
  }, 40 * 60 * 1000);
}
async function loadProfile() {
  try {
    const p = await db.myProfile(state.userId);
    state.profile = p || {};
    if (p && p.avatar_path) await storage.urls("avatars", [p.avatar_path]);
  } catch (e) { state.profile = {}; }
  renderMenuBtn();
}
function avatarInner(profile, email) {
  const url = profile && profile.avatar_path ? storage.cached("avatars", profile.avatar_path) : null;
  if (url) return '<img src="' + esc(url) + '" alt="">';
  const src = ((profile && profile.display_name) || email || "?").trim();
  return "<span>" + esc(src.charAt(0).toUpperCase()) + "</span>";
}
function renderMenuBtn() {
  const email = state.session && state.session.user.email;
  $("#menu").innerHTML = '<span class="avatar">' + avatarInner(state.profile, email) + "</span>";
}
function photoSetupError(e, fallback) {
  const m = (e && e.message) || "";
  if (/bucket not found|not found|does not exist|schema cache|relation/i.test(m)) return "Les photos ne sont pas encore activées : le 2e script SQL doit être exécuté dans Supabase.";
  return errText(e, fallback);
}
async function refreshHistory() {
  try { state.history = await db.history(state.cellar.id); state.hLoaded = true; renderAll(); }
  catch (e) { state.hLoaded = true; renderAll(); }
}

/* Navigation */
function setView(v) {
  state.view = v;
  $$(".view").forEach((el) => { el.hidden = el.id !== "v-" + v; });
  $$(".nav button").forEach((b) => { if (b.dataset.view === v) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
  $("#fab").hidden = v !== "cave";
  window.scrollTo(0, 0);
  if (v === "chat") renderChat();
}
$$(".nav button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
$("#fab").addEventListener("click", () => openBottleSheet(null));
$("#menu").addEventListener("click", openAccountSheet);

/* ------------------------------------------------------------------ */
/* Bouteilles                                                          */
/* ------------------------------------------------------------------ */
function typeStyle(t) { const k = TYPES[t] ? t : "autre"; return "--c:var(--t-" + k + ");--cf:var(--t-" + k + "-fg)"; }
function urgent(b) { return b.apogee && b.apogee <= YEAR + 1; }
function thumbHTML(b) {
  const url = b.photo_path ? storage.cached("bottle-photos", b.photo_path) : null;
  const inner = url ? '<img src="' + esc(url) + '" alt="" loading="lazy">' : bottleSVG(b);
  return '<div class="thumb" style="' + typeStyle(b.type) + '">' + inner + '<span class="qtybadge" title="Quantité">' + (b.qty || 0) + "</span></div>";
}

/* Photo de la bouteille dans la fiche : photo perso ou illustration de référence */
let pst = null;
function currentFormBottle() {
  return { name: val("f-name") || "Nom du vin", domaine: val("f-domaine"), vintage: parseInt(val("f-vintage"), 10) || null, type: getType() || "autre", region: val("f-region") };
}
function renderPhotoPreview() {
  const prev = $("#p-prev");
  if (!prev || !pst) return;
  let html, cap;
  if (pst.mode === "new") { html = '<img src="' + esc(pst.url) + '" alt="Photo de la bouteille">'; cap = "Ta photo"; }
  else if (pst.mode === "existing") {
    const u = storage.cached("bottle-photos", pst.path);
    html = u ? '<img src="' + esc(u) + '" alt="Photo de la bouteille">' : bottleSVG(currentFormBottle());
    cap = "Ta photo";
  } else { html = bottleSVG(currentFormBottle()); cap = "Illustration proposée"; }
  prev.innerHTML = html;
  $("#p-cap").textContent = cap;
  $("#p-illus").hidden = !(pst.mode === "new" || pst.mode === "existing");
}
async function setPhotoFile(file) {
  try {
    const blob = await imageToBlob(file, { max: 1000, quality: 0.8 });
    if (pst.url) URL.revokeObjectURL(pst.url);
    pst.mode = "new"; pst.blob = blob; pst.url = URL.createObjectURL(blob);
    renderPhotoPreview();
  } catch (e) { toast("Image illisible, essaie-en une autre."); }
}
function rowHTML(b) {
  let flag = "";
  if (b.apogee) {
    if (b.apogee < YEAR) flag = '<span class="pill bad">Peut-être passée</span>';
    else if (b.apogee <= YEAR + 1) flag = '<span class="pill warn">À boire vite</span>';
  }
  const meta = [b.vintage || "NV", b.region, b.place].filter(Boolean).map(esc).join(" · ");
  return '<div class="row" role="button" tabindex="0" data-id="' + esc(b.id) + '">'
    + thumbHTML(b)
    + '<div><div class="rname">' + esc(b.name) + "</div>"
    + (b.domaine ? '<div class="rdom">' + esc(b.domaine) + "</div>" : "")
    + '<div class="rmeta">' + meta + "</div>" + (flag ? "<div>" + flag + "</div>" : "") + "</div>"
    + '<div class="rside">' + (b.price ? '<div class="price">~' + fmtEur(b.price) + "</div>" : "")
    + '<button type="button" class="btn small ghost" data-act="remove" data-id="' + esc(b.id) + '">Retirer</button></div></div>';
}
function renderCave() {
  const all = state.bottles;
  const qty = all.reduce((s, b) => s + (b.qty || 0), 0);
  const val = all.reduce((s, b) => s + (b.qty || 0) * (Number(b.price) || 0), 0);
  $("#s-qty").textContent = state.bLoaded ? qty : "–";
  $("#s-ref").textContent = state.bLoaded ? all.length : "–";
  $("#s-val").textContent = state.bLoaded ? fmtEur(val) : "–";

  const counts = { all: all.length, urgent: all.filter(urgent).length };
  Object.keys(TYPES).forEach((k) => { counts[k] = all.filter((b) => (TYPES[b.type] ? b.type : "autre") === k).length; });
  const chips = [["all", "Tous"]];
  Object.keys(TYPES).forEach((k) => { if (counts[k]) chips.push([k, TYPES[k].label]); });
  if (counts.urgent) chips.push(["urgent", "À boire vite"]);
  if (!chips.some((c) => c[0] === state.ftype)) state.ftype = "all";
  $("#chips").innerHTML = chips.map((c) =>
    '<button type="button" class="chip" data-t="' + c[0] + '" aria-pressed="' + (state.ftype === c[0]) + '">' + c[1] + ' <span style="opacity:.6">' + counts[c[0]] + "</span></button>").join("");

  const q = norm(state.q);
  const list = all.filter((b) => {
    if (state.ftype === "urgent" && !urgent(b)) return false;
    if (state.ftype !== "all" && state.ftype !== "urgent" && (TYPES[b.type] ? b.type : "autre") !== state.ftype) return false;
    if (!q) return true;
    return norm([b.name, b.domaine, b.region, b.vintage, b.place, b.description].join(" ")).includes(q);
  });
  const s = state.sort;
  list.sort((a, b) => {
    if (s === "name") return norm(a.name).localeCompare(norm(b.name));
    if (s === "vintage") return (b.vintage || 0) - (a.vintage || 0);
    if (s === "price") return (Number(b.price) || 0) - (Number(a.price) || 0);
    return Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0);
  });

  let out;
  if (!state.bLoaded) out = '<div class="loading">Ouverture de la cave…</div>';
  else if (!all.length) {
    out = '<div class="list"><div class="empty"><h3>La cave est vide</h3><p>Ajoute une première bouteille à la main, en scannant un QR code ou en photographiant l\'étiquette.</p><div class="acts">'
      + '<button type="button" class="btn primary" data-act="add">Ajouter une bouteille</button></div></div></div>';
  } else if (!list.length) {
    out = '<div class="list"><div class="empty"><h3>Aucun résultat</h3><p>Aucune bouteille ne correspond à cette recherche.</p></div></div>';
  } else out = '<div class="list">' + list.map(rowHTML).join("") + "</div>";
  $("#list").innerHTML = out;
}
$("#q").addEventListener("input", (e) => { state.q = e.target.value; renderCave(); });
$("#sort").addEventListener("change", (e) => { state.sort = e.target.value; renderCave(); });
$("#chips").addEventListener("click", (e) => { const c = e.target.closest(".chip"); if (!c) return; state.ftype = c.dataset.t; renderCave(); });
const findBottle = (id) => state.bottles.find((b) => b.id === id);
$("#list").addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]");
  if (act) {
    e.stopPropagation();
    if (act.dataset.act === "remove") { const b = findBottle(act.dataset.id); if (b) openRemoveSheet(b); }
    if (act.dataset.act === "add") openBottleSheet(null);
    return;
  }
  const row = e.target.closest(".row");
  if (row) { const b = findBottle(row.dataset.id); if (b) openBottleSheet(b); }
});
$("#list").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const row = e.target.closest(".row");
  if (row && e.target === row) { e.preventDefault(); const b = findBottle(row.dataset.id); if (b) openBottleSheet(b); }
});

/* ------------------------------------------------------------------ */
/* Feuilles                                                            */
/* ------------------------------------------------------------------ */
let lastFocus = null;
let lockedY = 0;
function lockScroll() {
  if (document.body.classList.contains("locked")) return;
  lockedY = window.scrollY;
  document.body.style.top = -lockedY + "px";
  document.body.classList.add("locked");
}
function unlockScroll() {
  if (!document.body.classList.contains("locked")) return;
  document.body.classList.remove("locked");
  document.body.style.top = "";
  window.scrollTo(0, lockedY);
}
function openSheet(html, onMount) {
  lastFocus = document.activeElement;
  lockScroll();
  const ov = $("#overlay");
  ov.innerHTML = '<div class="scrim" id="scrim"><div class="sheet" role="dialog" aria-modal="true">' + html + "</div></div>";
  $("#scrim").addEventListener("mousedown", (e) => { if (e.target.id === "scrim") closeSheet(); });
  const first = $(".sheet input,.sheet button", ov);
  if (first && !/Mobi|Android/i.test(navigator.userAgent)) first.focus();
  if (onMount) onMount($(".sheet", ov));
}
function closeSheet() {
  $("#overlay").innerHTML = "";
  unlockScroll();
  if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* ignore */ } }
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { if ($("#scan")) closeScanner(); else if ($("#scrim")) closeSheet(); } });

function typeSeg(sel) {
  return '<div class="seg" role="radiogroup" aria-label="Type de vin">' + Object.keys(TYPES).map((k) =>
    '<input type="radio" name="f-type" id="ft-' + k + '" value="' + k + '"' + (sel === k ? " checked" : "") + '><label for="ft-' + k + '">' + TYPES[k].label + "</label>").join("") + "</div>";
}
const val = (id) => { const el = $("#" + id); return el ? el.value.trim() : ""; };
function setVal(id, v, onlyEmpty) { const el = $("#" + id); if (!el || v == null || v === "") return; if (onlyEmpty && el.value.trim()) return; el.value = v; }
const getType = () => { const r = $("input[name=f-type]:checked"); return r ? r.value : ""; };
function setType(t, onlyEmpty) { if (!t) return; if (onlyEmpty && getType()) return; const r = $("#ft-" + t); if (r) r.checked = true; }

function normType(s) {
  s = norm(s);
  if (!s) return "";
  if (/rouge|red|tinto/.test(s)) return "rouge";
  if (/blanc|white|blanco/.test(s)) return "blanc";
  if (/ros/.test(s)) return "rose";
  if (/champ|bulle|cremant|sparkling|petillant|prosecco|cava|brut|spumante/.test(s)) return "bulles";
  if (/liquor|moelleux|sauternes|doux|dessert|porto|passito/.test(s)) return "liquoreux";
  return TYPES[s] ? s : "autre";
}
function pick(o, keys) { for (const k of keys) for (const key in o) if (norm(key) === k && o[key] != null && o[key] !== "") return o[key]; return ""; }
function mapObj(o) {
  const r = {};
  r.name = pick(o, ["name", "nom", "vin", "cuvee"]);
  r.domaine = pick(o, ["domaine", "producteur", "chateau", "producer", "winery"]);
  const v = parseInt(pick(o, ["vintage", "millesime", "annee", "year"]), 10); if (v >= 1800 && v <= 2100) r.vintage = v;
  r.type = normType(pick(o, ["type", "couleur", "color", "colour"]));
  r.region = pick(o, ["region", "appellation", "origine"]);
  const p = parseFloat(String(pick(o, ["price", "prix", "prix estime", "estimation"])).replace(",", ".")); if (p > 0) r.price = p;
  const q = parseInt(pick(o, ["qty", "quantite", "quantity", "stock"]), 10); if (q > 0) r.qty = q;
  const a = parseInt(pick(o, ["apogee", "a boire avant", "garde"]), 10); if (a >= 1900 && a <= 2200) r.apogee = a;
  r.description = pick(o, ["description", "desc", "notes", "note", "commentaire"]);
  r.place = pick(o, ["emplacement", "place", "casier"]);
  return r;
}
function parseQR(txt) {
  txt = String(txt || "").trim();
  try { const o = JSON.parse(txt); if (o && typeof o === "object" && !Array.isArray(o)) { const m = mapObj(o); if (m.name || m.domaine) return m; } } catch (e) { /* not json */ }
  if (/^https?:\/\//i.test(txt)) return { description: "Lien du QR code : " + txt, _link: true };
  const kv = {}; let n = 0;
  txt.split(/[\n;|]/).forEach((p) => { const m = p.match(/^\s*([^:=]+?)\s*[:=]\s*(.+)$/); if (m) { kv[m[1]] = m[2].trim(); n++; } });
  if (n) { const r = mapObj(kv); if (r.name || r.domaine) return r; }
  return { name: txt.slice(0, 120) };
}
function fillForm(d, onlyEmpty) {
  setVal("f-name", d.name, onlyEmpty); setVal("f-domaine", d.domaine, onlyEmpty); setVal("f-vintage", d.vintage, onlyEmpty);
  setType(d.type, onlyEmpty); setVal("f-region", d.region, onlyEmpty); setVal("f-price", d.price, onlyEmpty);
  setVal("f-apogee", d.apogee, onlyEmpty); setVal("f-desc", d.description, onlyEmpty); setVal("f-place", d.place, onlyEmpty);
  if (d.qty && !onlyEmpty) setVal("f-qty", d.qty);
}

function openBottleSheet(b) {
  const editing = !!b;
  b = b || { qty: 1 };
  pst = { mode: b.photo_path ? "existing" : "none", blob: null, url: null, orig: b.photo_path || null, path: b.photo_path || null };
  const html = "<h2>" + (editing ? "Modifier la bouteille" : "Ajouter une bouteille") + "</h2>"
    + '<p class="sub">' + (editing ? "Corrige les informations ou la quantité." : "Scanne, photographie ou saisis à la main.") + "</p>"
    + (editing ? "" : '<div class="quick"><button type="button" class="btn" id="b-qr">Scanner un QR code</button><button type="button" class="btn" id="b-label">Photo de l\'étiquette</button></div>')
    + '<div class="photoblk"><div class="pprev" id="p-prev"></div><div class="pctl"><span class="lab" style="margin:0" id="p-cap">Illustration proposée</span>'
    + '<button type="button" class="btn small" id="p-take">Prendre une photo</button>'
    + '<button type="button" class="btn small" id="p-pick">Choisir une image</button>'
    + '<button type="button" class="btn small ghost" id="p-illus" hidden>Utiliser l\'illustration</button></div></div>'
    + '<input type="file" id="p-file-cam" accept="image/*" capture="environment" hidden><input type="file" id="p-file-pick" accept="image/*" hidden>'
    + '<label for="f-name">Nom du vin</label><input id="f-name" type="text" autocomplete="off" value="' + esc(b.name || "") + '" placeholder="Ex. Château Example, cuvée Prestige">'
    + '<label for="f-domaine">Domaine ou producteur</label><input id="f-domaine" type="text" autocomplete="off" value="' + esc(b.domaine || "") + '">'
    + '<div class="grid3"><div><label for="f-vintage">Millésime</label><input id="f-vintage" type="number" inputmode="numeric" min="1800" max="2100" value="' + esc(b.vintage || "") + '" placeholder="NV"></div>'
    + '<div><label for="f-qty">Quantité</label><input id="f-qty" type="number" inputmode="numeric" min="1" value="' + esc(b.qty || 1) + '"></div>'
    + '<div><label for="f-price">Prix estimé (€)</label><input id="f-price" type="number" inputmode="decimal" min="0" step="any" value="' + esc(b.price || "") + '"></div></div>'
    + "<label>Type</label>" + typeSeg(b.type || "")
    + '<label for="f-region">Région ou appellation</label><input id="f-region" type="text" autocomplete="off" value="' + esc(b.region || "") + '">'
    + '<div class="grid2"><div><label for="f-apogee">À boire avant (année)</label><input id="f-apogee" type="number" inputmode="numeric" min="1900" max="2200" value="' + esc(b.apogee || "") + '"></div>'
    + '<div><label for="f-place">Emplacement</label><input id="f-place" type="text" autocomplete="off" value="' + esc(b.place || "") + '" placeholder="Casier B, étage 2"></div></div>'
    + '<label for="f-desc">Description</label><textarea id="f-desc" rows="3" placeholder="Arômes, souvenirs, accords…">' + esc(b.description || "") + "</textarea>"
    + '<div class="acts" style="margin-top:12px"><button type="button" class="btn" id="b-ai">Compléter avec l\'IA</button></div>'
    + '<p class="note" id="ai-note">L\'IA propose type, région, prix indicatif et description à partir du nom. Tout reste modifiable.</p>'
    + '<div class="acts"><button type="button" class="btn ghost" id="b-cancel">Annuler</button><button type="button" class="btn primary" id="b-save">' + (editing ? "Enregistrer" : "Ajouter à la cave") + "</button></div>"
    + (editing ? '<div class="acts"><button type="button" class="btn" id="b-remove">Retirer des bouteilles…</button><button type="button" class="btn danger" id="b-del">Supprimer la ligne</button></div><p class="note">Supprimer sert à corriger une erreur de saisie et ne laisse pas de trace dans l\'historique. Pour une bouteille bue, vendue ou donnée, utilise Retirer.</p>' : "");

  openSheet(html, () => {
    $("#b-cancel").addEventListener("click", closeSheet);
    $("#b-save").addEventListener("click", () => saveBottle(b, editing));
    const qrb = $("#b-qr"); if (qrb) qrb.addEventListener("click", openScanner);
    const lb = $("#b-label"); if (lb) lb.addEventListener("click", () => $("#labelfile").click());
    $("#b-ai").addEventListener("click", aiComplete);
    renderPhotoPreview();
    if (pst.mode === "existing") storage.urls("bottle-photos", [pst.path]).then(renderPhotoPreview).catch(() => {});
    const camIn = $("#p-file-cam"), pickIn = $("#p-file-pick");
    $("#p-take").addEventListener("click", () => camIn.click());
    $("#p-pick").addEventListener("click", () => pickIn.click());
    [camIn, pickIn].forEach((inp) => inp.addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; if (f) setPhotoFile(f); }));
    $("#p-illus").addEventListener("click", () => { if (pst.url) URL.revokeObjectURL(pst.url); pst.mode = "none"; pst.blob = null; pst.url = null; renderPhotoPreview(); });
    ["f-name", "f-domaine", "f-vintage", "f-region"].forEach((id) => $("#" + id).addEventListener("input", () => { if (pst.mode !== "new") renderPhotoPreview(); }));
    $$("input[name=f-type]").forEach((r) => r.addEventListener("change", () => { if (pst.mode !== "new") renderPhotoPreview(); }));
    if (editing) {
      $("#b-remove").addEventListener("click", () => { closeSheet(); openRemoveSheet(b); });
      const del = $("#b-del"); let armed = false;
      del.addEventListener("click", async () => {
        if (!armed) { armed = true; del.textContent = "Confirmer la suppression"; setTimeout(() => { armed = false; if (del.isConnected) del.textContent = "Supprimer la ligne"; }, 4000); return; }
        try { await db.deleteBottle(b.id); storage.remove("bottle-photos", b.photo_path); closeSheet(); toast("Ligne supprimée."); refreshBottles(); }
        catch (e) { toast(errText(e, "Suppression impossible.")); }
      });
    }
  });
}

async function saveBottle(orig, editing) {
  const name = val("f-name");
  if (!name) { toast("Donne un nom au vin."); $("#f-name").focus(); return; }
  const v = parseInt(val("f-vintage"), 10);
  const q = Math.max(1, parseInt(val("f-qty"), 10) || 1);
  const p = parseFloat(val("f-price").replace(",", "."));
  const a = parseInt(val("f-apogee"), 10);
  const data = {
    name, domaine: orNull(val("f-domaine")), vintage: v >= 1800 && v <= 2100 ? v : null, qty: q,
    price: p > 0 ? p : null, type: getType() || "autre", region: orNull(val("f-region")),
    apogee: a >= 1900 && a <= 2200 ? a : null, place: orNull(val("f-place")), description: orNull(val("f-desc")),
  };
  const btn = $("#b-save");
  btn.disabled = true;
  const bottleId = editing ? orig.id : crypto.randomUUID();
  let uploaded = null;
  const photoPatch = {};
  try {
    if (pst && pst.mode === "new") {
      uploaded = state.cellar.id + "/" + bottleId + "-" + Date.now() + ".jpg";
      try { await storage.upload("bottle-photos", uploaded, pst.blob); }
      catch (e) { uploaded = null; throw new Error(photoSetupError(e, "Envoi de la photo impossible, réessaie.")); }
      photoPatch.photo_path = uploaded;
    } else if (pst && pst.mode === "none" && pst.orig) {
      photoPatch.photo_path = null;
    }
    if (editing) {
      await db.updateBottle(orig.id, { ...data, ...photoPatch });
      closeSheet(); toast("Bouteille modifiée.");
    } else {
      const key = norm(data.name) + "|" + (data.vintage || "nv") + "|" + norm(data.domaine);
      const dup = state.bottles.find((x) => norm(x.name) + "|" + (x.vintage || "nv") + "|" + norm(x.domaine) === key);
      if (dup) {
        const patch = { qty: (dup.qty || 0) + q };
        ["price", "region", "apogee", "place", "description"].forEach((k) => { if (!dup[k] && data[k]) patch[k] = data[k]; });
        if (uploaded && !dup.photo_path) { patch.photo_path = uploaded; }
        else if (uploaded) { storage.remove("bottle-photos", uploaded); uploaded = null; delete photoPatch.photo_path; }
        await db.updateBottle(dup.id, patch);
        closeSheet(); toast("Déjà en cave : quantité portée à " + patch.qty + ".");
      } else {
        await db.insertBottle({ id: bottleId, cellar_id: state.cellar.id, ...data, ...photoPatch });
        closeSheet(); toast("Bouteille ajoutée.");
      }
    }
    if (pst && pst.orig && "photo_path" in photoPatch) storage.remove("bottle-photos", pst.orig);
    refreshBottles();
  } catch (e) {
    if (uploaded) storage.remove("bottle-photos", uploaded);
    toast(errText(e, "Enregistrement impossible, réessaie."));
    btn.disabled = false;
  }
}

/* IA : compléter, étiquette */
function wineFromAI(w) {
  if (!w) return {};
  const r = {};
  ["name", "domaine", "vintage", "type", "region", "price", "apogee", "description"].forEach((k) => { if (w[k] != null && w[k] !== "") r[k] = w[k]; });
  return r;
}
async function aiComplete() {
  const name = val("f-name");
  if (!name) { toast("Saisis d'abord le nom du vin."); $("#f-name").focus(); return; }
  const btn = $("#b-ai");
  btn.disabled = true; btn.textContent = "Recherche…";
  const text = "Nom : " + name + (val("f-domaine") ? "\nDomaine : " + val("f-domaine") : "") + (val("f-vintage") ? "\nMillésime : " + val("f-vintage") : "") + (val("f-region") ? "\nRégion : " + val("f-region") : "");
  try {
    const d = wineFromAI(await ai.wineFromText(text));
    delete d.name;
    fillForm(d, true);
    const n = $("#ai-note"); if (n) n.textContent = "Proposition de l'IA pour les champs vides : à vérifier. Le prix est indicatif.";
  } catch (e) { toast(errText(e, "Échec de la demande, réessaie.")); }
  finally { if (btn.isConnected) { btn.disabled = false; btn.textContent = "Compléter avec l'IA"; } }
}
$("#labelfile").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!f || !$("#f-name")) return;
  const btn = $("#b-label");
  if (btn) { btn.disabled = true; btn.textContent = "Lecture…"; }
  try {
    const blob = await imageToBlob(f, { max: 1024, quality: 0.82 });
    const b64 = await blobToBase64(blob);
    const d = wineFromAI(await ai.wineFromImage(b64, "image/jpeg"));
    fillForm(d, false);
    if (pst && $("#p-prev")) {
      if (pst.url) URL.revokeObjectURL(pst.url);
      pst.mode = "new"; pst.blob = blob; pst.url = URL.createObjectURL(blob);
      renderPhotoPreview();
    }
    const n = $("#ai-note"); if (n) n.textContent = "Informations lues sur l'étiquette par l'IA : à vérifier. La photo est gardée pour la bouteille, tu peux la remplacer ou garder l'illustration.";
    toast("Étiquette lue, vérifie les champs.");
  } catch (err) { toast(errText(err, "Lecture impossible, réessaie.")); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = "Photo de l'étiquette"; } }
});

/* Scanner de QR code : caméra en direct, sinon photo */
let scanStream = null, scanRaf = 0;
function closeScanner() {
  cancelAnimationFrame(scanRaf);
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
  const el = $("#scan"); if (el) el.remove();
}
function onQRText(txt) {
  closeScanner();
  if (!$("#f-name")) return;
  const d = parseQR(txt);
  fillForm(d, false);
  toast(d._link ? "QR lu : lien noté dans la description. Complète le nom." : "QR code lu, vérifie les champs.");
}
async function decodeQRFile(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const W = bmp.width, H = bmp.height;
  if ("BarcodeDetector" in window) {
    try { const det = new BarcodeDetector({ formats: ["qr_code"] }); const r = await det.detect(bmp); if (r && r[0] && r[0].rawValue) return r[0].rawValue; } catch (e) { /* fallback */ }
  }
  for (const size of [1000, 1600, 640]) {
    const sc = Math.min(1, size / Math.max(W, H)), w = Math.max(1, Math.round(W * sc)), h = Math.max(1, Math.round(H * sc));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.drawImage(bmp, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h);
    const code = jsQR(d.data, w, h, { inversionAttempts: "attemptBoth" });
    if (code && code.data) return code.data;
  }
  return null;
}
$("#qrfile").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!f) return;
  toast("Lecture du QR code…");
  try {
    const txt = await decodeQRFile(f);
    if (!txt) { toast("Aucun QR code lisible sur la photo. Rapproche-toi et réessaie."); return; }
    onQRText(txt);
  } catch (err) { toast("Photo illisible, réessaie."); }
});
async function openScanner() {
  const wrap = document.createElement("div");
  wrap.className = "scan"; wrap.id = "scan";
  wrap.innerHTML = '<video id="scanvid" playsinline muted></video><div class="frame"></div><div class="hint" id="scanhint">Place le QR code dans le cadre</div>'
    + '<div class="bar"><button type="button" class="btn" id="scan-photo">Prendre une photo</button><button type="button" class="btn" id="scan-close">Fermer</button></div>';
  document.body.appendChild(wrap);
  $("#scan-close").addEventListener("click", closeScanner);
  $("#scan-photo").addEventListener("click", () => { closeScanner(); $("#qrfile").click(); });
  const vid = $("#scanvid");
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("no camera");
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    vid.srcObject = scanStream;
    await vid.play();
  } catch (e) {
    $("#scanhint").textContent = "Caméra indisponible ou refusée. Utilise « Prendre une photo ».";
    return;
  }
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const detector = "BarcodeDetector" in window ? new BarcodeDetector({ formats: ["qr_code"] }) : null;
  let last = 0, busy = false;
  const tick = async (t) => {
    if (!$("#scan")) return;
    if (!busy && t - last > 140 && vid.readyState >= 2 && vid.videoWidth) {
      busy = true; last = t;
      try {
        let text = null;
        if (detector) { const r = await detector.detect(vid); if (r && r[0]) text = r[0].rawValue; }
        else {
          const sc = Math.min(1, 720 / Math.max(vid.videoWidth, vid.videoHeight));
          canvas.width = Math.round(vid.videoWidth * sc); canvas.height = Math.round(vid.videoHeight * sc);
          ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
          const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(d.data, canvas.width, canvas.height, { inversionAttempts: "dontInvert" });
          if (code && code.data) text = code.data;
        }
        if (text) { onQRText(text); return; }
      } catch (e) { /* frame skipped */ }
      busy = false;
    }
    scanRaf = requestAnimationFrame(tick);
  };
  scanRaf = requestAnimationFrame(tick);
}

/* Retrait */
function openRemoveSheet(b) {
  let n = 1;
  const reasons = Object.keys(REASONS).map((k, i) =>
    '<input type="radio" name="r-reason" id="rr-' + k + '" value="' + k + '"' + (i === 0 ? " checked" : "") + '><label for="rr-' + k + '">' + REASONS[k] + "</label>").join("");
  const html = "<h2>Retirer de la cave</h2><p class=\"sub\">" + esc(b.name) + (b.vintage ? " " + b.vintage : "") + " · il en reste " + (b.qty || 0) + "</p>"
    + '<span class="lab">Combien de bouteilles</span><div class="qty"><button type="button" id="r-minus" aria-label="Moins">−</button><output id="r-n" aria-live="polite">1</output><button type="button" id="r-plus" aria-label="Plus">+</button></div>'
    + '<span class="lab">Pourquoi</span><div class="seg" role="radiogroup" aria-label="Motif">' + reasons + "</div>"
    + '<div id="r-sale" hidden><label for="r-price">Prix de vente par bouteille (€)</label><input id="r-price" type="number" inputmode="decimal" min="0" step="any" value="' + esc(b.price || "") + '"></div>'
    + '<label for="r-note">Précision (facultatif)</label><input id="r-note" type="text" autocomplete="off" placeholder="Avec qui, quelle occasion, à qui…">'
    + '<div class="acts"><button type="button" class="btn ghost" id="r-cancel">Annuler</button><button type="button" class="btn primary" id="r-ok">Retirer</button></div>';
  openSheet(html, () => {
    const max = b.qty || 1;
    const upd = () => { $("#r-n").textContent = n; $("#r-minus").disabled = n <= 1; $("#r-plus").disabled = n >= max; };
    upd();
    $("#r-minus").addEventListener("click", () => { if (n > 1) { n--; upd(); } });
    $("#r-plus").addEventListener("click", () => { if (n < max) { n++; upd(); } });
    $$("input[name=r-reason]").forEach((r) => r.addEventListener("change", () => { $("#r-sale").hidden = r.value !== "vendu" || !r.checked; }));
    $("#r-cancel").addEventListener("click", closeSheet);
    $("#r-ok").addEventListener("click", async () => {
      const reasonEl = $("input[name=r-reason]:checked");
      const reason = reasonEl ? reasonEl.value : "bu";
      const sp = parseFloat(val("r-price").replace(",", "."));
      const btn = $("#r-ok");
      btn.disabled = true;
      try {
        await db.removeBottles(b.id, n, reason, val("r-note"), reason === "vendu" && sp >= 0 ? sp : null);
        closeSheet();
        toast(n + (n > 1 ? " bouteilles retirées" : " bouteille retirée") + " · " + REASONS[reason].toLowerCase());
        refreshBottles(); refreshHistory();
      } catch (e) { toast(errText(e, "Retrait impossible, réessaie.")); btn.disabled = false; }
    });
  });
}

/* ------------------------------------------------------------------ */
/* Historique                                                          */
/* ------------------------------------------------------------------ */
let armedUndo = null, armedTimer = null;
function renderHist() {
  const all = state.history;
  const rs = ["all"].concat(Object.keys(REASONS).filter((k) => all.some((h) => h.reason === k)));
  if (!rs.includes(state.hfilter)) state.hfilter = "all";
  $("#hchips").innerHTML = rs.map((k) => {
    const c = k === "all" ? all.length : all.filter((h) => h.reason === k).length;
    return '<button type="button" class="chip" data-r="' + k + '" aria-pressed="' + (state.hfilter === k) + '">' + (k === "all" ? "Tout" : REASONS[k]) + ' <span style="opacity:.6">' + c + "</span></button>";
  }).join("");
  const list = all.filter((h) => state.hfilter === "all" || h.reason === state.hfilter);
  const sum = (r) => all.filter((h) => h.reason === r).reduce((s, h) => s + (h.qty || 0), 0);
  const sold = all.filter((h) => h.reason === "vendu" && h.sale_price != null).reduce((s, h) => s + h.qty * Number(h.sale_price), 0);
  $("#hsum").textContent = all.length ? sum("bu") + " bues · " + sum("vendu") + " vendues" + (sold ? " (" + fmtEur(sold) + ")" : "") + " · " + sum("donne") + " données · " + sum("abime") + " abîmées" : "";
  if (!state.hLoaded) { $("#hlist").innerHTML = '<div class="loading">Chargement de l\'historique…</div>'; return; }
  if (!list.length) {
    $("#hlist").innerHTML = '<div class="list"><div class="empty"><h3>Rien à afficher</h3><p>' + (all.length ? "Aucune sortie avec ce motif." : "Quand une bouteille est bue, vendue ou donnée, elle apparaît ici avec la date et le motif.") + "</p></div></div>";
    return;
  }
  let out = "", cur = "";
  list.forEach((h) => {
    const d = new Date(h.at), m = fmtMonth.format(d);
    if (m !== cur) { if (cur) out += "</div>"; out += '<div class="mhead">' + esc(m) + '</div><div class="list">'; cur = m; }
    const rsn = REASONS[h.reason] ? h.reason : "autre";
    out += '<div class="hrow"><div class="hname"><span class="rs ' + rsn + '">' + REASONS[rsn] + "</span>" + esc(h.name) + (h.vintage ? " " + h.vintage : "") + "</div>"
      + '<div class="price">×' + (h.qty || 1) + "</div>"
      + '<div class="hmeta">' + esc(fmtDay.format(d)) + (h.domaine ? " · " + esc(h.domaine) : "") + (h.sale_price != null ? " · vendu " + fmtEur(h.sale_price) + "/btl" : "") + "</div>"
      + '<div style="text-align:right"><button type="button" class="btn small ghost" data-undo="' + esc(h.id) + '">' + (armedUndo === h.id ? "Confirmer ?" : "Remettre en cave") + "</button></div>"
      + (h.note ? '<div class="hnote">' + esc(h.note) + "</div>" : "") + "</div>";
  });
  out += "</div>";
  $("#hlist").innerHTML = out;
}
$("#hchips").addEventListener("click", (e) => { const c = e.target.closest(".chip"); if (!c) return; state.hfilter = c.dataset.r; renderHist(); });
$("#hlist").addEventListener("click", async (e) => {
  const u = e.target.closest("[data-undo]");
  if (!u) return;
  const id = u.dataset.undo;
  if (armedUndo !== id) { armedUndo = id; clearTimeout(armedTimer); armedTimer = setTimeout(() => { armedUndo = null; renderHist(); }, 4000); renderHist(); return; }
  armedUndo = null; clearTimeout(armedTimer);
  try { await db.restore(id); toast("Remise en cave."); refreshBottles(); refreshHistory(); }
  catch (err) { toast(errText(err, "Annulation impossible.")); renderHist(); }
});

/* ------------------------------------------------------------------ */
/* Sommelier                                                           */
/* ------------------------------------------------------------------ */
const chat = { turns: [], busy: false };
const chatKey = () => "cave.chat." + (state.cellar ? state.cellar.id : "x");
function loadChatTurns() {
  try { const v = JSON.parse(localStorage.getItem(chatKey()) || "[]"); chat.turns = v.filter((t) => t && (t.role === "user" || t.role === "assistant") && t.content); }
  catch (e) { chat.turns = []; }
}
function saveChatTurns() { try { localStorage.setItem(chatKey(), JSON.stringify(chat.turns.slice(-30))); } catch (e) { /* ignore */ } }
function inline(s) { return s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>"); }
function md(t) {
  return esc(t).split(/\n{2,}/).map((b) => {
    const lines = b.split("\n");
    if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) return "<ul>" + lines.map((l) => "<li>" + inline(l.replace(/^\s*[-*•]\s+/, "")) + "</li>").join("") + "</ul>";
    return "<p>" + lines.map(inline).join("<br>") + "</p>";
  }).join("");
}
const bubble = (role, text) => '<div class="msgb ' + (role === "user" ? "user" : "bot") + '">' + (role === "user" ? esc(text) : '<span class="who">Sommelier</span>' + md(text)) + "</div>";
function renderChat() {
  if (!state.cellar) return;
  let h = '<div class="msgb bot"><span class="who">Sommelier</span><p>Dis-moi ce que tu prépares ou l\'occasion, je choisis dans la cave'
    + (state.bottles.length || !state.bLoaded ? "" : " (elle est vide pour l'instant, je peux quand même conseiller)") + ".</p></div>";
  chat.turns.forEach((t) => { h += bubble(t.role, t.content); });
  $("#chatlog").innerHTML = h;
  const sg = ["Un vin pour ce soir, on fait un poulet rôti", "Que faut-il boire en priorité ?", "Une bouteille à partager à l'apéro", "Un vin pour un fromage ou un dessert"];
  $("#suggest").innerHTML = chat.turns.length ? "" : sg.map((s) => '<button type="button" class="chip" data-q="' + esc(s) + '">' + esc(s) + "</button>").join("");
}
$("#suggest").addEventListener("click", (e) => { const c = e.target.closest("[data-q]"); if (c) sendChat(c.dataset.q); });
async function sendChat(text) {
  text = (text || "").trim();
  if (!text || chat.busy || !state.cellar) return;
  chat.busy = true;
  $("#send").disabled = true; $("#chatin").disabled = true;
  chat.turns.push({ role: "user", content: text });
  const log = $("#chatlog");
  $("#suggest").innerHTML = "";
  log.insertAdjacentHTML("beforeend", bubble("user", text));
  log.insertAdjacentHTML("beforeend", '<div class="msgb bot" id="live"><span class="who">Sommelier</span><p>Je regarde dans la cave…</p></div>');
  const live = $("#live");
  live.scrollIntoView({ block: "end", behavior: "smooth" });
  try {
    const reply = await ai.sommelier(state.cellar.id, chat.turns.slice(-12));
    chat.turns.push({ role: "assistant", content: reply });
    live.outerHTML = bubble("assistant", reply);
  } catch (e) {
    chat.turns.pop();
    live.outerHTML = '<div class="msgb bot err">' + esc(errText(e, "Le sommelier n'a pas pu répondre, réessaie.")) + "</div>";
  } finally {
    chat.busy = false;
    $("#send").disabled = false; $("#chatin").disabled = false; $("#chatin").focus();
    saveChatTurns();
  }
}
function autosize() { const t = $("#chatin"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 140) + "px"; }
$("#composer").addEventListener("submit", (e) => { e.preventDefault(); const t = $("#chatin").value; $("#chatin").value = ""; autosize(); sendChat(t); });
$("#chatin").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#composer").requestSubmit(); } });
$("#chatin").addEventListener("input", autosize);

/* ------------------------------------------------------------------ */
/* Compte et partage                                                   */
/* ------------------------------------------------------------------ */
async function openAccountSheet() {
  const c = state.cellar;
  if (!c) return;
  const owner = c.role === "owner";
  const email = (state.session && state.session.user.email) || "";
  const p = state.profile || {};
  const html = "<h2>" + esc(c.name) + "</h2><p class=\"sub\">Connecté : " + esc(email) + "</p>"
    + '<div class="profile"><span class="avatar big" id="av-big">' + avatarInner(p, email) + '</span><div class="pctl">'
    + '<button type="button" class="btn small" id="av-pick">' + (p.avatar_path ? "Changer la photo" : "Ajouter une photo de profil") + "</button>"
    + '<button type="button" class="btn small ghost" id="av-del"' + (p.avatar_path ? "" : " hidden") + ">Retirer la photo</button></div></div>"
    + '<input type="file" id="av-file" accept="image/*" hidden>'
    + '<label for="pf-name">Ton prénom</label><div class="grid2" style="grid-template-columns:1fr auto"><input id="pf-name" type="text" maxlength="60" autocomplete="given-name" value="' + esc(p.display_name || "") + '"><button type="button" class="btn" id="pf-save">Enregistrer</button></div>'
    + '<span class="lab">Personnes qui ont accès</span><ul class="members" id="members"><li>Chargement…</li></ul>'
    + (owner
      ? '<label for="m-email">Ajouter quelqu\'un (email de son compte)</label><div class="grid2" style="grid-template-columns:1fr auto"><input id="m-email" type="email" inputmode="email" autocomplete="off" placeholder="prenom@exemple.fr"><button type="button" class="btn primary" id="m-add">Ajouter</button></div>'
        + '<p class="note">La personne doit d\'abord avoir créé son compte sur cette page.</p>'
        + '<label for="m-name">Nom de la cave</label><div class="grid2" style="grid-template-columns:1fr auto"><input id="m-name" type="text" value="' + esc(c.name) + '"><button type="button" class="btn" id="m-rename">Renommer</button></div>'
      : "")
    + '<div class="acts"><button type="button" class="btn ghost" id="m-close">Fermer</button><button type="button" class="btn danger" id="m-out">Se déconnecter</button></div>';
  openSheet(html, () => {
    $("#m-close").addEventListener("click", closeSheet);
    $("#m-out").addEventListener("click", async () => { closeSheet(); await auth.signOut(); });

    const loadMembers = async () => {
      try {
        const rows = await db.members(c.id);
        const profs = {};
        try {
          const ps = await db.profiles(rows.map((m) => m.user_id));
          ps.forEach((x) => { profs[x.user_id] = x; });
          await storage.urls("avatars", ps.map((x) => x.avatar_path).filter(Boolean));
        } catch (e) { /* profils pas encore activés */ }
        const el = $("#members"); if (!el) return;
        el.innerHTML = rows.map((m) => {
          const pr = profs[m.user_id];
          return '<li><span class="mem"><span class="avatar sm">' + avatarInner(pr, m.email) + "</span><span>" + esc((pr && pr.display_name) || m.email) + "</span></span><small>" + (m.role === "owner" ? "propriétaire" : "membre") + "</small></li>";
        }).join("");
      } catch (e) { const el = $("#members"); if (el) el.innerHTML = "<li>Liste indisponible.</li>"; }
    };
    loadMembers();

    const refreshAvatar = () => {
      const big = $("#av-big"); if (big) big.innerHTML = avatarInner(state.profile, email);
      const has = !!(state.profile && state.profile.avatar_path);
      const pick = $("#av-pick"); if (pick) pick.textContent = has ? "Changer la photo" : "Ajouter une photo de profil";
      const del = $("#av-del"); if (del) del.hidden = !has;
      renderMenuBtn();
    };
    $("#av-pick").addEventListener("click", () => $("#av-file").click());
    $("#av-file").addEventListener("change", async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!f) return;
      const btn = $("#av-pick");
      btn.disabled = true;
      try {
        const blob = await imageToBlob(f, { max: 256, square: true, quality: 0.85 });
        const path = state.userId + "/avatar-" + Date.now() + ".jpg";
        await storage.upload("avatars", path, blob);
        const old = state.profile && state.profile.avatar_path;
        await db.saveProfile(state.userId, { avatar_path: path });
        state.profile = { ...(state.profile || {}), avatar_path: path };
        await storage.urls("avatars", [path]);
        if (old) storage.remove("avatars", old);
        refreshAvatar(); loadMembers();
        toast("Photo de profil mise à jour.");
      } catch (err) { toast(photoSetupError(err, "Envoi de la photo impossible.")); }
      finally { if (btn.isConnected) btn.disabled = false; }
    });
    $("#av-del").addEventListener("click", async () => {
      const old = state.profile && state.profile.avatar_path;
      if (!old) return;
      try {
        await db.saveProfile(state.userId, { avatar_path: null });
        state.profile = { ...state.profile, avatar_path: null };
        storage.remove("avatars", old);
        refreshAvatar(); loadMembers();
        toast("Photo retirée.");
      } catch (err) { toast(errText(err, "Suppression impossible.")); }
    });
    $("#pf-save").addEventListener("click", async () => {
      const name = val("pf-name");
      try {
        await db.saveProfile(state.userId, { display_name: name || null });
        state.profile = { ...(state.profile || {}), display_name: name || null };
        refreshAvatar(); loadMembers();
        toast("Prénom enregistré.");
      } catch (err) { toast(photoSetupError(err, "Enregistrement impossible.")); }
    });

    if (owner) {
      $("#m-add").addEventListener("click", async () => {
        const mail = val("m-email");
        if (!mail) return;
        const btn = $("#m-add"); btn.disabled = true;
        try { await db.invite(c.id, mail); $("#m-email").value = ""; toast("Accès ajouté."); await loadMembers(); }
        catch (e) { toast(errText(e, "Ajout impossible.")); }
        finally { btn.disabled = false; }
      });
      $("#m-rename").addEventListener("click", async () => {
        const name = val("m-name");
        if (!name) return;
        try { await db.rename(c.id, name); c.name = name; $("#brand").textContent = name; document.title = name; toast("Cave renommée."); }
        catch (e) { toast(errText(e, "Renommage impossible.")); }
      });
    }
  });
}

/* ------------------------------------------------------------------ */
function renderAll() {
  if (!state.cellar) return;
  renderCave();
  renderHist();
  if (state.view === "chat" && !chat.busy) renderChat();
}

/* Récupération de mot de passe */
function openNewPasswordSheet() {
  openSheet("<h2>Nouveau mot de passe</h2><p class=\"sub\">Choisis un mot de passe d'au moins 8 caractères.</p>"
    + '<label for="np">Mot de passe</label><input id="np" type="password" autocomplete="new-password">'
    + '<div class="acts"><button type="button" class="btn primary" id="np-ok">Enregistrer</button></div>', () => {
    $("#np-ok").addEventListener("click", async () => {
      const pw = $("#np").value;
      if (pw.length < 8) { toast("8 caractères minimum."); return; }
      const { error } = await auth.setPassword(pw);
      if (error) toast(frAuthError(error)); else { closeSheet(); toast("Mot de passe mis à jour."); }
    });
  });
}

/* Démarrage */
setAuthMode("in");
auth.onChange((event, session) => {
  // Ne pas appeler Supabase directement dans ce callback : on repousse d'un tour.
  setTimeout(() => {
    if (event === "PASSWORD_RECOVERY") { onSession(session).then(openNewPasswordSheet); return; }
    onSession(session);
  }, 0);
});
auth.getSession().then((s) => { if (!s) show("auth"); });
