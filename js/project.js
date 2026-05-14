let projectId      = null
let projectData    = null
let projectMembers = []
let projectSubprojects = []  // [{id, name, sort_order, project_id}]
let allTasks       = []
let realtimeChannels = []
let pendingImageBlob     = null
let pendingTaskImageBlob = null

const BATCH_SIZE    = 50
let taskOffset      = 0
let taskHasMore     = true
let taskObserver    = null
let taskLoading     = false

let selectedTaskIds = new Set()
let dragSrcId       = null
let dragOverId      = null
let dragSaveTimer   = null

// ── Init ──────────────────────────────────────────────────────

async function init() {
  try {
    const profile = await requireAuth()
    if (!profile) return

    projectId = window.location.hash.slice(1)
    if (!projectId) { window.location.href = 'dashboard.html'; return }

    document.getElementById('nav-placeholder').innerHTML = renderNav('project')
    initReviewBadge()
    initNotifications()
    initKeyboardShortcuts()

    await loadProjectData()
    await loadProjectSubprojects()
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
        <button class="btn btn-sm btn-secondary" onclick="openEditProject()">Upravit projekt</button>
        <button class="btn btn-sm btn-secondary" onclick="openManageSubprojects()">Spravovat podprojekty</button>
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

// ── Podprojekty ───────────────────────────────────────────────

async function loadProjectSubprojects() {
  const { data, error } = await db
    .from('subprojects')
    .select('*')
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true })
  projectSubprojects = error ? [] : (data || [])

  // Naplnit filter select
  const sel = document.getElementById('filter-subproject')
  if (sel) {
    const current = sel.value
    sel.innerHTML = `
      <option value="">Všechny podprojekty</option>
      ${projectSubprojects.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
      <option value="__none__">Bez podprojektu</option>
    `
    sel.value = current
  }
}

function getSubprojectName(id) {
  if (!id) return 'Bez podprojektu'
  return projectSubprojects.find(s => s.id === id)?.name || 'Bez podprojektu'
}

// ── Úkoly ─────────────────────────────────────────────────────

function buildTaskQuery(offset) {
  const filterUser       = document.getElementById('filter-user')?.value || ''
  const filterStatus     = document.getElementById('filter-status')?.value || ''
  const filterPriority   = document.getElementById('filter-priority')?.value || ''
  const filterSubproject = document.getElementById('filter-subproject')?.value || ''
  const search           = (document.getElementById('search-tasks')?.value || '').trim()

  let q = db
    .from('tasks')
    .select('*, comments(count), assigned:assigned_to(id, name, initials, color), creator:created_by(id, name), updater:updated_by(id, name)')
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true, nullsFirst: false })
    .order('due_date', { ascending: true, nullsFirst: false })
    .range(offset, offset + BATCH_SIZE - 1)

  if (filterUser)     q = q.eq('assigned_to', filterUser)
  if (filterStatus)   q = q.eq('status', filterStatus)
  if (filterPriority) q = q.eq('priority', filterPriority)
  if (filterSubproject === '__none__') q = q.is('subproject_id', null)
  else if (filterSubproject)           q = q.eq('subproject_id', filterSubproject)
  if (search)         q = q.or(`title.ilike.%${search}%,description.ilike.%${search}%`)

  return q
}

async function renderTasks() {
  const container = document.getElementById('tasks-container')
  taskOffset      = 0
  taskHasMore     = true
  taskLoading     = false
  allTasks        = []
  selectedTaskIds = new Set()
  if (taskObserver) { taskObserver.disconnect(); taskObserver = null }
  container.innerHTML = '<div class="loading-state">Načítám úkoly…</div>'

  const { data: tasks, error } = await buildTaskQuery(0)

  if (error) {
    container.innerHTML = '<div class="empty-state">Chyba při načítání.</div>'
    return
  }

  allTasks    = tasks || []
  taskOffset  = allTasks.length
  taskHasMore = allTasks.length === BATCH_SIZE

  renderTaskList(allTasks)
  if (taskHasMore) setupSentinel()
}

function applyFilters() {
  renderTasks()
}

async function loadMoreTasks() {
  if (!taskHasMore || taskLoading) return
  taskLoading = true
  if (taskObserver) { taskObserver.disconnect(); taskObserver = null }

  const sentinel = document.getElementById('load-more-sentinel')
  if (sentinel) sentinel.innerHTML = '<div class="load-more-indicator"><span class="load-more-spinner"></span>Načítám…</div>'

  const { data: tasks, error } = await buildTaskQuery(taskOffset)
  taskLoading = false
  if (error || !tasks || tasks.length === 0) {
    taskHasMore = false
    if (sentinel) sentinel.remove()
    return
  }

  allTasks    = [...allTasks, ...tasks]
  taskOffset += tasks.length
  taskHasMore = tasks.length === BATCH_SIZE

  // Skupin je víc — překreslit list (uloží se scroll v rámci stránky díky absolutním pozicím)
  renderTaskList(allTasks)

  if (taskHasMore) setupSentinel()
}

function setupSentinel() {
  const sentinel = document.getElementById('load-more-sentinel')
  if (!sentinel) return
  taskObserver = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting) loadMoreTasks()
  }, { rootMargin: '200px' })
  taskObserver.observe(sentinel)
}

