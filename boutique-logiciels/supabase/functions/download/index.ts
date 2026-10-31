// Donne un lien de téléchargement temporaire (5 min) si le client possède une licence active.
import { adminClient, corsHeaders, currentUser, json } from "../_shared/common.ts";

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
