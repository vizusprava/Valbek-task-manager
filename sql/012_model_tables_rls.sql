-- Zajistit RLS na model_files a model_annotations (vznikly ručně, nebyly ve verzi).
-- Rozhodnutí: 3D data vidí všichni PŘIHLÁŠENÍ (authenticated), ale NIKDO nepřihlášený (anon).
-- Tím se zavře riziko, že tabulka s vypnutým RLS je přes API otevřená i anonymům.
-- Spustit v Supabase SQL editoru. Bezpečné spustit opakovaně.

-- ── model_files ─────────────────────────────────────────────
ALTER TABLE model_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "model_files_select" ON model_files;
CREATE POLICY "model_files_select" ON model_files
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "model_files_insert" ON model_files;
CREATE POLICY "model_files_insert" ON model_files
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "model_files_update" ON model_files;
CREATE POLICY "model_files_update" ON model_files
  FOR UPDATE TO authenticated USING (true);

DROP POLICY IF EXISTS "model_files_delete" ON model_files;
CREATE POLICY "model_files_delete" ON model_files
  FOR DELETE TO authenticated USING (true);

-- ── model_annotations ───────────────────────────────────────
ALTER TABLE model_annotations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "model_annotations_select" ON model_annotations;
CREATE POLICY "model_annotations_select" ON model_annotations
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "model_annotations_insert" ON model_annotations;
CREATE POLICY "model_annotations_insert" ON model_annotations
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "model_annotations_update" ON model_annotations;
CREATE POLICY "model_annotations_update" ON model_annotations
  FOR UPDATE TO authenticated USING (true);

DROP POLICY IF EXISTS "model_annotations_delete" ON model_annotations;
CREATE POLICY "model_annotations_delete" ON model_annotations
  FOR DELETE TO authenticated USING (true);

-- ────────────────────────────────────────────────────────────
-- OVĚŘENÍ: které veřejné tabulky NEMAJÍ zapnuté RLS? (mělo by vrátit 0 řádků)
-- Spusť zvlášť a zkontroluj — týká se i task_assignees, task_templates apod.,
-- pokud vznikly ručně mimo setup.sql:
--
--   SELECT tablename FROM pg_tables
--   WHERE schemaname = 'public' AND rowsecurity = false;
-- ────────────────────────────────────────────────────────────
