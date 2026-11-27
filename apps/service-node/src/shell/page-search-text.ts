// The caller scopes the pages alias p to documents the current account can read.
// Project only user-facing text fields. Attachments can contain large inline data URLs.
//
// A field holds rich text as segments — [{ text, marks? } | { embed, marks? }] — which is how every
// editor block saves it (types/rich-text.d.ts). Older documents and plain fields like a code block
// hold a bare string. Read both: reading only strings leaves real pages out of the index with no
// error, and reading an array with ->> would index its raw JSON.
//
// `b` is the block being read. Both exports below bind it.
const blockText = `(
  SELECT string_agg(part, ' ') FROM (
    SELECT CASE jsonb_typeof(field)
      WHEN 'string' THEN field #>> '{}'
      -- Segments of one field join with no separator: they are one run of text.
      WHEN 'array' THEN (SELECT string_agg(segment->>'text', '' ORDER BY seat)
        FROM jsonb_array_elements(field) WITH ORDINALITY AS segments(segment,seat)
        WHERE jsonb_typeof(segment)='object')
    END AS part
    FROM unnest(ARRAY[b->'data'->'text', b->'data'->'caption', b->'data'->'code', b->'data'->'title']) AS field
  ) fields WHERE part IS NOT NULL AND part <> ''
)`;

const blocksOf = `jsonb_array_elements(CASE WHEN jsonb_typeof(p.content->'blocks')='array' THEN p.content->'blocks' ELSE '[]' END)
  WITH ORDINALITY AS blocks(b,ord)`;

/** Every readable word of a page, in reading order. One value per page, for previews. */
export const pageSearchText = `coalesce((
  SELECT string_agg(regexp_replace(extracted.value, '<[^>]+>', ' ', 'g'), E'\n' ORDER BY ord)
  FROM ${blocksOf}
  CROSS JOIN LATERAL (SELECT ${blockText} AS value) extracted
  WHERE extracted.value IS NOT NULL AND extracted.value <> ''
), '')`;

/**
 * The same text, one row per block, so a match can cite the block it came from.
 * Join it with LEFT JOIN LATERAL: a page with no readable block still has to be findable by title,
 * and a block saved without an id yields a null block_id rather than dropping out.
 */
export const pageBlockText = `(
  SELECT b->>'id' AS block_id, regexp_replace(extracted.value, '<[^>]+>', ' ', 'g') AS body
  FROM ${blocksOf}
  CROSS JOIN LATERAL (SELECT ${blockText} AS value) extracted
  WHERE extracted.value IS NOT NULL AND extracted.value <> ''
)`;
