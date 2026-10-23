-- Run only against a local Supabase test database after migrations 001-004.
-- Uses an existing Auth user but rolls all fixture data back.
begin;

do $$
declare
  fixture_user uuid;
  fixture_item uuid := pg_catalog.gen_random_uuid();
  claimed record;
  latest_claim record;
  vector_text text := '[' || array_to_string(array_fill(0::float8, array[768]), ',') || ']';
  stored boolean;
  retry_state text;
  active_jobs integer;
  item_version bigint;
  item_status text;
begin
  select id into fixture_user from auth.users limit 1;
  if fixture_user is null then
    raise exception 'Create a local Supabase Auth user before running this integration test.';
  end if;
  perform set_config('request.jwt.claim.sub', fixture_user::text, true);

  -- Insert and edit both enqueue in the same transaction, each with a version.
  insert into public.saved_items (id, user_id, source_url, title, notes, tags)
  values (fixture_item, fixture_user, 'https://example.test/reel', 'First title', 'First note', array['one']);

  select embedding_content_version into item_version
    from public.saved_items where id = fixture_item;
  if item_version <> 1 then raise exception 'New item version should start at 1.'; end if;

  update public.saved_items set notes = 'Second note' where id = fixture_item;
  select embedding_content_version into item_version
    from public.saved_items where id = fixture_item;
  if item_version <> 2 then raise exception 'Text edits should increment the content version.'; end if;

  select count(*) into active_jobs
    from public.embedding_jobs
   where item_id = fixture_item and content_version = 2 and status = 'queued';
  if active_jobs <> 1 then raise exception 'Edit should create exactly one active job for its version.'; end if;

  -- The partial unique index prevents a duplicate active job for that version.
  insert into public.embedding_jobs (item_id, user_id, content_version)
  values (fixture_item, fixture_user, 2)
  on conflict (item_id, content_version)
    where status in ('queued', 'processing')
  do nothing;
  select count(*) into active_jobs
    from public.embedding_jobs
   where item_id = fixture_item and content_version = 2 and status = 'queued';
  if active_jobs <> 1 then raise exception 'Duplicate enqueue created a second active job.'; end if;

  -- Claim version 2, edit during processing, then prove its completion is rejected.
  select * into claimed from public.claim_embedding_job('sql-integration-test');
  if claimed.item_id <> fixture_item or claimed.content_version <> 2 then
    raise exception 'Worker did not claim the expected latest job.';
  end if;
  update public.saved_items set title = 'Newest title' where id = fixture_item;
  select public.complete_embedding_job(
    claimed.job_id, claimed.claim_token, claimed.content_version, vector_text, 'nomic-embed-text'
  ) into stored;
  if stored then raise exception 'A stale job must not store an embedding.'; end if;

  select embedding_content_version, embedding_status
    into item_version, item_status
    from public.saved_items where id = fixture_item;
  if item_version <> 3 or item_status <> 'pending' then
    raise exception 'The edited item should remain pending at the latest version.';
  end if;
  if (select embedding is not null from public.saved_items where id = fixture_item) then
    raise exception 'Stale completion unexpectedly wrote a vector.';
  end if;

  -- Claim latest version and confirm failure schedules a retry with a delay.
  select * into latest_claim from public.claim_embedding_job('sql-integration-test');
  if latest_claim.item_id <> fixture_item or latest_claim.content_version <> 3 then
    raise exception 'Worker did not claim the newest content version.';
  end if;
  select public.fail_embedding_job(
    latest_claim.job_id, latest_claim.claim_token, latest_claim.content_version, 'Ollama unavailable'
  ) into retry_state;
  if retry_state <> 'retrying' then raise exception 'Transient failure should be retried.'; end if;
  if not exists (
    select 1 from public.embedding_jobs
     where id = latest_claim.job_id and status = 'queued' and available_at > now()
  ) then raise exception 'Retry should use delayed exponential backoff.'; end if;
end;
$$;

rollback;
