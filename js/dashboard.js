let allProfiles    = []
let allProjects    = []
let realtimeChannel = null
let activeFilter   = 'aktivní'

async function init() {
  const profile = await requireAuth()
  if (!profile) return

  document.getElementById('nav-placeholder').innerHTML = renderNav('dashboard')
  initReviewBadge()

  await loadProfiles()
  await loadProjects()
  renderFilterTabs()
  renderGrid()
  subscribeRealtime()

  if (new URLSearchParams(window.location.search).has('new')) {
    history.replaceState(null, '', 'dashboard.html')
    openCreateProject()
  }
}

async function loadProfiles() {
  const { data } = await db.from('profiles').select('*').order('name')
  allProfiles = data || []
}

async function loadProjects() {
  const { data, error } = await db
    .from('projects')
    .select('id, name, description, status, due_date, created_at, created_by, project_members(user_id)')
    .order('created_at', { ascending: false })

  if (error) { allProjects = []; return }
  allProjects = data || []
}

// ── Záložky filtrování ────────────────────────────────────────

function renderFilterTabs() {
  const header = document.querySelector('.page-header')
  if (!header || document.getElementById('project-tabs')) return

  const tabs = document.createElement('div')
  tabs.id = 'project-tabs'
  tabs.className = 'filter-tabs'
  tabs.innerHTML = `
    <button class="tab-btn active"  data-filter="aktivní"   onclick="setFilter('aktivní')">Aktivní</button>
    <button class="tab-btn"         data-filter="dokončeno"  onclick="setFilter('dokončeno')">Dokončené</button>
    <button class="tab-btn"         data-filter="vše"        onclick="setFilter('vše')">Vše</button>
  `
  header.after(tabs)
}

function setFilter(filter) {
  activeFilter = filter
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === filter)
  })
  renderGrid()
}

// ── Vykreslení gridu ──────────────────────────────────────────

async function renderGrid() {
  const grid = document.getElementById('projects-grid')

  const filtered = activeFilter === 'vše'
    ? allProjects
    : allProjects.filter(p => p.status === activeFilter)

  if (filtered.length === 0) {
    const msg = activeFilter === 'dokončeno' ? 'Žádné dokončené projekty.'
      : activeFilter === 'aktivní' ? `Žádné aktivní projekty. ${isAdmin() ? 'Vytvořte první projekt.' : 'Počkejte, až vás admin přidá do projektu.'}`
      : 'Žádné projekty.'
    grid.innerHTML = `<div class="empty-state">${msg}</div>`
    if (isAdmin()) grid.innerHTML += `
      <button class="project-card project-card-new" onclick="openCreateProject()">
        <div class="new-project-icon">+</div><span>Nový projekt</span>
      </button>`
    return
  }

  const projectIds = filtered.map(p => p.id)
  const { data: tasks } = await db.from('tasks').select('project_id, status').in('project_id', projectIds)

  const tasksByProject = {}
  ;(tasks || []).forEach(t => {
    if (!tasksByProject[t.project_id]) tasksByProject[t.project_id] = []
    tasksByProject[t.project_id].push(t)
  })

  grid.innerHTML = filtered.map(p => {
    const projectTasks = tasksByProject[p.id] || []
    const total  = projectTasks.length
    const done   = projectTasks.filter(t => t.status === 'hotovo').length
    const review = projectTasks.filter(t => t.status === 'připraveno ke kontrole').length
    const inprog = projectTasks.filter(t => t.status === 'rozpracováno').length
    const todo   = projectTasks.filter(t => t.status === 'neudělano').length
    const progressPct = total > 0 ? Math.round((done / total) * 100) : 0

    const memberIds    = (p.project_members || []).map(m => m.user_id)
    const members      = allProfiles.filter(pr => memberIds.includes(pr.id))
    const memberAvatars = members.map(m => avatar(m.name)).join('')

    const overdue  = p.due_date && new Date(p.due_date) < new Date() && p.status !== 'dokončeno'
    const dueLine  = p.due_date
      ? `<div class="project-due ${overdue ? 'overdue-text' : ''}">Termín: ${formatDate(p.due_date)}</div>`
      : ''
    const doneBadge = p.status === 'dokončeno'
      ? `<span class="badge status-done" style="margin-left:auto">Dokončeno</span>` : ''

    const cardClass = p.status === 'dokončeno' ? 'project-card-done' : overdue ? 'project-card-overdue' : ''

    return `
      <a href="project.html#${p.id}" class="project-card ${cardClass}">
        <div class="project-card-header">
          <h3>${esc(p.name)}</h3>
          <div class="avatar-group">${memberAvatars}</div>
        </div>
        ${doneBadge}
        ${p.description ? `<p class="project-desc">${esc(p.description)}</p>` : ''}
        ${dueLine}
        <div class="project-stats">
          <span class="stat" title="Neudělano"><span class="dot status-todo"></span>${todo}</span>
          <span class="stat" title="Rozpracováno"><span class="dot status-inprogress"></span>${inprog}</span>
          <span class="stat" title="Ke kontrole"><span class="dot status-review"></span>${review}</span>
          <span class="stat" title="Hotovo"><span class="dot status-done"></span>${done}</span>
        </div>
        <div class="progress-bar-wrap">
          <div class="progress-bar" style="width:${progressPct}%"></div>
        </div>
        <div class="progress-label">${progressPct}% hotovo · ${total} úkolů</div>
      </a>
    `
  }).join('')

  if (isAdmin()) {
    grid.innerHTML += `
      <button class="project-card project-card-new" onclick="openCreateProject()">
        <div class="new-project-icon">+</div><span>Nový projekt</span>
      </button>`
  }
}

