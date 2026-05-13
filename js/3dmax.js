let refData = {}

async function init() {
  const profile = await requireAuth()
  if (!profile) return

  document.getElementById('nav-placeholder').innerHTML = renderNav('3dmax')
  initReviewBadge()
  initNotifications()
  initKeyboardShortcuts()

  await loadData()
}

async function loadData() {
  const { data, error } = await db
    .from('reference_items')
    .select('*')
    .eq('page', '3dmax')
    .order('sort_order', { ascending: true })

  if (error) {
    document.getElementById('reference-container').innerHTML = '<div class="empty-state">Chyba načítání.</div>'
    return
  }

  const items = data || []
  refData = {
    layers:     items.filter(r => r.section === 'layers'),
    model_subs: items.filter(r => r.section === 'model_subs'),
    object_ids: items.filter(r => r.section === 'object_ids'),
  }

  render()
}

function render() {
  document.getElementById('reference-container').innerHTML = `
    <div class="reference-grid">
      ${renderSection('layers',     'Hladiny',                  false)}
      ${renderSection('model_subs', 'Model – kategorie (003)',  false)}
      ${renderSection('object_ids', 'Object ID',                true)}
    </div>
  `
}

function renderSection(section, title, idsOnRight) {
  const items   = refData[section] || []
  const canEdit = isAdmin()

  const headerCols = idsOnRight
    ? `<th>Název</th><th style="text-align:right">ID</th>`
    : `<th>Vrstva</th><th>Název</th>`
  const extraTh = canEdit ? '<th class="ref-del"></th>' : ''

  const rows = items.map(item => renderRefRow(item, canEdit, idsOnRight)).join('')

  const emptyRow = `<tr><td colspan="3" class="text-muted" style="padding:8px 6px">Žádné položky.</td></tr>`
  const addBtn = canEdit
    ? `<button class="btn btn-sm btn-secondary" style="width:100%;margin-top:2px" onclick="openAddItem('${section}')">+ Přidat</button>`
    : ''

  return `
    <div class="reference-section">
      <h3>${esc(title)}</h3>
      <table class="ref-table">
        <thead><tr>${headerCols}${extraTh}</tr></thead>
        <tbody>${rows || emptyRow}</tbody>
      </table>
      ${addBtn}
    </div>
  `
}

function renderRefRow(item, canEdit, idsOnRight) {
  const id    = item.id
  const code  = esc(item.code || '–')
  const name  = esc(item.name)

  const codeTd = canEdit
    ? `<td class="ref-code editable-ref" onclick="inlineEditRef(event,'${id}','code','${esc(item.code || '')}')">${code}</td>`
    : `<td class="ref-code">${code}</td>`

  const nameTd = canEdit
    ? `<td class="editable-ref" onclick="inlineEditRef(event,'${id}','name','${esc(item.name)}')">${name}</td>`
    : `<td>${name}</td>`

  const delTd = canEdit
    ? `<td class="ref-del"><button class="btn-icon btn-danger" onclick="event.stopPropagation();deleteRefItem('${id}')" title="Smazat">✕</button></td>`
    : ''

  return idsOnRight
    ? `<tr>${nameTd}${codeTd}${delTd}</tr>`
    : `<tr>${codeTd}${nameTd}${delTd}</tr>`
}

async function inlineEditRef(event, itemId, field, currentValue) {
  event.stopPropagation()
  const cell = event.currentTarget
  const original = cell.innerHTML
  let saved = false

  const isCode = field === 'code'
  cell.innerHTML = `<input style="width:100%;padding:2px 4px;font-size:13px${isCode ? ';font-family:monospace;font-weight:700;color:var(--brand)' : ''}" type="text" value="${esc(currentValue)}">`
  const input = cell.querySelector('input')
  input.focus(); input.select()

  const save = async () => {
    if (saved) return; saved = true
    const val = input.value.trim() || null
    if (field === 'name' && !val) { cell.innerHTML = original; return }
    const { error } = await db.from('reference_items').update({ [field]: val }).eq('id', itemId)
    if (error) { showError(error.message); cell.innerHTML = original; return }
    const section = Object.keys(refData).find(s => refData[s].some(r => r.id === itemId))
    if (section) { const item = refData[section].find(r => r.id === itemId); if (item) item[field] = val }
    cell.className = isCode ? 'ref-code editable-ref' : 'editable-ref'
    cell.textContent = val || '–'
    cell.onclick = (e) => inlineEditRef(e, itemId, field, val || '')
  }

  input.addEventListener('blur', save)
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur() }
    if (e.key === 'Escape') { saved = true; cell.innerHTML = original }
  })
}

async function deleteRefItem(itemId) {
  if (!await confirmDialog('Smazat položku?', { confirmLabel: 'Smazat', danger: true })) return
  const { error } = await db.from('reference_items').delete().eq('id', itemId)
  if (error) { showError(error.message); return }
  showToast('Smazáno.')
  await loadData()
}

function openAddItem(section) {
  const labels = { layers: 'Hladiny', model_subs: 'Model – kategorie', object_ids: 'Object ID' }
  openModal(`
    <div class="modal-header">
      <h2>Přidat – ${esc(labels[section] || section)}</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Kód / číslo</label>
        <input type="text" id="ri-code" placeholder="např. 008">
      </div>
      <div class="form-group">
        <label>Název</label>
        <input type="text" id="ri-name" required placeholder="název">
      </div>
    </div>
    <div id="ri-error" class="form-error hidden"></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal()">Zrušit</button>
      <button class="btn btn-primary" onclick="saveNewItem('${section}')">Přidat</button>
    </div>
  `)
  setTimeout(() => document.getElementById('ri-code')?.focus(), 50)
}

async function saveNewItem(section) {
  const errEl = document.getElementById('ri-error')
  const code  = document.getElementById('ri-code')?.value.trim() || null
  const name  = document.getElementById('ri-name')?.value.trim()
  errEl.classList.add('hidden')

  if (!name) { errEl.textContent = 'Název je povinný.'; errEl.classList.remove('hidden'); return }

  const maxOrder = (refData[section] || []).reduce((m, r) => Math.max(m, r.sort_order || 0), 0)
  const { error } = await db.from('reference_items').insert({
    page: '3dmax', section, code, name, sort_order: maxOrder + 10
  })
  if (error) { errEl.textContent = error.message; errEl.classList.remove('hidden'); return }

  showToast('Přidáno.')
  closeModal()
  await loadData()
}

init()
