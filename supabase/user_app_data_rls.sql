-- Loto Votre Chance — sécurisation de la table user_app_data.
-- Script idempotent : ne supprime aucune donnée et peut être relancé sans risque.
-- À exécuter dans Supabase > SQL Editor.

create table if not exists public.user_app_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_app_data enable row level security;

-- Aucun accès anonyme ; accès authentifié limité aux opérations utiles.
revoke all on public.user_app_data from anon;
grant select, insert, update on public.user_app_data to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_app_data' and policyname = 'lvc_select_own') then
    create policy lvc_select_own on public.user_app_data for select to authenticated using ((select auth.uid()) = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_app_data' and policyname = 'lvc_insert_own') then
    create policy lvc_insert_own on public.user_app_data for insert to authenticated with check ((select auth.uid()) = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_app_data' and policyname = 'lvc_update_own') then
    create policy lvc_update_own on public.user_app_data for update to authenticated
      using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
  end if;
end $$;

-- Contrôle : liste des politiques actives. Toute politique plus permissive
-- (par exemple using (true)) doit être supprimée manuellement après vérification.
select policyname, cmd, roles, qual, with_check
from pg_policies where schemaname = 'public' and tablename = 'user_app_data';
