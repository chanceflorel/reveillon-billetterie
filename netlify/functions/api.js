const crypto = require("crypto");

const HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const reply = (statusCode, body) => ({ statusCode, headers: HEADERS, body: JSON.stringify(body) });

const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from(crypto.randomBytes(10), (b) => CHARS[b % CHARS.length]).join("");
const priceOf = (t) => Number(t.prix) || 0;

// Ce qui peut être montré à l'écran (le numéro de téléphone reste privé)
const pub = (t) => ({
  code: t.code,
  nom: t.nom,
  vendeur: t.vendeur,
  prix: priceOf(t),
  cree: t.cree,
  envoye: !!t.envoye,
  utilise: t.utilise || null,
});

async function getStore(event) {
  const blobs = await import("@netlify/blobs");
  blobs.connectLambda(event);
  return blobs.getStore({ name: "reveillon" });
}

exports.handler = async (event) => {
  try {
    return await handle(event);
  } catch (err) {
    console.error("Erreur fonction :", err);
    return reply(500, { error: "Erreur serveur : " + err.message });
  }
};

async function handle(event) {
  const action = (event.path || "").split("/").filter(Boolean).pop();

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return reply(400, { error: "Requête invalide." });
  }

  const store = await getStore(event);

  // Vérification publique d'un billet (QR code) : aucun code d'accès, ne consomme rien
  if (action === "verify") {
    const code = String((event.queryStringParameters || {}).code || "").toUpperCase();
    if (!/^[A-Z2-9]{10}$/.test(code)) return reply(200, { status: "invalid" });
    const t = await store.get("t/" + code, { type: "json" });
    if (!t) return reply(200, { status: "invalid" });
    return reply(200, {
      status: t.utilise ? "used" : "valid",
      ticket: { code: t.code, nom: t.nom, vendeur: t.vendeur, prix: priceOf(t) },
    });
  }

  // Contrôle du code d'accès commun pour tout le reste
  const expected = (process.env.ACCESS_CODE || "").trim();
  const given = (event.headers["x-access-code"] || "").trim();
  if (!expected || given !== expected) {
    return reply(401, { error: "Code d'accès incorrect." });
  }

  // Connexion : enregistre le vendeur pour qu'il apparaisse dans le tableau, même sans vente
  if (action === "check") {
    const name = String(body.vendeur || "").trim().slice(0, 40);
    if (name) {
      await store.setJSON("v/" + encodeURIComponent(name), { vendeur: name, vu: new Date().toISOString() });
    }
    return reply(200, { ok: true });
  }

  // Créer un billet après paiement en espèces
  if (action === "create") {
    const nom = String(body.nom || "").trim().slice(0, 80);
    const tel = String(body.tel || "").replace(/\D/g, "");
    const vendeur = String(body.vendeur || "").trim().slice(0, 40);
    const prix = Number(body.prix);
    if (!nom || tel.length < 8 || tel.length > 15) {
      return reply(400, { error: "Nom ou numéro WhatsApp invalide." });
    }
    if (!(prix > 0) || prix > 100000) {
      return reply(400, { error: "Prix invalide." });
    }
    let code;
    do {
      code = newCode();
    } while (await store.get("t/" + code, { type: "json" }));

    const ticket = { code, nom, tel, vendeur, prix, cree: new Date().toISOString(), envoye: false, utilise: null };
    await store.setJSON("t/" + code, ticket, { onlyIfNew: true });
    return reply(200, { ticket: pub(ticket) });
  }

  // Marquer un billet comme envoyé au client
  if (action === "sent") {
    const code = String(body.code || "").toUpperCase();
    const ticket = await store.get("t/" + code, { type: "json" });
    if (!ticket) return reply(404, { error: "Billet introuvable." });
    ticket.envoye = true;
    await store.setJSON("t/" + code, ticket);
    return reply(200, { ok: true });
  }

  // Valider l'entrée : un billet ne peut être validé qu'une seule fois
  if (action === "validate") {
    const code = String(body.code || "").toUpperCase();
    if (!/^[A-Z2-9]{10}$/.test(code)) return reply(200, { status: "invalid" });

    const key = "t/" + code;
    const current = await store.getWithMetadata(key, { type: "json" });
    if (!current || !current.data) return reply(200, { status: "invalid" });
    if (current.data.utilise) return reply(200, { status: "used", ticket: pub(current.data) });

    const updated = { ...current.data, utilise: new Date().toISOString() };
    try {
      await store.setJSON(key, updated, { onlyIfMatch: current.etag });
    } catch {
      // Un autre scanner vient de valider ce billet une seconde avant
      return reply(200, { status: "used", ticket: pub(current.data) });
    }
    return reply(200, { status: "valid", ticket: pub(updated) });
  }

  // Remise à zéro complète (billets et vendeurs) : demande la confirmation "EFFACER"
  if (action === "reset") {
    if (body.confirm !== "EFFACER") {
      return reply(400, { error: "Confirmation manquante." });
    }
    for (const prefix of ["t/", "v/"]) {
      const { blobs } = await store.list({ prefix });
      await Promise.all(blobs.map((b) => store.delete(b.key)));
    }
    return reply(200, { ok: true });
  }

  // Statistiques partagées : tous les vendeurs connectés et toutes les ventes
  if (action === "stats") {
    const ticketList = await store.list({ prefix: "t/" });
    const tickets = (await Promise.all(ticketList.blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);

    const sellerList = await store.list({ prefix: "v/" });
    const registered = (await Promise.all(sellerList.blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);

    const sellers = {};
    const ensure = (name) => (sellers[name] ??= { vendeur: name, vendus: 0, montant: 0, envoyes: 0, entrees: 0 });

    for (const v of registered) ensure(v.vendeur);

    let sent = 0;
    let used = 0;
    let total = 0;
    for (const t of tickets) {
      const s = ensure(t.vendeur || "Sans nom");
      s.vendus++;
      s.montant += priceOf(t);
      total += priceOf(t);
      if (t.envoye) { s.envoyes++; sent++; }
      if (t.utilise) { s.entrees++; used++; }
    }

    const recent = [...tickets]
      .sort((a, b) => String(b.cree).localeCompare(String(a.cree)))
      .slice(0, 500)
      .map(pub);

    return reply(200, {
      total: tickets.length,
      montant: total,
      envoyes: sent,
      entrees: used,
      vendeurs: Object.values(sellers).sort((a, b) => b.montant - a.montant || a.vendeur.localeCompare(b.vendeur)),
      recent,
    });
  }

  return reply(404, { error: "Action inconnue." });
}
