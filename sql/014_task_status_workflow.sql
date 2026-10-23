-- Rozšířený workflow stavů úkolu:
--   Neuděláno → Připravený podklad → Rozpracováno → Kontrola pracovník
--   → Kontrola nadřízený → Schváleno → Hotovo
-- "Kontrola nadřízený" používá původní hodnotu 'připraveno ke kontrole',
-- takže existující úkoly ve stavu "Ke kontrole" se nemusí přepisovat.
-- Spustit v Supabase SQL editoru. Bezpečné spustit opakovaně.

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN (
    'neudělano',
    'připravený podklad',
    'rozpracováno',
    'kontrola pracovník',
    'připraveno ke kontrole',
    'schváleno',
    'hotovo'
  ));
