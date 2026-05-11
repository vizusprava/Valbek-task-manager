let projectId      = null
let projectData    = null
let projectMembers = []   // pole profilů členů
let allTasks       = []
let realtimeChannels = []
let pendingImageBlob     = null  // pro komentáře
let pendingTaskImageBlob = null  // pro nový úkol

// ── Init ──────────────────────────────────────────────────────

async function init() {
  try {
    const profile = await requireAuth()
    if (!profile) return

    projectId = window.location.hash.slice(1)
    if (!projectId) { window.location.href = 'dashboard.html'; return }

    document.getElementById('nav-placeholder').innerHTML = renderNav('project')
    initReviewBadge()

    await loadProjectData()
    await renderTasks()
    setupFilters()
    subscribeRealtime()
  } catch (err) {
    showError('Chyba načítání projektu: ' + err.message)
  }
}

async function loadProjectData() {
  const { data: proj, error } = await db
    .from('projects')
    .select('*, project_members(user_id, profiles(id, name, role, initials, color))')
    .eq('id', projectId)
    .single()

  if (error) throw new Error(error.message)
  if (!proj) throw new Error('Projekt nenalezen.')

  projectData    = proj
  projectMembers = (proj.project_members || []).map(m => m.profiles).filter(Boolean)

  const isDone   = proj.status === 'dokončeno'
  const overdue  = proj.due_date && new Date(proj.due_date) < new Date() && !isDone

  document.getElementById('project-name').textContent = proj.name
  document.getElementById('project-desc').textContent = proj.description || ''
  document.title = `${proj.name} – TaskManager`
  renderProjectFilePath(proj)

  // Status + termín v hlavičce
  const projectActions = document.getElementById('project-actions')
  projectActions.innerHTML = `
    <div class="project-meta">
      ${isDone ? `<span class="badge status-done">Dokončeno</span>` : ''}
      ${proj.due_date ? `<span class="project-due-header ${overdue ? 'overdue-text' : ''}">Termín: ${formatDate(proj.due_date)}</span>` : ''}
    </div>
    ${isAdmin() ? `
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn btn-sm ${isDone ? 'btn-secondary' : 'btn-danger'}"
          onclick="toggleProjectStatus('${proj.id}', '${isDone ? 'aktivní' : 'dokončeno'}')">
          ${isDone ? 'Znovu otevřít' : 'Dokončit projekt'}
        </button>
        <button class="btn btn-sm btn-danger" onclick="deleteProject('${proj.id}')">Smazat projekt</button>
      </div>
    ` : ''}
  `

  // Members bar
  document.getElementById('members-bar').innerHTML = `
    <div class="members-list">
      ${projectMembers.map(m => avatar(m.name, false, m.initials, m.color)).join('')}
      <span class="members-label">${projectMembers.map(m => esc(m.name)).join(', ')}</span>
    </div>
    ${isAdmin() ? `
      <div class="members-actions">
        <button class="btn btn-sm btn-secondary" onclick="openManageMembers()">Spravovat členy</button>
        ${!isDone ? `<button class="btn btn-sm btn-primary" onclick="openCreateTask()">+ Přidat úkol</button>` : ''}
      </div>
    ` : (!isDone ? `<button class="btn btn-sm btn-primary" onclick="openCreateTask()">+ Přidat úkol</button>` : '')}
  `

  // Naplnit filter uživatelů
  const userFilter = document.getElementById('filter-user')
  projectMembers.forEach(m => {
    const opt = document.createElement('option')
    opt.value = m.id
    opt.textContent = m.name
    userFilter.appendChild(opt)
  })
}

// ── Úkoly ─────────────────────────────────────────────────────

async function renderTasks() {
  const container = document.getElementById('tasks-container')

  const { data: tasks, error } = await db
    .from('tasks')
    .select('*, assigned:assigned_to(id, name, initials, color), creator:created_by(id, name), updater:updated_by(id, name)')
    .eq('project_id', projectId)
    .order('due_date', { ascending: true, nullsFirst: false })

  if (error) {
    container.innerHTML = '<div class="empty-state">Chyba při načítání.</div>'
    return
  }

  allTasks = tasks || []
  applyFilters()
}