function renderTaskRow(t) {
  const overdue      = isOverdue(t.due_date) && t.status !== 'hotovo'
  const canEdit      = isAdmin() || t.assigned_to === currentProfile.id
  const canDelete    = isAdmin() || t.created_by === currentProfile.id
  const commentCount = t.comments?.[0]?.count ?? 0
  const statusTd = canEdit
    ? `<td class="editable-cell" onclick="inlineStatus(event,'${t.id}','${t.status}')" title="Kliknutím změnit">${statusBadge(t.status)}</td>`
    : `<td>${statusBadge(t.status)}</td>`
  const priorTd  = canEdit
    ? `<td class="editable-cell" onclick="inlinePriority(event,'${t.id}','${t.priority}')" title="Kliknutím změnit">${priorityBadge(t.priority)}</td>`
    : `<td>${priorityBadge(t.priority)}</td>`
  const dueTd    = canEdit
    ? `<td class="editable-cell ${overdue ? 'overdue-text' : ''}" onclick="inlineDueDate(event,'${t.id}','${t.due_date || ''}')" title="Kliknutím změnit">${formatDate(t.due_date)}</td>`
    : `<td class="${overdue ? 'overdue-text' : ''}">${formatDate(t.due_date)}</td>`
  const pathTd   = `<td class="col-filepath">
    ${t.file_path ? `<button class="btn-copy-path" data-path="${esc(t.file_path)}" title="${esc(t.file_path)}"
        onclick="event.stopPropagation();copyPath(this.dataset.path)">📋</button>` : ''}
    ${canDelete ? `<button class="btn-icon btn-danger" onclick="event.stopPropagation();deleteTask('${t.id}')" title="Smazat úkol">🗑</button>` : ''}
  </td>`
  const dragTd = isAdmin()
    ? `<td class="col-drag" onclick="event.stopPropagation()">
        <span class="drag-handle" draggable="true"
              ondragstart="handleDragStart(event,'${t.id}')"
              ondragend="handleDragEnd(event)">⠿</span>
      </td>`
    : `<td class="col-drag"></td>`
  return `
    <tr class="task-row ${overdue ? 'overdue' : ''}" data-id="${t.id}"
        ondragover="handleDragOver(event,'${t.id}')"
        ondrop="handleDrop(event,'${t.id}')"
        onclick="openTaskDetail('${t.id}')">
      ${dragTd}
      <td class="col-checkbox" onclick="event.stopPropagation()">
        <input type="checkbox" class="task-cb" id="cb-${t.id}"
               ${selectedTaskIds.has(t.id) ? 'checked' : ''}
               onchange="toggleBulkCheckbox(event,'${t.id}')">
      </td>
      <td class="task-title-cell">
        <span class="task-title">${esc(t.title)}</span>
        ${commentCount > 0 ? `<span class="comment-count">💬 ${commentCount}</span>` : ''}
        ${t.description ? `<span class="task-desc-preview">${esc(t.description.substring(0, 60))}${t.description.length > 60 ? '…' : ''}</span>` : ''}
      </td>
      <td>${t.assigned ? `${avatar(t.assigned.name, true, t.assigned.initials, t.assigned.color)} ${esc(t.assigned.name)}` : '<span class="text-muted">–</span>'}</td>
      ${statusTd}${priorTd}${dueTd}${pathTd}
    </tr>
  `
}

