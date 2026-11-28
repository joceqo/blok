// The caller scopes the pages alias p to documents the current account can read.
// Project only user-facing text fields. Attachments can contain large inline data URLs.
//
// A field holds rich text as segments — [{ text, marks? } | { embed, marks? }] — which is how every
// editor block saves it (types/rich-text.d.ts). Older documents and plain fields like a code block
// hold a bare string. Read both: reading only strings leaves real pages out of the index with no
// error, and reading an array with ->> would index its raw JSON.
//
// `b` is the block being read and `p` the page holding it. Both exports below bind them.

/** One field, read as text whichever of the two shapes it holds. Null when it holds neither. */
const textOf = (field: string) => `CASE jsonb_typeof(${field})
  WHEN 'string' THEN ${field} #>> '{}'
  -- Segments of one field join with no separator: they are one run of text.
  WHEN 'array' THEN (SELECT string_agg(segment->>'text', '' ORDER BY seat)
    FROM jsonb_array_elements(${field}) WITH ORDINALITY AS segments(segment,seat)
    WHERE jsonb_typeof(segment)='object')
  END`;

const arrayAt = (value: string) =>
  `CASE WHEN jsonb_typeof(${value})='array' THEN ${value} ELSE '[]' END`;

/**
 * Everything the page's databases declare, read once and joined before the blocks are walked.
 *
 * A row stores an option's id and a column's id, never their names — those live on the database
 * block's schema. Without this map a row indexes as "o-wait", a word no one can read, and the word
 * someone would search for is nowhere. Derived once per page: a thousand-row tracker re-deriving
 * its own vocabulary per row is the shape that made this cost seconds before.
 */
const COLUMNS = `jsonb_array_elements(${arrayAt("p.content->'blocks'")}) AS schemas(sb)
  CROSS JOIN LATERAL jsonb_array_elements(${arrayAt("sb->'data'->'schema'")}) AS declared(col)
  LEFT JOIN LATERAL jsonb_array_elements(${arrayAt("col->'config'->'options'")}) AS choices(choice) ON true`;

// One pass over the page's columns, not one per map: every page pays this, including the many
// that hold no database at all. A column repeated once per option aggregates to the same value.
const PAGE_SCHEMA = `LATERAL (SELECT
  jsonb_object_agg(col->>'id', col->>'name') FILTER (WHERE col ? 'id' AND col ? 'name') AS names,
  jsonb_object_agg(col->>'id', col->>'type') FILTER (WHERE col ? 'id' AND col ? 'type') AS kinds,
  -- Columns read in the order they are shown. Positions are fractional indices, so they sort.
  jsonb_object_agg(col->>'id', coalesce(col->>'position','')) FILTER (WHERE col ? 'id') AS spots,
  jsonb_object_agg(choice->>'id', choice->>'label')
    FILTER (WHERE jsonb_typeof(choice)='object' AND choice ? 'id' AND choice ? 'label') AS labels
  FROM ${COLUMNS}) page_schema`;

/** A database's own words: what it is called, and what its columns offer. */
const SCHEMA_WORDS = `(
  SELECT string_agg(word, ' ') FROM (
    SELECT col->>'name' AS word
      FROM jsonb_array_elements(${arrayAt("b->'data'->'schema'")}) AS mine(col)
    UNION ALL
    SELECT choice->>'label'
      FROM jsonb_array_elements(${arrayAt("b->'data'->'schema'")}) AS mine(col)
      CROSS JOIN LATERAL jsonb_array_elements(${arrayAt("col->'config'->'options'")}) AS choices(choice)
  ) schema_words
)`;

/**
 * A database row IS a block, and its column values are its content — the whole point of a tracker.
 * They are not blocks themselves (the architectural law), so nothing else reads them.
 *
 * Each value is named by its column: "En attente" alone could be anything, "État : En attente"
 * answers a question. Only the kinds that hold writing are read — a person, a relation or a file
 * stores ids, which would put a word no one can read in front of a reader.
 */
