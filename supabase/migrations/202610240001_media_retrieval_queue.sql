-- Experimental, opt-in link retrieval. Additive only: existing items, vectors,
-- embedding jobs, uploaded media, and video jobs are preserved.
begin;

alter table public.saved_items
  add column if not exists media_retrieval_opt_in boolean not null default false,
  add column if not exists media_retrieval_status text not null default 'not_requested',
  add column if not exists media_retrieval_version bigint not null default 0,
  add column if not exists media_retrieval_error text,
  add column if not exists media_retrieved_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid='public.saved_items'::regclass
      and conname='saved_items_media_retrieval_status_check'
  ) then
    alter table public.saved_items add constraint saved_items_media_retrieval_status_check
      check (media_retrieval_status in (
        'not_requested','pending','retrieving','retrieved','unsupported',
        'requires_authorization','retry_wait','failed'
      ));
  end if;
end;
$$;

create table if not exists public.media_retrieval_jobs (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.saved_items(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'yt-dlp',
  source_url text not null,
  source_version bigint not null,
  status text not null default 'queued' check (status in (
    'queued','retrieving','retry_wait','retrieved','unsupported',
    'requires_authorization','failed','superseded'
  )),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 4 check (max_attempts between 1 and 4),
  available_at timestamptz not null default now(),
  claim_token uuid,
  worker_name text,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create unique index if not exists media_retrieval_jobs_one_active_version_idx
  on public.media_retrieval_jobs(item_id,source_version)
  where status in ('queued','retrieving','retry_wait');
create index if not exists media_retrieval_jobs_claim_idx
  on public.media_retrieval_jobs(available_at,created_at)
  where status in ('queued','retry_wait','retrieving');

alter table public.media_retrieval_jobs enable row level security;
revoke all on public.media_retrieval_jobs from public,anon,authenticated;
grant select,insert,update,delete on public.media_retrieval_jobs to service_role;

-- Match only ordinary public Reel/post permalinks. The worker repeats this
-- validation and never accepts an arbitrary URL as a downloader target.
create or replace function public.is_supported_instagram_reel_url(target_url text)
returns boolean language sql immutable security invoker set search_path='' as $$
  select coalesce(target_url ~* '^https://(www\.)?instagram\.com/(reel|reels|p)/[A-Za-z0-9_-]+/?([?#][^[:space:]]*)?$', false)
$$;

create or replace function public.prepare_saved_item_media_retrieval()
returns trigger language plpgsql security definer set search_path='' as $$
declare url_changed boolean;
begin
  if tg_op='INSERT' then
    -- Only the trusted local server's service-role RPC may opt an item in.
    if coalesce(auth.role(),'')<>'service_role' then new.media_retrieval_opt_in:=false; end if;
    if new.media_retrieval_opt_in then
      new.media_retrieval_version:=greatest(coalesce(new.media_retrieval_version,0),1);
      if new.media_storage_key is not null then
        new.media_retrieval_status:='unsupported';
        new.media_retrieval_error:='A video file is already attached to this item.';
      elsif public.is_supported_instagram_reel_url(new.source_url) then
        new.media_retrieval_status:='pending';
        new.media_retrieval_error:=null;
      else
        new.media_retrieval_status:='unsupported';
        new.media_retrieval_error:='Automatic retrieval currently supports Instagram Reel and post permalinks only.';
      end if;
    else
      new.media_retrieval_status:='not_requested';
      new.media_retrieval_version:=coalesce(new.media_retrieval_version,0);
    end if;
    return new;
  end if;

  if coalesce(auth.role(),'')<>'service_role' then
    new.media_retrieval_opt_in:=old.media_retrieval_opt_in;
  end if;
  url_changed:=new.source_url is distinct from old.source_url;
  if url_changed or new.media_retrieval_opt_in is distinct from old.media_retrieval_opt_in then
    -- Older jobs become stale by source_version. The claim/complete RPC marks
    -- them superseded after rechecking the saved row; do not lock jobs here.
    if new.media_retrieval_opt_in then
      new.media_retrieval_version:=coalesce(old.media_retrieval_version,0)+1;
      new.media_retrieval_error:=null;
      new.media_retrieved_at:=null;
      if new.media_storage_key is not null then
        new.media_retrieval_status:='unsupported';
        new.media_retrieval_error:='A video file is already attached to this item.';
      elsif public.is_supported_instagram_reel_url(new.source_url) then
        new.media_retrieval_status:='pending';
      else
        new.media_retrieval_status:='unsupported';
        new.media_retrieval_error:='Automatic retrieval currently supports Instagram Reel and post permalinks only.';
      end if;
    else
      new.media_retrieval_version:=coalesce(old.media_retrieval_version,0)+1;
      new.media_retrieval_status:='not_requested';
      new.media_retrieval_error:=null;
      new.media_retrieved_at:=null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists saved_items_prepare_media_retrieval on public.saved_items;
create trigger saved_items_prepare_media_retrieval
before insert or update of source_url,media_retrieval_opt_in on public.saved_items
for each row execute function public.prepare_saved_item_media_retrieval();

create or replace function public.enqueue_saved_item_media_retrieval()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' then
    if new.media_retrieval_opt_in and new.media_retrieval_status='pending' then
      insert into public.media_retrieval_jobs(item_id,user_id,source_url,source_version)
        values(new.id,new.user_id,regexp_replace(new.source_url,'[?#].*$',''),new.media_retrieval_version)
        on conflict(item_id,source_version)
          where status in ('queued','retrieving','retry_wait') do nothing;
    end if;
  elsif new.media_retrieval_opt_in
     and new.media_retrieval_status='pending'
     and (new.source_url is distinct from old.source_url
          or new.media_retrieval_opt_in is distinct from old.media_retrieval_opt_in) then
    insert into public.media_retrieval_jobs(item_id,user_id,source_url,source_version)
      values(new.id,new.user_id,regexp_replace(new.source_url,'[?#].*$',''),new.media_retrieval_version)
      on conflict(item_id,source_version)
        where status in ('queued','retrieving','retry_wait') do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists saved_items_enqueue_media_retrieval on public.saved_items;
create trigger saved_items_enqueue_media_retrieval
after insert or update of source_url,media_retrieval_opt_in on public.saved_items
for each row execute function public.enqueue_saved_item_media_retrieval();

-- The server authenticates the user first, then calls this function with its
-- server-only Supabase client. Restricting execute to service_role ensures a
-- browser cannot turn retrieval on when the local opt-in flag is disabled.
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
    raise exception 'Valid title required';
  end if;
  insert into public.saved_items(id,user_id,source_url,title,notes,tags,media_retrieval_opt_in)
  values(target_item_id,target_user_id,target_source_url,btrim(target_title),coalesce(target_notes,''),coalesce(target_tags,'{}'),coalesce(target_retrieval_enabled,false));
  return target_item_id;
end;
$$;
revoke all on function public.create_saved_item_with_retrieval(uuid,uuid,text,text,text,text[],boolean) from public,anon,authenticated;
grant execute on function public.create_saved_item_with_retrieval(uuid,uuid,text,text,text,text[],boolean) to service_role;

create or replace function public.claim_media_retrieval_job(target_worker_name text)
returns table(job_id uuid,item_id uuid,user_id uuid,provider text,source_url text,source_version bigint,claim_token uuid,attempts integer,max_attempts integer)
language plpgsql security definer set search_path='' as $$
declare picked public.media_retrieval_jobs%rowtype;
begin
  -- Only one media download may be active across all retrieval-worker copies.
  perform pg_catalog.pg_advisory_xact_lock(746281903,1);
  if exists(select 1 from public.media_retrieval_jobs as active
            where active.status='retrieving' and active.lease_expires_at>now()) then
    return;
  end if;
  select j.* into picked from public.media_retrieval_jobs as j
   where (j.status in ('queued','retry_wait') and j.available_at<=now())
      or (j.status='retrieving' and j.lease_expires_at<=now())
   order by j.available_at,j.created_at
   for update skip locked limit 1;
  if not found then return; end if;
  update public.media_retrieval_jobs as j
     set status='retrieving',attempts=j.attempts+1,worker_name=target_worker_name,
         claim_token=gen_random_uuid(),lease_expires_at=now()+interval '30 minutes',
         updated_at=now()
   where j.id=picked.id returning j.* into picked;
  update public.saved_items as s set media_retrieval_status='retrieving',media_retrieval_error=null
   where s.id=picked.item_id and s.user_id=picked.user_id
     and s.media_retrieval_version=picked.source_version
     and regexp_replace(s.source_url,'[?#].*$','')=picked.source_url and s.media_storage_key is null;
  if not found then
    update public.media_retrieval_jobs as j set status='superseded',claim_token=null,
      lease_expires_at=null,completed_at=now(),updated_at=now() where j.id=picked.id;
    return;
  end if;
  return query select picked.id,picked.item_id,picked.user_id,picked.provider,picked.source_url,
    picked.source_version,picked.claim_token,picked.attempts,picked.max_attempts;
end;
$$;

create or replace function public.complete_media_retrieval_job(
  target_job_id uuid,target_claim_token uuid,target_storage_key text,
  target_mime_type text,target_size_bytes bigint,target_duration_seconds real
) returns boolean language plpgsql security definer set search_path='' as $$
declare job public.media_retrieval_jobs%rowtype; item public.saved_items%rowtype; next_media_version bigint;
begin
  select j.* into job from public.media_retrieval_jobs as j where j.id=target_job_id for update;
  if not found or job.status<>'retrieving' or job.claim_token<>target_claim_token
     or job.lease_expires_at<=now() then return false; end if;
  select s.* into item from public.saved_items as s where s.id=job.item_id for update;
  if not found or item.user_id<>job.user_id or regexp_replace(item.source_url,'[?#].*$','')<>job.source_url
     or item.media_retrieval_version<>job.source_version
     or item.media_storage_key is not null or not item.media_retrieval_opt_in then
    update public.media_retrieval_jobs as j set status='superseded',claim_token=null,
      lease_expires_at=null,completed_at=now(),updated_at=now() where j.id=job.id;
    return false;
  end if;
  if target_storage_key !~ '^[0-9a-f-]{36}\.(mp4|mov|webm)$'
     or target_mime_type not in ('video/mp4','video/quicktime','video/webm')
     or target_size_bytes<=0 or target_duration_seconds<=0 then
    raise exception 'Validated media metadata is required';
  end if;
  next_media_version:=item.media_version+1;
  update public.saved_items as s set media_storage_key=target_storage_key,
    media_original_name='retrieved video',media_mime_type=target_mime_type,
    media_size_bytes=target_size_bytes,media_duration_seconds=target_duration_seconds,
    media_version=next_media_version,media_status='pending',media_error=null,
    media_retrieval_status='retrieved',media_retrieval_error=null,media_retrieved_at=now()
   where s.id=item.id and s.user_id=job.user_id
     and s.media_retrieval_version=job.source_version and s.media_storage_key is null;
  if not found then return false; end if;
  insert into public.video_processing_jobs(item_id,user_id,media_version,storage_key)
    values(item.id,item.user_id,next_media_version,target_storage_key)
    on conflict(item_id,media_version) where status in ('queued','processing') do nothing;
  update public.media_retrieval_jobs as j set status='retrieved',claim_token=null,
    lease_expires_at=null,last_error=null,completed_at=now(),updated_at=now() where j.id=job.id;
  return true;
end;
$$;

create or replace function public.fail_media_retrieval_job(
  target_job_id uuid,target_claim_token uuid,target_status text,safe_error text
) returns text language plpgsql security definer set search_path='' as $$
declare job public.media_retrieval_jobs%rowtype; final_status text; next_available timestamptz;
begin
  select j.* into job from public.media_retrieval_jobs as j where j.id=target_job_id for update;
  if not found or job.status<>'retrieving' or job.claim_token<>target_claim_token then return 'superseded'; end if;
  if target_status not in ('retry_wait','unsupported','requires_authorization','failed') then
    raise exception 'Invalid retrieval failure status';
  end if;
  final_status:=case when target_status='retry_wait' and job.attempts<job.max_attempts then 'retry_wait'
                      when target_status='retry_wait' then 'failed' else target_status end;
  next_available:=case when final_status='retry_wait'
    then now()+make_interval(secs=>least(3600,15*(2^least(job.attempts-1,8))::integer)) else null end;
  update public.media_retrieval_jobs as j set status=final_status,claim_token=null,
    lease_expires_at=null,available_at=coalesce(next_available,j.available_at),
    last_error=left(safe_error,1000),completed_at=case when final_status='retry_wait' then null else now() end,
    updated_at=now() where j.id=job.id;
  update public.saved_items as s set media_retrieval_status=final_status,
    media_retrieval_error=left(safe_error,1000)
   where s.id=job.item_id and s.user_id=job.user_id
     and s.media_retrieval_version=job.source_version
     and regexp_replace(s.source_url,'[?#].*$','')=job.source_url;
  return final_status;
end;
$$;

create or replace function public.retry_failed_media_retrieval(target_item_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare item public.saved_items%rowtype;
begin
  select s.* into item from public.saved_items as s
    where s.id=target_item_id and s.user_id=(select auth.uid()) for update;
  if not found or item.media_retrieval_status<>'failed' or not item.media_retrieval_opt_in
     or item.media_storage_key is not null
     or not public.is_supported_instagram_reel_url(item.source_url) then return false; end if;
  insert into public.media_retrieval_jobs(item_id,user_id,source_url,source_version)
    values(item.id,item.user_id,regexp_replace(item.source_url,'[?#].*$',''),item.media_retrieval_version);
  update public.saved_items as s set media_retrieval_status='pending',media_retrieval_error=null
    where s.id=item.id;
  return true;
end;
$$;

revoke all on function public.claim_media_retrieval_job(text) from public,anon,authenticated;
revoke all on function public.complete_media_retrieval_job(uuid,uuid,text,text,bigint,real) from public,anon,authenticated;
revoke all on function public.fail_media_retrieval_job(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.claim_media_retrieval_job(text),
  public.complete_media_retrieval_job(uuid,uuid,text,text,bigint,real),
  public.fail_media_retrieval_job(uuid,uuid,text,text) to service_role;
revoke all on function public.retry_failed_media_retrieval(uuid) from public,anon;
grant execute on function public.retry_failed_media_retrieval(uuid) to authenticated;

commit;
