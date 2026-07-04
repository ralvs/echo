-- Harden SECURITY DEFINER RPCs: they exist for Echo's own service-role callers
-- (lib/ and echo-mcp), not for the public PostgREST surface. Postgres grants
-- EXECUTE to PUBLIC by default, which left them callable by anon/authenticated.
revoke execute on function public.upsert_entity(text, text) from public, anon, authenticated;
revoke execute on function public.upsert_entity_edge(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.get_thought_stats() from public, anon, authenticated;

grant execute on function public.upsert_entity(text, text) to service_role;
grant execute on function public.upsert_entity_edge(uuid, uuid, text) to service_role;
grant execute on function public.get_thought_stats() to service_role;

-- Pinned to public (not '') because the 00023 body uses unqualified table refs.
alter function public.get_thought_stats() set search_path = public;
