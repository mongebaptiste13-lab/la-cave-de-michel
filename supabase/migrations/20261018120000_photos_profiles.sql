-- Photos de bouteilles, photos de profil et prénoms.
-- À appliquer après le premier script (éditeur SQL de Supabase).

-- 1. Chemin de la photo sur chaque bouteille (vide = illustration de référence)
alter table public.bottles add column if not exists photo_path text;

-- 2. Profils (prénom + photo)
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) <= 60),
  avatar_path text,
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

create or replace function public.shares_cellar_with(p_user uuid)
returns boolean language sql security definer stable set search_path = ''
as $$
  select exists (
    select 1 from public.cellar_members a
    join public.cellar_members b on a.cellar_id = b.cellar_id
    where a.user_id = (select auth.uid()) and b.user_id = p_user
  );
$$;
revoke all on function public.shares_cellar_with(uuid) from public, anon;
grant execute on function public.shares_cellar_with(uuid) to authenticated;

create policy profiles_select on public.profiles for select to authenticated
  using (user_id = (select auth.uid()) or public.shares_cellar_with(user_id));
create policy profiles_insert on public.profiles for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy profiles_update on public.profiles for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- 3. Fonctions d'accès aux fichiers (le premier dossier du chemin est l'identifiant de la cave ou de la personne)
create or replace function public.can_access_cellar_file(p_name text)
returns boolean language plpgsql stable security definer set search_path = ''
as $$
declare v uuid;
begin
  begin
    v := ((storage.foldername(p_name))[1])::uuid;
  exception when others then
    return false;
  end;
  return public.is_member(v);
end $$;
revoke all on function public.can_access_cellar_file(text) from public, anon;
grant execute on function public.can_access_cellar_file(text) to authenticated;

create or replace function public.can_read_avatar_file(p_name text)
returns boolean language plpgsql stable security definer set search_path = ''
as $$
declare v uuid;
begin
  begin
    v := ((storage.foldername(p_name))[1])::uuid;
  exception when others then
    return false;
  end;
  return v = (select auth.uid()) or public.shares_cellar_with(v);
end $$;
revoke all on function public.can_read_avatar_file(text) from public, anon;
grant execute on function public.can_read_avatar_file(text) to authenticated;

-- 4. Dossiers de stockage privés (photos limitées à 2 Mo, avatars à 1 Mo)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('bottle-photos', 'bottle-photos', false, 2097152, array['image/jpeg', 'image/png', 'image/webp']),
  ('avatars', 'avatars', false, 1048576, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy bottle_photos_select on storage.objects for select to authenticated
  using (bucket_id = 'bottle-photos' and public.can_access_cellar_file(name));
create policy bottle_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'bottle-photos' and public.can_access_cellar_file(name));
create policy bottle_photos_update on storage.objects for update to authenticated
  using (bucket_id = 'bottle-photos' and public.can_access_cellar_file(name))
  with check (bucket_id = 'bottle-photos' and public.can_access_cellar_file(name));
create policy bottle_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'bottle-photos' and public.can_access_cellar_file(name));

create policy avatars_select on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and public.can_read_avatar_file(name));
create policy avatars_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy avatars_update on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy avatars_delete on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- 5. L'annulation d'un retrait remet aussi la photo
create or replace function public.restore_history(p_history uuid)
returns void language plpgsql set search_path = ''
as $$
declare h public.history%rowtype; s jsonb;
begin
  select * into h from public.history where id = p_history for update;
  if not found then raise exception 'Entrée introuvable'; end if;
  if h.bottle_id is not null and exists (select 1 from public.bottles where id = h.bottle_id) then
    update public.bottles set qty = qty + h.qty, updated_at = now() where id = h.bottle_id;
  else
    s := coalesce(h.snapshot, '{}'::jsonb);
    insert into public.bottles(id, cellar_id, name, domaine, vintage, type, region, qty,
                               price, apogee, place, description, photo_path)
    values (coalesce(h.bottle_id, gen_random_uuid()), h.cellar_id, h.name, h.domaine, h.vintage,
            h.type, h.region, h.qty, nullif(s->>'price', '')::numeric, nullif(s->>'apogee', '')::int,
            s->>'place', s->>'description', nullif(s->>'photo_path', ''));
  end if;
  delete from public.history where id = h.id;
end $$;
