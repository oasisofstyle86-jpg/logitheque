-- =====================================================================
-- 002 : fiches détaillées, livraison automatique, service client,
--       acceptation des conditions de vente
-- =====================================================================

-- ---------- Détails publics des logiciels ----------
alter table public.products
  add column if not exists included      text[] not null default '{}',  -- ce que l'acheteur reçoit
  add column if not exists delivery_info text,                          -- comment se passe la livraison
  add column if not exists language      text not null default 'Français',
  add column if not exists faq           jsonb  not null default '[]';  -- [{ "q": "...", "a": "..." }]

-- ---------- Accès privé (lien + instructions), visible seulement par les acheteurs ----------
create table if not exists public.product_access (
  product_id   uuid primary key references public.products(id) on delete cascade,
  access_url   text,
  instructions text,
  updated_at   timestamptz not null default now()
);
alter table public.product_access enable row level security;

create policy "acces: acheteurs" on public.product_access for select
  using (public.is_admin() or exists (
    select 1 from public.licenses l
    where l.product_id = product_access.product_id and l.user_id = auth.uid() and l.status = 'active'));
create policy "acces: admin" on public.product_access for all
  using (public.is_admin()) with check (public.is_admin());

-- ---------- Service client ----------
create table if not exists public.support_tickets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete set null,
  name        text not null check (char_length(name) between 1 and 120),
  email       text not null check (char_length(email) between 3 and 200 and email like '%@%'),
  topic       text not null default 'question'
              check (topic in ('question','avant-achat','paiement','licence','installation','remboursement','autre')),
  order_ref   text check (order_ref is null or char_length(order_ref) <= 80),
  message     text not null check (char_length(message) between 5 and 4000),
  status      text not null default 'open' check (status in ('open','answered','closed')),
  reply       text check (reply is null or char_length(reply) <= 4000),
  replied_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists support_user_idx on public.support_tickets(user_id);
create index if not exists support_status_idx on public.support_tickets(status, created_at desc);
alter table public.support_tickets enable row level security;

-- tout visiteur peut écrire (connecté ou non) ; un client connecté ne peut écrire qu'en son nom
create policy "support: envoi" on public.support_tickets for insert to anon, authenticated
  with check (
    status = 'open' and reply is null and replied_at is null
    and (user_id is null or user_id = auth.uid()));
-- le client voit ses propres demandes et les réponses ; l'admin voit tout
create policy "support: lecture" on public.support_tickets for select
  using ((user_id is not null and user_id = auth.uid()) or public.is_admin());
create policy "support: admin" on public.support_tickets for update
  using (public.is_admin()) with check (public.is_admin());

-- ---------- Preuve d'acceptation des conditions (utile en cas de contestation) ----------
alter table public.orders
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists terms_version     text;
