-- Přepnout storage buckety 'attachments' a 'models' na PRIVÁTNÍ + RLS na storage.objects.
-- Soubory se pak servírují jen přes dočasné signed URL (frontend: lib/storage.tsx),
-- takže nejsou dostupné anonymně podle znalosti URL.
-- Spustit v Supabase SQL editoru. Bezpečné spustit opakovaně.

-- 1) Buckety na privátní
UPDATE storage.buckets SET public = false WHERE id IN ('attachments', 'models');

-- 2) RLS politiky na storage.objects (jen přihlášení, jen tyto dva buckety)
DROP POLICY IF EXISTS "tm_objects_select" ON storage.objects;
CREATE POLICY "tm_objects_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id IN ('attachments', 'models'));

DROP POLICY IF EXISTS "tm_objects_insert" ON storage.objects;
CREATE POLICY "tm_objects_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id IN ('attachments', 'models'));

DROP POLICY IF EXISTS "tm_objects_update" ON storage.objects;
CREATE POLICY "tm_objects_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id IN ('attachments', 'models'))
  WITH CHECK (bucket_id IN ('attachments', 'models'));

DROP POLICY IF EXISTS "tm_objects_delete" ON storage.objects;
CREATE POLICY "tm_objects_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id IN ('attachments', 'models'));
