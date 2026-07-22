-- Track advertised/adopted budget source stage through ingestion and give
-- extracted budget indicators the same effective-date shape used by
-- amendment_events.

ALTER TABLE public.pending_ingestions
  ADD COLUMN budget_stage text NULL CHECK (budget_stage IN ('advertised', 'adopted'));

ALTER TABLE public.documents
  ADD COLUMN budget_stage text NULL CHECK (budget_stage IN ('advertised', 'adopted'));

ALTER TABLE public.budget_indicators
  ADD COLUMN effective_date date NULL,
  ADD COLUMN effective_date_source text NULL CHECK (effective_date_source IN (
    'default', 'municode_note', 'bos_summary'
  ));

CREATE INDEX pending_ingestions_budget_stage_idx
  ON public.pending_ingestions (budget_stage)
  WHERE budget_stage IS NOT NULL;

CREATE INDEX documents_budget_stage_idx
  ON public.documents (budget_stage)
  WHERE budget_stage IS NOT NULL;

CREATE INDEX budget_indicators_effective_date_idx
  ON public.budget_indicators (effective_date)
  WHERE effective_date IS NOT NULL;

UPDATE public.documents
SET budget_stage = CASE
  WHEN lower(url) LIKE '%/fy20%/advertised/%' THEN 'advertised'
  WHEN lower(url) LIKE '%/fy20%/adopted/%'
    OR lower(url) LIKE '%/fy20%/adopted-package/%'
    OR lower(url) LIKE '%/fy20%/fy20%-adopted-package.pdf'
    OR lower(url) LIKE '%adopted%20budget%'
    OR lower(url) LIKE '%adopted-budget%'
    THEN 'adopted'
  ELSE budget_stage
END
WHERE doc_type = 'budget_pdf'
  AND budget_stage IS NULL;

UPDATE public.budget_indicators bi
SET
  effective_date = CASE
    WHEN d.budget_stage = 'adopted' AND bi.fiscal_year IS NOT NULL
      THEN make_date(bi.fiscal_year - 1, 7, 1)
    ELSE NULL
  END,
  effective_date_source = CASE
    WHEN d.budget_stage = 'adopted' AND bi.fiscal_year IS NOT NULL
      THEN 'default'
    ELSE NULL
  END
FROM public.documents d
WHERE bi.document_id = d.id
  AND d.doc_type = 'budget_pdf'
  AND (
    bi.effective_date IS DISTINCT FROM CASE
      WHEN d.budget_stage = 'adopted' AND bi.fiscal_year IS NOT NULL
        THEN make_date(bi.fiscal_year - 1, 7, 1)
      ELSE NULL
    END
    OR bi.effective_date_source IS DISTINCT FROM CASE
      WHEN d.budget_stage = 'adopted' AND bi.fiscal_year IS NOT NULL
        THEN 'default'
      ELSE NULL
    END
  );
