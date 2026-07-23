-- Wave 3a: collapse byte-identical Municode ordinance duplicate rows and
-- repair stale/missing is_current pointers.
--
-- Derived from live production on 2026-07-23 and intentionally guarded:
--   duplicate (municode_node_id, content_hash) groups: 224
--   duplicate rows in those groups: 1,369
--   duplicate excess rows to delete: 1,145
--   stale-current nodes: 46
--   missing-current nodes: 58
--
-- Do not apply before PR review coordination.

DO $$
DECLARE
  duplicate_group_count integer;
  duplicate_row_count integer;
  duplicate_excess_count integer;
  stale_current_count integer;
  missing_current_count integer;
  crosswalk_conflict_count integer;
  crosswalk_duplicate_ref_count integer;
  deleted_count integer;
  post_duplicate_group_count integer;
  post_stale_current_count integer;
  post_missing_current_count integer;
BEGIN
  WITH duplicate_groups AS (
    SELECT municode_node_id, content_hash, count(*) AS n
    FROM public.ordinance_provisions
    WHERE source_type = 'municode'
    GROUP BY municode_node_id, content_hash
    HAVING count(*) > 1
  ),
  stale AS (
    SELECT c.municode_node_id
    FROM public.ordinance_provisions c
    WHERE c.source_type = 'municode'
      AND c.is_current = true
      AND EXISTS (
        SELECT 1
        FROM public.ordinance_provisions s
        WHERE s.source_type = 'municode'
          AND s.municode_node_id = c.municode_node_id
          AND s.effective_date > c.effective_date
      )
  ),
  missing AS (
    SELECT municode_node_id
    FROM public.ordinance_provisions
    WHERE source_type = 'municode'
    GROUP BY municode_node_id
    HAVING count(*) FILTER (WHERE is_current) = 0
  )
  SELECT
    (SELECT count(*) FROM duplicate_groups),
    (SELECT coalesce(sum(n), 0) FROM duplicate_groups),
    (SELECT coalesce(sum(n - 1), 0) FROM duplicate_groups),
    (SELECT count(*) FROM stale),
    (SELECT count(*) FROM missing)
  INTO
    duplicate_group_count,
    duplicate_row_count,
    duplicate_excess_count,
    stale_current_count,
    missing_current_count;

  IF duplicate_group_count = 0
    AND duplicate_row_count = 0
    AND duplicate_excess_count = 0
    AND stale_current_count = 0
    AND missing_current_count = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS ordinance_provisions_municode_node_content_hash_key
      ON public.ordinance_provisions (municode_node_id, content_hash)
      WHERE source_type = 'municode';
    RETURN;
  END IF;

  IF duplicate_group_count <> 224
    OR duplicate_row_count <> 1369
    OR duplicate_excess_count <> 1145
    OR stale_current_count <> 46
    OR missing_current_count <> 58 THEN
    RAISE EXCEPTION
      'Unexpected ordinance cleanup preconditions: duplicate groups %, duplicate rows %, duplicate excess %, stale-current %, missing-current %',
      duplicate_group_count,
      duplicate_row_count,
      duplicate_excess_count,
      stale_current_count,
      missing_current_count;
  END IF;

  CREATE TEMP TABLE _ordinance_duplicate_map ON COMMIT DROP AS
  WITH duplicate_groups AS (
    SELECT municode_node_id, content_hash
    FROM public.ordinance_provisions
    WHERE source_type = 'municode'
    GROUP BY municode_node_id, content_hash
    HAVING count(*) > 1
  ),
  ranked AS (
    SELECT
      op.id,
      first_value(op.id) OVER (
        PARTITION BY op.municode_node_id, op.content_hash
        ORDER BY op.effective_date DESC, op.is_current DESC, op.created_at DESC, op.id DESC
      ) AS keeper_id,
      row_number() OVER (
        PARTITION BY op.municode_node_id, op.content_hash
        ORDER BY op.effective_date DESC, op.is_current DESC, op.created_at DESC, op.id DESC
      ) AS rank_in_group
    FROM public.ordinance_provisions op
    JOIN duplicate_groups dg
      ON dg.municode_node_id = op.municode_node_id
     AND dg.content_hash = op.content_hash
    WHERE op.source_type = 'municode'
  )
  SELECT id AS old_id, keeper_id
  FROM ranked
  WHERE rank_in_group > 1;

  SELECT count(*)
  INTO crosswalk_conflict_count
  FROM (
    SELECT m.keeper_id
    FROM public.ordinance_section_crosswalk cw
    JOIN _ordinance_duplicate_map m ON m.old_id = cw.ordinance_provision_id
    GROUP BY m.keeper_id
    HAVING count(*) > 1
  ) conflicts;

  SELECT count(*)
  INTO crosswalk_duplicate_ref_count
  FROM public.ordinance_section_crosswalk cw
  JOIN _ordinance_duplicate_map m ON m.old_id = cw.ordinance_provision_id
  JOIN public.ordinance_section_crosswalk existing
    ON existing.ordinance_provision_id = m.keeper_id;

  IF crosswalk_conflict_count <> 0 OR crosswalk_duplicate_ref_count <> 0 THEN
    RAISE EXCEPTION
      'ordinance_section_crosswalk would violate unique ordinance_provision_id on duplicate repoint: duplicate keeper refs %, keeper already referenced %',
      crosswalk_conflict_count,
      crosswalk_duplicate_ref_count;
  END IF;

  UPDATE public.code_reconciliation_logs l
  SET ordinance_provision_id = m.keeper_id
  FROM _ordinance_duplicate_map m
  WHERE l.ordinance_provision_id = m.old_id;

  UPDATE public.ordinance_section_crosswalk cw
  SET ordinance_provision_id = m.keeper_id
  FROM _ordinance_duplicate_map m
  WHERE cw.ordinance_provision_id = m.old_id;

  DELETE FROM public.ordinance_provisions op
  USING _ordinance_duplicate_map m
  WHERE op.id = m.old_id;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  IF deleted_count <> 1145 THEN
    RAISE EXCEPTION 'Expected to delete 1145 byte-identical duplicate ordinance rows, deleted %', deleted_count;
  END IF;

  CREATE TEMP TABLE _ordinance_current_repair ON COMMIT DROP AS
  WITH ranked AS (
    SELECT
      op.id,
      op.municode_node_id,
      op.effective_date,
      op.is_current,
      first_value(op.id) OVER (
        PARTITION BY op.municode_node_id
        ORDER BY op.effective_date DESC, op.created_at DESC, op.id DESC
      ) AS newest_id,
      first_value(op.effective_date) OVER (
        PARTITION BY op.municode_node_id
        ORDER BY op.effective_date DESC, op.created_at DESC, op.id DESC
      ) AS newest_effective_date,
      bool_or(op.is_current) OVER (PARTITION BY op.municode_node_id) AS has_current
    FROM public.ordinance_provisions op
    WHERE op.source_type = 'municode'
  )
  SELECT DISTINCT municode_node_id, newest_id, newest_effective_date
  FROM ranked
  WHERE (is_current = true AND id <> newest_id)
     OR has_current = false;

  IF (SELECT count(*) FROM _ordinance_current_repair) <> 104 THEN
    RAISE EXCEPTION 'Expected 104 Municode nodes needing current-pointer repair after dedupe, found %',
      (SELECT count(*) FROM _ordinance_current_repair);
  END IF;

  UPDATE public.ordinance_provisions op
  SET
    is_current = false,
    superseded_date = CASE
      WHEN op.effective_date < r.newest_effective_date
        AND (op.superseded_date IS NULL OR op.superseded_date > r.newest_effective_date)
        THEN r.newest_effective_date
      ELSE op.superseded_date
    END,
    updated_at = now()
  FROM _ordinance_current_repair r
  WHERE op.municode_node_id = r.municode_node_id
    AND op.source_type = 'municode'
    AND op.id <> r.newest_id
    AND op.is_current = true;

  UPDATE public.ordinance_provisions op
  SET
    is_current = true,
    superseded_date = NULL,
    updated_at = now()
  FROM _ordinance_current_repair r
  WHERE op.id = r.newest_id
    AND op.source_type = 'municode';

  WITH duplicate_groups AS (
    SELECT 1
    FROM public.ordinance_provisions
    WHERE source_type = 'municode'
    GROUP BY municode_node_id, content_hash
    HAVING count(*) > 1
  ),
  stale AS (
    SELECT 1
    FROM public.ordinance_provisions c
    WHERE c.source_type = 'municode'
      AND c.is_current = true
      AND EXISTS (
        SELECT 1
        FROM public.ordinance_provisions s
        WHERE s.source_type = 'municode'
          AND s.municode_node_id = c.municode_node_id
          AND s.effective_date > c.effective_date
      )
  ),
  missing AS (
    SELECT 1
    FROM public.ordinance_provisions
    WHERE source_type = 'municode'
    GROUP BY municode_node_id
    HAVING count(*) FILTER (WHERE is_current) = 0
  )
  SELECT
    (SELECT count(*) FROM duplicate_groups),
    (SELECT count(*) FROM stale),
    (SELECT count(*) FROM missing)
  INTO post_duplicate_group_count, post_stale_current_count, post_missing_current_count;

  IF post_duplicate_group_count <> 0
    OR post_stale_current_count <> 0
    OR post_missing_current_count <> 0 THEN
    RAISE EXCEPTION
      'Ordinance cleanup postconditions failed: duplicate groups %, stale-current %, missing-current %',
      post_duplicate_group_count,
      post_stale_current_count,
      post_missing_current_count;
  END IF;

  CREATE UNIQUE INDEX IF NOT EXISTS ordinance_provisions_municode_node_content_hash_key
    ON public.ordinance_provisions (municode_node_id, content_hash)
    WHERE source_type = 'municode';
END $$;