function renderTaskList(tasks) {
  const container = document.getElementById('tasks-container')

  const bulkAssignedSelect = isAdmin()
    ? `<select id="bulk-assigned" onchange="bulkApplyAssigned()">
        <option value="">Přiřadit…</option>
        ${memberOptions(projectMembers, '')}
      </select>`
    : ''

  // Skupiny: každý podprojekt + případná skupina "Bez podprojektu"
  const filterSub = document.getElementById('filter-subproject')?.value || ''
  let groups
  if (filterSub === '__none__') {
    groups = [{ id: null, name: 'Bez podprojektu', tasks: tasks.filter(t => !t.subproject_id) }]
  } else if (filterSub) {
    const sp = projectSubprojects.find(s => s.id === filterSub)
    groups = sp ? [{ id: sp.id, name: sp.name, tasks: tasks.filter(t => t.subproject_id === sp.id) }] : []
  } else {
    groups = projectSubprojects.map(sp => ({
      id: sp.id,
      name: sp.name,
      tasks: tasks.filter(t => t.subproject_id === sp.id),
    }))
    const orphanTasks = tasks.filter(t => !t.subproject_id)
    if (orphanTasks.length > 0 || projectSubprojects.length === 0) {
      groups.push({ id: null, name: 'Bez podprojektu', tasks: orphanTasks })
    }
  }

  // Stav rozbalení (localStorage)
  const collapseKey = `tm-collapsed:${projectId}`
  let collapsed
  try { collapsed = new Set(JSON.parse(localStorage.getItem(collapseKey) || '[]')) }
  catch { collapsed = new Set() }

  const isDone = projectData?.status === 'dokončeno'
  const canAdd = !isDone

  const groupsHtml = groups.map(g => {
    const total  = g.tasks.length
    const done   = g.tasks.filter(t => t.status === 'hotovo').length
    const pct    = total ? Math.round(done / total * 100) : 0
    const key    = g.id || '__none__'
    const isCol  = collapsed.has(key)
    const addBtn = canAdd
      ? `<button class="btn btn-sm btn-secondary subproj-add-btn"
                 onclick="event.stopPropagation();openCreateTask('${g.id || ''}')">+ Úkol</button>`
      : ''

    return `
      <section class="subproj-section ${isCol ? 'is-collapsed' : ''}" data-subproject="${g.id || ''}">
        <header class="subproj-header" onclick="toggleSubprojectCollapse('${key}')">
          <span class="subproj-toggle">▾</span>
          <h3 class="subproj-name">${esc(g.name)}</h3>
          <span class="subproj-count">${total} úkol${total === 1 ? '' : (total < 5 ? 'y' : 'ů')}</span>
          ${total ? `
            <div class="subproj-progress-wrap" title="${pct}% hotovo">
              <div class="subproj-progress-bar" style="width:${pct}%"></div>
            </div>
            <span class="subproj-pct">${pct}%</span>` : ''}
          <span class="subproj-spacer"></span>
          ${addBtn}
        </header>
        <div class="subproj-body">
          ${total === 0
            ? `<div class="empty-state empty-state-sm">Žádné úkoly v této skupině.</div>`
            : `<table class="task-table">
                 <thead>
                   <tr>
                     <th class="col-drag"></th>
                     <th class="col-checkbox"></th>
                     <th>Úkol</th>
                     <th>Přiřazený</th>
                     <th>Stav</th>
                     <th>Priorita</th>
                     <th>Termín</th>
                     <th class="col-filepath" title="Cesta k souboru">📁</th>
                   </tr>
                 </thead>
                 <tbody class="task-tbody" data-subproject="${g.id || ''}">
                   ${g.tasks.map(renderTaskRow).join('')}
                 </tbody>
               </table>`}
        </div>
      </section>
    `
  }).join('')

  if (tasks.length === 0 && projectSubprojects.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        Tento projekt zatím nemá žádné podprojekty ani úkoly.
        ${isAdmin() ? `<div style="margin-top:8px"><button class="btn btn-sm btn-secondary" onclick="openManageSubprojects()">Vytvořit podprojekt</button></div>` : ''}
      </div>`
    return
  }

  container.innerHTML = `
    <div id="bulk-action-bar" class="bulk-action-bar hidden">
      <span id="bulk-count" class="bulk-count"></span>
      <select id="bulk-status" onchange="bulkApplyStatus()">
        <option value="">Změnit stav…</option>
        ${statusOptions('')}
      </select>
      ${bulkAssignedSelect}
      <button class="btn btn-sm btn-danger" onclick="bulkDelete()">🗑 Smazat</button>
      <button class="btn btn-sm btn-secondary" onclick="clearBulkSelection()">✕ Zrušit výběr</button>
    </div>
    ${groupsHtml}
    <div id="load-more-sentinel"></div>
  `
}

function toggleSubprojectCollapse(key) {
  const collapseKey = `tm-collapsed:${projectId}`
  let collapsed
  try { collapsed = new Set(JSON.parse(localStorage.getItem(collapseKey) || '[]')) }
  catch { collapsed = new Set() }
  if (collapsed.has(key)) collapsed.delete(key)
  else collapsed.add(key)
  localStorage.setItem(collapseKey, JSON.stringify([...collapsed]))
  const sel = key === '__none__'
    ? document.querySelector('.subproj-section[data-subproject=""]')
    : document.querySelector(`.subproj-section[data-subproject="${key}"]`)
  if (sel) sel.classList.toggle('is-collapsed')
}

function setupFilters() {
  document.getElementById('filter-user').addEventListener('change', applyFilters)
  document.getElementById('filter-status').addEventListener('change', applyFilters)
  document.getElementById('filter-priority').addEventListener('change', applyFilters)
  document.getElementById('filter-subproject')?.addEventListener('change', applyFilters)
  document.getElementById('search-tasks').addEventListener('input', debounce(applyFilters, 300))
}

function clearFilters() {
  document.getElementById('filter-user').value       = ''
  document.getElementById('filter-status').value     = ''
  document.getElementById('filter-priority').value   = ''
  const sub = document.getElementById('filter-subproject')
  if (sub) sub.value = ''
  document.getElementById('search-tasks').value      = ''
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

        <!-- Podprojekt -->
        <div class="form-group">
          <label>Podprojekt</label>
          ${canEdit
            ? `<select id="td-subproject">
                 <option value="">– bez podprojektu –</option>
                 ${projectSubprojects.map(s =>
                   `<option value="${s.id}" ${s.id === task.subproject_id ? 'selected' : ''}>${esc(s.name)}</option>`
                 ).join('')}
               </select>`
            : `<span>${esc(getSubprojectName(task.subproject_id))}</span>`}
        </div>

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
            ${isAdmin() || task.created_by === currentProfile.id ? `<button class="btn btn-danger btn-sm" onclick="deleteTask('${task.id}')">Smazat úkol</button>` : ''}
            <button class="btn btn-primary" onclick="saveTaskEdit('${task.id}')">Uložit změny</button>
          </div>
        ` : ''}
      </div>

      <div class="task-detail-side">
        <p class="meta-line">Vytvořil: <strong>${esc(task.creator?.name || '?')}</strong> · ${formatDate(task.created_at)}</p>
        <p class="meta-line">Upravil: <strong>${esc(task.updater?.name || '–')}</strong> · ${formatDateTime(task.updated_at)}</p>
      </div>
    </div>

    <div class="task-tab-bar">
      <button class="task-tab active" id="tab-btn-comments" onclick="switchTaskTab('comments','${taskId}')">💬 Komentáře</button>
      <button class="task-tab" id="tab-btn-files" onclick="switchTaskTab('files','${taskId}')">📎 Přílohy</button>
      <button class="task-tab" id="tab-btn-history" onclick="switchTaskTab('history','${taskId}')">📋 Historie</button>
    </div>

    <div id="tab-panel-files" class="task-tab-panel hidden">
      <div id="attach-list" class="attach-list"></div>
      <label class="attach-upload-area" id="attach-drop-zone"
             ondragover="attachDragOver(event)" ondragleave="attachDragLeave(event)" ondrop="attachDrop(event,'${taskId}')">
        <div>📁 Přetáhni soubor sem nebo <u>klikni pro výběr</u></div>
        <div style="margin-top:4px;font-size:11px">Max. 20 MB — obrázky, PDF, DWG, …</div>
        <input type="file" multiple onchange="uploadAttachments(event,'${taskId}')">
      </label>
    </div>

    <div id="tab-panel-comments" class="task-tab-panel">
      <div class="comments-section">
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
    </div>

    <div id="tab-panel-history" class="task-tab-panel hidden">
      <div id="activity-list" class="activity-list">
        <p class="text-muted">Načítám historii…</p>
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
  const oldTask   = allTasks.find(t => t.id === taskId)
  const updateData = {
    updated_by: currentProfile.id,
    description: document.getElementById('td-desc')?.value || null,
    status:      document.getElementById('td-status')?.value,
    priority:    document.getElementById('td-priority')?.value,
    due_date:    document.getElementById('td-due')?.value || null,
  }
  const subSel = document.getElementById('td-subproject')
  if (subSel) updateData.subproject_id = subSel.value || null
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
  if (oldTask) {
    for (const field of ['status', 'priority', 'due_date']) {
      const oldVal = oldTask[field] || null
      const newVal = updateData[field] || null
      if (oldVal !== newVal) await logActivity(taskId, field, oldVal, newVal)
    }
    if (subSel) {
      const oldSub = oldTask.subproject_id || null
      const newSub = updateData.subproject_id || null
      if (oldSub !== newSub) {
        await logActivity(taskId, 'subproject',
          getSubprojectName(oldSub), getSubprojectName(newSub))
      }
    }
    if (isAdmin()) {
      const oldAssigned = oldTask.assigned_to || null
      const newAssigned = updateData.assigned_to || null
      if (oldAssigned !== newAssigned) {
        const oldName = projectMembers.find(m => m.id === oldAssigned)?.name || null
        const newName = projectMembers.find(m => m.id === newAssigned)?.name || null
        await logActivity(taskId, 'assigned_to', oldName, newName)
      }
    }
  }

  showToast('Úkol uložen.')
  if (isAdmin() && updateData.assigned_to && updateData.assigned_to !== oldTask?.assigned_to) {
    await createNotification(
      updateData.assigned_to,
      'task_assigned',
      `Byl/a jsi přiřazen/a k úkolu: ${oldTask?.title || ''}`,
      taskId
    )
  }
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

async function createNotification(userId, type, message, taskId) {
  if (!userId || userId === currentProfile.id) return
  await db.from('notifications').insert({
    user_id: userId, type, message, task_id: taskId, project_id: projectId
  })
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
  const commentedTask = allTasks.find(t => t.id === taskId)
  if (commentedTask?.assigned_to) {
    await createNotification(
      commentedTask.assigned_to,
      'new_comment',
      `Nový komentář u úkolu: ${commentedTask.title}`,
      taskId
    )
  }
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

function openCreateTask(preselectSubprojectId = '') {
  pendingTaskImageBlob = null
  const subOptions = projectSubprojects.map(s =>
    `<option value="${s.id}" ${s.id === preselectSubprojectId ? 'selected' : ''}>${esc(s.name)}</option>`
  ).join('')
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
        <label>Podprojekt</label>
        <select id="ct-subproject">
          <option value="">– bez podprojektu –</option>
          ${subOptions}
        </select>
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

  const maxOrder = allTasks.reduce((max, t) => Math.max(max, t.sort_order || 0), 0)
  const payload = {
    project_id:    projectId,
    subproject_id: document.getElementById('ct-subproject')?.value || null,
    title:         document.getElementById('ct-title').value.trim(),
    description:   document.getElementById('ct-desc').value.trim() || null,
    status:        document.getElementById('ct-status').value,
    priority:      document.getElementById('ct-priority').value,
    assigned_to:   document.getElementById('ct-assigned').value || null,
    due_date:      document.getElementById('ct-due').value || null,
    file_path:     document.getElementById('ct-filepath').value.trim() || null,
    created_by:    currentProfile.id,
    updated_by:    currentProfile.id,
    sort_order:    maxOrder + 10,
    image_url,
  }

  const { data: newTask, error } = await db.from('tasks').insert(payload).select('id').single()
  if (error) {
    errEl.textContent = error.message
    errEl.classList.remove('hidden')
    setLoading(btn, false)
    return
  }
  pendingTaskImageBlob = null
  showToast('Úkol vytvořen!')
  await logActivity(newTask.id, 'created', null, payload.title)
  if (payload.assigned_to) {
    await createNotification(
      payload.assigned_to,
      'task_assigned',
      `Byl/a jsi přiřazen/a k úkolu: ${payload.title}`,
      newTask.id
    )
  }
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

async function openEditProject() {
  if (!isAdmin()) return
  const { data: allProfiles } = await db.from('profiles').select('*').order('name')
  const memberIds = projectMembers.map(m => m.id)
  const proj = projectData

  openModal(`
    <div class="modal-header">
      <h2>Upravit projekt</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <form id="edit-project-form">
      <div class="form-group">
        <label>Název projektu</label>
        <input type="text" id="ep-name" required value="${esc(proj.name)}">
      </div>
      <div class="form-group">
        <label>Popis (volitelný)</label>
        <textarea id="ep-desc" rows="3">${esc(proj.description || '')}</textarea>
      </div>
      <div class="form-group">
        <label>Termín projektu (volitelný)</label>
        <input type="date" id="ep-due" value="${proj.due_date || ''}">
      </div>
      <div class="form-group">
        <label>Cesta k souboru (volitelná)</label>
        <input type="text" id="ep-filepath" value="${esc(proj.file_path || '')}" placeholder="\\\\server\\share\\projekt">
      </div>
      <div class="form-group">
        <label>Členové projektu</label>
        <div class="checkbox-group">
          ${(allProfiles || []).map(p => `
            <label class="checkbox-label">
              <input type="checkbox" name="ep-member" value="${p.id}"
                ${memberIds.includes(p.id) ? 'checked' : ''}>
              ${esc(p.name)} ${p.role === 'admin' ? '<span class="role-badge">admin</span>' : ''}
            </label>
          `).join('')}
        </div>
      </div>
      <div id="ep-error" class="form-error hidden"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Zrušit</button>
        <button type="button" class="btn btn-primary" onclick="saveEditProject()">Uložit změny</button>
      </div>
    </form>
  `)
}

async function saveEditProject() {
  const errEl = document.getElementById('ep-error')
  errEl.classList.add('hidden')
  const name = document.getElementById('ep-name')?.value.trim()
  if (!name) { errEl.textContent = 'Název projektu nesmí být prázdný.'; errEl.classList.remove('hidden'); return }
  const desc     = document.getElementById('ep-desc')?.value.trim()
  const due      = document.getElementById('ep-due')?.value || null
  const filepath = document.getElementById('ep-filepath')?.value.trim() || null
  const memberIds = Array.from(document.querySelectorAll('input[name="ep-member"]:checked')).map(c => c.value)

  const { error: projErr } = await db.from('projects').update({
    name,
    description: desc || null,
    due_date: due,
    file_path: filepath,
  }).eq('id', projectId)
  if (projErr) { errEl.textContent = projErr.message; errEl.classList.remove('hidden'); return }

  const { error: delErr } = await db.from('project_members').delete().eq('project_id', projectId)
  if (delErr) { errEl.textContent = delErr.message; errEl.classList.remove('hidden'); return }
  if (memberIds.length > 0) {
    const rows = memberIds.map(uid => ({ project_id: projectId, user_id: uid }))
    const { error: memErr } = await db.from('project_members').insert(rows)
    if (memErr) { errEl.textContent = memErr.message; errEl.classList.remove('hidden'); return }
  }

  showToast('Projekt uložen.')
  closeModal()
  await loadProjectData()
  await renderTasks()
}

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

// ── Správa podprojektů (admin) ────────────────────────────────

async function openManageSubprojects() {
  if (!isAdmin()) return
  await loadProjectSubprojects()

  const [refRes, tplRes] = await Promise.all([
    db.from('reference_items').select('id, code, name, sort_order')
      .eq('page', '3dmax').eq('section', 'model_subs').order('sort_order'),
    db.from('subproject_templates').select('id, name, sort_order').order('sort_order')
  ])
  const refItems = refRes.data || []
  const tplItems = tplRes.data || []
  const existingNames = new Set(projectSubprojects.map(s => s.name.toLowerCase()))

  const availableRef = refItems.filter(r => {
    const combined = (r.code ? r.code + ' ' : '') + r.name
    return !existingNames.has(combined.toLowerCase())
  })
  const availableTpl = tplItems.filter(t => !existingNames.has(t.name.toLowerCase()))

  openModal(`
    <div class="modal-header">
      <h2>Podprojekty</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <p class="text-muted" style="margin-bottom:12px">Změny názvů a pořadí ulož tlačítkem „Uložit". Smazání podprojektu se uplatní hned — úkoly v něm zůstanou jako „Bez podprojektu".</p>

    <div id="sp-list" class="sp-edit-list">
      ${projectSubprojects.length
        ? projectSubprojects.map((s, i) => renderSubprojectRow(s, i)).join('')
        : '<p class="text-muted" style="margin:6px 0">Zatím žádné podprojekty.</p>'}
    </div>

    ${availableRef.length ? `
      <div class="subproj-tpl-group" style="margin-top:14px">
        <div class="subproj-tpl-title">Z 3DMax kategorií</div>
        <div class="checkbox-group checkbox-group-compact">
          ${availableRef.map(r => {
            const combined = (r.code ? r.code + ' ' : '') + r.name
            return `<label class="checkbox-label">
              <input type="checkbox" name="sp-tpl-ref" value="${esc(combined)}">
              ${esc(combined)}
            </label>`
          }).join('')}
        </div>
      </div>` : ''}

    ${availableTpl.length ? `
      <div class="subproj-tpl-group" style="margin-top:14px">
        <div class="subproj-tpl-title">Vlastní šablony</div>
        <div class="checkbox-group checkbox-group-compact">
          ${availableTpl.map(t => `
            <label class="checkbox-label">
              <input type="checkbox" name="sp-tpl-custom" value="${esc(t.name)}">
              ${esc(t.name)}
            </label>
          `).join('')}
        </div>
      </div>` : ''}

    ${availableRef.length || availableTpl.length ? `
      <button type="button" class="btn btn-sm btn-secondary" style="margin-top:8px" onclick="addSubprojectsFromTemplates()">+ Přidat vybrané</button>
    ` : ''}

    <div class="subproj-add-row" style="margin-top:12px">
      <input type="text" id="sp-new-name" placeholder="Název vlastního podprojektu…"
             onkeydown="if(event.key==='Enter'){event.preventDefault();addSubproject()}">
      <button type="button" class="btn btn-sm btn-secondary" onclick="addSubproject()">+ Přidat</button>
    </div>

    <div id="sp-error" class="form-error hidden"></div>
    <div class="modal-actions" style="margin-top:14px">
      <button class="btn btn-secondary" onclick="closeModal()">Zavřít</button>
      <button class="btn btn-primary" onclick="saveSubprojects()">Uložit změny</button>
    </div>
  `)
}

async function addSubprojectsFromTemplates() {
  const errEl = document.getElementById('sp-error')
  errEl.classList.add('hidden')
  const names = [
    ...Array.from(document.querySelectorAll('input[name="sp-tpl-ref"]:checked')).map(cb => cb.value),
    ...Array.from(document.querySelectorAll('input[name="sp-tpl-custom"]:checked')).map(cb => cb.value),
  ]
  if (!names.length) return
  const existing = new Set(projectSubprojects.map(s => s.name.toLowerCase()))
  const toAdd = names.filter(n => !existing.has(n.toLowerCase()))
  if (!toAdd.length) return
  const nextOrder = projectSubprojects.length * 10
  const rows = toAdd.map((name, i) => ({
    project_id: projectId,
    name,
    sort_order: nextOrder + i * 10,
    created_by: currentProfile.id,
  }))
  const { error } = await db.from('subprojects').insert(rows)
  if (error) { errEl.textContent = error.message; errEl.classList.remove('hidden'); return }
  const cnt = toAdd.length
  showToast(`Přidáno ${cnt} podprojekt${cnt === 1 ? '' : cnt < 5 ? 'y' : 'ů'}.`)
  openManageSubprojects()
}

function renderSubprojectRow(sp, idx) {
  return `
    <div class="sp-row" data-id="${sp.id}">
      <span class="sp-order">${idx + 1}.</span>
      <input type="text" class="sp-name-input" value="${esc(sp.name)}" data-original="${esc(sp.name)}">
      <div class="sp-row-actions">
        <button type="button" class="btn-icon" onclick="moveSubproject('${sp.id}',-1)" title="Nahoru">▲</button>
        <button type="button" class="btn-icon" onclick="moveSubproject('${sp.id}',1)"  title="Dolů">▼</button>
        <button type="button" class="btn-icon btn-danger" onclick="deleteSubproject('${sp.id}')" title="Smazat">✕</button>
      </div>
    </div>
  `
}

function _readSpListOrder() {
  const rows = Array.from(document.querySelectorAll('#sp-list .sp-row'))
  return rows.map(r => ({
    id:   r.dataset.id,
    name: r.querySelector('.sp-name-input')?.value.trim() || '',
  }))
}

function moveSubproject(id, dir) {
  const list = _readSpListOrder()
  const idx  = list.findIndex(x => x.id === id)
  const tgt  = idx + dir
  if (idx < 0 || tgt < 0 || tgt >= list.length) return
  const [item] = list.splice(idx, 1)
  list.splice(tgt, 0, item)
  // znovu vykresli list – ale zachovat hodnoty v inputech
  const wrap = document.getElementById('sp-list')
  if (!wrap) return
  // Najdi původní objekty (kvůli rerender)
  const lookup = Object.fromEntries(projectSubprojects.map(s => [s.id, s]))
  // Aktualizuj projectSubprojects v paměti dočasně dle nového pořadí (s aktuálními názvy)
  const reorderedTmp = list.map(x => ({ ...(lookup[x.id] || { id: x.id }), name: x.name }))
  wrap.innerHTML = reorderedTmp.map((s, i) => renderSubprojectRow(s, i)).join('')
}

async function addSubproject() {
  const input = document.getElementById('sp-new-name')
  const name = input?.value.trim()
  if (!name) return
  const errEl = document.getElementById('sp-error')
  errEl.classList.add('hidden')
  // ulož ručně přidané + uložit existující editace najednou? raději hned vlož
  const nextOrder = (_readSpListOrder().length) * 10
  const { data, error } = await db.from('subprojects').insert({
    project_id: projectId,
    name,
    sort_order: nextOrder,
    created_by: currentProfile.id,
  }).select().single()
  if (error) { errEl.textContent = error.message; errEl.classList.remove('hidden'); return }
  input.value = ''
  await loadProjectSubprojects()
  // znovu otevřít modál se zachováním rozdělané editace neimplementujeme — překreslíme list
  const wrap = document.getElementById('sp-list')
  if (wrap) wrap.innerHTML = projectSubprojects.map((s, i) => renderSubprojectRow(s, i)).join('')
}

async function deleteSubproject(id) {
  const sp = projectSubprojects.find(s => s.id === id)
  if (!sp) return
  const cnt = allTasks.filter(t => t.subproject_id === id).length
  const msg = cnt > 0
    ? `Smazat podprojekt „${sp.name}"? ${cnt} úkol${cnt === 1 ? '' : (cnt < 5 ? 'y' : 'ů')} v něm zůstane jako „Bez podprojektu".`
    : `Smazat podprojekt „${sp.name}"?`
  if (!await confirmDialog(msg, { confirmLabel: 'Smazat', danger: true })) {
    // confirmDialog zavře modál – znovu otevřít
    return openManageSubprojects()
  }
  const { error } = await db.from('subprojects').delete().eq('id', id)
  if (error) { showError(error.message); return openManageSubprojects() }
  showToast('Podprojekt smazán.')
  await loadProjectSubprojects()
  await renderTasks()
  openManageSubprojects()
}

async function saveSubprojects() {
  const errEl = document.getElementById('sp-error')
  errEl.classList.add('hidden')
  const rows = _readSpListOrder()

  // Validace
  for (const r of rows) {
    if (!r.name) { errEl.textContent = 'Název nesmí být prázdný.'; errEl.classList.remove('hidden'); return }
  }
  const seen = new Set()
  for (const r of rows) {
    const k = r.name.toLowerCase()
    if (seen.has(k)) { errEl.textContent = `Duplicitní název: ${r.name}`; errEl.classList.remove('hidden'); return }
    seen.add(k)
  }

  // Diff vůči projectSubprojects a postupně updatuj
  const updates = []
  rows.forEach((r, i) => {
    const orig = projectSubprojects.find(s => s.id === r.id)
    if (!orig) return
    if (orig.name !== r.name || orig.sort_order !== i * 10) {
      updates.push(db.from('subprojects').update({ name: r.name, sort_order: i * 10 }).eq('id', r.id))
    }
  })
  if (updates.length === 0) { closeModal(); return }

  const results = await Promise.all(updates)
  const errs = results.filter(x => x.error)
  if (errs.length) { errEl.textContent = errs[0].error.message; errEl.classList.remove('hidden'); return }
  showToast('Podprojekty uloženy.')
  closeModal()
  await loadProjectSubprojects()
  await renderTasks()
}

// ── Aktivitní log ─────────────────────────────────────────────

function switchTaskTab(tab, taskId) {
  document.getElementById('tab-panel-comments').classList.toggle('hidden', tab !== 'comments')
  document.getElementById('tab-panel-files').classList.toggle('hidden', tab !== 'files')
  document.getElementById('tab-panel-history').classList.toggle('hidden', tab !== 'history')
  document.getElementById('tab-btn-comments').classList.toggle('active', tab === 'comments')
  document.getElementById('tab-btn-files').classList.toggle('active', tab === 'files')
  document.getElementById('tab-btn-history').classList.toggle('active', tab === 'history')
  if (tab === 'history') loadActivityLog(taskId)
  if (tab === 'files') loadAttachments(taskId)
}

async function loadActivityLog(taskId) {
  const list = document.getElementById('activity-list')
  if (!list) return
  const { data, error } = await db
    .from('task_activity')
    .select('*, user:user_id(name)')
    .eq('task_id', taskId)
    .order('created_at', { ascending: false })

  if (error) { list.innerHTML = '<p class="text-muted">Chyba načítání.</p>'; return }
  if (!data || data.length === 0) { list.innerHTML = '<p class="text-muted">Žádná historie.</p>'; return }
  list.innerHTML = data.map(renderActivityItem).join('')
}

function renderActivityItem(a) {
  const fieldLabels = { status: 'Stav', priority: 'Priorita', due_date: 'Termín', assigned_to: 'Přiřazený', file_path: 'Cesta', subproject: 'Podprojekt', created: 'Vytvoření' }
  const fieldLabel = fieldLabels[a.field] || a.field

  let changeHtml
  if (a.field === 'created') {
    changeHtml = `<span>Úkol byl vytvořen: <strong>${esc(a.new_value || '')}</strong></span>`
  } else {
    const oldDisplay = formatActivityValue(a.field, a.old_value)
    const newDisplay = formatActivityValue(a.field, a.new_value)
    changeHtml = `
      <span class="activity-field">${esc(fieldLabel)}</span>:
      ${a.old_value ? `<span class="activity-old">${esc(oldDisplay)}</span> <span class="activity-arrow">→</span>` : ''}
      <span class="activity-new">${esc(newDisplay)}</span>
    `
  }

  return `
    <div class="activity-item">
      <div class="activity-meta">${esc(a.user?.name || '?')} · ${formatDateTime(a.created_at)}</div>
      <div class="activity-change">${changeHtml}</div>
    </div>
  `
}

function formatActivityValue(field, value) {
  if (!value) return '–'
  if (field === 'status') return STATUS_LABELS[value] || value
  if (field === 'priority') return PRIORITY_LABELS[value] || value
  if (field === 'due_date') return formatDate(value)
  return value
}

// ── Hromadné operace ──────────────────────────────────────────

function toggleBulkCheckbox(event, taskId) {
  if (event.target.checked) selectedTaskIds.add(taskId)
  else { selectedTaskIds.delete(taskId); const all = document.getElementById('cb-all'); if (all) all.checked = false }
  updateBulkBar()
}

function toggleAllCheckboxes(checked) {
  allTasks.forEach(t => {
    if (checked) selectedTaskIds.add(t.id)
    else selectedTaskIds.delete(t.id)
    const cb = document.getElementById(`cb-${t.id}`)
    if (cb) cb.checked = checked
  })
  updateBulkBar()
}

function updateBulkBar() {
  const bar = document.getElementById('bulk-action-bar')
  if (!bar) return
  const count = selectedTaskIds.size
  bar.classList.toggle('hidden', count === 0)
  const countEl = document.getElementById('bulk-count')
  if (countEl) {
    const suffix = count === 1 ? 'vybrán' : count < 5 ? 'vybrány' : 'vybráno'
    countEl.textContent = `${count} ${suffix}`
  }
}

async function bulkApplyStatus() {
  const select = document.getElementById('bulk-status')
  const status = select?.value
  if (!status || selectedTaskIds.size === 0) return
  select.value = ''
  const ids = [...selectedTaskIds]
  const { error } = await db.from('tasks').update({ status, updated_by: currentProfile.id }).in('id', ids)
  if (error) { showError(error.message); return }
  showToast(`Stav změněn u ${ids.length} úkolů.`)
  clearBulkSelection()
  await renderTasks()
}

async function bulkApplyAssigned() {
  const select = document.getElementById('bulk-assigned')
  const userId = select?.value || null
  if (!userId || selectedTaskIds.size === 0) return
  select.value = ''
  const ids = [...selectedTaskIds]
  const { error } = await db.from('tasks').update({ assigned_to: userId, updated_by: currentProfile.id }).in('id', ids)
  if (error) { showError(error.message); return }
  showToast(`Přiřazení změněno u ${ids.length} úkolů.`)
  clearBulkSelection()
  await renderTasks()
}

async function bulkDelete() {
  if (selectedTaskIds.size === 0) return
  const count = selectedTaskIds.size
  if (!await confirmDialog(`Smazat ${count} ${count === 1 ? 'úkol' : count < 5 ? 'úkoly' : 'úkolů'}? Tato akce je nevratná.`, { confirmLabel: 'Smazat', danger: true })) return
  const ids = [...selectedTaskIds]
  const { error } = await db.from('tasks').delete().in('id', ids)
  if (error) { showError(error.message); return }
  showToast(`Smazáno ${ids.length} úkolů.`)
  clearBulkSelection()
  await renderTasks()
}

function clearBulkSelection() {
  selectedTaskIds.clear()
  document.querySelectorAll('.task-cb').forEach(cb => cb.checked = false)
  updateBulkBar()
}

// ── Přílohy ───────────────────────────────────────────────────

const ATTACH_BUCKET = 'task-attachments'
const ATTACH_MAX_MB = 20

async function loadAttachments(taskId) {
  const list = document.getElementById('attach-list')
  if (!list) return
  list.innerHTML = '<p class="text-muted" style="font-size:13px">Načítám…</p>'

  const { data, error } = await db
    .from('task_attachments')
    .select('*, uploader:uploaded_by(name)')
    .eq('task_id', taskId)
    .order('created_at', { ascending: true })

  if (error) { list.innerHTML = '<p class="text-muted">Chyba načítání příloh.</p>'; return }
  list.innerHTML = (data || []).map(renderAttachItem).join('') || '<p class="text-muted" style="font-size:13px">Zatím žádné přílohy.</p>'
}

function renderAttachItem(a) {
  const icon = attachIcon(a.mime_type)
  const size = a.file_size ? formatFileSize(a.file_size) : ''
  const canDel = currentProfile && (a.uploaded_by === currentProfile.id || isAdmin())
  const { data: { publicUrl } } = db.storage.from(ATTACH_BUCKET).getPublicUrl(a.file_path)

  return `
    <div class="attach-item">
      <span class="attach-icon">${icon}</span>
      <div class="attach-info">
        <div class="attach-name" title="${esc(a.file_name)}">${esc(a.file_name)}</div>
        <div class="attach-meta">${esc(a.uploader?.name || '?')} · ${formatDate(a.created_at)}${size ? ' · ' + size : ''}</div>
      </div>
      <div class="attach-actions">
        <a href="${publicUrl}" target="_blank" download="${esc(a.file_name)}" class="btn btn-sm btn-secondary" title="Stáhnout">⬇</a>
        ${canDel ? `<button class="btn btn-sm btn-danger" onclick="deleteAttachment('${a.id}','${a.file_path}','${a.task_id}')" title="Smazat">✕</button>` : ''}
      </div>
    </div>`
}

function attachIcon(mime) {
  if (!mime) return '📄'
  if (mime.startsWith('image/')) return '🖼️'
  if (mime === 'application/pdf') return '📕'
  if (mime.includes('dwg') || mime.includes('autocad')) return '📐'
  if (mime.includes('zip') || mime.includes('rar') || mime.includes('7z')) return '🗜️'
  if (mime.includes('word') || mime.includes('document')) return '📝'
  if (mime.includes('excel') || mime.includes('spreadsheet')) return '📊'
  return '📄'
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

async function uploadAttachments(event, taskId) {
  const files = Array.from(event.target.files || [])
  event.target.value = ''
  await processAttachFiles(files, taskId)
}

function attachDragOver(event) {
  event.preventDefault()
  document.getElementById('attach-drop-zone')?.classList.add('drag-active')
}

function attachDragLeave(event) {
  document.getElementById('attach-drop-zone')?.classList.remove('drag-active')
}

async function attachDrop(event, taskId) {
  event.preventDefault()
  document.getElementById('attach-drop-zone')?.classList.remove('drag-active')
  const files = Array.from(event.dataTransfer.files || [])
  await processAttachFiles(files, taskId)
}

async function processAttachFiles(files, taskId) {
  if (!files.length) return
  const tooBig = files.filter(f => f.size > ATTACH_MAX_MB * 1024 * 1024)
  if (tooBig.length) {
    showError(`Soubor ${tooBig[0].name} je větší než ${ATTACH_MAX_MB} MB.`)
    return
  }

  showToast('Nahrávám…')
  const uploads = files.map(file => uploadSingleAttachment(file, taskId))
  const results = await Promise.all(uploads)
  if (results.some(r => r === false)) showError('Některé soubory se nepodařilo nahrát.')
  else showToast('Nahráno.')
  await loadAttachments(taskId)
}

async function uploadSingleAttachment(file, taskId) {
  const ext      = file.name.includes('.') ? '.' + file.name.split('.').pop() : ''
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
  const path     = `${taskId}/${Date.now()}-${safeName}`

  const { error: storageErr } = await db.storage.from(ATTACH_BUCKET).upload(path, file)
  if (storageErr) { showError(storageErr.message); return false }

  const { error: dbErr } = await db.from('task_attachments').insert({
    task_id:     taskId,
    uploaded_by: currentProfile.id,
    file_name:   file.name,
    file_path:   path,
    file_size:   file.size,
    mime_type:   file.type || null,
  })
  if (dbErr) {
    await db.storage.from(ATTACH_BUCKET).remove([path])
    showError(dbErr.message)
    return false
  }
  return true
}

async function deleteAttachment(attachId, filePath, taskId) {
  if (!await confirmDialog('Smazat přílohu?', { confirmLabel: 'Smazat', danger: true })) return
  await db.storage.from(ATTACH_BUCKET).remove([filePath])
  const { error } = await db.from('task_attachments').delete().eq('id', attachId)
  if (error) { showError(error.message); return }
  showToast('Příloha smazána.')
  await loadAttachments(taskId)
}

// ── Drag & drop řazení ────────────────────────────────────────

function handleDragStart(event, taskId) {
  dragSrcId = taskId
  event.dataTransfer.effectAllowed = 'move'
  event.currentTarget.closest('tr')?.classList.add('dragging')
}

function handleDragEnd(event) {
  dragSrcId  = null
  dragOverId = null
  document.querySelectorAll('.task-row').forEach(r => r.classList.remove('dragging', 'drag-over'))
}

function handleDragOver(event, taskId) {
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
  if (dragOverId !== taskId) {
    document.querySelectorAll('.task-row').forEach(r => r.classList.remove('drag-over'))
    dragOverId = taskId
    const row = document.querySelector(`tr[data-id="${taskId}"]`)
    if (row) row.classList.add('drag-over')
  }
}

async function handleDrop(event, taskId) {
  event.preventDefault()
  if (!dragSrcId || dragSrcId === taskId) return

  const srcTask = allTasks.find(t => t.id === dragSrcId)
  const dstTask = allTasks.find(t => t.id === taskId)
  if (!srcTask || !dstTask) return

  // Přesun mezi podprojekty řeš v detailu úkolu
  if ((srcTask.subproject_id || null) !== (dstTask.subproject_id || null)) {
    showError('Pro přesun do jiného podprojektu otevři úkol a změň „Podprojekt".')
    return
  }

  const srcIdx = allTasks.findIndex(t => t.id === dragSrcId)
  const dstIdx = allTasks.findIndex(t => t.id === taskId)
  if (srcIdx === -1 || dstIdx === -1) return

  const [moved] = allTasks.splice(srcIdx, 1)
  allTasks.splice(dstIdx, 0, moved)

  renderTaskList(allTasks)
  scheduleSaveDragOrder()
}

function scheduleSaveDragOrder() {
  if (dragSaveTimer) clearTimeout(dragSaveTimer)
  dragSaveTimer = setTimeout(saveDragOrder, 600)
}

async function saveDragOrder() {
  const updates = allTasks.map((t, i) =>
    db.from('tasks').update({ sort_order: i * 10 }).eq('id', t.id)
  )
  const results = await Promise.all(updates)
  if (results.some(r => r.error)) showError('Chyba při ukládání pořadí.')
}

// ── Realtime tasks ────────────────────────────────────────────

function subscribeRealtime() {
  const ch = db
    .channel('project-tasks')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks',
        filter: `project_id=eq.${projectId}` }, async (payload) => {
      await renderTasks()
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'subprojects',
        filter: `project_id=eq.${projectId}` }, async () => {
      await loadProjectSubprojects()
      renderTaskList(allTasks)
    })
    .subscribe()
  realtimeChannels.push(ch)
}

init()
