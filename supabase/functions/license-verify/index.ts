// Vérification de licence appelée par VOS logiciels (au démarrage ou à l'activation).
// Déployer avec --no-verify-jwt.
//
// Requête  : POST { "license_key": "ABCDE-...", "product": "slug-du-logiciel",
//                   "machine_id": "identifiant-unique-du-poste", "machine_name": "PC-Bureau" }
// Réponse  : { "valid": true, "product": "...", "activations": 1, "max_activations": 1 }
//         ou { "valid": false, "reason": "..." }
// ---- fichier autonome : copier-coller tel quel dans l'éditeur Supabase ----
// Outils partagés par les fonctions serveur
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";

export const corsHeaders = {
  "Access-Control-Allow-Origin": (() => { try { return new URL(Deno.env.get("SITE_URL") ?? "https://oasisofstyle86-jpg.github.io/logitheque").origin; } catch { return "*"; } })(),
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Client avec tous les droits (clé service) — uniquement côté serveur. */
export function adminClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

/** Retrouve l'utilisateur connecté à partir de l'en-tête Authorization. */
export async function currentUser(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  if (!token) return null;
  const { data, error } = await adminClient().auth.getUser(token);
  if (error) return null;
  return data.user;
}

export function stripeClient() {
  return new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

/** Clé de licence lisible : XXXXX-XXXXX-XXXXX-XXXXX (sans 0/O/1/I). */
export function newLicenseKey(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join("")).join("-");
}

// ---- code de la fonction ----

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const { license_key, product, machine_id, machine_name } = await req.json().catch(() => ({}));
  if (!license_key || !product || !machine_id) {
    return json({ valid: false, reason: "license_key, product et machine_id sont requis" }, 400);
  }

  const db = adminClient();
  const { data: lic } = await db
    .from("licenses")
    .select("id, status, max_activations, products!inner(slug, name)")
    .eq("license_key", String(license_key).trim().toUpperCase())
    .eq("products.slug", product)
    .maybeSingle();

  if (!lic) return json({ valid: false, reason: "Clé inconnue pour ce logiciel" });
  if (lic.status !== "active") return json({ valid: false, reason: "Licence révoquée ou abonnement terminé" });

  const { data: existing } = await db
    .from("license_activations").select("id").eq("license_id", lic.id).eq("machine_id", machine_id).maybeSingle();

  if (existing) {
    await db.from("license_activations").update({ last_seen_at: new Date().toISOString() }).eq("id", existing.id);
  } else {
    const { count } = await db
      .from("license_activations").select("id", { count: "exact", head: true }).eq("license_id", lic.id);
    if ((count ?? 0) >= lic.max_activations) {
      return json({ valid: false, reason: `Licence déjà activée sur ${lic.max_activations} poste(s). Libérez un poste depuis votre compte.` });
    }
    await db.from("license_activations").insert({ license_id: lic.id, machine_id, machine_name });
  }

  const { count: activations } = await db
    .from("license_activations").select("id", { count: "exact", head: true }).eq("license_id", lic.id);
  await db.from("licenses").update({ activations: activations ?? 0 }).eq("id", lic.id);

  // deno-lint-ignore no-explicit-any
  const p = (lic as any).products;
  return new Response(
    JSON.stringify({ valid: true, product: p.name, activations, max_activations: lic.max_activations }),
    { headers: { ...cors, "Content-Type": "application/json" } },
  );
});