function applyFilters() {
  const filterUser     = document.getElementById('filter-user').value
  const filterStatus   = document.getElementById('filter-status').value
  const filterPriority = document.getElementById('filter-priority').value

  let filtered = allTasks
  if (filterUser)     filtered = filtered.filter(t => t.assigned_to === filterUser)
  if (filterStatus)   filtered = filtered.filter(t => t.status === filterStatus)
  if (filterPriority) filtered = filtered.filter(t => t.priority === filterPriority)

  renderTaskList(filtered)
}

function renderTaskList(tasks) {
  const container = document.getElementById('tasks-container')

  if (tasks.length === 0) {
    container.innerHTML = '<div class="empty-state">Žádné úkoly odpovídají filtru.</div>'
    return
  }

  container.innerHTML = `
    <table class="task-table">
      <thead>
        <tr>
          <th>Úkol</th>
          <th>Přiřazený</th>
          <th>Stav</th>
          <th>Priorita</th>
          <th>Termín</th>
          <th class="col-filepath" title="Cesta k souboru">📁</th>
        </tr>
      </thead>
      <tbody>
        ${tasks.map(t => {
          const overdue  = isOverdue(t.due_date) && t.status !== 'hotovo'
          const canEdit  = isAdmin() || t.assigned_to === currentProfile.id
          const statusTd = canEdit
            ? `<td class="editable-cell" onclick="inlineStatus(event,'${t.id}','${t.status}')" title="Kliknutím změnit">${statusBadge(t.status)}</td>`
            : `<td>${statusBadge(t.status)}</td>`
          const priorTd  = canEdit
            ? `<td class="editable-cell" onclick="inlinePriority(event,'${t.id}','${t.priority}')" title="Kliknutím změnit">${priorityBadge(t.priority)}</td>`
            : `<td>${priorityBadge(t.priority)}</td>`
          const dueTd    = canEdit
            ? `<td class="editable-cell ${overdue ? 'overdue-text' : ''}" onclick="inlineDueDate(event,'${t.id}','${t.due_date || ''}')" title="Kliknutím změnit">${formatDate(t.due_date)}</td>`
            : `<td class="${overdue ? 'overdue-text' : ''}">${formatDate(t.due_date)}</td>`
          const pathTd   = t.file_path
            ? `<td class="col-filepath">
                 <button class="btn-copy-path" data-path="${esc(t.file_path)}" title="${esc(t.file_path)}"
                   onclick="event.stopPropagation();copyPath(this.dataset.path)">📋</button>
               </td>`
            : `<td class="col-filepath"></td>`
          return `
            <tr class="task-row ${overdue ? 'overdue' : ''}" onclick="openTaskDetail('${t.id}')">
              <td class="task-title-cell">
                <span class="task-title">${esc(t.title)}</span>
                ${t.description ? `<span class="task-desc-preview">${esc(t.description.substring(0, 60))}${t.description.length > 60 ? '…' : ''}</span>` : ''}
              </td>
              <td>${t.assigned ? `${avatar(t.assigned.name, true, t.assigned.initials, t.assigned.color)} ${esc(t.assigned.name)}` : '<span class="text-muted">–</span>'}</td>
              ${statusTd}${priorTd}${dueTd}${pathTd}
            </tr>
          `
        }).join('')}
      </tbody>
    </table>
  `
}

function setupFilters() {
  document.getElementById('filter-user').addEventListener('change', applyFilters)
  document.getElementById('filter-status').addEventListener('change', applyFilters)
  document.getElementById('filter-priority').addEventListener('change', applyFilters)
}

function clearFilters() {
  document.getElementById('filter-user').value     = ''
  document.getElementById('filter-status').value   = ''
  document.getElementById('filter-priority').value = ''
  applyFilters()
}

// ── Detail úkolu ──────────────────────────────────────────────

