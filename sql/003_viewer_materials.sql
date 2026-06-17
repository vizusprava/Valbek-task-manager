-- Globální knihovna PBR materiálů 3D vieweru.
-- Textury se ukládají do bucketu `models` pod textures/{materialId}/.
-- Spustit v Supabase SQL editoru.

CREATE TABLE IF NOT EXISTS viewer_materials (
  id         uuid PRIMARY KEY,
  data       jsonb NOT NULL,
  updated_by uuid REFERENCES profiles(id),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE viewer_materials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "viewer_materials_select" ON viewer_materials;
CREATE POLICY "viewer_materials_select" ON viewer_materials
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "viewer_materials_insert" ON viewer_materials;
CREATE POLICY "viewer_materials_insert" ON viewer_materials
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "viewer_materials_update" ON viewer_materials;
CREATE POLICY "viewer_materials_update" ON viewer_materials
  FOR UPDATE TO authenticated USING (true);

DROP POLICY IF EXISTS "viewer_materials_delete" ON viewer_materials;
CREATE POLICY "viewer_materials_delete" ON viewer_materials
  FOR DELETE TO authenticated USING (true);