// ── Nový projekt ──────────────────────────────────────────────

function openCreateProject() {
  openModal(`
    <div class="modal-header">
      <h2>Nový projekt</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <form id="create-project-form">
      <div class="form-group">
        <label>Název projektu</label>
        <input type="text" id="proj-name" required placeholder="Název projektu">
      </div>
      <div class="form-group">
        <label>Popis (volitelný)</label>
        <textarea id="proj-desc" rows="3" placeholder="Krátký popis projektu…"></textarea>
      </div>
      <div class="form-group">
        <label>Termín projektu (volitelný)</label>
        <input type="date" id="proj-due">
      </div>
      <div class="form-group">
        <label>Cesta k souboru (volitelná)</label>
        <input type="text" id="proj-filepath" placeholder="\\\\server\\share\\projekt">
      </div>
      <div class="form-group">
        <label>Členové projektu</label>
        <div class="checkbox-group">
          ${allProfiles.map(p => `
            <label class="checkbox-label">
              <input type="checkbox" name="member" value="${p.id}"
                ${p.id === currentProfile.id ? 'checked disabled' : ''}>
              ${esc(p.name)} ${p.role === 'admin' ? '<span class="role-badge">admin</span>' : ''}
            </label>
          `).join('')}
        </div>
      </div>
      <div id="create-proj-error" class="form-error hidden"></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" onclick="closeModal()">Zrušit</button>
        <button type="submit" class="btn btn-primary" id="create-proj-btn">Vytvořit projekt</button>
      </div>
    </form>
  `)
  document.getElementById('create-project-form').addEventListener('submit', createProject)
}

async function createProject(e) {
  e.preventDefault()
  const btn    = document.getElementById('create-proj-btn')
  const errEl  = document.getElementById('create-proj-error')
  const name   = document.getElementById('proj-name').value.trim()
  const desc   = document.getElementById('proj-desc').value.trim()
  const due    = document.getElementById('proj-due').value || null

  const checkedBoxes = document.querySelectorAll('input[name="member"]:checked')
  const memberIds    = Array.from(checkedBoxes).map(cb => cb.value)
  if (!memberIds.includes(currentProfile.id)) memberIds.push(currentProfile.id)

  errEl.classList.add('hidden')
  setLoading(btn, true)

  try {
    const filepath = document.getElementById('proj-filepath').value.trim() || null
    const { data: proj, error } = await db
      .from('projects')
      .insert({ name, description: desc || null, due_date: due, file_path: filepath, created_by: currentProfile.id })
      .select()
      .single()

    if (error) throw error

    const memberRows = memberIds.map(uid => ({ project_id: proj.id, user_id: uid }))
    const { error: memErr } = await db.from('project_members').insert(memberRows)
    if (memErr) throw memErr

    closeModal()
    showToast('Projekt vytvořen!')
    await loadProjects()
    renderGrid()
  } catch (err) {
    errEl.textContent = err.message
    errEl.classList.remove('hidden')
    setLoading(btn, false)
  }
}

// ── Realtime ──────────────────────────────────────────────────

function subscribeRealtime() {
  if (realtimeChannel) db.removeChannel(realtimeChannel)
  realtimeChannel = db
    .channel('dashboard-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' },        async () => { await loadProjects(); renderGrid() })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'project_members' }, async () => { await loadProjects(); renderGrid() })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' },           async () => { await loadProjects(); renderGrid() })
    .subscribe()
}

init()
