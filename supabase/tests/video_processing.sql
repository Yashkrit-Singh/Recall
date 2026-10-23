-- Run in a local Supabase test database after migrations 001-006.
-- Uses existing auth users and rolls all fixture rows back.
begin;
do $$
declare
  fixture_user uuid;
  fixture_item uuid;
  fixture_job public.video_processing_jobs%rowtype;
  did_complete boolean;
begin
  select id into fixture_user from auth.users limit 1;
  if fixture_user is null then raise exception 'Create a local Supabase Auth user before running this test.'; end if;
  perform set_config('request.jwt.claim.sub',fixture_user::text,true);

  fixture_item := public.create_saved_video_with_job(
    'http://recall.local/uploaded-video','Queue test','Test notes',array['test'],
    '11111111-1111-4111-8111-111111111111.mp4','fixture.mp4','video/mp4',1024,5
  );
  if not exists(select 1 from public.saved_items where id=fixture_item and media_status='pending' and media_version=1) then
    raise exception 'Saved video metadata did not persist.';
  end if;
  select * into fixture_job from public.video_processing_jobs where item_id=fixture_item;
  if fixture_job.id is null or fixture_job.status<>'queued' then
    raise exception 'Video item and durable queue row were not inserted atomically.';
  end if;

  -- Simulate a worker lease, then change the media revision before completion.
  update public.video_processing_jobs set status='processing',claim_token=gen_random_uuid() where id=fixture_job.id returning * into fixture_job;
  update public.saved_items set media_version=media_version+1 where id=fixture_item;
  select public.complete_video_processing_job(
    fixture_job.id,fixture_job.claim_token,fixture_job.media_version,
    '[{"start":0,"end":1,"text":"stale text"}]'::jsonb,'[]'::jsonb,'[]'::jsonb,
    'stale text','ready',null
  ) into did_complete;
  if did_complete then raise exception 'A stale media job unexpectedly completed.'; end if;
  if exists(select 1 from public.saved_items where id=fixture_item and extracted_text<>'') then
    raise exception 'A stale extraction overwrote newer media state.';
  end if;
  if not exists(select 1 from public.video_processing_jobs where id=fixture_job.id and status='superseded') then
    raise exception 'Stale job was not marked superseded.';
  end if;
end;
$$;
rollback;
