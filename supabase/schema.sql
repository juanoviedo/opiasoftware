-- Esquema de OPIA Software para Supabase.
-- Ejecutar completo en: Supabase Dashboard > SQL Editor > New query.
--
-- Tablas: leads y visits (portadas del servidor local JSONL).
-- RLS activado SIN políticas: solo el service_role (las funciones de Vercel)
-- y el editor de Supabase pueden leer/escribir. El anon key no ve nada.

create table if not exists public.leads (
  id bigint generated always as identity primary key,
  t timestamptz not null default now(),
  name text,
  email text,
  phone text,
  company text,
  role text,
  service text,
  message text,
  urgency text,
  page text,
  ref text,
  refhost text,
  source text,
  ad text,
  src_utm text,
  med text,
  cmp text,
  cnt text,
  trm text,
  fbclid boolean,
  gclid boolean,
  ip text,
  iph text,
  ua text,
  device text,
  os text,
  browser text,
  bot boolean default false,
  internal boolean default false,
  status text default 'nuevo',
  geo jsonb
);

create table if not exists public.visits (
  id bigint generated always as identity primary key,
  t timestamptz not null default now(),
  ev text default 'pageview',
  vid text,
  sid text,
  ip text,
  iph text,
  path text,
  q text,
  ref text,
  refhost text,
  source text,
  ad text,
  src_utm text,
  med text,
  cmp text,
  cnt text,
  trm text,
  fbclid boolean,
  gclid boolean,
  ti text,
  ua text,
  device text,
  os text,
  browser text,
  sw integer,
  sh integer,
  lang text,
  tz double precision,
  bot boolean default false,
  preview boolean default false,
  internal boolean default false,
  href text,
  geo jsonb
);

create index if not exists leads_t_idx on public.leads (t desc);
create index if not exists visits_t_idx on public.visits (t desc);
create index if not exists visits_ev_idx on public.visits (ev);

alter table public.leads enable row level security;
alter table public.visits enable row level security;

-- Retención de 90 días, igual que el servidor local. Requiere pg_cron
-- (Database > Extensions > habilitar "pg_cron"). Si no se habilita, el
-- borrado se puede hacer a mano de vez en cuando con el mismo DELETE.
-- create extension if not exists pg_cron;
-- select cron.schedule('opia-purge', '17 3 * * *', $$
--   delete from public.visits where t < now() - interval '90 days';
--   delete from public.leads  where t < now() - interval '90 days';
-- $$);
