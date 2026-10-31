# Boutique de logiciels — guide de mise en ligne

Site de vente de vos propres logiciels : catalogue par rayons, recherche, fiches produit,
avis clients, panier, paiement Stripe, clés de licence générées automatiquement,
téléchargement réservé aux acheteurs, espace administrateur.

```
site/index.html                     le site (une seule page, à héberger n'importe où)
supabase/migrations/001_schema.sql  la base de données (tables, sécurité, stockage)
supabase/functions/
  create-checkout/   crée la page de paiement Stripe (prix lus dans la base)
  stripe-webhook/    paiement reçu → commande payée + clés de licence ; remboursement → licence révoquée
  download/          lien de téléchargement temporaire pour les clients ayant une licence
  license-verify/    vérification de clé appelée par VOS logiciels (activation par poste)
```

Sans configuration, le site tourne en **mode démonstration** (produits d'exemple).

---

## Étape 0 — Stripe : mettre l'activité à jour

Dashboard Stripe → **Settings → Business → Account details** :
- Industrie : *Software* (logiciels)
- Description : « Vente de logiciels développés par nous, livrés par téléchargement avec clé de licence »
- URL du site : l'adresse de votre future boutique

Ajoutez aussi sur le site (pied de page ou page dédiée) : conditions de vente, politique de remboursement,
e-mail de contact. Stripe les vérifie.

## Étape 1 — Créer le projet Supabase

1. supabase.com → **New project** (région conseillée : `eu-central-1`, la plus proche de Madagascar).
2. **SQL Editor** → collez tout `supabase/migrations/001_schema.sql` → **Run**.
3. **Authentication → URL Configuration** : *Site URL* = l'adresse de votre boutique.

## Étape 2 — Déployer les fonctions serveur

Sur votre Mac, dans le dossier du projet :

```bash
brew install supabase/tap/supabase
supabase login
supabase link --project-ref VOTRE_REF_PROJET

supabase functions deploy create-checkout
supabase functions deploy download
supabase functions deploy stripe-webhook --no-verify-jwt
supabase functions deploy license-verify --no-verify-jwt
```

## Étape 3 — Les secrets (à saisir vous-même, ne les partagez jamais)

```bash
supabase secrets set STRIPE_SECRET_KEY=sk_live_...      # Stripe → Developers → API keys
supabase secrets set SITE_URL=https://votre-boutique.com
supabase secrets set CURRENCY=usd
```

Puis Stripe → **Developers → Webhooks → Add endpoint** :
- URL : `https://VOTRE_REF_PROJET.supabase.co/functions/v1/stripe-webhook`
- Événements : `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`,
  `customer.subscription.updated`, `customer.subscription.deleted`

Copiez le *Signing secret* (`whsec_...`) :

```bash
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
```

> Commencez avec les clés **test** (`sk_test_...`) et la carte `4242 4242 4242 4242`.
> Passez en `sk_live_` seulement quand un achat test crée bien une licence.

## Étape 4 — Configurer et publier le site

Ouvrez `site/index.html`, en haut du script :

```js
const CONFIG = {
  SHOP_NAME: "Le nom de votre boutique",
  SUPABASE_URL: "https://VOTRE_REF_PROJET.supabase.co",
  SUPABASE_ANON_KEY: "eyJ...",   // Settings → API → anon / publishable (clé publique)
  CURRENCY: "usd",
  SUPPORT_EMAIL: "support@votre-boutique.com",
};
```

Hébergement gratuit possible : Netlify (glisser-déposer le dossier `site`), Cloudflare Pages, GitHub Pages.

## Étape 5 — Devenir administrateur

1. Créez votre compte sur le site (« Mon compte » → « Créer un compte »).
2. Supabase → SQL Editor :
   ```sql
   update public.profiles set is_admin = true where email = 'votre@email.com';
   ```
3. Rechargez le site : l'onglet **Administration** apparaît. Ajoutez vos logiciels
   (pochette, fichier d'installation, prix, licence à vie ou abonnement).

## Vérifier une licence depuis votre logiciel

```http
POST https://VOTRE_REF_PROJET.supabase.co/functions/v1/license-verify
Content-Type: application/json

{ "license_key": "ABCDE-FGHJK-LMNPQ-RSTUV", "product": "caisse-pro",
  "machine_id": "identifiant-unique-du-poste", "machine_name": "PC caisse 1" }
```

Réponse : `{"valid": true, ...}` ou `{"valid": false, "reason": "..."}`.
Une licence = 1 poste par défaut (colonne `max_activations` modifiable par licence).

## Fonctionnement d'un achat

1. Le client remplit son panier et clique « Payer ».
2. `create-checkout` relit les prix dans la base (impossible de les trafiquer), crée la commande et la page Stripe.
3. Le client paie chez Stripe.
4. Stripe prévient `stripe-webhook` → commande « payée » + une clé par licence achetée.
5. Le client voit ses clés dans « Mes licences » et télécharge le fichier (lien valable 5 minutes).
6. Remboursement total ou abonnement arrêté → licences révoquées automatiquement.
