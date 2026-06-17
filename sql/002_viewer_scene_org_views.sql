-- Organizace scény 3D vieweru (přejmenování objektů, vrstvy, nastavení prostředí)
-- + uložené pohledy kamery pro prezentace.
-- Spustit v Supabase SQL editoru.

CREATE TABLE IF NOT EXISTS model_scene_org (
  model_id   uuid PRIMARY KEY REFERENCES model_files(id) ON DELETE CASCADE,
  data       jsonb NOT NULL,
  updated_by uuid REFERENCES profiles(id),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS model_views (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id   uuid NOT NULL REFERENCES model_files(id) ON DELETE CASCADE,
  name       text NOT NULL,
  camera     jsonb NOT NULL,
  created_by uuid REFERENCES profiles(id),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS model_views_model_id_idx ON model_views(model_id);

ALTER TABLE model_scene_org ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_views     ENABLE ROW LEVEL SECURITY;

-- stejný režim jako ostatní viewer tabulky: čtení i zápis pro přihlášené
DROP POLICY IF EXISTS "model_scene_org_select" ON model_scene_org;
CREATE POLICY "model_scene_org_select" ON model_scene_org
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "model_scene_org_insert" ON model_scene_org;
CREATE POLICY "model_scene_org_insert" ON model_scene_org
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "model_scene_org_update" ON model_scene_org;
CREATE POLICY "model_scene_org_update" ON model_scene_org
  FOR UPDATE TO authenticated USING (true);

DROP POLICY IF EXISTS "model_scene_org_delete" ON model_scene_org;
CREATE POLICY "model_scene_org_delete" ON model_scene_org
  FOR DELETE TO authenticated USING (true);

DROP POLICY IF EXISTS "model_views_select" ON model_views;
CREATE POLICY "model_views_select" ON model_views
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "model_views_insert" ON model_views;
CREATE POLICY "model_views_insert" ON model_views
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "model_views_delete" ON model_views;
CREATE POLICY "model_views_delete" ON model_views
  FOR DELETE TO authenticated USING (true);
