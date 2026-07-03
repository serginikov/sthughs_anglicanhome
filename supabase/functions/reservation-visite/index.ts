// Edge Function : réservation de visite depuis le site public.
// Reçoit le formulaire, valide, garde une copie locale puis transmet
// à l'app médicale via webhook sécurisé (x-webhook-secret).
// Secrets requis : WEBHOOK_SECRET, MEDICAL_WEBHOOK_URL.

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CRENEAUX = ["matin", "apres_midi"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TEL_RE = /^[+\d][\d\s().-]{6,}$/;
const RATE_LIMIT = 3; // demandes max par IP par heure

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });

  let p: Record<string, unknown>;
  try {
    p = await req.json();
  } catch {
    return reply(400, { error: "bad_json" });
  }

  // Honeypot : un humain ne remplit jamais ce champ caché.
  // Rejet silencieux : on répond comme si tout allait bien.
  if (String(p.website ?? "").trim() !== "") {
    return reply(200, { ok: true });
  }

  const prenom = String(p.prenom ?? "").trim();
  const nom = String(p.nom ?? "").trim();
  const email = String(p.email ?? "").trim().toLowerCase();
  const telephone = String(p.telephone ?? "").trim();
  const residentSaisi = String(p.resident_saisi ?? "").trim();
  const lienParente = String(p.lien_parente ?? "").trim() || null;
  const dateVisite = String(p.date_visite ?? "").trim();
  const creneau = String(p.creneau ?? "").trim();
  const nbVisiteurs = Number(p.nb_visiteurs ?? 1);
  const message = String(p.message ?? "").trim() || null;

  if (!prenom || !nom || !email || !telephone || !residentSaisi || !dateVisite || !creneau) {
    return reply(400, { error: "missing_fields" });
  }
  if (!EMAIL_RE.test(email)) return reply(400, { error: "bad_email" });
  if (!TEL_RE.test(telephone)) return reply(400, { error: "bad_phone" });
  if (!CRENEAUX.includes(creneau)) return reply(400, { error: "bad_slot" });
  if (!Number.isInteger(nbVisiteurs) || nbVisiteurs < 1 || nbVisiteurs > 6) {
    return reply(400, { error: "bad_visitors" });
  }

  const d = new Date(dateVisite + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (isNaN(d.getTime()) || d <= today) return reply(400, { error: "bad_date" });
  const day = d.getDay();
  if (day === 0 || day === 6) return reply(400, { error: "weekday_only" });

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Rate limit par IP
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "inconnue";
  const uneHeure = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await db
    .from("demandes_visite_site")
    .select("id", { count: "exact", head: true })
    .eq("ip", ip)
    .gte("created_at", uneHeure);
  if ((count ?? 0) >= RATE_LIMIT) {
    return reply(429, { error: "rate_limited" });
  }

  // Copie locale d'abord : la demande n'est jamais perdue
  const { data: copie, error: insErr } = await db
    .from("demandes_visite_site")
    .insert({
      prenom, nom, email, telephone,
      resident_saisi: residentSaisi,
      lien_parente: lienParente,
      date_visite: dateVisite,
      creneau,
      nb_visiteurs: nbVisiteurs,
      message,
      ip,
      statut_transmission: "transmise",
    })
    .select("id")
    .single();
  if (insErr) return reply(500, { error: "storage_failed" });

  // Transmission à l'app médicale
  const url = Deno.env.get("MEDICAL_WEBHOOK_URL");
  const secret = Deno.env.get("WEBHOOK_SECRET");
  if (!url || !secret) {
    await db.from("demandes_visite_site")
      .update({ statut_transmission: "echec_transmission", erreur: "secrets non configurés" })
      .eq("id", copie.id);
    return reply(200, { ok: true }); // le visiteur n'y peut rien
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-webhook-secret": secret },
      body: JSON.stringify({
        demandeur_prenom: prenom,
        demandeur_nom: nom,
        demandeur_email: email,
        demandeur_telephone: telephone,
        resident_saisi: residentSaisi,
        lien_parente: lienParente,
        date_visite: dateVisite,
        creneau,
        nb_visiteurs: nbVisiteurs,
        message,
      }),
    });

    if (res.status === 409) {
      await db.from("demandes_visite_site")
        .update({ statut_transmission: "doublon" })
        .eq("id", copie.id);
      return reply(409, { error: "duplicate" });
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
  } catch (e) {
    await db.from("demandes_visite_site")
      .update({ statut_transmission: "echec_transmission", erreur: String(e) })
      .eq("id", copie.id);
    console.error("Transmission app médicale échouée:", e);
    // Copie conservée : succès pour le visiteur, rattrapage manuel possible
  }

  return reply(200, { ok: true });
});
