// The caller scopes the pages alias p to documents the current account can read.
// Project only user-facing text fields. Attachments can contain large inline data URLs.
export const pageSearchText = `coalesce((
  SELECT string_agg(regexp_replace(
    coalesce(b->'data'->>'text', b->'data'->>'caption', b->'data'->>'code', b->'data'->>'title'), '<[^>]+>', ' ', 'g'
  ), E'\n' ORDER BY ord)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.content->'blocks')='array' THEN p.content->'blocks' ELSE '[]' END)
    WITH ORDINALITY AS blocks(b,ord)
  WHERE jsonb_typeof(b->'data'->'text')='string' OR jsonb_typeof(b->'data'->'caption')='string'
    OR jsonb_typeof(b->'data'->'code')='string' OR jsonb_typeof(b->'data'->'title')='string'
), '')`;
