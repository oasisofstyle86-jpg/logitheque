-- =====================================================================
-- 003 : renforcement de la sécurité
--  - is_admin() déplacée dans un schéma privé (non exposé par l'API)
--  - chaque règle d'accès limitée au bon rôle (visiteur / client connecté)
--  - limite anti-spam sur le service client
--  - contrôles de longueur et de format
-- =====================================================================

-- ---------- Fonction administrateur dans un schéma privé ----------
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;
revoke all on function private.is_admin() from public, anon;
grant execute on function private.is_admin() to authenticated;

-- ---------- Catégories ----------
drop policy if exists "categories: admin" on public.categories;
create policy "categories: admin ajout" on public.categories for insert to authenticated with check (private.is_admin());
create policy "categories: admin maj"   on public.categories for update to authenticated using (private.is_admin()) with check (private.is_admin());
create policy "categories: admin suppr" on public.categories for delete to authenticated using (private.is_admin());

-- ---------- Produits ----------
drop policy if exists "produits: lecture" on public.products;
drop policy if exists "produits: admin" on public.products;
create policy "produits: lecture visiteur" on public.products for select to anon using (is_published);
create policy "produits: lecture client"   on public.products for select to authenticated using (is_published or private.is_admin());
create policy "produits: admin ajout" on public.products for insert to authenticated with check (private.is_admin());
create policy "produits: admin maj"   on public.products for update to authenticated using (private.is_admin()) with check (private.is_admin());
create policy "produits: admin suppr" on public.products for delete to authenticated using (private.is_admin());

-- ---------- Accès privé aux logiciels ----------
drop policy if exists "acces: acheteurs" on public.product_access;
drop policy if exists "acces: admin" on public.product_access;
create policy "acces: acheteurs" on public.product_access for select to authenticated
  using (private.is_admin() or exists (
    select 1 from public.licenses l
    where l.product_id = product_access.product_id and l.user_id = auth.uid() and l.status = 'active'));
create policy "acces: admin ajout" on public.product_access for insert to authenticated with check (private.is_admin());
create policy "acces: admin maj"   on public.product_access for update to authenticated using (private.is_admin()) with check (private.is_admin());
create policy "acces: admin suppr" on public.product_access for delete to authenticated using (private.is_admin());
alter table public.product_access drop constraint if exists product_access_url_https;
alter table public.product_access add constraint product_access_url_https
  check (access_url is null or (access_url ~ '^https://[^\s<>"]+$' and char_length(access_url) <= 500));

-- ---------- Profils ----------
drop policy if exists "profil: lecture" on public.profiles;
drop policy if exists "profil: maj nom" on public.profiles;
create policy "profil: lecture" on public.profiles for select to authenticated using (id = auth.uid() or private.is_admin());
create policy "profil: maj nom" on public.profiles for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid()
    and is_admin = (select p.is_admin from public.profiles p where p.id = auth.uid())
    and email is not distinct from (select p.email from public.profiles p where p.id = auth.uid()));
alter table public.profiles drop constraint if exists profiles_full_name_len;
alter table public.profiles add constraint profiles_full_name_len check (full_name is null or char_length(full_name) <= 120);

-- ---------- Commandes, lignes, licences, activations ----------
drop policy if exists "commandes: lecture" on public.orders;
create policy "commandes: lecture" on public.orders for select to authenticated using (user_id = auth.uid() or private.is_admin());

drop policy if exists "lignes: lecture" on public.order_items;
create policy "lignes: lecture" on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_items.order_id and (o.user_id = auth.uid() or private.is_admin())));

drop policy if exists "licences: lecture" on public.licenses;
drop policy if exists "licences: admin" on public.licenses;
create policy "licences: lecture" on public.licenses for select to authenticated using (user_id = auth.uid() or private.is_admin());
create policy "licences: admin"   on public.licenses for update to authenticated using (private.is_admin()) with check (private.is_admin());

