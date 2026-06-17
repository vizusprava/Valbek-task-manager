-- Anotace přiřazené k uloženým pohledům (prezentace s naskakujícími poznámkami).
-- Spustit v Supabase SQL editoru. Bezpečné spustit opakovaně.

ALTER TABLE model_views ADD COLUMN IF NOT EXISTS annotation_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