async function openTaskDetail(taskId) {
  const task = allTasks.find(t => t.id === taskId)
  if (!task) return

  const canEdit = isAdmin() || task.assigned_to === currentProfile.id

  // Načti komentáře
  const { data: comments } = await db
    .from('comments')
    .select('*, author:author_id(id, name)')
    .eq('task_id', taskId)
    .order('created_at', { ascending: true })

  const commentsHtml = (comments || []).map(renderCommentItem).join('')

  const overdue = isOverdue(task.due_date) && task.status !== 'hotovo'

  openModal(`
    <div class="modal-header">
      <h2>${esc(task.title)}</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>

    <div class="task-detail-grid">
      <div class="task-detail-main">
        <!-- Popis -->
        <div class="form-group">
          <label>Popis</label>
          ${canEdit
            ? `<textarea id="td-desc" rows="4">${esc(task.description || '')}</textarea>`
            : `<p class="field-value">${esc(task.description || '–')}</p>`}
        </div>

        ${task.image_url ? `
          <div class="form-group">
            <label>Příloha</label>
            <img src="${task.image_url}" class="comment-img" onclick="openImageFull('${task.image_url}')" alt="příloha">
          </div>
        ` : ''}

        <!-- Stav + Priorita -->
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

        <!-- Přiřazený (pouze admin mění) -->
        <div class="form-group">
          <label>Přiřazený</label>
          ${isAdmin()
            ? `<select id="td-assigned"><option value="">– nikdo –</option>${memberOptions(projectMembers, task.assigned_to)}</select>`
            : `<span>${esc(task.assigned?.name || '–')}</span>`}
        </div>

        <!-- Termín -->
        <div class="form-group">
          <label>Termín ${overdue ? '<span class="badge-overdue">Po termínu</span>' : ''}</label>
          ${canEdit
            ? `<input type="date" id="td-due" value="${task.due_date || ''}">`
            : `<span class="${overdue ? 'overdue-text' : ''}">${formatDate(task.due_date)}</span>`}
        </div>

        <!-- Cesta k souboru -->
        <div class="form-group">
          <label>Cesta k souboru</label>
          ${canEdit
            ? `<input type="text" id="td-filepath" value="${esc(task.file_path || '')}" placeholder="\\\\server\\share\\projekt">`
            : task.file_path
              ? `<div class="filepath-row">
                   <code class="filepath-text">${esc(task.file_path)}</code>
                   <button class="btn-icon" data-path="${esc(task.file_path)}" onclick="copyPath(this.dataset.path)" title="Kopírovat">📋</button>
                 </div>`
              : '<span class="text-muted">–</span>'}
          ${canEdit && task.file_path
            ? `<div style="margin-top:4px"><button class="btn-icon" data-path="${esc(task.file_path)}" onclick="copyPath(this.dataset.path)">📋 Kopírovat cestu</button></div>`
            : ''}
        </div>

        ${canEdit ? `
          <div id="task-edit-error" class="form-error hidden"></div>
          <div class="modal-actions" style="margin-top:8px">
            ${isAdmin() ? `<button class="btn btn-danger btn-sm" onclick="deleteTask('${task.id}')">Smazat úkol</button>` : ''}
            <button class="btn btn-primary" onclick="saveTaskEdit('${task.id}')">Uložit změny</button>
          </div>
        ` : ''}
      </div>

      <div class="task-detail-side">
        <p class="meta-line">Vytvořil: <strong>${esc(task.creator?.name || '?')}</strong> · ${formatDate(task.created_at)}</p>
        <p class="meta-line">Upravil: <strong>${esc(task.updater?.name || '–')}</strong> · ${formatDateTime(task.updated_at)}</p>
      </div>
    </div>

    <!-- Komentáře -->
    <div class="comments-section">
      <h3>Komentáře</h3>
      <div id="comments-list">
        ${commentsHtml || '<p class="text-muted">Zatím žádné komentáře.</p>'}
      </div>
      <div class="comment-form">
        <div id="img-preview-wrap" class="img-preview-wrap hidden">
          <img id="img-preview" class="comment-img-preview" alt="náhled">
          <button class="btn-icon" onclick="removeCommentImage()" title="Odebrat obrázek">✕</button>
        </div>
        <textarea id="new-comment" rows="2" placeholder="Napište komentář… (Ctrl+V pro screenshot)"></textarea>
        <div class="comment-form-actions">
          <label class="btn btn-sm btn-secondary" title="Přiložit obrázek ze souboru" style="cursor:pointer">
            📎<input type="file" accept="image/*" style="display:none" onchange="attachImageFile(event)">
          </label>
          <button class="btn btn-primary btn-sm" onclick="addComment('${taskId}')">Odeslat</button>
        </div>
      </div>
    </div>
  `)

  setupCommentPaste(taskId)

  // Realtime komentáře přímo v modalu
  subscribeComments(taskId)
}

