-- Fix the PL/pgSQL name collision between the RETURNS TABLE output
-- variable `media_version` and public.saved_items.media_version.
-- Replaces only the function; existing video jobs and saved media are untouched.
begin;

create or replace function public.claim_video_processing_job(worker_name text)
returns table(
  job_id uuid,
  item_id uuid,
  user_id uuid,
  media_version bigint,
  storage_key text,
  claim_token uuid,
  attempts integer,
  max_attempts integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  picked public.video_processing_jobs%rowtype;
begin
  select j.* into picked
  from public.video_processing_jobs as j
  where (j.status = 'queued' and j.available_at <= now())
     or (j.status = 'processing' and j.locked_until < now())
  order by j.available_at, j.created_at
  for update skip locked
  limit 1;

  if not found then
    return;
  end if;

  update public.video_processing_jobs as j
  set status = 'processing',
      attempts = j.attempts + 1,
      worker_name = claim_video_processing_job.worker_name,
      claim_token = gen_random_uuid(),
      locked_until = now() + interval '15 minutes',
      updated_at = now()
  where j.id = picked.id
  returning j.* into picked;

  update public.saved_items as s
  set media_status = 'processing',
      media_error = null
  where s.id = picked.item_id
    and s.media_version = picked.media_version;

  return query
  select picked.id,
         picked.item_id,
         picked.user_id,
         picked.media_version,
         picked.storage_key,
         picked.claim_token,
         picked.attempts,
         picked.max_attempts;
end;
$$;

-- CREATE OR REPLACE preserves the existing function owner and grants.
commit;