const PROPERTY_TEXT = `(
  SELECT string_agg(page_schema.names ->> key || ' : ' || said, ' · '
    ORDER BY coalesce(page_schema.spots ->> key, 'zz'), key)
  FROM (
    SELECT key, CASE page_schema.kinds ->> key
      WHEN 'select' THEN page_schema.labels ->> (value #>> '{}')
      WHEN 'status' THEN page_schema.labels ->> (value #>> '{}')
      WHEN 'multiSelect' THEN (SELECT string_agg(page_schema.labels ->> (item #>> '{}'), ', ' ORDER BY seat)
        FROM jsonb_array_elements(${arrayAt('value')}) WITH ORDINALITY AS items(item,seat))
      WHEN 'richText' THEN (SELECT string_agg(${textOf("held->'data'->'text'")}, ' ')
        FROM jsonb_array_elements(${arrayAt("value->'blocks'")}) AS kept(held))
      WHEN 'title' THEN ${textOf('value')}
      WHEN 'text' THEN ${textOf('value')}
      WHEN 'url' THEN ${textOf('value')}
      WHEN 'email' THEN ${textOf('value')}
      WHEN 'phone' THEN ${textOf('value')}
      END AS said
    FROM jsonb_each(CASE WHEN jsonb_typeof(b->'data'->'properties')='object'
      THEN b->'data'->'properties' ELSE '{}' END) AS held_values(key,value)
  ) said_rows
  WHERE said IS NOT NULL AND said <> '' AND page_schema.names ? key
)`;

// `alt` is what someone wrote about a picture, and the only thing a text index can know about it.
// `fileName` names an attachment the same way, and `description` is the line under a database's
// title — the one place someone says what the thing is for. The address is left out on purpose:
// a hashed file name is noise in front of a reader.
const FIELDS = `ARRAY[b->'data'->'text', b->'data'->'caption', b->'data'->'code',
  b->'data'->'title', b->'data'->'alt', b->'data'->'fileName', b->'data'->'description']`;

const blockText = `(
  SELECT string_agg(nullif(part, ''), ' ') FROM (
    SELECT ${textOf('field')} AS part FROM unnest(${FIELDS}) AS field
    UNION ALL SELECT ${PROPERTY_TEXT}
    UNION ALL SELECT ${SCHEMA_WORDS}
  ) fields
)`;

const blocksOf = `${PAGE_SCHEMA}, jsonb_array_elements(${arrayAt("p.content->'blocks'")})
  WITH ORDINALITY AS blocks(b,ord)`;

/** Every readable word of a page, in reading order. One value per page, for previews. */
export const pageSearchText = `coalesce((
  SELECT string_agg(regexp_replace(extracted.value, '<[^>]+>', ' ', 'g'), E'\n' ORDER BY ord)
  FROM ${blocksOf}
  CROSS JOIN LATERAL (SELECT ${blockText} AS value) extracted
  WHERE extracted.value <> ''
), '')`;

/**
 * The same text, one row per block, so a match can cite the block it came from.
 * Join it with LEFT JOIN LATERAL: a page with no readable block still has to be findable by title,
 * and a block saved without an id yields a null block_id rather than dropping out.
 */
export const pageBlockText = `(
  SELECT b->>'id' AS block_id, ord, regexp_replace(extracted.value, '<[^>]+>', ' ', 'g') AS body,
    b->>'type' AS block_type, b->>'parent' AS parent_id,
    -- What this block is called, for a child that wants to name it: a database titles its rows.
    CASE WHEN jsonb_typeof(b->'data'->'title')='string' THEN b->'data'->>'title' END AS label
  FROM ${blocksOf}
  CROSS JOIN LATERAL (SELECT ${blockText} AS value) extracted
  WHERE extracted.value <> ''
)`;
