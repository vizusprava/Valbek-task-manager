-- Chybějící UPDATE policy na model_views.
-- Bez ní RLS tiše zahazuje všechny UPDATE (přejmenování pohledu, drag řazení,
-- aktualizace kamery, zaškrtnutí anotací v pohledu) — zápis "proběhne" bez chyby,
-- ale ovlivní 0 řádků, takže se změna po refetchi ztratí.
-- Spustit v Supabase SQL editoru. Bezpečné spustit opakovaně.

DROP POLICY IF EXISTS "model_views_update" ON model_views;
CREATE POLICY "model_views_update" ON model_views
  FOR UPDATE TO authenticated USING (true);
