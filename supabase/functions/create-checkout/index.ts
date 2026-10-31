// Crée une commande "pending" puis une page de paiement Stripe Checkout.
// Les prix viennent TOUJOURS de la base, jamais du navigateur.
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

const CURRENCY = (Deno.env.get("CURRENCY") ?? "eur").toLowerCase();
const SITE_URL = Deno.env.get("SITE_URL") ?? "https://oasisofstyle86-jpg.github.io/logitheque";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);

  const user = await currentUser(req);
  if (!user) return json({ error: "Connectez-vous pour acheter." }, 401);

  let items: { product_id: string; quantity?: number }[];
  try {
    ({ items } = await req.json());
  } catch {
    return json({ error: "Requête invalide" }, 400);
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > 30) {
    return json({ error: "Panier vide ou trop grand" }, 400);
  }

  const db = adminClient();
  const ids = [...new Set(items.map((i) => i.product_id))];
  const { data: products, error } = await db
    .from("products")
    .select("id, name, tagline, price_cents, billing, cover_url, is_published")
    .in("id", ids);
  if (error) return json({ error: error.message }, 500);

  const byId = new Map(products!.filter((p) => p.is_published).map((p) => [p.id, p]));
  const lines = items.map((i) => ({
    product: byId.get(i.product_id),
    quantity: Math.min(Math.max(Math.floor(i.quantity ?? 1), 1), 50),
  }));
  if (lines.some((l) => !l.product)) return json({ error: "Un produit n'est plus disponible." }, 400);

  // Stripe n'autorise pas un abonnement et un achat unique dans le même paiement.
  const subs = lines.filter((l) => l.product!.billing !== "one_time");
  if (subs.length > 0 && lines.length > 1) {
    return json({ error: "Un abonnement doit être acheté seul. Retirez les autres articles du panier." }, 400);
  }
  const mode = subs.length ? "subscription" : "payment";

  const total = lines.reduce((s, l) => s + l.product!.price_cents * l.quantity, 0);

  // 1) Commande en attente
  const { data: order, error: oErr } = await db
    .from("orders")
    .insert({ user_id: user.id, email: user.email, total_cents: total, currency: CURRENCY })
    .select("id")
    .single();
  if (oErr) return json({ error: oErr.message }, 500);

  await db.from("order_items").insert(
    lines.map((l) => ({
      order_id: order.id,
      product_id: l.product!.id,
      product_name: l.product!.name,
      unit_cents: l.product!.price_cents,
      quantity: l.quantity,
    })),
  );

  // 2) Session Stripe
  const stripe = stripeClient();
  const session = await stripe.checkout.sessions.create({
    mode,
    customer_email: user.email,
    client_reference_id: order.id,
    metadata: { order_id: order.id, user_id: user.id },
    ...(mode === "subscription"
      ? { subscription_data: { metadata: { order_id: order.id, user_id: user.id } } }
      : { payment_intent_data: { metadata: { order_id: order.id, user_id: user.id } } }),
    line_items: lines.map((l) => ({
      quantity: l.quantity,
      price_data: {
        currency: CURRENCY,
        unit_amount: l.product!.price_cents,
        product_data: {
          name: l.product!.name,
          ...(l.product!.tagline ? { description: l.product!.tagline } : {}),
          ...(l.product!.cover_url?.startsWith("https://") ? { images: [l.product!.cover_url] } : {}),
          metadata: { product_id: l.product!.id },
        },
        ...(l.product!.billing !== "one_time"
          ? { recurring: { interval: l.product!.billing === "monthly" ? "month" : "year" } }
          : {}),
      },
    })),
    success_url: `${SITE_URL}/#merci`,
    cancel_url: `${SITE_URL}/#panier`,
    allow_promotion_codes: true,
  });

  await db.from("orders").update({ stripe_session_id: session.id }).eq("id", order.id);
  return json({ url: session.url });
});
