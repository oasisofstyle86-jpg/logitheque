// Relie le compte Stripe à la boutique : vérifie la clé secrète, crée le webhook
// et enregistre son secret de signature. Réservé à l'administrateur.
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

const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "charge.refunded",
  "customer.subscription.updated",
  "customer.subscription.deleted",
] as const;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const user = await currentUser(req);
  if (!user) return json({ error: "Connectez-vous." }, 401);

  const db = adminClient();
  const { data: profile } = await db.from("profiles").select("is_admin").eq("id", user.id).maybeSingle();
  if (!profile?.is_admin) return json({ error: "Réservé à l'administrateur." }, 403);

  const { action } = await req.json().catch(() => ({ action: "status" }));
  const key = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  if (!key) {
    return json({ connected: false, step: "key", error: "La clé secrète Stripe n'est pas encore enregistrée dans Supabase (secret STRIPE_SECRET_KEY)." });
  }
  if (!/^(sk|rk)_(test|live)_/.test(key)) {
    return json({ connected: false, step: "key", error: "La valeur de STRIPE_SECRET_KEY ne ressemble pas à une clé secrète Stripe (elle doit commencer par sk_test_ ou sk_live_)." });
  }
  const mode = key.includes("_live_") ? "live" : "test";
  const secretName = `stripe_webhook_secret_${mode}`;
  const webhookUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/stripe-webhook`;

  const stripe = stripeClient();
  let account: { name: string; email: string | null; charges_enabled: boolean };
  try {
    const a = await stripe.accounts.retrieve();
    account = {
      name: a.settings?.dashboard?.display_name || a.business_profile?.name || a.email || a.id,
      email: a.email ?? null,
      charges_enabled: !!a.charges_enabled,
    };
  } catch (err) {
    return json({ connected: false, step: "key", error: `Stripe refuse la clé : ${(err as Error).message}` });
  }

  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
  const mine = endpoints.data.filter((e) => e.url === webhookUrl);
  const { data: saved } = await db.from("app_secrets").select("value").eq("name", secretName).maybeSingle();

  const linked = mine.some((e) => e.status === "enabled") && !!saved?.value;
  if (action !== "connect" || linked) {
    return json({ connected: linked, mode, account, webhook: linked ? webhookUrl : null });
  }

  // (Re)création du webhook : Stripe ne donne le secret de signature qu'à la création.
  for (const e of mine) await stripe.webhookEndpoints.del(e.id);
  const created = await stripe.webhookEndpoints.create({
    url: webhookUrl,
    enabled_events: [...WEBHOOK_EVENTS],
    description: "Logithèque : paiements et licences",
  });
  const { error } = await db.from("app_secrets").upsert({ name: secretName, value: created.secret!, updated_at: new Date().toISOString() });
  if (error) return json({ connected: false, error: error.message }, 500);

  return json({ connected: true, mode, account, webhook: webhookUrl });
});
