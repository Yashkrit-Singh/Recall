-- Recall Stage 1: each row belongs to exactly one Supabase Auth user.
create table if not exists public.saved_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_url text not null,
  title text not null,
  notes text not null default '',
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint saved_items_source_url_not_empty check (length(trim(source_url)) > 0),
  constraint saved_items_title_not_empty check (length(trim(title)) > 0)
);

create index if not exists saved_items_user_created_idx
  on public.saved_items (user_id, created_at desc);

create or replace function public.set_saved_item_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists saved_items_set_updated_at on public.saved_items;
create trigger saved_items_set_updated_at
  before update on public.saved_items
  for each row execute function public.set_saved_item_updated_at();

alter table public.saved_items enable row level security;

create policy "Users can read their own saved items"
  on public.saved_items for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Users can add their own saved items"
  on public.saved_items for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Users can update their own saved items"
  on public.saved_items for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "Users can delete their own saved items"
  on public.saved_items for delete to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.search_saved_items(search_term text)
returns table (
  id uuid,
  user_id uuid,
  source_url text,
  title text,
  notes text,
  tags text[],
  created_at timestamptz,
  updated_at timestamptz,
  rank real
)
language sql
stable
security invoker
set search_path = ''
as $$
  select s.id, s.user_id, s.source_url, s.title, s.notes, s.tags,
         s.created_at, s.updated_at,
         (
           case when s.title ilike '%' || search_term || '%' then 4.0 else 0.0 end +
           case when array_to_string(s.tags, ' ') ilike '%' || search_term || '%' then 3.0 else 0.0 end +
           case when s.notes ilike '%' || search_term || '%' then 2.0 else 0.0 end +
           case when s.source_url ilike '%' || search_term || '%' then 0.5 else 0.0 end
         )::real as rank
  from public.saved_items as s
  where (select auth.uid()) = s.user_id
    and (
      s.title ilike '%' || search_term || '%' or
      array_to_string(s.tags, ' ') ilike '%' || search_term || '%' or
      s.notes ilike '%' || search_term || '%' or
      s.source_url ilike '%' || search_term || '%'
    )
  order by rank desc, s.created_at desc;
$$;

grant execute on function public.search_saved_items(text) to authenticated;
