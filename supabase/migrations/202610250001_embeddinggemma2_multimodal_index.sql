-- EmbeddingGemma 2 experiment. Additive only: preserves saved_items.embedding,
-- Nomic's 768-d vector space, and all existing queues and search functions.
begin;

alter table public.saved_items
  add column if not exists embeddinggemma_media_version bigint not null default 0,
  add column if not exists embeddinggemma_metadata_version bigint not null default 0,
  add column if not exists embeddinggemma_status text,
  add column if not exists embeddinggemma_error text;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid='public.saved_items'::regclass and conname='saved_items_embeddinggemma_status_check'
  ) then
    alter table public.saved_items add constraint saved_items_embeddinggemma_status_check
      check (embeddinggemma_status is null or embeddinggemma_status in ('pending','processing','ready','failed'));
  end if;
end;
$$;

create table if not exists public.saved_item_multimodal_embeddings (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.saved_items(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  model_id text not null check (model_id = 'google/embeddinggemma-2'),
  modality text not null check (modality in ('video','audio','metadata')),
  media_version bigint,
  metadata_version bigint,
  segment_start real,
  segment_end real,
  embedding extensions.vector(768) not null,
  created_at timestamptz not null default now(),
  check (
    (modality='metadata' and media_version is null and metadata_version is not null and segment_start is null and segment_end is null)
    or (modality in ('video','audio') and media_version is not null and metadata_version is null and segment_start >= 0 and segment_end > segment_start)
  )
);

create unique index if not exists multimodal_metadata_version_idx
  on public.saved_item_multimodal_embeddings(item_id,model_id,metadata_version)
  where modality='metadata';
create unique index if not exists multimodal_media_segment_idx
  on public.saved_item_multimodal_embeddings(item_id,model_id,media_version,modality,segment_start)
  where modality in ('video','audio');
create index if not exists multimodal_embedding_hnsw_idx
  on public.saved_item_multimodal_embeddings using hnsw (embedding extensions.vector_cosine_ops)
  where model_id='google/embeddinggemma-2';

alter table public.saved_item_multimodal_embeddings enable row level security;
drop policy if exists saved_item_multimodal_embeddings_read_own on public.saved_item_multimodal_embeddings;
create policy saved_item_multimodal_embeddings_read_own
  on public.saved_item_multimodal_embeddings for select to authenticated
  using (user_id=(select auth.uid()));
revoke all on public.saved_item_multimodal_embeddings from anon,authenticated;
grant select on public.saved_item_multimodal_embeddings to authenticated;
grant all on public.saved_item_multimodal_embeddings to service_role;

create table if not exists public.multimodal_embedding_jobs (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.saved_items(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  model_id text not null default 'google/embeddinggemma-2' check (model_id='google/embeddinggemma-2'),
  scope text not null check (scope in ('media','metadata')),
  media_version bigint not null,
  metadata_version bigint not null,
  status text not null default 'queued' check (status in ('queued','processing','succeeded','retry_wait','failed','superseded')),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  available_at timestamptz not null default now(),
  locked_until timestamptz,
  claim_token uuid,
  worker_name text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create unique index if not exists multimodal_embedding_one_active_scope_idx
  on public.multimodal_embedding_jobs(item_id,model_id,scope,media_version,metadata_version)
  where status in ('queued','processing','retry_wait');
create index if not exists multimodal_embedding_claim_idx
  on public.multimodal_embedding_jobs(available_at,created_at) where status in ('queued','retry_wait');
alter table public.multimodal_embedding_jobs enable row level security;
revoke all on public.multimodal_embedding_jobs from public,anon,authenticated;
grant all on public.multimodal_embedding_jobs to service_role;

create or replace function public.prepare_saved_item_embeddinggemma_versions()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' then
    new.embeddinggemma_media_version:=case when new.media_storage_key is null then 0 else greatest(coalesce(new.media_version,1),1) end;
    new.embeddinggemma_metadata_version:=case when new.media_storage_key is null then 0 else 1 end;
    new.embeddinggemma_status:='pending';
  else
    if new.media_storage_key is distinct from old.media_storage_key or new.media_version is distinct from old.media_version then
      new.embeddinggemma_media_version:=old.embeddinggemma_media_version+1;
      if new.media_storage_key is not null then new.embeddinggemma_status:='pending'; end if;
      new.embeddinggemma_error:=null;
    end if;
    if row(new.title,new.notes,new.tags) is distinct from row(old.title,old.notes,old.tags) then
      new.embeddinggemma_metadata_version:=old.embeddinggemma_metadata_version+1;
      new.embeddinggemma_status:='pending'; new.embeddinggemma_error:=null;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists saved_items_embeddinggemma_versions on public.saved_items;
create trigger saved_items_embeddinggemma_versions
  before insert or update of title,notes,tags,media_storage_key,media_version on public.saved_items
  for each row execute function public.prepare_saved_item_embeddinggemma_versions();

create or replace function public.enqueue_saved_item_embeddinggemma_jobs()
returns trigger language plpgsql security definer set search_path='' as $$
declare media_changed boolean; metadata_changed boolean;
begin
  if tg_op='INSERT' then
    media_changed:=new.media_storage_key is not null; metadata_changed:=true;
  else
    media_changed:=new.media_storage_key is not null and new.embeddinggemma_media_version is distinct from old.embeddinggemma_media_version;
    metadata_changed:=new.embeddinggemma_metadata_version is distinct from old.embeddinggemma_metadata_version;
  end if;
  if media_changed then
    insert into public.multimodal_embedding_jobs(item_id,user_id,scope,media_version,metadata_version)
      values(new.id,new.user_id,'media',new.embeddinggemma_media_version,new.embeddinggemma_metadata_version)
      on conflict(item_id,model_id,scope,media_version,metadata_version)
        where status in ('queued','processing','retry_wait') do nothing;
  end if;
  if metadata_changed then
    insert into public.multimodal_embedding_jobs(item_id,user_id,scope,media_version,metadata_version)
      values(new.id,new.user_id,'metadata',new.embeddinggemma_media_version,new.embeddinggemma_metadata_version)
      on conflict(item_id,model_id,scope,media_version,metadata_version)
        where status in ('queued','processing','retry_wait') do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists saved_items_embeddinggemma_jobs on public.saved_items;
create trigger saved_items_embeddinggemma_jobs
  after insert or update of title,notes,tags,media_storage_key,media_version on public.saved_items
  for each row execute function public.enqueue_saved_item_embeddinggemma_jobs();

create or replace function public.claim_multimodal_embedding_job(worker_name text)
returns table(job_id uuid,item_id uuid,user_id uuid,model_id text,scope text,media_version bigint,
  metadata_version bigint,claim_token uuid,attempts integer,max_attempts integer)
language plpgsql security definer set search_path='' as $$
declare picked public.multimodal_embedding_jobs%rowtype;
begin
  update public.multimodal_embedding_jobs as j set status='failed',last_error='Worker lease expired at retry limit.',
    locked_until=null,claim_token=null,completed_at=now(),updated_at=now()
   where j.status='processing' and j.locked_until<=now() and j.attempts>=j.max_attempts;
  select j.* into picked from public.multimodal_embedding_jobs as j
   where ((j.status in ('queued','retry_wait') and j.available_at<=now())
       or (j.status='processing' and j.locked_until<=now()))
     and j.attempts<j.max_attempts
   order by j.available_at,j.created_at for update skip locked limit 1;
  if not found then return; end if;
  update public.multimodal_embedding_jobs as j set status='processing',attempts=j.attempts+1,
    worker_name=claim_multimodal_embedding_job.worker_name,claim_token=gen_random_uuid(),
    locked_until=now()+interval '30 minutes',updated_at=now()
   where j.id=picked.id returning j.* into picked;
  update public.saved_items as s set embeddinggemma_status='processing',embeddinggemma_error=null
   where s.id=picked.item_id and s.user_id=picked.user_id
     and ((picked.scope='media' and s.embeddinggemma_media_version=picked.media_version)
       or (picked.scope='metadata' and s.embeddinggemma_metadata_version=picked.metadata_version));
  return query select picked.id,picked.item_id,picked.user_id,picked.model_id,picked.scope,
    picked.media_version,picked.metadata_version,picked.claim_token,picked.attempts,picked.max_attempts;
end;
$$;

create or replace function public.complete_multimodal_embedding_job(
  target_job_id uuid,target_claim_token uuid,target_segments jsonb
) returns boolean language plpgsql security definer set search_path='' as $$
declare job public.multimodal_embedding_jobs%rowtype; item public.saved_items%rowtype;
  segment jsonb; embedding_text text; vector_count integer:=0;
begin
  select j.* into job from public.multimodal_embedding_jobs as j where j.id=target_job_id for update;
  if not found or job.status<>'processing' or job.claim_token<>target_claim_token then return false; end if;
  select s.* into item from public.saved_items as s where s.id=job.item_id and s.user_id=job.user_id for update;
  if not found or (job.scope='media' and item.embeddinggemma_media_version<>job.media_version)
     or (job.scope='metadata' and item.embeddinggemma_metadata_version<>job.metadata_version) then
    update public.multimodal_embedding_jobs as j set status='superseded',claim_token=null,locked_until=null,
      completed_at=now(),updated_at=now() where j.id=job.id;
    return false;
  end if;
  if jsonb_typeof(target_segments)<>'array' or jsonb_array_length(target_segments)=0 then
    raise exception 'Non-empty multimodal segment vectors are required';
  end if;
  if job.scope='media' then
    delete from public.saved_item_multimodal_embeddings as e
     where e.item_id=job.item_id and e.model_id=job.model_id and e.media_version=job.media_version;
  else
    delete from public.saved_item_multimodal_embeddings as e
     where e.item_id=job.item_id and e.model_id=job.model_id and e.modality='metadata'
       and e.metadata_version=job.metadata_version;
  end if;
  for segment in select value from jsonb_array_elements(target_segments)
  loop
    if segment->>'modality' not in ('video','audio','metadata')
       or (job.scope='media' and segment->>'modality' not in ('video','audio'))
       or (job.scope='metadata' and segment->>'modality'<>'metadata')
       or jsonb_typeof(segment->'embedding')<>'array'
       or jsonb_array_length(segment->'embedding')<>768 then
      raise exception 'Invalid EmbeddingGemma 2 segment payload';
    end if;
    select '['||string_agg(value::text,',')||']' into embedding_text
      from jsonb_array_elements(segment->'embedding');
    insert into public.saved_item_multimodal_embeddings(
      item_id,user_id,model_id,modality,media_version,metadata_version,segment_start,segment_end,embedding
    ) values (
      job.item_id,job.user_id,job.model_id,segment->>'modality',
      case when job.scope='media' then job.media_version else null end,
      case when job.scope='metadata' then job.metadata_version else null end,
      nullif(segment->>'start','')::real,nullif(segment->>'end','')::real,
      embedding_text::extensions.vector(768)
    );
    vector_count:=vector_count+1;
  end loop;
  update public.multimodal_embedding_jobs as j set status='succeeded',claim_token=null,locked_until=null,
    last_error=null,completed_at=now(),updated_at=now() where j.id=job.id;
  update public.saved_items as s set embeddinggemma_status=case
      when exists(select 1 from public.multimodal_embedding_jobs as active
        where active.item_id=job.item_id and active.status in ('queued','processing','retry_wait')) then 'processing'
      else 'ready' end,embeddinggemma_error=null
    where s.id=job.item_id and s.user_id=job.user_id;
  return vector_count>0;
end;
$$;

create or replace function public.fail_multimodal_embedding_job(
  target_job_id uuid,target_claim_token uuid,safe_error text
) returns text language plpgsql security definer set search_path='' as $$
declare job public.multimodal_embedding_jobs%rowtype; next_status text;
begin
  select j.* into job from public.multimodal_embedding_jobs as j where j.id=target_job_id for update;
  if not found or job.status<>'processing' or job.claim_token<>target_claim_token then return 'superseded'; end if;
  next_status:=case when job.attempts>=job.max_attempts then 'failed' else 'retry_wait' end;
  update public.multimodal_embedding_jobs as j set status=next_status,claim_token=null,locked_until=null,
    available_at=case when next_status='retry_wait' then now()+make_interval(secs=>least(3600,5*(2^least(job.attempts-1,10))::integer)) else j.available_at end,
    last_error=left(safe_error,1000),completed_at=case when next_status='failed' then now() else null end,
    updated_at=now() where j.id=job.id;
  update public.saved_items as s set embeddinggemma_status=case when next_status='failed' then 'failed' else 'pending' end,
    embeddinggemma_error=left(safe_error,1000) where s.id=job.item_id and s.user_id=job.user_id
      and ((job.scope='media' and s.embeddinggemma_media_version=job.media_version)
        or (job.scope='metadata' and s.embeddinggemma_metadata_version=job.metadata_version));
  return next_status;
end;
$$;

create or replace function public.search_saved_item_multimodal(query_embedding text,result_limit integer default 30)
returns table(id uuid,user_id uuid,source_url text,title text,notes text,tags text[],created_at timestamptz,updated_at timestamptz,
  similarity real,matched_modality text,segment_start real,segment_end real,search_index text)
language sql stable security invoker set search_path='' as $$
  with ranked as (
    select s.id,s.user_id,s.source_url,s.title,s.notes,s.tags,s.created_at,s.updated_at,
      (1-(e.embedding OPERATOR(extensions.<=>) query_embedding::extensions.vector(768)))::real as similarity,
      e.modality as matched_modality,e.segment_start,e.segment_end
    from public.saved_item_multimodal_embeddings as e
    join public.saved_items as s on s.id=e.item_id and s.user_id=e.user_id
    where s.user_id=(select auth.uid()) and e.user_id=(select auth.uid())
      and e.model_id='google/embeddinggemma-2'
      and ((e.modality='metadata' and e.metadata_version=s.embeddinggemma_metadata_version)
        or (e.modality in ('video','audio') and e.media_version=s.embeddinggemma_media_version))
  ), best_per_item as (
    select r.*,row_number() over(partition by r.id order by r.similarity desc) as item_rank
    from ranked as r
  )
  select r.id,r.user_id,r.source_url,r.title,r.notes,r.tags,r.created_at,r.updated_at,r.similarity,
    r.matched_modality,r.segment_start,r.segment_end,'EmbeddingGemma 2'
  from best_per_item as r where r.item_rank=1
  order by r.similarity desc limit greatest(1,least(result_limit,100));
$$;

create or replace function public.enqueue_existing_multimodal_items()
returns bigint language plpgsql security definer set search_path='' as $$
declare queued bigint:=0; inserted bigint:=0;
begin
  insert into public.multimodal_embedding_jobs(item_id,user_id,scope,media_version,metadata_version)
  select s.id,s.user_id,'media',s.embeddinggemma_media_version,s.embeddinggemma_metadata_version
    from public.saved_items as s where s.user_id=(select auth.uid()) and s.media_storage_key is not null
      and not exists(select 1 from public.saved_item_multimodal_embeddings as e where e.item_id=s.id
        and e.model_id='google/embeddinggemma-2' and e.modality in ('video','audio')
        and e.media_version=s.embeddinggemma_media_version)
  on conflict(item_id,model_id,scope,media_version,metadata_version)
    where status in ('queued','processing','retry_wait') do nothing;
  get diagnostics inserted=row_count; queued:=queued+inserted;
  insert into public.multimodal_embedding_jobs(item_id,user_id,scope,media_version,metadata_version)
  select s.id,s.user_id,'metadata',s.embeddinggemma_media_version,s.embeddinggemma_metadata_version
    from public.saved_items as s where s.user_id=(select auth.uid())
      and not exists(select 1 from public.saved_item_multimodal_embeddings as e where e.item_id=s.id
        and e.model_id='google/embeddinggemma-2' and e.modality='metadata'
        and e.metadata_version=s.embeddinggemma_metadata_version)
  on conflict(item_id,model_id,scope,media_version,metadata_version)
    where status in ('queued','processing','retry_wait') do nothing;
  get diagnostics inserted=row_count; queued:=queued+inserted;
  update public.saved_items as s set embeddinggemma_status='pending',embeddinggemma_error=null
    where s.user_id=(select auth.uid()) and exists(
      select 1 from public.multimodal_embedding_jobs as j where j.item_id=s.id
        and j.status in ('queued','processing','retry_wait')
    );
  return queued;
end;
$$;

revoke all on function public.claim_multimodal_embedding_job(text) from public,anon,authenticated;
revoke all on function public.complete_multimodal_embedding_job(uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.fail_multimodal_embedding_job(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.claim_multimodal_embedding_job(text),
  public.complete_multimodal_embedding_job(uuid,uuid,jsonb),public.fail_multimodal_embedding_job(uuid,uuid,text) to service_role;
revoke all on function public.search_saved_item_multimodal(text,integer) from public,anon;
grant execute on function public.search_saved_item_multimodal(text,integer) to authenticated;
revoke all on function public.enqueue_existing_multimodal_items() from public,anon;
grant execute on function public.enqueue_existing_multimodal_items() to authenticated;

notify pgrst,'reload schema';
commit;
