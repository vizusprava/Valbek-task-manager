-- Posun textového boxu anotace na obrazovce (drag). Tečka zůstává ukotvená na 3D bodě.
-- Spustit v Supabase SQL editoru. Bezpečné spustit opakovaně.

ALTER TABLE model_annotations ADD COLUMN IF NOT EXISTS offset_x real NOT NULL DEFAULT 0;
ALTER TABLE model_annotations ADD COLUMN IF NOT EXISTS offset_y real NOT NULL DEFAULT 0;
