// Reçoit les notifications de Stripe (paiement réussi, remboursement, fin d'abonnement)
// et met à jour les commandes + crée/révoque les licences.
// À déployer SANS vérification JWT (Stripe n'envoie pas de jeton Supabase) :
//   supabase functions deploy stripe-webhook --no-verify-jwt
// ---- fichier autonome : copier-coller tel quel dans l'éditeur Supabase ----
// Outils partagés par les fonctions serveur
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17";

export const corsHeaders = {
  "Access-Control-Allow-Origin": (() => { try { return new URL(Deno.env.get("SITE_URL")!).origin; } catch { return "*"; } })(),
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

const stripe = stripeClient();
const cryptoProvider = Stripe.createSubtleCryptoProvider();

Deno.serve(async (req) => {
  const signature = req.headers.get("Stripe-Signature");
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature!,
      Deno.env.get("STRIPE_WEBHOOK_SECRET")!,
      undefined,
      cryptoProvider,
    );
  } catch (err) {
    return new Response(`Signature invalide : ${(err as Error).message}`, { status: 400 });
  }

  const db = adminClient();

  try {
    switch (event.type) {
      // Paiement validé → commande payée + licences
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const s = event.data.object as Stripe.Checkout.Session;
        if (s.payment_status !== "paid" && s.payment_status !== "no_payment_required") break;
        const orderId = s.metadata?.order_id ?? s.client_reference_id;
        if (!orderId) break;

        // Mise à jour conditionnelle : si Stripe envoie l'événement deux fois,
        // une seule exécution passe la commande en "paid" et crée les licences.
        const { data: updated } = await db.from("orders").update({
          status: "paid",
          paid_at: new Date().toISOString(),
          total_cents: s.amount_total ?? undefined,
          stripe_payment_intent: typeof s.payment_intent === "string" ? s.payment_intent : null,
          stripe_subscription_id: typeof s.subscription === "string" ? s.subscription : null,
        }).eq("id", orderId).in("status", ["pending", "failed"]).select("id, user_id");
        const order = updated?.[0];
        if (!order) break; // déjà traité

        const { data: items } = await db
          .from("order_items").select("product_id, quantity").eq("order_id", orderId);
        const licenses = (items ?? []).flatMap((it) =>
          Array.from({ length: it.quantity }, () => ({
            user_id: order.user_id,
            order_id: orderId,
            product_id: it.product_id,
            license_key: newLicenseKey(),
          }))
        );
        if (licenses.length) await db.from("licenses").insert(licenses);
        break;
      }

      case "checkout.session.async_payment_failed":
      case "checkout.session.expired": {
        const s = event.data.object as Stripe.Checkout.Session;
        const orderId = s.metadata?.order_id ?? s.client_reference_id;
        if (orderId) await db.from("orders").update({ status: "failed" }).eq("id", orderId).eq("status", "pending");
        break;
      }

      // Remboursement → licences révoquées
      case "charge.refunded": {
        const c = event.data.object as Stripe.Charge;
        if (!c.refunded) break; // remboursement partiel : on ne touche à rien
        const pi = typeof c.payment_intent === "string" ? c.payment_intent : c.payment_intent?.id;
        const { data: order } = await db.from("orders").select("id").eq("stripe_payment_intent", pi).maybeSingle();
        if (order) {
          await db.from("orders").update({ status: "refunded" }).eq("id", order.id);
          await db.from("licenses").update({ status: "revoked" }).eq("order_id", order.id);
        }
        break;
      }

      // Abonnement arrêté → licences révoquées ; abonnement relancé → réactivées
      case "customer.subscription.deleted":
      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const { data: order } = await db.from("orders").select("id").eq("stripe_subscription_id", sub.id).maybeSingle();
        if (!order) break;
        const active = ["active", "trialing", "past_due"].includes(sub.status);
        await db.from("licenses").update({ status: active ? "active" : "revoked" }).eq("order_id", order.id);
        break;
      }
    }
  } catch (err) {
    console.error(err);
    return new Response("Erreur de traitement", { status: 500 }); // Stripe réessaiera
  }

  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
