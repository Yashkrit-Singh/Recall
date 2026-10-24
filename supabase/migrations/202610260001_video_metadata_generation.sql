-- Additive local video-to-metadata queue. Existing saved rows, media, jobs,
-- and Nomic/EmbeddingGemma indexes remain untouched.
begin;

alter table public.saved_items
  add column if not exists metadata_generation_status text not null default 'not_requested',
  add column if not exists metadata_generation_error text,
  add column if not exists metadata_generation_warnings text[] not null default '{}',
  add column if not exists metadata_generation_version bigint not null default 0,
  add column if not exists metadata_title_user_edited boolean not null default true,
  add column if not exists metadata_notes_user_edited boolean not null default true,
  add column if not exists metadata_tags_user_edited boolean not null default true;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid='public.saved_items'::regclass and conname='saved_items_metadata_generation_status_check') then
    alter table public.saved_items add constraint saved_items_metadata_generation_status_check
      check (metadata_generation_status in ('not_requested','waiting_for_media','pending','processing','ready','partially_ready','failed'));
  end if;
end;
$$;

create table if not exists public.saved_item_metadata_jobs (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.saved_items(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  media_version bigint not null,
  metadata_version bigint not null,
  status text not null default 'queued' check (status in ('queued','processing','retry_wait','succeeded','failed','superseded')),
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
create unique index if not exists saved_item_metadata_one_active_version_idx
  on public.saved_item_metadata_jobs(item_id,media_version,metadata_version)
  where status in ('queued','processing','retry_wait');
create index if not exists saved_item_metadata_claim_idx
  on public.saved_item_metadata_jobs(available_at,created_at) where status in ('queued','retry_wait');
alter table public.saved_item_metadata_jobs enable row level security;
revoke all on public.saved_item_metadata_jobs from public,anon,authenticated;
grant all on public.saved_item_metadata_jobs to service_role;

create or replace function public.prepare_saved_item_metadata_generation()
returns trigger language plpgsql security definer set search_path='' as $$
declare user_changed_metadata boolean:=false;
begin
  if tg_op='INSERT' then
    new.metadata_generation_version:=greatest(coalesce(new.metadata_generation_version,0),1);
    if new.media_storage_key is not null and new.media_status in ('ready','partially_ready') then
      new.metadata_generation_status:='pending';
    elsif coalesce(new.media_retrieval_opt_in,false) then
      new.metadata_generation_status:='waiting_for_media';
    end if;
    return new;
  end if;
  if coalesce(auth.role(),'')='authenticated' then
    if new.title is distinct from old.title then new.metadata_title_user_edited:=true; user_changed_metadata:=true; end if;
    if new.notes is distinct from old.notes then new.metadata_notes_user_edited:=true; user_changed_metadata:=true; end if;
    if new.tags is distinct from old.tags then new.metadata_tags_user_edited:=true; user_changed_metadata:=true; end if;
    if user_changed_metadata then
      new.metadata_generation_version:=old.metadata_generation_version+1;
      new.metadata_generation_error:=null;
      new.metadata_generation_warnings:='{}';
      new.metadata_generation_status:=case
        when new.media_storage_key is null then 'waiting_for_media'
        when new.media_status in ('ready','partially_ready') then 'pending'
        else 'waiting_for_media' end;
    end if;
  end if;
  if new.media_storage_key is not null and new.media_status in ('ready','partially_ready')
     and old.media_status is distinct from new.media_status
     and new.metadata_generation_status in ('not_requested','waiting_for_media') then
    new.metadata_generation_status:='pending';
    new.metadata_generation_error:=null;
    new.metadata_generation_warnings:='{}';
    new.metadata_generation_version:=greatest(new.metadata_generation_version,old.metadata_generation_version+1);
  end if;
  return new;
end;
$$;
drop trigger if exists saved_items_prepare_metadata_generation on public.saved_items;
create trigger saved_items_prepare_metadata_generation
  before insert or update of title,notes,tags,media_storage_key,media_version,media_status
  on public.saved_items for each row execute function public.prepare_saved_item_metadata_generation();

create or replace function public.enqueue_saved_item_metadata_job()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.media_storage_key is not null and new.media_status in ('ready','partially_ready')
     and new.metadata_generation_status='pending'
     and (tg_op='INSERT' or new.metadata_generation_version is distinct from old.metadata_generation_version
       or new.metadata_generation_status is distinct from old.metadata_generation_status) then
    insert into public.saved_item_metadata_jobs(item_id,user_id,media_version,metadata_version)
      values(new.id,new.user_id,new.media_version,new.metadata_generation_version)
      on conflict(item_id,media_version,metadata_version)
        where status in ('queued','processing','retry_wait') do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists saved_items_metadata_generation_job on public.saved_items;
create trigger saved_items_metadata_generation_job
  after insert or update of title,notes,tags,media_storage_key,media_version,media_status,metadata_generation_status
  on public.saved_items for each row execute function public.enqueue_saved_item_metadata_job();
revoke all on function public.prepare_saved_item_metadata_generation() from public,anon,authenticated;
revoke all on function public.enqueue_saved_item_metadata_job() from public,anon,authenticated;

-- Keep the existing atomic URL-save/retrieval RPC signature. A generic title
-- placeholder satisfies saved_items_title_not_empty until real media is analyzed.
create or replace function public.create_saved_item_with_retrieval(
  target_item_id uuid,target_user_id uuid,target_source_url text,target_title text,target_notes text,
  target_tags text[],target_retrieval_enabled boolean
) returns uuid language plpgsql security definer set search_path='' as $$
begin
  if target_item_id is null then raise exception 'Item id required'; end if;
  if target_user_id is null or not exists(select 1 from auth.users u where u.id=target_user_id) then
    raise exception 'Valid item owner required';
  end if;
  if target_source_url !~* '^https?://' or length(target_source_url)>2048 then
    raise exception 'Valid HTTP(S) URL required';
  end if;
  if nullif(btrim(target_title),'') is null or length(target_title)>180 then
    raise exception 'Valid placeholder title required';
  end if;
  insert into public.saved_items(id,user_id,source_url,title,notes,tags,media_retrieval_opt_in,
    metadata_generation_status,metadata_generation_version,metadata_title_user_edited,metadata_notes_user_edited,metadata_tags_user_edited)
  values(target_item_id,target_user_id,target_source_url,btrim(target_title),coalesce(target_notes,''),coalesce(target_tags,'{}'),
    coalesce(target_retrieval_enabled,false),case when coalesce(target_retrieval_enabled,false) then 'waiting_for_media' else 'not_requested' end,
    1,false,false,false);
  return target_item_id;
end;
$$;
revoke all on function public.create_saved_item_with_retrieval(uuid,uuid,text,text,text,text[],boolean) from public,anon,authenticated;
grant execute on function public.create_saved_item_with_retrieval(uuid,uuid,text,text,text,text[],boolean) to service_role;

create or replace function public.claim_saved_item_metadata_job(target_worker_name text)
returns table(job_id uuid,item_id uuid,user_id uuid,media_version bigint,metadata_version bigint,claim_token uuid,attempts integer,max_attempts integer)
language plpgsql security definer set search_path='' as $$
declare picked public.saved_item_metadata_jobs%rowtype;
begin
  update public.saved_item_metadata_jobs as j set status='failed',last_error='Worker lease expired at retry limit.',
    locked_until=null,claim_token=null,completed_at=now(),updated_at=now()
   where j.status='processing' and j.locked_until<=now() and j.attempts>=j.max_attempts;
  update public.saved_items as s set metadata_generation_status='failed',
    metadata_generation_error='Metadata worker lease expired after the retry limit.'
   where s.metadata_generation_status='processing'
     and exists(select 1 from public.saved_item_metadata_jobs as j
       where j.item_id=s.id and j.user_id=s.user_id and j.media_version=s.media_version
         and j.metadata_version=s.metadata_generation_version and j.status='failed'
         and j.last_error='Worker lease expired at retry limit.');
  select j.* into picked from public.saved_item_metadata_jobs as j
   where ((j.status in ('queued','retry_wait') and j.available_at<=now())
       or (j.status='processing' and j.locked_until<=now() and j.attempts<j.max_attempts))
   order by j.available_at,j.created_at for update skip locked limit 1;
  if not found then return; end if;
  update public.saved_item_metadata_jobs as j set status='processing',attempts=j.attempts+1,
    worker_name=target_worker_name,claim_token=gen_random_uuid(),locked_until=now()+interval '20 minutes',updated_at=now()
    where j.id=picked.id returning * into picked;
  update public.saved_items as s set metadata_generation_status='processing',metadata_generation_error=null
    where s.id=picked.item_id and s.user_id=picked.user_id and s.media_version=picked.media_version
      and s.metadata_generation_version=picked.metadata_version and s.media_storage_key is not null;
  if not found then
    update public.saved_item_metadata_jobs as j set status='superseded',claim_token=null,locked_until=null,completed_at=now(),updated_at=now()
      where j.id=picked.id;
    return;
  end if;
  return query select picked.id,picked.item_id,picked.user_id,picked.media_version,picked.metadata_version,
    picked.claim_token,picked.attempts,picked.max_attempts;
end;
$$;

-- Preserve upload support while letting metadata generation fill only fields
-- the uploader left blank. The video and its processing job remain atomic.
create or replace function public.create_saved_video_with_job(
  target_source_url text,target_title text,target_notes text,target_tags text[],
  target_storage_key text,target_original_name text,target_mime_type text,
  target_size_bytes bigint,target_duration_seconds real
) returns uuid language plpgsql security definer set search_path='' as $$
declare new_item_id uuid:=gen_random_uuid(); owner_id uuid:=(select auth.uid());
begin
  if owner_id is null then raise exception 'Sign in required'; end if;
  if target_mime_type not in ('video/mp4','video/quicktime','video/webm') then raise exception 'Unsupported video type'; end if;
  if target_storage_key !~ '^[0-9a-f-]{36}\.(mp4|mov|webm)$' then raise exception 'Invalid generated storage key'; end if;
  insert into public.saved_items(id,user_id,source_url,title,notes,tags,media_storage_key,media_original_name,
    media_mime_type,media_size_bytes,media_duration_seconds,media_version,media_status,
    metadata_generation_status,metadata_generation_version,metadata_title_user_edited,metadata_notes_user_edited,metadata_tags_user_edited)
  values(new_item_id,owner_id,target_source_url,coalesce(nullif(btrim(target_title),''),'Uploaded video'),
    coalesce(target_notes,''),coalesce(target_tags,'{}'),target_storage_key,target_original_name,
    target_mime_type,target_size_bytes,target_duration_seconds,1,'pending','not_requested',1,
    nullif(btrim(target_title),'') is not null,
    nullif(btrim(target_notes),'') is not null,coalesce(cardinality(target_tags),0)>0);
  insert into public.video_processing_jobs(item_id,user_id,media_version,storage_key)
    values(new_item_id,owner_id,1,target_storage_key);
  return new_item_id;
end;
$$;
revoke all on function public.create_saved_video_with_job(text,text,text,text[],text,text,text,bigint,real) from public,anon;
grant execute on function public.create_saved_video_with_job(text,text,text,text[],text,text,text,bigint,real) to authenticated;

create or replace function public.complete_saved_item_metadata_job(
  target_job_id uuid,target_claim_token uuid,target_media_version bigint,target_metadata_version bigint,
  generated_title text,generated_notes text,generated_tags text[],processing_warnings text[] default '{}'
) returns boolean language plpgsql security definer set search_path='' as $$
declare job public.saved_item_metadata_jobs%rowtype; item public.saved_items%rowtype;
begin
  select j.* into job from public.saved_item_metadata_jobs as j where j.id=target_job_id for update;
  if not found or job.status<>'processing' or job.claim_token<>target_claim_token then return false; end if;
  select s.* into item from public.saved_items as s where s.id=job.item_id and s.user_id=job.user_id for update;
  if not found or item.media_version<>target_media_version or item.metadata_generation_version<>target_metadata_version then
    update public.saved_item_metadata_jobs as j set status='superseded',claim_token=null,locked_until=null,completed_at=now(),updated_at=now()
      where j.id=job.id;
    return false;
  end if;
  if nullif(btrim(generated_title),'') is null or length(generated_title)>180
     or length(generated_notes)>3000 or coalesce(cardinality(generated_tags),0)>8
     or exists(select 1 from unnest(coalesce(generated_tags,'{}')) as t(value) where length(t.value)>48) then
    raise exception 'Generated metadata failed validation';
  end if;
  update public.saved_items as s set
    title=case when not s.metadata_title_user_edited then btrim(generated_title) else s.title end,
    notes=case when not s.metadata_notes_user_edited then btrim(generated_notes) else s.notes end,
    tags=case when not s.metadata_tags_user_edited then coalesce(generated_tags,'{}') else s.tags end,
    metadata_generation_status=case when cardinality(coalesce(processing_warnings,'{}'))>0 then 'partially_ready' else 'ready' end,
    metadata_generation_error=null,
    metadata_generation_warnings=coalesce(processing_warnings,'{}')
   where s.id=item.id and s.user_id=job.user_id and s.media_version=target_media_version
     and s.metadata_generation_version=target_metadata_version;
  if not found then return false; end if;
  update public.saved_item_metadata_jobs as j set status='succeeded',claim_token=null,locked_until=null,
    last_error=null,completed_at=now(),updated_at=now() where j.id=job.id;
  return true;
end;
$$;

create or replace function public.fail_saved_item_metadata_job(target_job_id uuid,target_claim_token uuid,safe_error text)
returns text language plpgsql security definer set search_path='' as $$
declare job public.saved_item_metadata_jobs%rowtype; next_status text;
begin
  select j.* into job from public.saved_item_metadata_jobs as j where j.id=target_job_id for update;
  if not found or job.status<>'processing' or job.claim_token<>target_claim_token then return 'superseded'; end if;
  if not exists(select 1 from public.saved_items as s where s.id=job.item_id and s.user_id=job.user_id
      and s.media_version=job.media_version and s.metadata_generation_version=job.metadata_version) then
    update public.saved_item_metadata_jobs as j set status='superseded',claim_token=null,locked_until=null,
      completed_at=now(),updated_at=now() where j.id=job.id;
    return 'superseded';
  end if;
  next_status:=case when job.attempts>=job.max_attempts then 'failed' else 'retry_wait' end;
  update public.saved_item_metadata_jobs as j set status=next_status,claim_token=null,locked_until=null,
    available_at=case when next_status='retry_wait' then now()+make_interval(secs=>least(3600,15*(2^least(job.attempts-1,8))::integer)) else j.available_at end,
    last_error=left(safe_error,1000),completed_at=case when next_status='failed' then now() else null end,updated_at=now()
    where j.id=job.id;
  update public.saved_items as s set metadata_generation_status=case when next_status='failed' then 'failed' else 'pending' end,
    metadata_generation_error=left(safe_error,1000)
    where s.id=job.item_id and s.user_id=job.user_id and s.media_version=job.media_version
      and s.metadata_generation_version=job.metadata_version;
  return next_status;
end;
$$;

create or replace function public.enqueue_saved_item_metadata_generation(target_item_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare item public.saved_items%rowtype; next_version bigint;
begin
  if (select auth.uid()) is null then return false; end if;
  select s.* into item from public.saved_items as s where s.id=target_item_id and s.user_id=(select auth.uid()) for update;
  if not found or item.media_storage_key is null or item.media_status not in ('ready','partially_ready') then return false; end if;
  next_version:=item.metadata_generation_version+1;
  update public.saved_items as s set metadata_generation_version=next_version,
    metadata_generation_status='pending',metadata_generation_error=null,metadata_generation_warnings='{}'
    where s.id=item.id and s.user_id=item.user_id;
  -- The AFTER UPDATE trigger inserted the durable job in the same transaction.
  return true;
end;
$$;

revoke all on function public.claim_saved_item_metadata_job(text) from public,anon,authenticated;
revoke all on function public.complete_saved_item_metadata_job(uuid,uuid,bigint,bigint,text,text,text[],text[]) from public,anon,authenticated;
revoke all on function public.fail_saved_item_metadata_job(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.claim_saved_item_metadata_job(text),
  public.complete_saved_item_metadata_job(uuid,uuid,bigint,bigint,text,text,text[],text[]),
  public.fail_saved_item_metadata_job(uuid,uuid,text) to service_role;
revoke all on function public.enqueue_saved_item_metadata_generation(uuid) from public,anon;
grant execute on function public.enqueue_saved_item_metadata_generation(uuid) to authenticated;

notify pgrst,'reload schema';
commit;
