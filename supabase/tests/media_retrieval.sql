-- Run after migrations 001-008 in a local Supabase database.
begin;
do $$
declare
  fixture_user uuid;
  fixture_item uuid:=gen_random_uuid();
  direct_item uuid:=gen_random_uuid();
  fixture_job public.media_retrieval_jobs%rowtype;
begin
  select u.id into fixture_user from auth.users as u limit 1;
  if fixture_user is null then raise exception 'Create a local Supabase Auth user before running this test.'; end if;
  perform set_config('request.jwt.claim.sub',fixture_user::text,true);
  perform set_config('request.jwt.claim.role','service_role',true);

  perform public.create_saved_item_with_retrieval(
    fixture_item,fixture_user,'https://www.instagram.com/reel/abc123/?igsh=fixture',
    'Atomic retrieval test','user notes',array['test'],true
  );
  if not exists(select 1 from public.saved_items s where s.id=fixture_item
      and s.media_retrieval_status='pending' and s.media_retrieval_version=1) then
    raise exception 'The saved Reel was not created with its retrieval state.';
  end if;
  select j.* into fixture_job from public.media_retrieval_jobs as j where j.item_id=fixture_item;
  if fixture_job.id is null or fixture_job.status<>'queued'
     or fixture_job.source_url<>'https://www.instagram.com/reel/abc123/' then
    raise exception 'The atomic save did not enqueue a canonical retrieval job.';
  end if;
  perform set_config('test.recall_fixture_item',fixture_item::text,true);

  -- Browser-authenticated direct writes cannot enable the server-only opt-in.
  perform set_config('request.jwt.claim.role','authenticated',true);
  insert into public.saved_items(id,user_id,source_url,title,media_retrieval_opt_in)
    values(direct_item,fixture_user,'https://www.instagram.com/reel/other123/','Direct insert',true);
  if not exists(select 1 from public.saved_items s where s.id=direct_item
      and s.media_retrieval_opt_in=false and s.media_retrieval_status='not_requested') then
    raise exception 'A browser insert unexpectedly enabled media retrieval.';
  end if;
  if exists(select 1 from public.media_retrieval_jobs j where j.item_id=direct_item) then
    raise exception 'A browser insert unexpectedly created a retrieval job.';
  end if;

  if not (select c.relrowsecurity from pg_catalog.pg_class c
          where c.oid='public.media_retrieval_jobs'::regclass) then
    raise exception 'Retrieval queue must have RLS enabled.';
  end if;
  if has_table_privilege('authenticated','public.media_retrieval_jobs','SELECT') then
    raise exception 'Authenticated browser users must not read retrieval jobs.';
  end if;
  if has_function_privilege('authenticated',
       'public.create_saved_item_with_retrieval(uuid,uuid,text,text,text,text[],boolean)','EXECUTE') then
    raise exception 'Only the trusted server may invoke the opt-in atomic save RPC.';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_policies p
    where p.schemaname='public' and p.tablename='saved_items'
      and p.cmd='SELECT' and p.qual like '%auth.uid%user_id%'
  ) then
    raise exception 'Saved-item reads must retain user-scoped RLS.';
  end if;
  if (select column_default from information_schema.columns
      where table_schema='public' and table_name='saved_items'
        and column_name='media_retrieval_opt_in')<>'false' then
    raise exception 'Existing rows must default to retrieval disabled.';
  end if;
end;
$$;

-- A different authenticated user must not see the saved item through RLS.
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000000',true);
do $$
begin
  if exists(select 1 from public.saved_items
            where id=current_setting('test.recall_fixture_item')::uuid) then
    raise exception 'A different user can read another user''s saved item.';
  end if;
end;
$$;
reset role;
rollback;
