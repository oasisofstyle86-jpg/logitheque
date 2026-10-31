// Donne un lien de téléchargement temporaire (5 min) si le client possède une licence active.
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const user = await currentUser(req);
  if (!user) return json({ error: "Connectez-vous." }, 401);

  const { product_id } = await req.json().catch(() => ({}));
  if (!product_id) return json({ error: "Produit manquant" }, 400);

  const db = adminClient();
  const { data: lic } = await db
    .from("licenses").select("id")
    .eq("user_id", user.id).eq("product_id", product_id).eq("status", "active")
    .limit(1).maybeSingle();
  if (!lic) return json({ error: "Aucune licence active pour ce logiciel." }, 403);

  const { data: product } = await db.from("products").select("file_path, name").eq("id", product_id).single();
  if (!product?.file_path) return json({ error: "Fichier pas encore disponible. Contactez le support." }, 404);

  const { data, error } = await db.storage.from("software").createSignedUrl(product.file_path, 300, {
    download: true,
  });
  if (error) return json({ error: error.message }, 500);
  return json({ url: data.signedUrl });
});
