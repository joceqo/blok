// The caller scopes the pages alias p to documents the current account can read.
// Project only user-facing text fields. Attachments can contain large inline data URLs.
//
// A field holds rich text as segments — [{ text, marks? } | { embed, marks? }] — which is how every
// editor block saves it (types/rich-text.d.ts). Older documents and plain fields like a code block
// hold a bare string. Read both: reading only strings leaves real pages out of the index with no
// error, and reading an array with ->> would index its raw JSON.
export const pageSearchText = `coalesce((
  SELECT string_agg(regexp_replace(extracted.value, '<[^>]+>', ' ', 'g'), E'\n' ORDER BY ord)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.content->'blocks')='array' THEN p.content->'blocks' ELSE '[]' END)
    WITH ORDINALITY AS blocks(b,ord)
  CROSS JOIN LATERAL (
    SELECT string_agg(part, ' ') AS value FROM (
      SELECT CASE jsonb_typeof(field)
        WHEN 'string' THEN field #>> '{}'
        -- Segments of one field join with no separator: they are one run of text.
        WHEN 'array' THEN (SELECT string_agg(segment->>'text', '' ORDER BY seat)
          FROM jsonb_array_elements(field) WITH ORDINALITY AS segments(segment,seat)
          WHERE jsonb_typeof(segment)='object')
      END AS part
      FROM unnest(ARRAY[b->'data'->'text', b->'data'->'caption', b->'data'->'code', b->'data'->'title']) AS field
    ) fields WHERE part IS NOT NULL AND part <> ''
  ) extracted
  WHERE extracted.value IS NOT NULL AND extracted.value <> ''
), '')`;
