let reviewTasks   = []
let reviewChannel = null

async function init() {
  const profile = await requireAuth()
  if (!profile) return
  if (!isAdmin()) { window.location.href = 'dashboard.html'; return }

  document.getElementById('nav-placeholder').innerHTML = renderNav('review')
  initReviewBadge()

  await loadReviewTasks()
  renderReview()
  subscribeRealtime()
}

async function loadReviewTasks() {
  const { data, error } = await db
    .from('tasks')
    .select('*, project:project_id(id, name), assigned:assigned_to(id, name), creator:created_by(id, name)')
    .eq('status', 'připraveno ke kontrole')
    .order('due_date', { ascending: true, nullsFirst: false })

  if (error) { reviewTasks = []; return }
  reviewTasks = data || []
}

function renderReview() {
  const container = document.getElementById('review-container')

  updateReviewBadge()

  if (reviewTasks.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>Žádné úkoly ke kontrole.</p>
        <p class="text-muted" style="margin-top:8px">Zobrazí se zde, jakmile někdo označí úkol jako „Připraveno ke kontrole".</p>
      </div>`
    return
  }

  // Seskupit podle projektu
  const byProject = {}
  reviewTasks.forEach(t => {
    const pid = t.project?.id || 'x'
    if (!byProject[pid]) byProject[pid] = { project: t.project, tasks: [] }
    byProject[pid].tasks.push(t)
  })

  container.innerHTML = Object.values(byProject).map(group => {
    const projId = group.project?.id
    return `
    <div class="task-group">
      <div class="task-group-title review-group-title">
        <a href="project.html#${projId}">${esc(group.project?.name || '–')}</a>
        <span class="badge status-review">${group.tasks.length} ke kontrole</span>
      </div>
      <table class="task-table">
        <thead>
          <tr>
            <th>Úkol</th>
            <th>Přiřazený</th>
            <th>Stav</th>
            <th>Priorita</th>
            <th>Termín</th>
          </tr>
        </thead>
        <tbody>
          ${group.tasks.map(t => {
            const overdue = isOverdue(t.due_date)
            return `
              <tr class="task-row ${overdue ? 'overdue' : ''}"
                  onclick="window.location.href='project.html#${projId}'"
                  style="cursor:pointer">
                <td class="task-title-cell">
                  <span class="task-title">${esc(t.title)}</span>
                  ${t.description ? `<span class="task-desc-preview">${esc(t.description.substring(0, 70))}${t.description.length > 70 ? '…' : ''}</span>` : ''}
                </td>
                <td>${t.assigned
                  ? `${avatar(t.assigned.name, true)} ${esc(t.assigned.name)}`
                  : '<span class="text-muted">–</span>'}</td>
                <td class="editable-cell" onclick="inlineStatus(event,'${t.id}','${t.status}')" title="Kliknutím změnit">${statusBadge(t.status)}</td>
                <td class="editable-cell" onclick="inlinePriority(event,'${t.id}','${t.priority}')" title="Kliknutím změnit">${priorityBadge(t.priority)}</td>
                <td class="editable-cell ${overdue ? 'overdue-text' : ''}" onclick="inlineDueDate(event,'${t.id}','${t.due_date || ''}')" title="Kliknutím změnit">${formatDate(t.due_date)}</td>
              </tr>
            `
          }).join('')}
        </tbody>
      </table>
    </div>`
  }).join('')
}

function subscribeRealtime() {
  if (reviewChannel) db.removeChannel(reviewChannel)
  reviewChannel = db
    .channel('review-page')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, async () => {
      await loadReviewTasks()
      renderReview()
    })
    .subscribe()
}

init()
