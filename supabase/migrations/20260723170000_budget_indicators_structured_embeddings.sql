-- Wave 3b: budget_indicators embedding/citation integrity.
--
-- Embedding generation now uses a structured-column representation built in
-- supabase/functions/_shared/budget-indicator.ts. raw_extracted_text remains
-- the citeable source span and is not rewritten by this migration.
--
-- The unique index is intentionally row-granular: it prevents duplicate
-- extracted indicator rows while preserving legitimate same indicator names
-- across fiscal years, chunks, stages, departments, programs, and values.

CREATE UNIQUE INDEX budget_indicators_natural_key_uidx
  ON public.budget_indicators (
    document_id,
    chunk_sequence,
    fiscal_year,
    COALESCE(department, ''),
    COALESCE(program, ''),
    indicator_name,
    COALESCE(value_actual::text, ''),
    COALESCE(value_target::text, ''),
    COALESCE(value_prior_year::text, ''),
    COALESCE(unit, ''),
    COALESCE(effective_date::text, ''),
    COALESCE(effective_date_source, ''),
    md5(raw_extracted_text)
  );
