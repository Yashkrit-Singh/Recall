-- Do not return a nearest neighbor when it is not a meaningful match.
-- Keep the existing pgvector model, dimensions, RLS behavior, and saved rows.
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
    and (1 - (s.embedding OPERATOR(extensions.<=>) query_embedding::extensions.vector(768))) >= 0.55
  order by s.embedding OPERATOR(extensions.<=>) query_embedding::extensions.vector(768)
  limit greatest(1, least(result_limit, 100));
$$;

revoke all on function public.search_saved_items_semantic(text, integer, text) from public, anon;
grant execute on function public.search_saved_items_semantic(text, integer, text) to authenticated;

notify pgrst, 'reload schema';
