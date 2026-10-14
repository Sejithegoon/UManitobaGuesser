-- Tiny pgTAP-compatible subset for the offline PGlite harness (PGlite does not
-- ship pgTAP). Implements only what supabase/tests/database/*.sql uses:
-- plan, pass, ok, is, throws_ok, lives_ok, finish. Real runs use pgTAP via
-- `supabase test db`.

create schema tap;
grant usage on schema tap to public;

create table tap.state (planned int, ran int not null default 0, failed int not null default 0);
grant all on tap.state to public;

create function tap.record(passed boolean, descr text) returns text language plpgsql as $$
declare n int;
begin
  update tap.state set ran = ran + 1, failed = failed + (case when passed then 0 else 1 end)
  returning ran into n;
  return (case when passed then 'ok ' else 'not ok ' end) || n || ' - ' || coalesce(descr, '');
end $$;

create function tap.plan(n int) returns text language plpgsql as $$
begin
  delete from tap.state;
  insert into tap.state (planned) values (n);
  return '1..' || n;
end $$;

create function tap.pass(descr text) returns text language sql as $$ select tap.record(true, descr) $$;
create function tap.ok(cond boolean, descr text) returns text language sql as $$ select tap.record(coalesce(cond, false), descr) $$;

create function tap.is(got anyelement, want anyelement, descr text) returns text language plpgsql as $$
begin
  if got is not distinct from want then return tap.record(true, descr); end if;
  return tap.record(false, descr || format(' (got %s, expected %s)', coalesce(got::text, 'NULL'), coalesce(want::text, 'NULL')));
end $$;

create function tap.throws_ok(query text, errcode text, errmsg text, descr text) returns text language plpgsql as $$
begin
  execute query;
  return tap.record(false, descr || ' (no error was raised)');
exception when others then
  if (errcode is null or sqlstate = errcode) and (errmsg is null or sqlerrm = errmsg) then
    return tap.record(true, descr);
  end if;
  return tap.record(false, descr || format(' (got %s: %s)', sqlstate, sqlerrm));
end $$;

create function tap.lives_ok(query text, descr text) returns text language plpgsql as $$
begin
  execute query;
  return tap.record(true, descr);
exception when others then
  return tap.record(false, descr || format(' (died %s: %s)', sqlstate, sqlerrm));
end $$;

create function tap.finish() returns setof text language plpgsql as $$
declare s tap.state;
begin
  select * into s from tap.state;
  if s.planned is distinct from s.ran then
    return next format('not ok - planned %s tests but ran %s', s.planned, s.ran);
  end if;
  if s.failed > 0 then
    return next format('# failed %s of %s', s.failed, s.ran);
  end if;
end $$;

grant execute on all functions in schema tap to public;
