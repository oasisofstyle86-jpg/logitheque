// Vérification de licence appelée par VOS logiciels (au démarrage ou à l'activation).
// Déployer avec --no-verify-jwt.
//
// Requête  : POST { "license_key": "ABCDE-...", "product": "slug-du-logiciel",
//                   "machine_id": "identifiant-unique-du-poste", "machine_name": "PC-Bureau" }
// Réponse  : { "valid": true, "product": "...", "activations": 1, "max_activations": 1 }
//         ou { "valid": false, "reason": "..." }
import { adminClient, json } from "../_shared/common.ts";

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