async function deleteProject(projId) {
  if (!await confirmDialog('Opravdu smazat celý projekt včetně všech úkolů a komentářů? Tato akce je nevratná.', { confirmLabel: 'Smazat projekt', danger: true })) return
  const { error } = await db.from('projects').delete().eq('id', projId)
  if (error) { showError(error.message); return }
  window.location.href = 'dashboard.html'
}

async function toggleProjectStatus(projId, newStatus) {
  const isDone = newStatus === 'dokončeno'
  if (!await confirmDialog(
    isDone ? 'Opravdu dokončit projekt?' : 'Znovu otevřít projekt?',
    { confirmLabel: isDone ? 'Dokončit' : 'Otevřít' }
  )) return
  const { error } = await db.from('projects').update({ status: newStatus }).eq('id', projId)
  if (error) { showError(error.message); return }
  showToast(newStatus === 'dokončeno' ? 'Projekt dokončen.' : 'Projekt znovu otevřen.')
  await loadProjectData()
}

async function saveTaskEdit(taskId) {
  const errEl     = document.getElementById('task-edit-error')
  const updateData = {
    updated_by: currentProfile.id,
    description: document.getElementById('td-desc')?.value || null,
    status:      document.getElementById('td-status')?.value,
    priority:    document.getElementById('td-priority')?.value,
    due_date:    document.getElementById('td-due')?.value || null,
  }
  if (isAdmin()) {
    updateData.assigned_to = document.getElementById('td-assigned')?.value || null
  }
  const fp = document.getElementById('td-filepath')
  if (fp !== null) updateData.file_path = fp.value.trim() || null

  errEl.classList.add('hidden')
  const { error } = await db.from('tasks').update(updateData).eq('id', taskId)
  if (error) {
    errEl.textContent = error.message
    errEl.classList.remove('hidden')
    return
  }
  showToast('Úkol uložen.')
  closeModal()
  await renderTasks()
}

async function deleteTask(taskId) {
  if (!await confirmDialog('Opravdu smazat úkol?', { confirmLabel: 'Smazat úkol', danger: true })) return
  const { error } = await db.from('tasks').delete().eq('id', taskId)
  if (error) { showError(error.message); return }
  showToast('Úkol smazán.')
  closeModal()
  await renderTasks()
}

// ── Komentáře ─────────────────────────────────────────────────

async function addComment(taskId) {
  const textarea = document.getElementById('new-comment')
  const text     = textarea?.value?.trim() || ''
  if (!text && !pendingImageBlob) return

  let image_url = null
  if (pendingImageBlob) {
    const path = `comments/${currentProfile.id}/${Date.now()}.png`
    const { error: upErr } = await db.storage.from('attachments').upload(path, pendingImageBlob, { contentType: 'image/png' })
    if (upErr) { showError('Chyba nahrávání obrázku: ' + upErr.message); return }
    const { data: urlData } = db.storage.from('attachments').getPublicUrl(path)
    image_url = urlData.publicUrl
  }

  const { error } = await db.from('comments').insert({
    task_id:   taskId,
    author_id: currentProfile.id,
    text:      text || '',
    image_url,
  })
  if (error) { showError(error.message); return }
  if (textarea) textarea.value = ''
  removeCommentImage()
  showToast('Komentář odeslán.')
  await refreshCommentsList(taskId)
}

async function deleteComment(commentId, taskId) {
  if (!await confirmDialog('Smazat komentář?', { confirmLabel: 'Smazat', danger: true })) return
  const { error } = await db.from('comments').delete().eq('id', commentId)
  if (error) { showError(error.message); return }
  showToast('Komentář smazán.')
  if (taskId) await refreshCommentsList(taskId)
}

