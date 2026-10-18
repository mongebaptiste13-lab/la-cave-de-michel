import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

function must(res) {
  if (res.error) throw res.error;
  return res.data;
}

export const auth = {
  getSession: async () => (await supabase.auth.getSession()).data.session,
  onChange: (cb) => supabase.auth.onAuthStateChange((event, session) => cb(event, session)),
  signIn: (email, password) => supabase.auth.signInWithPassword({ email, password }),
  signUp: (email, password) => supabase.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } }),
  signOut: () => supabase.auth.signOut(),
  reset: (email) => supabase.auth.resetPasswordForEmail(email, { redirectTo: location.origin }),
  setPassword: (password) => supabase.auth.updateUser({ password }),
};

export const db = {
  async myCellar() {
    const rows = must(
      await supabase
        .from("cellar_members")
        .select("role, cellars(id, name)")
        .order("created_at", { ascending: true })
        .limit(1),
    );
    if (!rows.length || !rows[0].cellars) return null;
    return { id: rows[0].cellars.id, name: rows[0].cellars.name, role: rows[0].role };
  },
  async createCellar(name) {
    return must(await supabase.rpc("create_cellar", { p_name: name }));
  },
  async bottles(cellarId) {
    return must(await supabase.from("bottles").select("*").eq("cellar_id", cellarId).order("created_at", { ascending: false }));
  },
  async history(cellarId) {
    return must(await supabase.from("history").select("*").eq("cellar_id", cellarId).order("at", { ascending: false }).limit(500));
  },
  async insertBottle(row) {
    return must(await supabase.from("bottles").insert(row).select().single());
  },
  async updateBottle(id, patch) {
    return must(await supabase.from("bottles").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select().single());
  },
  async deleteBottle(id) {
    must(await supabase.from("bottles").delete().eq("id", id));
  },
  async removeBottles(id, qty, reason, note, salePrice) {
    must(await supabase.rpc("remove_bottles", {
      p_bottle: id, p_qty: qty, p_reason: reason, p_note: note || null, p_sale_price: salePrice,
    }));
  },
  async restore(historyId) {
    must(await supabase.rpc("restore_history", { p_history: historyId }));
  },
  async members(cellarId) {
    return must(await supabase.rpc("list_members", { p_cellar: cellarId }));
  },
  async invite(cellarId, email) {
    must(await supabase.rpc("add_member_by_email", { p_cellar: cellarId, p_email: email }));
  },
  async rename(cellarId, name) {
    must(await supabase.from("cellars").update({ name }).eq("id", cellarId));
  },
  subscribe(cellarId, onChange) {
    const ch = supabase.channel("cave-" + cellarId);
    ["bottles", "history"].forEach((table) => {
      ch.on("postgres_changes", { event: "*", schema: "public", table, filter: `cellar_id=eq.${cellarId}` }, () => onChange(table));
    });
    ch.subscribe();
    return () => supabase.removeChannel(ch);
  },
};

async function callAI(payload) {
  const session = await auth.getSession();
  if (!session) throw new Error("Connexion requise.");
  const r = await fetch(`${SUPABASE_URL}/functions/v1/ai`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + session.access_token,
      apikey: SUPABASE_KEY,
    },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || "L'IA n'a pas pu répondre."), { status: r.status });
  return j;
}

export const ai = {
  wineFromText: async (text) => (await callAI({ action: "wine_text", text })).wine,
  wineFromImage: async (base64, mime) => (await callAI({ action: "wine_image", image: base64, mime })).wine,
  sommelier: async (cellarId, messages) => (await callAI({ action: "sommelier", cellar_id: cellarId, messages })).text,
};

// Réduit la photo (1024 px max, JPEG) : moins de données envoyées, moins de jetons consommés.
export async function photoToBase64(file, max = 1024) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const sc = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * sc));
  c.height = Math.max(1, Math.round(bmp.height * sc));
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.82));
  const dataUrl = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
  return String(dataUrl).split(",")[1];
}
