-- Vlastní barva anotace (box + spojnice s tečkou). NULL = výchozí indigo.
-- Spustit v Supabase SQL editoru. Bezpečné spustit opakovaně.

ALTER TABLE model_annotations ADD COLUMN IF NOT EXISTS color text;
