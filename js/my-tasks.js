let allMyTasks = []

async function init() {
  const profile = await requireAuth()
  if (!profile) return

  document.getElementById('nav-placeholder').innerHTML = renderNav('my-tasks')
  initReviewBadge()
  initNotifications()
  initKeyboardShortcuts()

  await loadMyTasks()
  document.getElementById('filter-status').addEventListener('change', applyFilters)
  document.getElementById('filter-priority').addEventListener('change', applyFilters)
  document.getElementById('search-tasks').addEventListener('input', debounce(applyFilters, 300))

  // Realtime: překreslit při změně mých úkolů
  db
    .channel('my-tasks-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, async () => {
      await loadMyTasks()
    })
    .subscribe()
}

async function loadMyTasks() {
  const { data: tasks, error } = await db
    .from('tasks')
    .select('*, comments(count), project:project_id(id, name), assigned:assigned_to(id, name, initials, color), creator:created_by(id, name), updater:updated_by(id, name)')
    .eq('assigned_to', currentProfile.id)
    .order('due_date', { ascending: true, nullsFirst: false })

  if (error) {
    document.getElementById('my-tasks-container').innerHTML = '<div class="empty-state">Chyba při načítání.</div>'
    return
  }

  allMyTasks = tasks || []
  applyFilters()
}

function applyFilters() {
  const filterStatus   = document.getElementById('filter-status').value
  const filterPriority = document.getElementById('filter-priority').value
  const search         = document.getElementById('search-tasks').value.toLowerCase().trim()

  let filtered = allMyTasks
  if (filterStatus)   filtered = filtered.filter(t => t.status === filterStatus)
  if (filterPriority) filtered = filtered.filter(t => t.priority === filterPriority)
  if (search)         filtered = filtered.filter(t =>
    t.title.toLowerCase().includes(search) ||
    (t.description || '').toLowerCase().includes(search) ||
    (t.project?.name || '').toLowerCase().includes(search)
  )

  renderMyTasks(filtered)
}

function clearFilters() {
  document.getElementById('filter-status').value   = ''
  document.getElementById('filter-priority').value = ''
  document.getElementById('search-tasks').value    = ''
  applyFilters()
}

function renderMyTasks(tasks) {
  const container = document.getElementById('my-tasks-container')

  if (tasks.length === 0) {
    container.innerHTML = '<div class="empty-state">Žádné úkoly odpovídající filtru.</div>'
    return
  }

  // Seskupit podle projektu
  const byProject = {}
  tasks.forEach(t => {
    const key = t.project?.id || 'unknown'
    if (!byProject[key]) byProject[key] = { name: t.project?.name || '–', tasks: [] }
    byProject[key].tasks.push(t)
  })

  container.innerHTML = Object.values(byProject).map(group => `
    <div class="task-group">
      <h3 class="task-group-title">
        <a href="project.html?id=${group.tasks[0].project_id}">${esc(group.name)}</a>
      </h3>
      <table class="task-table">
        <thead>
          <tr>
            <th>Úkol</th>
            <th>Stav</th>
            <th>Priorita</th>
            <th>Termín</th>
          </tr>
        </thead>
        <tbody>
          ${group.tasks.map(t => {
            const overdue = isOverdue(t.due_date) && t.status !== 'hotovo'
            const commentCount = t.comments?.[0]?.count ?? 0
            return `
              <tr class="task-row ${overdue ? 'overdue' : ''}"
                  onclick="openMyTaskDetail('${t.id}', '${t.project_id}')">
                <td class="task-title-cell">
                  <span class="task-title">${esc(t.title)}</span>${commentCount > 0 ? `<span class="comment-count">💬 ${commentCount}</span>` : ''}
                  ${t.description ? `<span class="task-desc-preview">${esc(t.description.substring(0, 60))}${t.description.length > 60 ? '…' : ''}</span>` : ''}
                </td>
                <td class="editable-cell" onclick="inlineStatus(event,'${t.id}','${t.status}')" title="Kliknutím změnit">${statusBadge(t.status)}</td>
                <td class="editable-cell" onclick="inlinePriority(event,'${t.id}','${t.priority}')" title="Kliknutím změnit">${priorityBadge(t.priority)}</td>
                <td class="editable-cell ${overdue ? 'overdue-text' : ''}" onclick="inlineDueDate(event,'${t.id}','${t.due_date || ''}')" title="Kliknutím změnit">${formatDate(t.due_date)}</td>
              </tr>
            `
          }).join('')}
        </tbody>
      </table>
    </div>
  `).join('')
}

