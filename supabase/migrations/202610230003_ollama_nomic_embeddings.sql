-- Recall Stage 3: migrate the vector width from OpenAI's 1536 dimensions to
-- nomic-embed-text's 768 dimensions. Saved item rows and their text are kept;
-- only the incompatible vectors and vector index are reset.

drop index if exists public.saved_items_embedding_hnsw_idx;
drop function if exists public.search_saved_items_semantic(text, integer);

do $$
declare
  embedding_type text;
begin
  select pg_catalog.format_type(a.atttypid, a.atttypmod)
    into embedding_type
    from pg_catalog.pg_attribute as a
   where a.attrelid = 'public.saved_items'::regclass
     and a.attname = 'embedding'
     and not a.attisdropped;

  if embedding_type is null then
    raise exception 'The Stage 2 embedding column is missing. Run the Stage 2 migration first.';
  end if;

  if embedding_type not like '%vector(768)' then
    alter table public.saved_items
      alter column embedding type extensions.vector(768)
      using null::extensions.vector(768);
    update public.saved_items set embedding_model = null;
  end if;
end;
$$;

create index if not exists saved_items_embedding_hnsw_idx
  on public.saved_items using hnsw (embedding extensions.vector_cosine_ops)
  where embedding is not null;

create or replace function public.search_saved_items_semantic(
  query_embedding text,
  result_limit integer default 30,
  required_model text default 'nomic-embed-text'
)
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
         (1 - (s.embedding OPERATOR(extensions.<=>) query_embedding::extensions.vector(768)))::real as similarity
  from public.saved_items as s
  where (select auth.uid()) = s.user_id
    and s.embedding is not null
    and s.embedding_model = required_model
  order by s.embedding OPERATOR(extensions.<=>) query_embedding::extensions.vector(768)
  limit greatest(1, least(result_limit, 100));
$$;

create or replace function public.set_saved_item_embedding(item_id uuid, item_embedding text, model_name text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then return false; end if;
  update public.saved_items
     set embedding = item_embedding::extensions.vector(768),
         embedding_model = model_name
   where id = item_id
     and user_id = (select auth.uid());
  return found;
end;
$$;

revoke all on function public.search_saved_items_semantic(text, integer, text) from public, anon;
revoke all on function public.set_saved_item_embedding(uuid, text, text) from public, anon;
grant execute on function public.search_saved_items_semantic(text, integer, text) to authenticated;
grant execute on function public.set_saved_item_embedding(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
