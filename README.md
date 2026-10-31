# Boutique de logiciels — installation pas à pas (sans Terminal)

Tout se fait dans le navigateur. Durée : environ 45 minutes.

```
docs/index.html                     le site (publié par GitHub Pages)
supabase/migrations/001_schema.sql  la base de données
supabase/functions/<nom>/index.ts   4 fonctions serveur, chacune à copier-coller telle quelle
```

Gardez un bloc-notes ouvert : vous allez noter 5 valeurs (A à E).

---

## Partie 1 — GitHub : mettre le code en ligne

1. Décompressez `boutique-logiciels.zip` sur votre Mac (double-clic).
2. Connectez-vous à github.com avec votre **nouveau compte**.
3. En haut à droite **+ → New repository**.
   - Repository name : `boutique` (ou un autre nom, sans espace)
   - Cochez **Public** (obligatoire pour GitHub Pages gratuit ; aucune clé secrète n'est dans le code)
   - Cliquez **Create repository**.
4. Sur la page du dépôt vide, cliquez le lien **uploading an existing file**.
5. Ouvrez le dossier `boutique-logiciels` dans le Finder, sélectionnez **son contenu**
   (`docs`, `supabase`, `README.md`) et glissez-le dans la page. Attendez la fin de l'envoi.
6. En bas : **Commit changes**.
7. **Settings → Pages** (menu de gauche) :
   - Source : *Deploy from a branch*
   - Branch : `main` / dossier **`/docs`** → **Save**
8. Après 1 à 2 minutes, l'adresse du site s'affiche en haut de cette page :
   `https://VOTRE-NOM.github.io/boutique/` → **notez-la (A)**.
   Ouvrez-la : le site s'affiche en mode démonstration. C'est normal à ce stade.

## Partie 2 — Supabase : la base de données

1. supabase.com → connectez-vous avec le **nouveau compte** → **New project**.
   - Name : `boutique-logiciels`
   - Database password : cliquez *Generate*, gardez-le de côté
   - Region : **Central EU (Frankfurt)**
   - **Create new project**, attendez 2 minutes.
2. Menu de gauche **SQL Editor** → **New query**.
   Sur GitHub, ouvrez `supabase/migrations/001_schema.sql`, cliquez l'icône **Copy raw file**,
   collez dans l'éditeur → **Run**. Résultat attendu : *Success. No rows returned*.
3. **Project Settings → API Keys** :
   - onglet **Legacy API keys** → copiez la clé **anon public** (commence par `eyJ`) → **(B)**
4. **Project Settings → Data API** (ou *General*) : copiez la **Project URL**
   `https://xxxxxxxx.supabase.co` → **(C)**
5. **Authentication → URL Configuration** :
   - Site URL : collez **(A)**
   - Redirect URLs → **Add URL** : collez **(A)** encore → **Save**

## Partie 3 — Supabase : les 4 fonctions serveur

Pour **chacune** des fonctions ci-dessous :

1. Menu **Edge Functions → Deploy a new function → Via Editor**.
2. Nom de la fonction : exactement celui du tableau.
3. Effacez le code d'exemple. Sur GitHub, ouvrez `supabase/functions/<nom>/index.ts`,
   **Copy raw file**, collez → **Deploy function**.
4. Pour les deux marquées « Non » : ouvrez la fonction → **Details** (ou *Settings*) →
   désactivez **Verify JWT with legacy secret / Enforce JWT verification** → **Save**.

| Nom exact          | Vérification JWT |
|--------------------|------------------|
| `create-checkout`  | Oui (laisser)    |
| `download`         | Oui (laisser)    |
| `stripe-webhook`   | **Non**          |
| `license-verify`   | **Non**          |

## Partie 4 — Stripe

1. dashboard.stripe.com → **Settings → Business → Account details** :
   industrie *Software*, description « Vente de logiciels développés par nous, livrés par
   téléchargement avec clé de licence », site web **(A)**.
2. Activez le **mode Test** (interrupteur en haut à droite).
3. **Developers → API keys** → *Secret key* `sk_test_...` → **(D)**.
   Ne l'envoyez à personne, ne la mettez jamais dans GitHub.
4. **Developers → Webhooks → Add endpoint** :
   - Endpoint URL : `(C)/functions/v1/stripe-webhook`
     (ex. `https://xxxxxxxx.supabase.co/functions/v1/stripe-webhook`)
   - **Select events**, cochez :
     `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
     `checkout.session.async_payment_failed`, `checkout.session.expired`,
     `charge.refunded`, `customer.subscription.updated`, `customer.subscription.deleted`
   - **Add endpoint**, puis **Signing secret → Reveal** → `whsec_...` → **(E)**

## Partie 5 — Les secrets dans Supabase

**Edge Functions → Secrets** (ou *Project Settings → Edge Functions*) → ajoutez :

| Name                    | Value                         |
|-------------------------|-------------------------------|
| `STRIPE_SECRET_KEY`     | (D)                           |
| `STRIPE_WEBHOOK_SECRET` | (E)                           |
| `SITE_URL`              | (A) **sans** le `/` final     |
| `CURRENCY`              | `gbp`                         |

→ **Save**. (`SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` sont déjà fournis par Supabase.)

## Partie 6 — Relier le site à Supabase

1. Sur GitHub, ouvrez `docs/index.html` → icône **crayon** (Edit).
2. Cherchez `const CONFIG` (Cmd+F) et remplissez :
   ```js
   SHOP_NAME: "Le nom de votre boutique",
   SUPABASE_URL: "(C)",
   SUPABASE_ANON_KEY: "(B)",
   CURRENCY: "usd",          // la même que le secret CURRENCY
   SUPPORT_EMAIL: "votre e-mail de contact",
   ```
3. **Commit changes**. Attendez 1 minute, rechargez **(A)** :
   la bande orange « Mode démonstration » a disparu et le catalogue est vide.

## Partie 7 — Devenir administrateur et ajouter un logiciel

1. Sur le site : **Mon compte → Créer un compte**, confirmez avec le lien reçu par e-mail.
2. Supabase → **SQL Editor** :
   ```sql
   update public.profiles set is_admin = true where email = 'votre@email.com';
   ```
3. Rechargez le site → **Mon espace → Administration → Ajouter un logiciel**.
   Fichier d'installation : 50 Mo maximum sur l'offre gratuite de Supabase.

## Partie 8 — Test d'achat, puis passage en réel

1. Achetez votre logiciel avec la carte `4242 4242 4242 4242`, date future, CVC `123`.
2. Vérifiez : la licence apparaît dans **Mes licences**, le bouton **Télécharger** fonctionne.
3. Quand tout marche : refaites la **Partie 4** en mode **Live** (clé `sk_live_...`,
   nouveau webhook, nouveau `whsec_...`) et remplacez les deux secrets de la **Partie 5**.

---

## En cas de problème

| Symptôme | Cause probable |
|---|---|
| « Impossible de charger le catalogue » | (B) ou (C) mal copiés dans `docs/index.html` |
| Le bouton Payer affiche une erreur | Secret `STRIPE_SECRET_KEY` absent ou fonction `create-checkout` mal nommée |
| Paiement OK mais pas de licence | Webhook : mauvaise URL, `whsec_` incorrect, ou « Verify JWT » encore activé sur `stripe-webhook`. Regardez Stripe → Webhooks → l'endpoint → *Event deliveries* |
| Le lien de confirmation d'e-mail mène à une page d'erreur | Partie 2, étape 5 |
| « Fichier pas encore disponible » | Aucun fichier d'installation envoyé pour ce logiciel |

## Vérifier une licence depuis votre logiciel

```http
POST (C)/functions/v1/license-verify
Content-Type: application/json

{ "license_key": "ABCDE-FGHJK-LMNPQ-RSTUV", "product": "adresse-de-la-fiche",
  "machine_id": "identifiant-unique-du-poste", "machine_name": "PC caisse 1" }
```

Réponse : `{"valid": true, ...}` ou `{"valid": false, "reason": "..."}`. Une licence = 1 poste par défaut.
