-- Pořadí uložených pohledů 3D vieweru (drag & drop přeřazení v prezentaci).
-- Spustit v Supabase SQL editoru. Bezpečné spustit opakovaně.

ALTER TABLE model_views ADD COLUMN IF NOT EXISTS sort_order bigint;

-- existujícím pohledům nastav pořadí podle data vytvoření (per model)
WITH ordered AS (
  SELECT id, row_number() OVER (PARTITION BY model_id ORDER BY created_at) - 1 AS rn
  FROM model_views
  WHERE sort_order IS NULL
)
UPDATE model_views m SET sort_order = o.rn
FROM ordered o WHERE m.id = o.id;
