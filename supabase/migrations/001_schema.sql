-- =====================================================================
-- Boutique de logiciels — schéma Supabase
-- Tables : profiles, categories, products, orders, order_items,
--          licenses, reviews  + bucket privé "software" pour les fichiers
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Profils (un par utilisateur Supabase Auth) ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
-- Fonction interne du déclencheur : personne n'a besoin de l'appeler directement
revoke execute on function public.handle_new_user() from public, anon, authenticated;
-- is_admin() reste appelable : les règles de sécurité en ont besoin, et elle ne révèle
-- que le statut de la personne connectée.

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- ---------- Catégories ----------
create table if not exists public.categories (
  id        serial primary key,
  slug      text unique not null,
  name      text not null,
  icon      text,
  position  int not null default 0
);

-- ---------- Produits (logiciels) ----------
create table if not exists public.products (
  id               uuid primary key default gen_random_uuid(),
  slug             text unique not null,
  name             text not null,
  tagline          text,
  description      text,
  category_id      int references public.categories(id) on delete set null,
  price_cents      int not null check (price_cents >= 0),
  compare_at_cents int,                      -- ancien prix barré (promo)
  billing          text not null default 'one_time'
                   check (billing in ('one_time','monthly','yearly')),
  version          text,
  platforms        text[] not null default '{}',   -- {'Windows','macOS','Android'...}
  requirements     text,
  features         text[] not null default '{}',
  cover_url        text,
  screenshots      text[] not null default '{}',
  file_path        text,                     -- chemin dans le bucket privé "software"
  is_published     boolean not null default true,
  is_featured      boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists products_category_idx on public.products(category_id);
create index if not exists products_search_idx on public.products
  using gin (to_tsvector('french', coalesce(name,'') || ' ' || coalesce(tagline,'') || ' ' || coalesce(description,'')));

-- ---------- Commandes ----------
create table if not exists public.orders (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid references auth.users(id) on delete set null,
  email              text,
  status             text not null default 'pending'
                     check (status in ('pending','paid','refunded','failed')),
  total_cents        int not null default 0,
  currency           text not null default 'usd',
  stripe_session_id  text unique,
  stripe_payment_intent text,
  stripe_subscription_id text,
  created_at         timestamptz not null default now(),
  paid_at            timestamptz
);
create index if not exists orders_user_idx on public.orders(user_id);

create table if not exists public.order_items (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.orders(id) on delete cascade,
  product_id   uuid references public.products(id) on delete set null,
  product_name text not null,
  unit_cents   int not null,
  quantity     int not null default 1 check (quantity between 1 and 50)
);

-- ---------- Licences (générées après paiement) ----------
create table if not exists public.licenses (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete set null,
  order_id    uuid references public.orders(id) on delete cascade,
  product_id  uuid references public.products(id) on delete set null,
  license_key text unique not null,
  status      text not null default 'active' check (status in ('active','revoked')),
  activations int not null default 0,
  max_activations int not null default 1,
  created_at  timestamptz not null default now()
);
create index if not exists licenses_user_idx on public.licenses(user_id);

-- Postes sur lesquels une licence est activée (vérifiés par la fonction license-verify)
create table if not exists public.license_activations (
  id          uuid primary key default gen_random_uuid(),
  license_id  uuid not null references public.licenses(id) on delete cascade,
  machine_id  text not null,
  machine_name text,
  created_at  timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (license_id, machine_id)
);

-- ---------- Avis clients (seulement si le client a acheté) ----------
create table if not exists public.reviews (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  author_name text,
  rating      int not null check (rating between 1 and 5),
  comment     text,
  created_at  timestamptz not null default now(),
  unique (product_id, user_id)
);

-- Note moyenne par produit
create or replace view public.product_ratings
with (security_invoker = true) as
  select product_id, round(avg(rating)::numeric, 1) as avg_rating, count(*)::int as review_count
  from public.reviews group by product_id;

-- ---------- Sécurité (Row Level Security) ----------
alter table public.profiles    enable row level security;
alter table public.categories  enable row level security;
alter table public.products    enable row level security;
alter table public.orders      enable row level security;
alter table public.order_items enable row level security;
alter table public.licenses    enable row level security;
alter table public.reviews     enable row level security;
alter table public.license_activations enable row level security;

create policy "activations: lecture" on public.license_activations for select
  using (exists (select 1 from public.licenses l where l.id = license_id and (l.user_id = auth.uid() or public.is_admin())));
create policy "activations: retrait" on public.license_activations for delete
  using (exists (select 1 from public.licenses l where l.id = license_id and (l.user_id = auth.uid() or public.is_admin())));

-- profils : chacun lit le sien ; l'admin lit tout
create policy "profil: lecture" on public.profiles for select
  using (id = auth.uid() or public.is_admin());
create policy "profil: maj nom" on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid() and is_admin = (select is_admin from public.profiles where id = auth.uid()));