async function refreshCommentsList(taskId) {
  const { data: comments } = await db
    .from('comments')
    .select('*, author:author_id(id, name)')
    .eq('task_id', taskId)
    .order('created_at', { ascending: true })

  const list = document.getElementById('comments-list')
  if (!list) return

  list.innerHTML = comments?.length
    ? comments.map(renderCommentItem).join('')
    : '<p class="text-muted">Zatím žádné komentáře.</p>'
}

function subscribeComments(taskId) {
  // Odhlásit předchozí comment channel
  const prev = realtimeChannels.find(c => c.name === 'modal-comments')
  if (prev) db.removeChannel(prev)

  const ch = db
    .channel('modal-comments')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'comments',
        filter: `task_id=eq.${taskId}` }, () => refreshCommentsList(taskId))
    .subscribe()

  ch.name = 'modal-comments'
  realtimeChannels.push(ch)
}

// ── Komentář – image helpers ──────────────────────────────────

function renderCommentItem(c) {
  return `
    <div class="comment" data-id="${c.id}">
      <div class="comment-header">
        <span class="comment-author">${esc(c.author?.name || '?')}</span>
        <span class="comment-date">${formatDateTime(c.created_at)}</span>
        ${(isAdmin() || c.author_id === currentProfile.id) ? `
          <button class="btn-icon btn-danger" onclick="deleteComment('${c.id}','${c.task_id}')" title="Smazat komentář">✕</button>
        ` : ''}
      </div>
      ${c.text ? `<p class="comment-text">${esc(c.text)}</p>` : ''}
      ${c.image_url ? `<img src="${c.image_url}" class="comment-img" onclick="openImageFull('${c.image_url}')" alt="příloha">` : ''}
    </div>
  `
}

function setupCommentPaste(taskId) {
  const textarea = document.getElementById('new-comment')
  if (!textarea) return
  textarea.addEventListener('paste', e => {
    const items = Array.from(e.clipboardData?.items || [])
    const imgItem = items.find(item => item.type.startsWith('image/'))
    if (!imgItem) return
    e.preventDefault()
    const blob = imgItem.getAsFile()
    if (!blob) return
    openAnnotator(blob, annotated => _setPendingImage(annotated))
  })
}

function attachImageFile(event) {
  const file = event.target.files[0]
  if (!file) return
  event.target.value = ''
  openAnnotator(file, annotated => _setPendingImage(annotated))
}

function _setPendingImage(blob) {
  pendingImageBlob = blob
  const wrap    = document.getElementById('img-preview-wrap')
  const preview = document.getElementById('img-preview')
  if (!wrap || !preview) return
  if (preview.src) URL.revokeObjectURL(preview.src)
  preview.src = URL.createObjectURL(blob)
  wrap.classList.remove('hidden')
}

function removeCommentImage() {
  const wrap    = document.getElementById('img-preview-wrap')
  const preview = document.getElementById('img-preview')
  if (preview?.src) { URL.revokeObjectURL(preview.src); preview.src = '' }
  if (wrap) wrap.classList.add('hidden')
  pendingImageBlob = null
}

function openImageFull(url) {
  openModal(`
    <div class="modal-header">
      <h2>Příloha</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <img src="${url}" style="max-width:100%;border-radius:8px;display:block" alt="příloha">
  `)
}

function setupTaskImagePaste() {
  const textarea = document.getElementById('ct-desc')
  if (!textarea) return
  textarea.addEventListener('paste', e => {
    const items = Array.from(e.clipboardData?.items || [])
    const imgItem = items.find(item => item.type.startsWith('image/'))
    if (!imgItem) return
    e.preventDefault()
    const blob = imgItem.getAsFile()
    if (!blob) return
    openAnnotator(blob, annotated => _setTaskPendingImage(annotated))
  })
}

function attachTaskImageFile(event) {
  const file = event.target.files[0]
  if (!file) return
  event.target.value = ''
  openAnnotator(file, annotated => _setTaskPendingImage(annotated))
}

function _setTaskPendingImage(blob) {
  pendingTaskImageBlob = blob
  const wrap    = document.getElementById('ct-img-preview-wrap')
  const preview = document.getElementById('ct-img-preview')
  if (!wrap || !preview) return
  if (preview.src) URL.revokeObjectURL(preview.src)
  preview.src = URL.createObjectURL(blob)
  wrap.classList.remove('hidden')
}

