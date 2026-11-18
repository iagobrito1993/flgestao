create role anon nologin; create role authenticated nologin; create role authenticator login noinherit; grant anon, authenticated to authenticator;
create schema auth; create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('test.uid',true),''), nullif(current_setting('request.jwt.claims',true),'')::json->>'sub')::uuid $$;
grant usage on schema auth to anon, authenticated; grant select on auth.users to authenticated;
create schema storage; create table storage.buckets(id text primary key,name text,public boolean); create table storage.objects(id serial, bucket_id text);
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
