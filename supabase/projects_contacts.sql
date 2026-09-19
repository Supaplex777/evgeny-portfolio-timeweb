-- Additive production migration: projects, project images, contact requests.
-- Does not modify certificate tables, existing buckets, Auth, or existing policies.

create extension if not exists pgcrypto;

create table if not exists public.portfolio_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  title text not null check (char_length(title) between 1 and 120),
  slug text not null unique,
  category text not null check (category in ('ai','automation','web','data','other')),
  summary text not null check (char_length(summary) between 1 and 400),
  description text not null check (char_length(description) between 1 and 10000),
  goal text check (char_length(goal) <= 1000),
  result text check (char_length(result) <= 1000),
  status text not null default 'MVP' check (status in ('В разработке','MVP','Завершён','Активный')),
  tags text[] not null default '{}',
  cover_path text,
  project_url text,
  github_url text,
  demo_url text,
  published boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.portfolio_project_images (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.portfolio_projects(id) on delete cascade,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete restrict,
  storage_path text not null unique,
  alt_text text not null default '' check (char_length(alt_text) <= 240),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.contact_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 100),
  contact text not null check (char_length(contact) between 3 and 200),
  project_type text not null check (project_type in ('AI-автоматизация','Интеграция','Аналитика данных','Web-проект','Другое')),
  message text not null check (char_length(message) between 10 and 3000),
  status text not null default 'new' check (status in ('new','read','replied','archived')),
  created_at timestamptz not null default now()
);

alter table public.portfolio_projects enable row level security;
alter table public.portfolio_project_images enable row level security;
alter table public.contact_requests enable row level security;

create policy "public reads published projects" on public.portfolio_projects
  for select using (published = true or auth.uid() = owner_id);
create policy "owner inserts projects" on public.portfolio_projects
  for insert to authenticated with check (auth.uid() = owner_id);
create policy "owner updates projects" on public.portfolio_projects
  for update to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "owner deletes projects" on public.portfolio_projects
  for delete to authenticated using (auth.uid() = owner_id);

create policy "public reads published project images" on public.portfolio_project_images
  for select using (exists (select 1 from public.portfolio_projects p where p.id = project_id and (p.published or p.owner_id = auth.uid())));
create policy "owner inserts project images" on public.portfolio_project_images
  for insert to authenticated with check (auth.uid() = owner_id and exists (select 1 from public.portfolio_projects p where p.id = project_id and p.owner_id = auth.uid()));
create policy "owner updates project images" on public.portfolio_project_images
  for update to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
create policy "owner deletes project images" on public.portfolio_project_images
  for delete to authenticated using (auth.uid() = owner_id);

create policy "public submits contact requests" on public.contact_requests
  for insert to anon, authenticated with check (status = 'new');
-- Contact requests intentionally have no SELECT/UPDATE/DELETE policy.
-- They are write-only from the public site; review is performed in Dashboard.

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('portfolio-projects','portfolio-projects',true,5242880,array['image/webp'])
on conflict (id) do nothing;

create policy "public reads project media" on storage.objects
  for select using (bucket_id = 'portfolio-projects');
create policy "owner uploads project media" on storage.objects
  for insert to authenticated with check (bucket_id = 'portfolio-projects' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "owner updates project media" on storage.objects
  for update to authenticated using (bucket_id = 'portfolio-projects' and owner_id = auth.uid()::text) with check (bucket_id = 'portfolio-projects' and owner_id = auth.uid()::text);
create policy "owner deletes project media" on storage.objects
  for delete to authenticated using (bucket_id = 'portfolio-projects' and owner_id = auth.uid()::text);

create index if not exists portfolio_projects_public_idx on public.portfolio_projects (published, sort_order, created_at desc);
create index if not exists portfolio_project_images_project_idx on public.portfolio_project_images (project_id, sort_order);
create index if not exists contact_requests_created_idx on public.contact_requests (created_at desc);

grant select on public.portfolio_projects, public.portfolio_project_images to anon, authenticated;
grant insert, update, delete on public.portfolio_projects, public.portfolio_project_images to authenticated;
grant insert on public.contact_requests to anon, authenticated;

-- Seed the existing TerraIntel case only when this project has one Auth owner.
insert into public.portfolio_projects
  (owner_id,title,slug,category,summary,description,goal,result,status,tags,published,sort_order)
select
  u.id,
  'TerraIntel',
  'terraintel',
  'ai',
  'AI-платформа анализа геопространственных данных и генерации отчётов.',
  'Модульная AI-платформа для анализа геопространственных данных, выявления аномалий и автоматического формирования аналитических отчётов.',
  'Автоматизировать анализ территорий и выявление аномалий.',
  'Сократить время анализа с дней до минут.',
  'MVP',
  array['Python','AI','SQL','API','Supabase','GeoPandas','Leaflet'],
  true,
  1
from auth.users u
where (select count(*) from auth.users) = 1
on conflict (slug) do nothing;