async function openMyTaskDetail(taskId, projId) {
  const task = allMyTasks.find(t => t.id === taskId)
  if (!task) return

  const canEdit = isAdmin() || task.assigned_to === currentProfile.id
  const overdue = isOverdue(task.due_date) && task.status !== 'hotovo'

  let taskProjectMembers = []
  if (isAdmin()) {
    const { data: membersData } = await db
      .from('project_members')
      .select('user_id, profiles(id, name)')
      .eq('project_id', task.project_id)
    taskProjectMembers = (membersData || []).map(m => m.profiles).filter(Boolean)
  }

  const { data: comments } = await db
    .from('comments')
    .select('*, author:author_id(id, name)')
    .eq('task_id', taskId)
    .order('created_at', { ascending: true })

  const commentsHtml = (comments || []).map(c => `
    <div class="comment" data-id="${c.id}">
      <div class="comment-header">
        <span class="comment-author">${esc(c.author?.name || '?')}</span>
        <span class="comment-date">${formatDateTime(c.created_at)}</span>
        ${(isAdmin() || c.author_id === currentProfile.id) ? `
          <button class="btn-icon btn-danger" onclick="deleteMyComment('${c.id}', '${taskId}', '${projId}')">✕</button>
        ` : ''}
      </div>
      <p class="comment-text">${esc(c.text)}</p>
    </div>
  `).join('')

  openModal(`
    <div class="modal-header">
      <h2>${esc(task.title)}</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <p class="text-muted">Projekt: <a href="project.html?id=${task.project_id}">${esc(task.project?.name || '–')}</a></p>

    <div class="task-detail-grid">
      <div class="task-detail-main">
        <div class="form-group">
          <label>Popis</label>
          ${canEdit
            ? `<textarea id="td-desc" rows="4">${esc(task.description || '')}</textarea>`
            : `<p class="field-value">${esc(task.description || '–')}</p>`}
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Stav</label>
            ${canEdit
              ? `<select id="td-status">${statusOptions(task.status)}</select>`
              : statusBadge(task.status)}
          </div>
          <div class="form-group">
            <label>Priorita</label>
            ${canEdit
              ? `<select id="td-priority">${priorityOptions(task.priority)}</select>`
              : priorityBadge(task.priority)}
          </div>
        </div>
        <div class="form-group">
          <label>Termín ${overdue ? '<span class="badge-overdue">Po termínu</span>' : ''}</label>
          ${canEdit
            ? `<input type="date" id="td-due" value="${task.due_date || ''}">`
            : `<span class="${overdue ? 'overdue-text' : ''}">${formatDate(task.due_date)}</span>`}
        </div>
        <div class="form-group">
          <label>Přiřazený</label>
          ${isAdmin()
            ? `<select id="td-assigned"><option value="">– nikdo –</option>${memberOptions(taskProjectMembers, task.assigned_to)}</select>`
            : `<span>${esc(task.assigned?.name || '–')}</span>`}
        </div>
        ${canEdit ? `
          <div id="task-edit-error" class="form-error hidden"></div>
          <div class="modal-actions" style="margin-top:8px">
            <button class="btn btn-primary" onclick="saveMyTaskEdit('${task.id}')">Uložit změny</button>
          </div>
        ` : ''}
      </div>
      <div class="task-detail-side">
        <p class="meta-line">Vytvořil: <strong>${esc(task.creator?.name || '?')}</strong> · ${formatDate(task.created_at)}</p>
        <p class="meta-line">Upravil: <strong>${esc(task.updater?.name || '–')}</strong> · ${formatDateTime(task.updated_at)}</p>
      </div>
    </div>

    <div class="comments-section">
      <h3>Komentáře</h3>
      <div id="comments-list">
        ${commentsHtml || '<p class="text-muted">Zatím žádné komentáře.</p>'}
      </div>
      <div class="comment-form">
        <textarea id="new-comment" rows="2" placeholder="Napište komentář…"></textarea>
        <button class="btn btn-primary btn-sm" onclick="addMyComment('${taskId}')">Odeslat</button>
      </div>
    </div>
  `)

  subscribeMyComments(taskId)
}

async function saveMyTaskEdit(taskId) {
  const errEl = document.getElementById('task-edit-error')
  errEl.classList.add('hidden')

  const updateData = {
    updated_by:  currentProfile.id,
    description: document.getElementById('td-desc')?.value || null,
    status:      document.getElementById('td-status')?.value,
    priority:    document.getElementById('td-priority')?.value,
    due_date:    document.getElementById('td-due')?.value || null,
  }
  if (isAdmin()) {
    updateData.assigned_to = document.getElementById('td-assigned')?.value || null
  }

  const { error } = await db.from('tasks').update(updateData).eq('id', taskId)

  if (error) {
    errEl.textContent = error.message
    errEl.classList.remove('hidden')
    return
  }
  showToast('Uloženo.')
  closeModal()
  await loadMyTasks()
}

async function addMyComment(taskId) {
  const textarea = document.getElementById('new-comment')
  const text = textarea?.value?.trim()
  if (!text) return
  const { error } = await db.from('comments').insert({ task_id: taskId, author_id: currentProfile.id, text })
  if (error) { showError(error.message); return }
  if (textarea) textarea.value = ''
  showToast('Komentář odeslán.')
}

async function deleteMyComment(commentId, taskId) {
  if (!await confirmDialog('Smazat komentář?', { confirmLabel: 'Smazat', danger: true })) return
  const { error } = await db.from('comments').delete().eq('id', commentId)
  if (error) { showError(error.message); return }
  showToast('Komentář smazán.')
}

function subscribeMyComments(taskId) {
  db
    .channel('my-task-comments')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'comments',
        filter: `task_id=eq.${taskId}` }, async () => {
      const { data: comments } = await db
        .from('comments')
        .select('*, author:author_id(id, name)')
        .eq('task_id', taskId)
        .order('created_at', { ascending: true })

      const list = document.getElementById('comments-list')
      if (!list) return

      if (!comments || comments.length === 0) {
        list.innerHTML = '<p class="text-muted">Zatím žádné komentáře.</p>'
        return
      }
      list.innerHTML = comments.map(c => `
        <div class="comment" data-id="${c.id}">
          <div class="comment-header">
            <span class="comment-author">${esc(c.author?.name || '?')}</span>
            <span class="comment-date">${formatDateTime(c.created_at)}</span>
            ${(isAdmin() || c.author_id === currentProfile.id) ? `
              <button class="btn-icon btn-danger" onclick="deleteMyComment('${c.id}', '${taskId}')">✕</button>
            ` : ''}
          </div>
          <p class="comment-text">${esc(c.text)}</p>
        </div>
      `).join('')
    })
    .subscribe()
}

init()