drop policy if exists "activations: lecture" on public.license_activations;
drop policy if exists "activations: retrait" on public.license_activations;
create policy "activations: lecture" on public.license_activations for select to authenticated
  using (exists (select 1 from public.licenses l where l.id = license_id and (l.user_id = auth.uid() or private.is_admin())));
create policy "activations: retrait" on public.license_activations for delete to authenticated
  using (exists (select 1 from public.licenses l where l.id = license_id and (l.user_id = auth.uid() or private.is_admin())));

-- ---------- Avis ----------
drop policy if exists "avis: ecriture" on public.reviews;
drop policy if exists "avis: suppression" on public.reviews;
create policy "avis: ecriture" on public.reviews for insert to authenticated
  with check (user_id = auth.uid() and exists (
    select 1 from public.licenses l where l.user_id = auth.uid() and l.product_id = reviews.product_id and l.status = 'active'));
create policy "avis: suppression" on public.reviews for delete to authenticated using (user_id = auth.uid() or private.is_admin());
alter table public.reviews drop constraint if exists reviews_lengths;
alter table public.reviews add constraint reviews_lengths
  check ((author_name is null or char_length(author_name) <= 60) and (comment is null or char_length(comment) <= 1000));

-- ---------- Service client ----------
drop policy if exists "support: lecture" on public.support_tickets;
drop policy if exists "support: admin" on public.support_tickets;
create policy "support: lecture" on public.support_tickets for select to authenticated
  using ((user_id is not null and user_id = auth.uid()) or private.is_admin());
create policy "support: admin" on public.support_tickets for update to authenticated
  using (private.is_admin()) with check (private.is_admin());

-- Anti-spam : 5 messages par adresse e-mail par heure, 60 messages au total par heure
create or replace function private.support_rate_limit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.support_tickets
      where lower(email) = lower(new.email) and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'Trop de messages envoyés depuis cette adresse. Réessayez dans une heure.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.support_tickets where created_at > now() - interval '1 hour') >= 60 then
    raise exception 'Le service client reçoit beaucoup de messages. Réessayez plus tard ou écrivez par e-mail.' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function private.support_rate_limit() from public, anon, authenticated;
drop trigger if exists support_rate_limit on public.support_tickets;
create trigger support_rate_limit before insert on public.support_tickets
  for each row execute function private.support_rate_limit();

-- ---------- Stockage (images et fichiers d'installation) ----------
drop policy if exists "media: admin ecrit" on storage.objects;
drop policy if exists "media: admin maj" on storage.objects;
drop policy if exists "media: admin supprime" on storage.objects;
drop policy if exists "software: admin ecrit" on storage.objects;
drop policy if exists "software: admin maj" on storage.objects;
drop policy if exists "software: admin supprime" on storage.objects;
create policy "media: admin ecrit"       on storage.objects for insert to authenticated with check (bucket_id = 'media' and private.is_admin());
create policy "media: admin maj"         on storage.objects for update to authenticated using (bucket_id = 'media' and private.is_admin());
create policy "media: admin supprime"    on storage.objects for delete to authenticated using (bucket_id = 'media' and private.is_admin());
create policy "software: admin lecture"  on storage.objects for select to authenticated using (bucket_id = 'software' and private.is_admin());
create policy "software: admin ecrit"    on storage.objects for insert to authenticated with check (bucket_id = 'software' and private.is_admin());
create policy "software: admin maj"      on storage.objects for update to authenticated using (bucket_id = 'software' and private.is_admin());
create policy "software: admin supprime" on storage.objects for delete to authenticated using (bucket_id = 'software' and private.is_admin());

-- ---------- L'ancienne fonction publique n'est plus utilisée ----------
drop function if exists public.is_admin();

-- ---------- Réglages serveur : aucun accès depuis l'API ----------
revoke all on public.app_secrets from anon, authenticated;
