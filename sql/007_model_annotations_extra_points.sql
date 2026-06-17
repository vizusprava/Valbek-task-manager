-- Další ukotvené body anotace — z jednoho textového boxu vede víc spojnic s tečkami.
-- Spustit v Supabase SQL editoru. Bezpečné spustit opakovaně.

ALTER TABLE model_annotations ADD COLUMN IF NOT EXISTS extra_points jsonb NOT NULL DEFAULT '[]'::jsonb;