-- catalogue : public en lecture, admin en écriture
create policy "categories: lecture" on public.categories for select using (true);
create policy "categories: admin"   on public.categories for all using (public.is_admin()) with check (public.is_admin());
create policy "produits: lecture"   on public.products for select using (is_published or public.is_admin());
create policy "produits: admin"     on public.products for all using (public.is_admin()) with check (public.is_admin());

-- commandes / licences : le client voit les siennes, l'admin tout.
-- Aucune écriture côté navigateur : seules les fonctions serveur (service role) écrivent.
create policy "commandes: lecture" on public.orders for select
  using (user_id = auth.uid() or public.is_admin());
create policy "lignes: lecture" on public.order_items for select
  using (exists (select 1 from public.orders o where o.id = order_id and (o.user_id = auth.uid() or public.is_admin())));
create policy "licences: lecture" on public.licenses for select
  using (user_id = auth.uid() or public.is_admin());
create policy "licences: admin" on public.licenses for update
  using (public.is_admin()) with check (public.is_admin());

-- avis : lecture publique ; écriture si le client possède une licence du produit
create policy "avis: lecture" on public.reviews for select using (true);
create policy "avis: ecriture" on public.reviews for insert
  with check (user_id = auth.uid() and exists (
    select 1 from public.licenses l where l.user_id = auth.uid() and l.product_id = reviews.product_id and l.status = 'active'));
create policy "avis: suppression" on public.reviews for delete
  using (user_id = auth.uid() or public.is_admin());

-- ---------- Stockage ----------
-- "software" : privé (fichiers d'installation, téléchargés via lien signé)
-- "media"    : public (images, captures d'écran)
insert into storage.buckets (id, name, public) values ('software','software', false)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('media','media', true)
  on conflict (id) do nothing;

create policy "media: lecture publique" on storage.objects for select using (bucket_id = 'media');
create policy "media: admin ecrit" on storage.objects for insert with check (bucket_id = 'media' and public.is_admin());
create policy "media: admin maj" on storage.objects for update using (bucket_id = 'media' and public.is_admin());
create policy "media: admin supprime" on storage.objects for delete using (bucket_id = 'media' and public.is_admin());
create policy "software: admin ecrit" on storage.objects for insert with check (bucket_id = 'software' and public.is_admin());
create policy "software: admin maj" on storage.objects for update using (bucket_id = 'software' and public.is_admin());
create policy "software: admin supprime" on storage.objects for delete using (bucket_id = 'software' and public.is_admin());

-- ---------- Catégories de départ ----------
insert into public.categories (slug, name, icon, position) values
  ('gestion',      'Gestion & Comptabilité', '📊', 1),
  ('education',    'Éducation & Formation',  '🎓', 2),
  ('commerce',     'Commerce & Caisse',      '🛒', 3),
  ('productivite', 'Productivité',           '⚡', 4),
  ('mobile',       'Applications mobiles',   '📱', 5),
  ('outils-dev',   'Outils développeurs',    '🧩', 6)
on conflict (slug) do nothing;
