-- Sjednocení tasks UPDATE policy s oprávněními v UI.
-- Původní policy povolovala update jen (assigned_to = auth.uid() OR is_admin()),
-- takže uživatel přiřazený přes task_assignees nebo tvůrce úkolu nemohl měnit stav
-- — změna tiše selhala. UI dovoluje: admin || tvůrce || přiřazený.
-- Spustit v Supabase SQL editoru. Bezpečné spustit opakovaně.

DROP POLICY IF EXISTS "tasks_update" ON tasks;
CREATE POLICY "tasks_update" ON tasks
  FOR UPDATE TO authenticated
  USING (
    is_admin()
    OR assigned_to = auth.uid()
    OR created_by  = auth.uid()
    OR EXISTS (
      SELECT 1 FROM task_assignees ta
      WHERE ta.task_id = tasks.id AND ta.user_id = auth.uid()
    )
  );
