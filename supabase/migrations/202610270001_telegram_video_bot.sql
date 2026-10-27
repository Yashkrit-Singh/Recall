-- Telegram account linking only. Existing saved-item, indexing, and search data
-- is untouched. Telegram searches use short-lived authenticated Supabase JWTs
-- so the existing search RPCs continue to enforce auth.uid() and RLS.
begin;

create table if not exists public.telegram_link_codes (
  code_hash text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists telegram_link_codes_user_active_idx
  on public.telegram_link_codes(user_id, expires_at) where consumed_at is null;

create table if not exists public.telegram_account_links (
  telegram_user_id text primary key check (telegram_user_id ~ '^[0-9]{1,24}$'),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  linked_at timestamptz not null default now()
);

alter table public.telegram_link_codes enable row level security;
alter table public.telegram_account_links enable row level security;
revoke all on public.telegram_link_codes, public.telegram_account_links from public, anon, authenticated;
grant all on public.telegram_link_codes, public.telegram_account_links to service_role;

create or replace function public.consume_telegram_link_code(
  target_code_hash text,
  target_telegram_user_id text
) returns text
language plpgsql security definer set search_path='' as $$
declare pairing public.telegram_link_codes%rowtype;
begin
  if target_code_hash !~ '^[0-9a-f]{64}$' or target_telegram_user_id !~ '^[0-9]{1,24}$' then
    return 'invalid';
  end if;
  select c.* into pairing from public.telegram_link_codes as c
    where c.code_hash=target_code_hash and c.consumed_at is null and c.expires_at>now()
    for update;
  if not found then return 'invalid'; end if;
  if exists(select 1 from public.telegram_account_links as l
      where l.telegram_user_id=target_telegram_user_id or l.user_id=pairing.user_id) then
    return 'already_linked';
  end if;
  update public.telegram_link_codes as c set consumed_at=now() where c.code_hash=pairing.code_hash;
  insert into public.telegram_account_links(telegram_user_id,user_id)
    values(target_telegram_user_id,pairing.user_id);
  return 'linked';
end;
$$;

revoke all on function public.consume_telegram_link_code(text,text) from public, anon, authenticated;
grant execute on function public.consume_telegram_link_code(text,text) to service_role;

-- Keep the existing authenticated keyword RPC useful for video memory: index
-- metadata and all text already extracted from transcript/OCR/visual analysis.
create or replace function public.search_saved_items(search_term text)
returns table (
  id uuid, user_id uuid, source_url text, title text, notes text, tags text[],
  created_at timestamptz, updated_at timestamptz, rank real
)
language sql stable security invoker set search_path='' as $$
  with terms as (
    select coalesce(array_agg(distinct lower(words.part)),array[]::text[]) as tokens
    from regexp_split_to_table(coalesce(search_term,''),'[^[:alnum:]]+') as words(part)
    where length(words.part)>=2 and lower(words.part)<>all(array[
      'a','an','and','are','as','at','be','by','did','do','for','from','find','has','how','i','in','is','it',
      'me','of','on','or','someone','that','the','they','this','to','video','was','were','what','where','which','who','with'
    ]::text[])
  ), query_terms as (
    select t.tokens,case when cardinality(t.tokens)>0
      then to_tsquery('simple',array_to_string(t.tokens,' | '))
      else to_tsquery('simple','') end as tsquery
    from terms as t
  ), searchable as (
    select s.*,
      concat_ws(' ',s.title,array_to_string(s.tags,' '),s.notes,s.source_url,
        coalesce(s.extracted_text,''),coalesce(s.transcript_segments::text,''),
        coalesce(s.ocr_frames::text,''),coalesce(s.visual_descriptions::text,''),
        coalesce(s.metadata_summary,''),coalesce(s.metadata_transcript_summary,''),
        coalesce(s.metadata_visual_summary,'')) as all_search_text
    from public.saved_items as s
    where s.user_id=(select auth.uid())
  ), scored as (
    select s.id,s.user_id,s.source_url,s.title,s.notes,s.tags,s.created_at,s.updated_at,s.all_search_text,
      (case when s.title ilike '%'||search_term||'%' or to_tsvector('simple',coalesce(s.title,'')) @@ q.tsquery then 4.0 else 0.0 end
       + case when array_to_string(s.tags,' ') ilike '%'||search_term||'%' or to_tsvector('simple',array_to_string(s.tags,' ')) @@ q.tsquery then 3.0 else 0.0 end
       + case when s.notes ilike '%'||search_term||'%' or to_tsvector('simple',coalesce(s.notes,'')) @@ q.tsquery then 2.0 else 0.0 end
       + case when concat_ws(' ',s.metadata_summary,s.metadata_transcript_summary,s.metadata_visual_summary) ilike '%'||search_term||'%'
          or to_tsvector('simple',concat_ws(' ',s.metadata_summary,s.metadata_transcript_summary,s.metadata_visual_summary)) @@ q.tsquery then 2.5 else 0.0 end
       + case when concat_ws(' ',s.extracted_text,s.transcript_segments::text) ilike '%'||search_term||'%'
          or to_tsvector('simple',concat_ws(' ',s.extracted_text,s.transcript_segments::text)) @@ q.tsquery then 2.0 else 0.0 end
       + case when concat_ws(' ',s.ocr_frames::text,s.visual_descriptions::text) ilike '%'||search_term||'%'
          or to_tsvector('simple',concat_ws(' ',s.ocr_frames::text,s.visual_descriptions::text)) @@ q.tsquery then 1.5 else 0.0 end
       + case when s.source_url ilike '%'||search_term||'%' then 0.5 else 0.0 end)::real as rank,
      q.tokens,
      (select count(*) from unnest(q.tokens) as term(token) where lower(s.all_search_text) like '%'||term.token||'%') as matched_terms
    from searchable as s cross join query_terms as q
  )
  select x.id,x.user_id,x.source_url,x.title,x.notes,x.tags,x.created_at,x.updated_at,x.rank
  from scored as x
  where search_term<>'' and (
    x.all_search_text ilike '%'||search_term||'%'
    or (cardinality(x.tokens)>0 and x.matched_terms>=least(2,cardinality(x.tokens)))
  )
  order by x.rank desc,x.created_at desc;
$$;
revoke all on function public.search_saved_items(text) from public,anon;
grant execute on function public.search_saved_items(text) to authenticated;

notify pgrst,'reload schema';
commit;
