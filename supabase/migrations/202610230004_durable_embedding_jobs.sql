-- Durable Stage 2 indexing queue. Additive: existing text and vectors are kept.
begin;

alter table public.saved_items
  add column if not exists embedding_status text not null default 'pending',
  add column if not exists embedding_error text,
  add column if not exists embedding_content_version bigint not null default 0,
  add column if not exists embedding_updated_at timestamptz;
update public.saved_items set embedding_status='ready'
 where embedding is not null and embedding_status='pending';

create table if not exists public.embedding_jobs (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.saved_items(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  content_version bigint not null,
  status text not null default 'queued' check(status in ('queued','processing','succeeded','failed','superseded')),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  available_at timestamptz not null default now(),
  locked_until timestamptz,
  claim_token uuid,
  locked_by text,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create unique index if not exists embedding_jobs_one_active_version_idx
  on public.embedding_jobs(item_id,content_version) where status in ('queued','processing');
create index if not exists embedding_jobs_claim_idx on public.embedding_jobs(available_at,created_at) where status='queued';
alter table public.embedding_jobs enable row level security;
revoke all on public.embedding_jobs from anon,authenticated;
grant select,insert,update,delete on public.embedding_jobs to service_role;

create or replace function public.enqueue_saved_item_embedding_version()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' then
    new.embedding_content_version:=greatest(coalesce(new.embedding_content_version,0),1);
    if new.embedding is null then new.embedding_status:='pending'; end if;
  elsif row(new.title,new.notes,new.tags) is distinct from row(old.title,old.notes,old.tags) then
    new.embedding_content_version:=coalesce(old.embedding_content_version,0)+1;
    new.embedding_status:='pending'; new.embedding_error:=null;
  end if;
  return new;
end;
$$;
drop trigger if exists saved_items_embedding_version on public.saved_items;
create trigger saved_items_embedding_version before insert or update of title,notes,tags on public.saved_items
for each row execute function public.enqueue_saved_item_embedding_version();

create or replace function public.enqueue_saved_item_embedding_job()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' or new.embedding_content_version is distinct from old.embedding_content_version then
    if new.embedding is null then
      insert into public.embedding_jobs(item_id,user_id,content_version)
      values(new.id,new.user_id,new.embedding_content_version)
      on conflict(item_id,content_version) where status in ('queued','processing') do nothing;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists saved_items_embedding_job on public.saved_items;
create trigger saved_items_embedding_job after insert or update of title,notes,tags on public.saved_items
for each row execute function public.enqueue_saved_item_embedding_job();

create or replace function public.claim_embedding_job(worker_name text)
returns table(job_id uuid,item_id uuid,user_id uuid,content_version bigint,claim_token uuid,title text,notes text,tags text[],attempts integer,max_attempts integer)
language plpgsql security definer set search_path='' as $$
declare picked public.embedding_jobs%rowtype; item public.saved_items%rowtype;
begin
  select * into picked from public.embedding_jobs j where (j.status='queued' and j.available_at<=now())
    or (j.status='processing' and j.lease_expires_at<now())
    order by j.available_at,j.created_at for update skip locked limit 1;
  if not found then return; end if;
  update public.embedding_jobs j set status='processing',attempts=j.attempts+1,locked_by=claim_embedding_job.worker_name,
    claim_token=gen_random_uuid(),lease_expires_at=now()+interval '3 minutes',updated_at=now()
    where j.id=picked.id returning * into picked;
  select * into item from public.saved_items where id=picked.item_id;
  if not found or item.embedding_content_version<>picked.content_version then
    update public.embedding_jobs set status='superseded',lease_expires_at=null,claim_token=null,completed_at=now() where id=picked.id;
    return;
  end if;
  update public.saved_items set embedding_status='processing' where id=item.id and embedding_content_version=picked.content_version;
  return query select picked.id,picked.item_id,picked.user_id,picked.content_version,picked.claim_token,item.title,item.notes,item.tags,picked.attempts,picked.max_attempts;
end;
$$;

create or replace function public.complete_embedding_job(target_job_id uuid,target_claim_token uuid,target_content_version bigint,item_embedding text,model_name text)
returns boolean language plpgsql security definer set search_path='' as $$
declare job public.embedding_jobs%rowtype;
begin
  select * into job from public.embedding_jobs where id=target_job_id for update;
  if not found or job.status<>'processing' or job.claim_token<>target_claim_token then return false; end if;
  update public.saved_items set embedding=item_embedding::extensions.vector(768),embedding_model=model_name,embedding_status='ready',embedding_error=null,embedding_updated_at=now()
    where id=job.item_id and user_id=job.user_id and embedding_content_version=target_content_version;
  if not found then
    update public.embedding_jobs set status='superseded',claim_token=null,lease_expires_at=null,completed_at=now(),updated_at=now() where id=job.id;
    return false;
  end if;
  update public.embedding_jobs set status='succeeded',claim_token=null,lease_expires_at=null,last_error=null,completed_at=now(),updated_at=now() where id=job.id;
  return true;
end;
$$;

create or replace function public.fail_embedding_job(target_job_id uuid,target_claim_token uuid,target_content_version bigint,safe_error text)
returns text language plpgsql security definer set search_path='' as $$
declare job public.embedding_jobs%rowtype; next_status text;
begin
  select * into job from public.embedding_jobs where id=target_job_id for update;
  if not found or job.claim_token<>target_claim_token then return 'superseded'; end if;
  next_status:=case when job.attempts>=job.max_attempts then 'failed' else 'queued' end;
  update public.embedding_jobs set status=next_status,claim_token=null,lease_expires_at=null,
    available_at=case when next_status='queued' then now()+make_interval(secs=>least(3600,5*power(2,least(job.attempts-1,10))::integer)) else available_at end,
    last_error=left(safe_error,1000),completed_at=case when next_status='failed' then now() else null end,updated_at=now() where id=job.id;
  update public.saved_items set embedding_status=case when next_status='failed' then 'failed' else 'pending' end,embedding_error=left(safe_error,1000)
    where id=job.item_id and embedding_content_version=target_content_version;
  return case when next_status='failed' then 'failed' else 'retrying' end;
end;
$$;

create or replace function public.count_unqueued_saved_item_embeddings()
returns bigint language sql stable security invoker set search_path='' as $$
 select count(*) from public.saved_items s where s.user_id=(select auth.uid()) and s.embedding is null
 and not exists(select 1 from public.embedding_jobs j where j.item_id=s.id and j.status in ('queued','processing'));
$$;
create or replace function public.enqueue_missing_saved_item_embeddings()
returns bigint language plpgsql security invoker set search_path='' as $$
declare queued bigint;
begin
 insert into public.embedding_jobs(item_id,user_id,content_version)
 select s.id,s.user_id,s.embedding_content_version from public.saved_items s
 where s.user_id=(select auth.uid()) and s.embedding is null
 and not exists(select 1 from public.embedding_jobs j where j.item_id=s.id and j.status in ('queued','processing'))
 on conflict(item_id,content_version) where status in ('queued','processing') do nothing;
 get diagnostics queued=row_count; return queued;
end;
$$;
create or replace function public.retry_failed_saved_item_embeddings()
returns bigint language plpgsql security invoker set search_path='' as $$
declare queued bigint;
begin
 insert into public.embedding_jobs(item_id,user_id,content_version)
 select s.id,s.user_id,s.embedding_content_version from public.saved_items s
 where s.user_id=(select auth.uid()) and s.embedding_status='failed'
 on conflict(item_id,content_version) where status in ('queued','processing') do nothing;
 get diagnostics queued=row_count;
 update public.saved_items set embedding_status='pending',embedding_error=null where user_id=(select auth.uid()) and embedding_status='failed';
 return queued;
end;
$$;

revoke all on function public.claim_embedding_job(text) from public,anon,authenticated;
revoke all on function public.complete_embedding_job(uuid,uuid,bigint,text,text) from public,anon,authenticated;
revoke all on function public.fail_embedding_job(uuid,uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.claim_embedding_job(text),public.complete_embedding_job(uuid,uuid,bigint,text,text),public.fail_embedding_job(uuid,uuid,bigint,text) to service_role;
grant execute on function public.count_unqueued_saved_item_embeddings(),public.enqueue_missing_saved_item_embeddings(),public.retry_failed_saved_item_embeddings() to authenticated;
commit;