function removeTaskImage() {
  const wrap    = document.getElementById('ct-img-preview-wrap')
  const preview = document.getElementById('ct-img-preview')
  if (preview?.src) { URL.revokeObjectURL(preview.src); preview.src = '' }
  if (wrap) wrap.classList.add('hidden')
  pendingTaskImageBlob = null
}

// ── Tvorba úkolu ──────────────────────────────────────────────

function openCreateTask() {
  pendingTaskImageBlob = null
  openModal(`
    <div class="modal-header">
      <h2>Nový úkol</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <form id="create-task-form">
      <div class="form-group">
        <label>Název úkolu</label>
        <input type="text" id="ct-title" required placeholder="Co je třeba udělat?">
      </div>
      <div class="form-group">
        <label>Popis (volitelný)</label>
        <textarea id="ct-desc" rows="3" placeholder="Detaily… (Ctrl+V pro přiložení screenshotu)"></textarea>
        <div id="ct-img-preview-wrap" class="img-preview-wrap hidden" style="margin-top:6px">
          <img id="ct-img-preview" class="comment-img-preview" alt="náhled">
          <button type="button" class="btn-icon" onclick="removeTaskImage()" title="Odebrat obrázek">✕</button>
        </div>
        <div style="margin-top:6px">
          <label class="btn btn-sm btn-secondary" title="Přiložit obrázek ze souboru" style="cursor:pointer">
            📎<input type="file" accept="image/*" style="display:none" onchange="attachTaskImageFile(event)">
          </label>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Stav</label>
          <select id="ct-status">${statusOptions('neudělano')}</select>
        </div>
        <div class="form-group">
          <label>Priorita</label>
          <select id="ct-priority">${priorityOptions('medium')}</select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Přiřazený</label>
          <select id="ct-assigned">
            <option value="">– nikdo –</option>
            ${memberOptions(projectMembers, currentProfile.id)}
          </select>
        </div>
        <div class="form-group">
          <label>Termín</label>
          <input type="date" id="ct-due">
        </div>
      </div>
      <div class="form-group">
        <label>Cesta k souboru (volitelná)</label>
        <input type="text" id="ct-filepath" placeholder="\\\\server\\share\\projekt">
      </div>
      <div id="create-task-error" class="form-error hidden"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Zrušit</button>
        <button type="submit" class="btn btn-primary" id="create-task-btn">Vytvořit úkol</button>
      </div>
    </form>
  `)
  document.getElementById('create-task-form').addEventListener('submit', createTask)
  setupTaskImagePaste()
}

async function createTask(e) {
  e.preventDefault()
  const btn   = document.getElementById('create-task-btn')
  const errEl = document.getElementById('create-task-error')
  errEl.classList.add('hidden')
  setLoading(btn, true)

  let image_url = null
  if (pendingTaskImageBlob) {
    const path = `tasks/${currentProfile.id}/${Date.now()}.png`
    const { error: upErr } = await db.storage.from('attachments').upload(path, pendingTaskImageBlob, { contentType: 'image/png' })
    if (upErr) {
      errEl.textContent = 'Chyba nahrávání obrázku: ' + upErr.message
      errEl.classList.remove('hidden')
      setLoading(btn, false)
      return
    }
    const { data: urlData } = db.storage.from('attachments').getPublicUrl(path)
    image_url = urlData.publicUrl
  }

  const payload = {
    project_id:  projectId,
    title:       document.getElementById('ct-title').value.trim(),
    description: document.getElementById('ct-desc').value.trim() || null,
    status:      document.getElementById('ct-status').value,
    priority:    document.getElementById('ct-priority').value,
    assigned_to: document.getElementById('ct-assigned').value || null,
    due_date:    document.getElementById('ct-due').value || null,
    file_path:   document.getElementById('ct-filepath').value.trim() || null,
    created_by:  currentProfile.id,
    updated_by:  currentProfile.id,
    image_url,
  }

  const { error } = await db.from('tasks').insert(payload)
  if (error) {
    errEl.textContent = error.message
    errEl.classList.remove('hidden')
    setLoading(btn, false)
    return
  }
  pendingTaskImageBlob = null
  showToast('Úkol vytvořen!')
  closeModal()
  await renderTasks()
}

