-- La cave de Michel : schéma, sécurité (RLS) et fonctions.
-- À appliquer une seule fois (éditeur SQL de Supabase, ou `supabase db push`).

create table public.cellars (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'La cave de Michel',
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.cellar_members (
  cellar_id uuid not null references public.cellars(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  created_at timestamptz not null default now(),
  primary key (cellar_id, user_id)
);
create index cellar_members_user_idx on public.cellar_members(user_id);

create table public.bottles (
  id uuid primary key default gen_random_uuid(),
  cellar_id uuid not null references public.cellars(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  domaine text,
  vintage int check (vintage is null or vintage between 1800 and 2100),
  type text not null default 'autre' check (type in ('rouge','blanc','rose','bulles','liquoreux','autre')),
  region text,
  qty int not null default 1 check (qty >= 0),
  price numeric(10,2) check (price is null or price >= 0),
  apogee int check (apogee is null or apogee between 1900 and 2200),
  place text,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index bottles_cellar_idx on public.bottles(cellar_id);

create table public.history (
  id uuid primary key default gen_random_uuid(),
  cellar_id uuid not null references public.cellars(id) on delete cascade,
  bottle_id uuid,
  name text not null,
  domaine text,
  vintage int,
  type text not null default 'autre',
  region text,
  qty int not null check (qty > 0),
  reason text not null check (reason in ('bu','vendu','donne','abime','autre')),
  note text,
  sale_price numeric(10,2),
  est_price numeric(10,2),
  snapshot jsonb,
  at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
create index history_cellar_idx on public.history(cellar_id, at desc);

-- Compteur d'appels IA par personne et par jour (écrit seulement par la fonction serveur).
create table public.ai_usage (
  user_id uuid not null,
  day date not null,
  count int not null default 0,
  primary key (user_id, day)
);

alter table public.cellars enable row level security;
alter table public.cellar_members enable row level security;
alter table public.bottles enable row level security;
alter table public.history enable row level security;
alter table public.ai_usage enable row level security;

create or replace function public.is_member(p_cellar uuid)
returns boolean language sql security definer stable set search_path = ''
as $$
  select exists (
    select 1 from public.cellar_members m
    where m.cellar_id = p_cellar and m.user_id = (select auth.uid())
  );
$$;
revoke all on function public.is_member(uuid) from public, anon;
grant execute on function public.is_member(uuid) to authenticated;

create policy cellars_select on public.cellars for select to authenticated
  using (public.is_member(id));
create policy cellars_update on public.cellars for update to authenticated
  using (public.is_member(id)) with check (public.is_member(id));

create policy members_select on public.cellar_members for select to authenticated
  using (user_id = (select auth.uid()) or public.is_member(cellar_id));

create policy bottles_all on public.bottles for all to authenticated
  using (public.is_member(cellar_id)) with check (public.is_member(cellar_id));

create policy history_select on public.history for select to authenticated
  using (public.is_member(cellar_id));
create policy history_insert on public.history for insert to authenticated
  with check (public.is_member(cellar_id));
create policy history_delete on public.history for delete to authenticated
  using (public.is_member(cellar_id));

create or replace function public.create_cellar(p_name text default 'La cave de Michel')
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_id uuid; v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'Connexion requise'; end if;
  insert into public.cellars(name, created_by)
    values (coalesce(nullif(trim(p_name), ''), 'La cave de Michel'), v_uid)
    returning id into v_id;
  insert into public.cellar_members(cellar_id, user_id, role) values (v_id, v_uid, 'owner');
  return v_id;
end $$;
revoke all on function public.create_cellar(text) from public, anon;
grant execute on function public.create_cellar(text) to authenticated;

create or replace function public.add_member_by_email(p_cellar uuid, p_email text)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_user uuid;
begin
  if not exists (
    select 1 from public.cellar_members
    where cellar_id = p_cellar and user_id = (select auth.uid()) and role = 'owner'
  ) then raise exception 'Seul le propriétaire peut inviter quelqu''un'; end if;
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then
    raise exception 'Aucun compte avec cet email. La personne doit d''abord créer son compte.';
  end if;
  insert into public.cellar_members(cellar_id, user_id, role)
    values (p_cellar, v_user, 'member') on conflict do nothing;
end $$;
revoke all on function public.add_member_by_email(uuid, text) from public, anon;
grant execute on function public.add_member_by_email(uuid, text) to authenticated;

create or replace function public.list_members(p_cellar uuid)
returns table(user_id uuid, email text, role text)
language plpgsql security definer stable set search_path = ''
as $$
begin
  if not public.is_member(p_cellar) then raise exception 'Accès refusé'; end if;
  return query
    select m.user_id, u.email::text, m.role
    from public.cellar_members m join auth.users u on u.id = m.user_id
    where m.cellar_id = p_cellar order by m.created_at;
end $$;
revoke all on function public.list_members(uuid) from public, anon;
grant execute on function public.list_members(uuid) to authenticated;

-- Retrait atomique : écrit l'historique puis baisse la quantité (ou supprime la ligne).
create or replace function public.remove_bottles(
  p_bottle uuid, p_qty int, p_reason text,
  p_note text default null, p_sale_price numeric default null)
returns void language plpgsql set search_path = ''
as $$
declare b public.bottles%rowtype;
begin
  select * into b from public.bottles where id = p_bottle for update;
  if not found then raise exception 'Bouteille introuvable'; end if;
  if p_qty < 1 or p_qty > b.qty then raise exception 'Quantité invalide'; end if;
  insert into public.history(cellar_id, bottle_id, name, domaine, vintage, type, region,
                             qty, reason, note, sale_price, est_price, snapshot)
  values (b.cellar_id, b.id, b.name, b.domaine, b.vintage, b.type, b.region,
          p_qty, p_reason, nullif(trim(coalesce(p_note, '')), ''), p_sale_price, b.price, to_jsonb(b));
  if p_qty = b.qty then
    delete from public.bottles where id = b.id;
  else
    update public.bottles set qty = qty - p_qty, updated_at = now() where id = b.id;
  end if;
end $$;
revoke all on function public.remove_bottles(uuid, int, text, text, numeric) from public, anon;
grant execute on function public.remove_bottles(uuid, int, text, text, numeric) to authenticated;

-- Annulation d'un retrait : remet les bouteilles en cave et supprime la ligne d'historique.
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
                               price, apogee, place, description)
    values (coalesce(h.bottle_id, gen_random_uuid()), h.cellar_id, h.name, h.domaine, h.vintage,
            h.type, h.region, h.qty, nullif(s->>'price', '')::numeric, nullif(s->>'apogee', '')::int,
            s->>'place', s->>'description');
  end if;
  delete from public.history where id = h.id;
end $$;
revoke all on function public.restore_history(uuid) from public, anon;
grant execute on function public.restore_history(uuid) to authenticated;

-- Limite quotidienne d'appels IA, appelée uniquement par la fonction serveur "ai".
create or replace function public.bump_ai_usage(p_user uuid, p_limit int)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare c int;
begin
  insert into public.ai_usage(user_id, day, count) values (p_user, current_date, 1)
  on conflict (user_id, day) do update set count = public.ai_usage.count + 1
  returning count into c;
  return c <= p_limit;
end $$;
revoke all on function public.bump_ai_usage(uuid, int) from public, anon, authenticated;
grant execute on function public.bump_ai_usage(uuid, int) to service_role;

-- Synchronisation en direct entre appareils.
alter publication supabase_realtime add table public.bottles, public.history;
