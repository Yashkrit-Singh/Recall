-- Stage 3: additive video metadata and a durable, user-scoped extraction queue.
-- This migration does not remove saved rows, embeddings, or existing embedding jobs.
begin;

alter table public.saved_items
  add column if not exists media_storage_key text,
  add column if not exists media_original_name text,
  add column if not exists media_mime_type text,
  add column if not exists media_size_bytes bigint,
  add column if not exists media_duration_seconds real,
  add column if not exists media_version bigint not null default 0,
  add column if not exists media_status text,
  add column if not exists media_error text,
  add column if not exists transcript_segments jsonb not null default '[]'::jsonb,
  add column if not exists ocr_frames jsonb not null default '[]'::jsonb,
  add column if not exists visual_descriptions jsonb not null default '[]'::jsonb,
  add column if not exists extracted_text text not null default '';

do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid='public.saved_items'::regclass and conname='saved_items_media_status_check') then
    alter table public.saved_items add constraint saved_items_media_status_check
      check (media_status is null or media_status in ('pending','processing','ready','partially_ready','failed'));
  end if;
end;
$$;

create table if not exists public.video_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.saved_items(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  media_version bigint not null,
  storage_key text not null,
  status text not null default 'queued' check (status in ('queued','processing','succeeded','failed','superseded')),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  available_at timestamptz not null default now(),
  locked_until timestamptz,
  claim_token uuid,
  worker_name text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists video_jobs_one_active_version_idx
  on public.video_processing_jobs(item_id, media_version)
  where status in ('queued','processing');
create index if not exists video_jobs_claim_idx
  on public.video_processing_jobs(available_at, created_at)
  where status = 'queued';

alter table public.video_processing_jobs enable row level security;
revoke all on public.video_processing_jobs from anon, authenticated;
grant select, insert, update, delete on public.video_processing_jobs to service_role;

create or replace function public.create_saved_video_with_job(
  target_source_url text, target_title text, target_notes text, target_tags text[],
  target_storage_key text, target_original_name text, target_mime_type text,
  target_size_bytes bigint, target_duration_seconds real
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare new_item_id uuid := gen_random_uuid();
begin
  if (select auth.uid()) is null then raise exception 'Sign in required'; end if;
  if target_mime_type not in ('video/mp4','video/quicktime','video/webm') then raise exception 'Unsupported video type'; end if;
  if target_storage_key !~ '^[0-9a-f-]{36}\.(mp4|mov|webm)$' then raise exception 'Invalid generated storage key'; end if;
  insert into public.saved_items (
    id,user_id,source_url,title,notes,tags,media_storage_key,media_original_name,
    media_mime_type,media_size_bytes,media_duration_seconds,media_version,media_status
  ) values (
    new_item_id,(select auth.uid()),target_source_url,target_title,target_notes,coalesce(target_tags,'{}'),
    target_storage_key,target_original_name,target_mime_type,target_size_bytes,target_duration_seconds,1,'pending'
  );
  insert into public.video_processing_jobs(item_id,user_id,media_version,storage_key)
  values(new_item_id,(select auth.uid()),1,target_storage_key);
  return new_item_id;
end;
$$;
revoke all on function public.create_saved_video_with_job(text,text,text,text[],text,text,text,bigint,real) from public, anon;
grant execute on function public.create_saved_video_with_job(text,text,text,text[],text,text,text,bigint,real) to authenticated;

create or replace function public.claim_video_processing_job(worker_name text)
returns table(job_id uuid,item_id uuid,user_id uuid,media_version bigint,storage_key text,claim_token uuid,attempts integer,max_attempts integer)
language plpgsql security definer set search_path = '' as $$
declare picked public.video_processing_jobs%rowtype;
begin
  select * into picked from public.video_processing_jobs j
   where j.status='queued' and j.available_at <= now()
      or j.status='processing' and j.locked_until < now()
   order by j.available_at,j.created_at for update skip locked limit 1;
  if not found then return; end if;
  update public.video_processing_jobs j set status='processing', attempts=j.attempts+1,
    worker_name=claim_video_processing_job.worker_name, claim_token=gen_random_uuid(),
    locked_until=now()+interval '15 minutes', updated_at=now()
   where j.id=picked.id returning * into picked;
  update public.saved_items set media_status='processing',media_error=null
   where id=picked.item_id and media_version=picked.media_version;
  return query select picked.id,picked.item_id,picked.user_id,picked.media_version,picked.storage_key,
    picked.claim_token,picked.attempts,picked.max_attempts;
end;
$$;

create or replace function public.complete_video_processing_job(
  target_job_id uuid,target_claim_token uuid,target_media_version bigint,
  target_transcript jsonb,target_ocr jsonb,target_visual jsonb,target_extracted_text text,
  target_status text,target_error text default null
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare job public.video_processing_jobs%rowtype;
begin
  select * into job from public.video_processing_jobs where id=target_job_id for update;
  if not found or job.status <> 'processing' or job.claim_token <> target_claim_token then return false; end if;
  update public.video_processing_jobs set status='succeeded',locked_until=null,claim_token=null,
    last_error=null,updated_at=now() where id=job.id;
  update public.saved_items set transcript_segments=coalesce(target_transcript,'[]'::jsonb),
    ocr_frames=coalesce(target_ocr,'[]'::jsonb),visual_descriptions=coalesce(target_visual,'[]'::jsonb),
    extracted_text=coalesce(target_extracted_text,''),media_status=target_status,
    media_error=target_error
   where id=job.item_id and user_id=job.user_id and media_version=target_media_version;
  if not found then
    update public.video_processing_jobs set status='superseded' where id=job.id;
    return false;
  end if;
  return true;
end;
$$;

create or replace function public.fail_video_processing_job(
  target_job_id uuid,target_claim_token uuid,safe_error text
) returns text
language plpgsql security definer set search_path = '' as $$
declare job public.video_processing_jobs%rowtype; next_status text;
begin
  select * into job from public.video_processing_jobs where id=target_job_id for update;
  if not found or job.claim_token <> target_claim_token then return 'superseded'; end if;
  next_status := case when job.attempts >= job.max_attempts then 'failed' else 'queued' end;
  update public.video_processing_jobs set status=next_status,claim_token=null,locked_until=null,
    available_at=case when next_status='queued' then now()+make_interval(secs => least(3600,5*(2 ^ least(job.attempts-1,10))::integer)) else available_at end,
    last_error=left(safe_error,1000),updated_at=now() where id=job.id;
  update public.saved_items set media_status=case when next_status='failed' then 'failed' else 'pending' end,
    media_error=left(safe_error,1000) where id=job.item_id and media_version=job.media_version;
  return case when next_status='failed' then 'failed' else 'retrying' end;
end;
$$;

create or replace function public.retry_failed_video_processing(target_item_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare item public.saved_items%rowtype;
begin
  select * into item from public.saved_items where id=target_item_id and user_id=(select auth.uid()) for update;
  if (select auth.uid()) is null or not found or item.media_status <> 'failed' then return false; end if;
  insert into public.video_processing_jobs(item_id,user_id,media_version,storage_key)
    values(item.id,item.user_id,item.media_version,item.media_storage_key)
    on conflict (item_id,media_version) where status in ('queued','processing') do nothing;
  update public.saved_items set media_status='pending',media_error=null where id=item.id;
  return true;
end;
$$;

revoke all on function public.claim_video_processing_job(text) from public, anon, authenticated;
revoke all on function public.complete_video_processing_job(uuid,uuid,bigint,jsonb,jsonb,jsonb,text,text,text) from public, anon, authenticated;
revoke all on function public.fail_video_processing_job(uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.retry_failed_video_processing(uuid) from public, anon;
grant execute on function public.claim_video_processing_job(text) to service_role;
grant execute on function public.complete_video_processing_job(uuid,uuid,bigint,jsonb,jsonb,jsonb,text,text,text) to service_role;
grant execute on function public.fail_video_processing_job(uuid,uuid,text) to service_role;
grant execute on function public.retry_failed_video_processing(uuid) to authenticated;

-- Extraction changes enqueue a fresh embedding version in the existing queue.
create or replace function public.enqueue_video_text_embedding()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.extracted_text is distinct from old.extracted_text then
    new.embedding_content_version := coalesce(old.embedding_content_version,0)+1;
    new.embedding_status := 'pending';
    new.embedding_error := null;
  end if;
  return new;
end;
$$;
drop trigger if exists saved_items_video_embedding_version on public.saved_items;
create trigger saved_items_video_embedding_version before update of extracted_text on public.saved_items
for each row execute function public.enqueue_video_text_embedding();

create or replace function public.enqueue_video_text_embedding_job()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.extracted_text is distinct from old.extracted_text then
    insert into public.embedding_jobs(item_id,user_id,content_version)
    values(new.id,new.user_id,new.embedding_content_version)
    on conflict (item_id,content_version) where status in ('queued','processing') do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists saved_items_video_embedding_job on public.saved_items;
create trigger saved_items_video_embedding_job after update of extracted_text on public.saved_items
for each row execute function public.enqueue_video_text_embedding_job();

-- Keep the existing authenticated keyword RPC useful before embeddings finish.
create or replace function public.search_saved_items(search_term text)
returns table(id uuid,user_id uuid,source_url text,title text,notes text,tags text[],created_at timestamptz,updated_at timestamptz,rank real)
language sql stable security invoker set search_path = '' as $$
  select s.id,s.user_id,s.source_url,s.title,s.notes,s.tags,s.created_at,s.updated_at,
    (case when s.title ilike '%'||search_term||'%' then 4.0 else 0.0 end +
     case when array_to_string(s.tags,' ') ilike '%'||search_term||'%' then 3.0 else 0.0 end +
     case when s.notes ilike '%'||search_term||'%' then 2.0 else 0.0 end +
     case when coalesce(s.extracted_text,'') ilike '%'||search_term||'%' then 2.5 else 0.0 end +
     case when s.source_url ilike '%'||search_term||'%' then 0.5 else 0.0 end)::real as rank
  from public.saved_items s
  where (select auth.uid())=s.user_id and (
    s.title ilike '%'||search_term||'%' or array_to_string(s.tags,' ') ilike '%'||search_term||'%' or
    s.notes ilike '%'||search_term||'%' or coalesce(s.extracted_text,'') ilike '%'||search_term||'%' or
    s.source_url ilike '%'||search_term||'%')
  order by rank desc,s.created_at desc;
$$;
grant execute on function public.search_saved_items(text) to authenticated;

notify pgrst, 'reload schema';
commit;