// ── Cesta k souboru – projekt ─────────────────────────────────

function renderProjectFilePath(proj) {
  const el   = document.getElementById('project-filepath')
  if (!el) return
  const path = proj.file_path

  if (!path && !isAdmin()) { el.innerHTML = ''; return }

  if (!path) {
    el.innerHTML = `<button class="btn-link filepath-add" onclick="editProjectFilePath('${proj.id}','')">+ Přidat cestu k souboru</button>`
    return
  }

  el.innerHTML = `
    <div class="filepath-row">
      <span class="filepath-icon">📁</span>
      <code class="filepath-text">${esc(path)}</code>
      <button class="btn-icon" data-path="${esc(path)}" onclick="copyPath(this.dataset.path)" title="Kopírovat cestu">📋</button>
      ${isAdmin() ? `<button class="btn-icon" data-path="${esc(path)}" onclick="editProjectFilePath('${proj.id}',this.dataset.path)" title="Upravit">✏️</button>` : ''}
    </div>
  `
}

function editProjectFilePath(projId, currentPath) {
  const el = document.getElementById('project-filepath')
  if (!el) return
  el.innerHTML = `
    <div class="filepath-row">
      <span class="filepath-icon">📁</span>
      <input id="fp-input" class="filepath-input" type="text" value="${esc(currentPath)}" placeholder="\\\\server\\share\\projekt">
      <button class="btn btn-sm btn-primary" onclick="saveProjectFilePath('${projId}')">Uložit</button>
      <button class="btn btn-sm btn-secondary" onclick="loadProjectData()">Zrušit</button>
    </div>
  `
  const inp = document.getElementById('fp-input')
  inp.focus(); inp.select()
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') saveProjectFilePath(projId) })
}

async function saveProjectFilePath(projId) {
  const val = document.getElementById('fp-input')?.value.trim() || null
  const { error } = await db.from('projects').update({ file_path: val }).eq('id', projId)
  if (error) { showError(error.message); return }
  showToast('Cesta uložena.')
  await loadProjectData()
}

// ── Správa členů (admin) ──────────────────────────────────────

async function openManageMembers() {
  const { data: allProfiles } = await db.from('profiles').select('*').order('name')
  const memberIds = projectMembers.map(m => m.id)

  openModal(`
    <div class="modal-header">
      <h2>Členové projektu</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="checkbox-group">
      ${(allProfiles || []).map(p => `
        <label class="checkbox-label">
          <input type="checkbox" name="pm" value="${p.id}"
            ${memberIds.includes(p.id) ? 'checked' : ''}>
          ${esc(p.name)} ${p.role === 'admin' ? '<span class="role-badge">admin</span>' : ''}
        </label>
      `).join('')}
    </div>
    <div id="manage-members-error" class="form-error hidden"></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Zrušit</button>
      <button class="btn btn-primary" onclick="saveMembers()">Uložit</button>
    </div>
  `)
}

async function saveMembers() {
  const checked  = Array.from(document.querySelectorAll('input[name="pm"]:checked')).map(c => c.value)
  const errEl    = document.getElementById('manage-members-error')
  errEl.classList.add('hidden')

  // Smaž všechny stávající členy a vlož nové
  const { error: delErr } = await db.from('project_members').delete().eq('project_id', projectId)
  if (delErr) { errEl.textContent = delErr.message; errEl.classList.remove('hidden'); return }

  if (checked.length > 0) {
    const rows = checked.map(uid => ({ project_id: projectId, user_id: uid }))
    const { error } = await db.from('project_members').insert(rows)
    if (error) { errEl.textContent = error.message; errEl.classList.remove('hidden'); return }
  }

  showToast('Členové uloženi.')
  closeModal()
  await loadProjectData()
  await renderTasks()
}

// ── Realtime tasks ────────────────────────────────────────────

function subscribeRealtime() {
  const ch = db
    .channel('project-tasks')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks',
        filter: `project_id=eq.${projectId}` }, async (payload) => {
      await renderTasks()
    })
    .subscribe()
  realtimeChannels.push(ch)
}

init()
