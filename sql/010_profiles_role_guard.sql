-- BEZPEČNOST: zabránit eskalaci práv přes profiles.role
--
-- Policy "profiles_update_own" (FOR UPDATE USING id = auth.uid()) nemá omezení
-- sloupců, takže běžný uživatel si může přímým API voláním přepsat vlastní
-- profiles.role na 'admin' a získat plná práva. Roli legitimně nastavuje jen
-- Edge Function create-user přes service_role (ten triggery RLS obchází? NE —
-- BEFORE trigger se spustí i pro service_role, proto trigger povolí změnu jen
-- adminovi NEBO service_role kontextu).
--
-- Tento trigger u UPDATE vrátí role na původní hodnotu, pokud volající není admin.
-- Spustit v Supabase SQL editoru. Bezpečné spustit opakovaně.

CREATE OR REPLACE FUNCTION prevent_role_self_escalation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role THEN
    -- service_role (Edge Function) nemá auth.uid() a smí roli měnit;
    -- jinak změnu povol jen adminovi, ostatním ji potichu vrať zpět.
    IF auth.uid() IS NOT NULL AND NOT is_admin() THEN
      NEW.role := OLD.role;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_no_role_escalation ON profiles;
CREATE TRIGGER profiles_no_role_escalation
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION prevent_role_self_escalation();
