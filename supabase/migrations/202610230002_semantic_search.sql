-- Recall Stage 2: vectors stay in the same RLS-protected Supabase table.
create schema if not exists extensions;
create extension if not exists vector with schema extensions;

alter table public.saved_items
  add column if not exists embedding extensions.vector(1536),
  add column if not exists embedding_model text;

create index if not exists saved_items_embedding_hnsw_idx
  on public.saved_items using hnsw (embedding extensions.vector_cosine_ops)
  where embedding is not null;

-- This endpoint is called through the signed-in user's Supabase client. RLS and
-- the explicit auth.uid() predicate both limit matching to the caller's rows.
create or replace function public.search_saved_items_semantic(query_embedding text, result_limit integer default 30)
returns table (
  id uuid,
  user_id uuid,
  source_url text,
  title text,
  notes text,
  tags text[],
  created_at timestamptz,
  updated_at timestamptz,
  similarity real
)
language sql
stable
security invoker
set search_path = ''
as $$
  select s.id, s.user_id, s.source_url, s.title, s.notes, s.tags,
         s.created_at, s.updated_at,
         (1 - (s.embedding OPERATOR(extensions.<=>) query_embedding::extensions.vector(1536)))::real as similarity
  from public.saved_items as s
  where (select auth.uid()) = s.user_id
    and s.embedding is not null
  order by s.embedding OPERATOR(extensions.<=>) query_embedding::extensions.vector(1536)
  limit greatest(1, least(result_limit, 100));
$$;

create or replace function public.set_saved_item_embedding(item_id uuid, item_embedding text, model_name text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    return false;
  end if;
  update public.saved_items
     set embedding = item_embedding::extensions.vector(1536),
         embedding_model = model_name
   where id = item_id
     and user_id = (select auth.uid());
  return found;
end;
$$;

create or replace function public.clear_saved_item_embedding(item_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then return false; end if;
  update public.saved_items set embedding = null, embedding_model = null
   where id = item_id and user_id = (select auth.uid());
  return found;
end;
$$;

revoke all on function public.search_saved_items_semantic(text, integer) from public, anon;
revoke all on function public.set_saved_item_embedding(uuid, text, text) from public, anon;
revoke all on function public.clear_saved_item_embedding(uuid) from public, anon;
grant execute on function public.search_saved_items_semantic(text, integer) to authenticated;
grant execute on function public.set_saved_item_embedding(uuid, text, text) to authenticated;
grant execute on function public.clear_saved_item_embedding(uuid) to authenticated;

-- Prevent direct vector writes while keeping the existing CRUD fields available.
revoke update on public.saved_items from anon, authenticated;
grant update (source_url, title, notes, tags) on public.saved_items to authenticated;
