-- Store full-timeline metadata separately from user notes. This is additive:
-- it preserves existing saved items, queues, Nomic vectors, and EmbeddingGemma
-- vectors. Apply only after reviewing, and after 202610260001.
begin;

alter table public.saved_items
  add column if not exists metadata_summary text not null default '',
  add column if not exists metadata_transcript_summary text not null default '',
  add column if not exists metadata_visual_summary text not null default '';

-- Metadata summaries are part of the EmbeddingGemma metadata input. Keep them
-- in the same model-specific index and let the existing AFTER trigger enqueue
-- the latest metadata version.
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
    if row(new.title,new.notes,new.tags,new.metadata_summary)
       is distinct from row(old.title,old.notes,old.tags,old.metadata_summary) then
      new.embeddinggemma_metadata_version:=old.embeddinggemma_metadata_version+1;
      new.embeddinggemma_status:='pending'; new.embeddinggemma_error:=null;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists saved_items_embeddinggemma_versions on public.saved_items;
create trigger saved_items_embeddinggemma_versions
  before insert or update of title,notes,tags,metadata_summary,media_storage_key,media_version on public.saved_items
  for each row execute function public.prepare_saved_item_embeddinggemma_versions();

drop trigger if exists saved_items_embeddinggemma_jobs on public.saved_items;
create trigger saved_items_embeddinggemma_jobs
  after insert or update of title,notes,tags,metadata_summary,media_storage_key,media_version on public.saved_items
  for each row execute function public.enqueue_saved_item_embeddinggemma_jobs();

-- Preserve the existing job claim signature and return shape. The longer lease
-- covers full audio transcription plus sequential local vision batches.
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
    worker_name=target_worker_name,claim_token=gen_random_uuid(),locked_until=now()+interval '90 minutes',updated_at=now()
    where j.id=picked.id returning j.* into picked;
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

create or replace function public.complete_saved_item_metadata_job_v2(
  target_job_id uuid,target_claim_token uuid,target_media_version bigint,target_metadata_version bigint,
  generated_title text,generated_summary text,generated_notes text,generated_tags text[],
  generated_transcript_summary text,generated_visual_summary text,analysis_warnings text[] default '{}'
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
     or nullif(btrim(generated_summary),'') is null or length(generated_summary)>1800
     or length(generated_notes)>3000 or length(generated_transcript_summary)>1600
     or nullif(btrim(generated_visual_summary),'') is null or length(generated_visual_summary)>2400
     or coalesce(cardinality(generated_tags),0)>10
     or exists(select 1 from unnest(coalesce(generated_tags,'{}')) as t(value) where length(t.value)>48)
     or coalesce(cardinality(analysis_warnings),0)>10
     or exists(select 1 from unnest(coalesce(analysis_warnings,'{}')) as w(value) where length(w.value)>300) then
    raise exception 'Generated metadata failed validation';
  end if;
  update public.saved_items as s set
    title=case when not s.metadata_title_user_edited then btrim(generated_title) else s.title end,
    notes=case when not s.metadata_notes_user_edited then btrim(generated_notes) else s.notes end,
    tags=case when not s.metadata_tags_user_edited then coalesce(generated_tags,'{}') else s.tags end,
    metadata_summary=btrim(generated_summary),
    metadata_transcript_summary=btrim(generated_transcript_summary),
    metadata_visual_summary=btrim(generated_visual_summary),
    metadata_generation_status=case when cardinality(coalesce(analysis_warnings,'{}'))>0 then 'partially_ready' else 'ready' end,
    metadata_generation_error=null,
    metadata_generation_warnings=coalesce(analysis_warnings,'{}')
   where s.id=item.id and s.user_id=job.user_id and s.media_version=target_media_version
     and s.metadata_generation_version=target_metadata_version;
  if not found then return false; end if;
  update public.saved_item_metadata_jobs as j set status='succeeded',claim_token=null,locked_until=null,
    last_error=null,completed_at=now(),updated_at=now() where j.id=job.id;
  return true;
end;
$$;

-- Keep keyword fallback useful when local embedding inference is unavailable.
-- Return shape and authenticated/RLS scoping match the existing RPC.
create or replace function public.search_saved_items(search_term text)
returns table (
  id uuid,user_id uuid,source_url text,title text,notes text,tags text[],created_at timestamptz,updated_at timestamptz,rank real
)
language sql stable security invoker set search_path='' as $$
  select s.id,s.user_id,s.source_url,s.title,s.notes,s.tags,s.created_at,s.updated_at,
    (case when s.title ilike '%'||search_term||'%' then 4.0 else 0.0 end
     + case when array_to_string(s.tags,' ') ilike '%'||search_term||'%' then 3.0 else 0.0 end
     + case when s.notes ilike '%'||search_term||'%' then 2.0 else 0.0 end
     + case when s.metadata_summary ilike '%'||search_term||'%' then 2.5 else 0.0 end
     + case when s.metadata_transcript_summary ilike '%'||search_term||'%' then 2.0 else 0.0 end
     + case when s.metadata_visual_summary ilike '%'||search_term||'%' then 1.5 else 0.0 end
     + case when s.source_url ilike '%'||search_term||'%' then 0.5 else 0.0 end)::real as rank
  from public.saved_items as s
  where (select auth.uid())=s.user_id and (
    s.title ilike '%'||search_term||'%' or array_to_string(s.tags,' ') ilike '%'||search_term||'%'
    or s.notes ilike '%'||search_term||'%' or s.metadata_summary ilike '%'||search_term||'%'
    or s.metadata_transcript_summary ilike '%'||search_term||'%'
    or s.metadata_visual_summary ilike '%'||search_term||'%' or s.source_url ilike '%'||search_term||'%'
  )
  order by rank desc,s.created_at desc;
$$;

revoke all on function public.prepare_saved_item_embeddinggemma_versions() from public,anon,authenticated;
revoke all on function public.search_saved_items(text) from public,anon;
grant execute on function public.search_saved_items(text) to authenticated;
revoke all on function public.complete_saved_item_metadata_job_v2(uuid,uuid,bigint,bigint,text,text,text,text[],text,text,text[]) from public,anon,authenticated;
grant execute on function public.complete_saved_item_metadata_job_v2(uuid,uuid,bigint,bigint,text,text,text,text[],text,text,text[]) to service_role;
revoke all on function public.claim_saved_item_metadata_job(text) from public,anon,authenticated;
grant execute on function public.claim_saved_item_metadata_job(text) to service_role;

notify pgrst,'reload schema';
commit;
