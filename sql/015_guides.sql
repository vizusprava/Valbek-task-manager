-- Návody / kontrolní seznamy (stránka "Návody" v levém panelu).
-- guides = jeden návod (např. "Kontrola práce v 3ds Max"),
-- guide_items = jednotlivé body návodu.
-- Body může přidávat / upravovat / mazat každý přihlášený,
-- celý návod smí smazat jen jeho autor nebo admin.
-- Spustit v Supabase SQL editoru. Bezpečné spustit opakovaně.

CREATE TABLE IF NOT EXISTS public.guides (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT NOT NULL,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_by  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.guide_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guide_id    UUID NOT NULL REFERENCES public.guides(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_by  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS guide_items_guide_idx ON public.guide_items (guide_id, sort_order);

-- ── RLS ─────────────────────────────────────────────────────
ALTER TABLE public.guides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guide_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "guides_select" ON public.guides;
CREATE POLICY "guides_select" ON public.guides
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "guides_insert" ON public.guides;
CREATE POLICY "guides_insert" ON public.guides
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "guides_update" ON public.guides;
CREATE POLICY "guides_update" ON public.guides
  FOR UPDATE TO authenticated USING (true);

DROP POLICY IF EXISTS "guides_delete" ON public.guides;
CREATE POLICY "guides_delete" ON public.guides
  FOR DELETE TO authenticated USING (created_by = auth.uid() OR is_admin());

DROP POLICY IF EXISTS "guide_items_select" ON public.guide_items;
CREATE POLICY "guide_items_select" ON public.guide_items
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "guide_items_insert" ON public.guide_items;
CREATE POLICY "guide_items_insert" ON public.guide_items
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "guide_items_update" ON public.guide_items;
CREATE POLICY "guide_items_update" ON public.guide_items
  FOR UPDATE TO authenticated USING (true);

DROP POLICY IF EXISTS "guide_items_delete" ON public.guide_items;
CREATE POLICY "guide_items_delete" ON public.guide_items
  FOR DELETE TO authenticated USING (true);

-- ── Realtime – změny se ostatním ukážou hned ────────────────
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.guides;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.guide_items;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;

-- ── Úvodní návod (vloží se jen jednou) ──────────────────────
DO $$
DECLARE
  g_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.guides WHERE title = 'Kontrola práce v 3ds Max') THEN
    INSERT INTO public.guides (title, description, sort_order)
    VALUES ('Kontrola práce v 3ds Max', 'Projdi před odevzdáním modelu.', 0)
    RETURNING id INTO g_id;

    INSERT INTO public.guide_items (guide_id, text, sort_order) VALUES
      (g_id, 'Všechno je ve správných hladinách a v hladině „0“ nic nezůstalo', 0),
      (g_id, 'Všechny objekty, materiály i hladiny jsou pojmenované podle konvence', 1),
      (g_id, 'Ve scéně nejsou žádné zbytky: skryté objekty, prázdné hladiny, nepoužité materiály ani pomocné kamery a světla', 2),
      (g_id, 'Geometrie je čistá, se správným měřítkem, Reset XForm a bez chyb v xView', 3),
      (g_id, 'UV a materiály jsou hotové a správně přiřazené', 4),
      (g_id, 'Všechny textury a soubory vedou na *V:* a nic nechybí (Asset Tracking)', 5),
      (g_id, 'Soubor je uložený na *V:* se správným názvem a verzí', 6),
      (g_id, 'V task manageru je aktualizovaný STAV modelu, cesta k souboru a krátká poznámka', 7);
  END IF;
END $$;
