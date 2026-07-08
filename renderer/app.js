/* 渲染进程主逻辑：状态管理 + 三个视图 + 弹窗流程 */
'use strict';

const state = {
  view: 'installed',
  skills: [],
  agents: [],
  updates: {}, // key "agentId:dirName" -> { hasUpdate, latest, error }
  settings: null,
  filterAgent: 'all',
  localQuery: '',
  resolved: null, // 安装弹窗中已解析的仓库
  syncTarget: null, // { agentId, dirName }
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function call(name, ...args) {
  const r = await window.api[name](...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

function toast(message, type = 'ok', ms = 4000) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function keyOf(skill) {
  return `${skill.agentId}:${skill.dirName}`;
}

/* ============ 数据加载 ============ */

async function refreshAll() {
  const [skills, agents, settings] = await Promise.all([
    call('listSkills'),
    call('listAgents'),
    call('getSettings'),
  ]);
  state.skills = skills;
  state.agents = agents;
  state.settings = settings;
  renderAll();
}

function renderAll() {
  renderSidebar();
  renderChips();
  renderSkillList();
  renderSettings();
}

/* ============ 侧栏 ============ */

function renderSidebar() {
  $('#count-installed').textContent = state.skills.length || '';
  const pill = $('#auto-update-pill');
  const on = state.settings && state.settings.autoUpdate;
  pill.textContent = on ? `自动更新：每 ${state.settings.autoUpdateHours} 小时` : '自动更新：关闭';
  pill.classList.toggle('on', Boolean(on));
}

function switchView(view) {
  state.view = view;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  ['installed', 'discover', 'settings'].forEach((v) => {
    $(`#view-${v}`).hidden = v !== view;
  });
}

/* ============ 已安装视图 ============ */

function renderChips() {
  const counts = {};
  for (const s of state.skills) counts[s.agentId] = (counts[s.agentId] || 0) + 1;
  const agentsWithSkills = state.agents.filter((a) => a.detected || counts[a.id]);
  let html = `<button class="chip ${state.filterAgent === 'all' ? 'active' : ''}" data-agent="all">全部<span class="n">${state.skills.length}</span></button>`;
  for (const a of agentsWithSkills) {
    html += `<button class="chip ${state.filterAgent === a.id ? 'active' : ''}" data-agent="${escapeHtml(a.id)}">${escapeHtml(a.name)}<span class="n">${counts[a.id] || 0}</span></button>`;
  }
  $('#agent-chips').innerHTML = html;
}

function renderSkillList() {
  const q = state.localQuery.trim().toLowerCase();
  let list = state.skills;
  if (state.filterAgent !== 'all') list = list.filter((s) => s.agentId === state.filterAgent);
  if (q) {
    list = list.filter(
      (s) =>
        s.dirName.toLowerCase().includes(q) ||
        s.title.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)
    );
  }

  const hasAnyUpdate = state.skills.some((s) => state.updates[keyOf(s)]?.hasUpdate);
  $('#btn-update-all').hidden = !hasAnyUpdate;

  if (list.length === 0) {
    $('#skill-list').innerHTML =
      `<div class="empty">${state.skills.length === 0 ? '还没有扫描到任何技能。<br>点右上角「＋ 安装技能」，粘贴一个 GitHub 仓库地址开始。' : '没有匹配的技能。'}</div>`;
    return;
  }

  $('#skill-list').innerHTML = list
    .map((s, i) => {
      const k = keyOf(s);
      const upd = state.updates[k];
      const lamp = !s.enabled ? 'off' : upd?.hasUpdate ? 'warn' : s.source ? 'ok' : 'off';
      const lampTitle = !s.enabled ? '已禁用' : upd?.hasUpdate ? '有可用更新' : s.source ? '已是最新（来自 GitHub）' : '本地技能（无来源记录）';
      return `
      <div class="skill-row ${s.enabled ? '' : 'disabled'}" data-key="${escapeHtml(k)}" style="--i:${i}">
        <span class="lamp ${lamp}" title="${lampTitle}"></span>
        <div class="skill-info">
          <div class="skill-name-line">
            <span class="skill-name">${escapeHtml(s.title)}</span>
            <span class="skill-agent">${escapeHtml(s.agentName)}</span>
            ${upd?.hasUpdate ? '<span class="skill-badge update">可更新</span>' : ''}
          </div>
          <div class="skill-desc" title="${escapeHtml(s.description)}">${escapeHtml(s.description) || '<span style="color:var(--faint)">（无描述）</span>'}</div>
          ${s.source ? `<div class="skill-source">${escapeHtml(s.source.repo)}${s.source.subpath ? ' / ' + escapeHtml(s.source.subpath) : ''} @ ${escapeHtml(s.source.commit.slice(0, 7))}</div>` : ''}
        </div>
        <div class="skill-actions">
          ${upd?.hasUpdate ? `<button class="btn small primary" data-act="update">更新</button>` : ''}
          <button class="icon-btn" data-act="sync" title="同步到其他 Agent">⇄</button>
          <button class="icon-btn" data-act="detail" title="查看详情">ⓘ</button>
          <button class="icon-btn danger" data-act="delete" title="删除">✕</button>
          <label class="switch" title="${s.enabled ? '点击禁用' : '点击启用'}">
            <input type="checkbox" data-act="toggle" ${s.enabled ? 'checked' : ''} />
            <span class="track"></span>
          </label>
        </div>
      </div>`;
    })
    .join('');
}

function findSkill(key) {
  return state.skills.find((s) => keyOf(s) === key);
}

async function onSkillAction(act, skill, rowEl) {
  const k = keyOf(skill);
  try {
    if (act === 'toggle') {
      state.skills = await call('toggleSkill', skill.agentId, skill.dirName, !skill.enabled);
      renderAll();
      toast(`${skill.title} 已${skill.enabled ? '禁用' : '启用'}`);
    } else if (act === 'delete') {
      if (!confirm(`确定删除技能「${skill.title}」（${skill.agentName}）吗？目录将被移除，无法恢复。`)) return;
      state.skills = await call('deleteSkill', skill.agentId, skill.dirName);
      delete state.updates[k];
      renderAll();
      toast(`已删除 ${skill.title}`, 'warn');
    } else if (act === 'update') {
      const btn = rowEl.querySelector('[data-act="update"]');
      if (btn) { btn.disabled = true; btn.textContent = '更新中…'; }
      const r = await call('updateSkill', k);
      state.skills = r.skills;
      delete state.updates[k];
      renderAll();
      toast(`已更新：${r.installed.join('、') || skill.title}`);
      if (r.errors.length) toast(r.errors.join('\n'), 'warn', 6000);
    } else if (act === 'sync') {
      openSyncModal(skill);
    } else if (act === 'detail') {
      await openDetailModal(skill);
    }
  } catch (e) {
    toast(e.message, 'error', 6000);
    refreshAll();
  }
}

$('#skill-list').addEventListener('click', (ev) => {
  const actEl = ev.target.closest('[data-act]');
  if (!actEl) return;
  const row = ev.target.closest('.skill-row');
  const skill = findSkill(row.dataset.key);
  if (!skill) return;
  const act = actEl.dataset.act;
  if (act === 'toggle') ev.preventDefault(); // 状态由数据驱动，不让复选框自己变
  onSkillAction(act, skill, row);
});

$('#agent-chips').addEventListener('click', (ev) => {
  const chip = ev.target.closest('.chip');
  if (!chip) return;
  state.filterAgent = chip.dataset.agent;
  renderChips();
  renderSkillList();
});

$('#local-search').addEventListener('input', (ev) => {
  state.localQuery = ev.target.value;
  renderSkillList();
});

/* ============ 检查更新 ============ */

async function checkUpdates(silent = false) {
  const btn = $('#btn-check-updates');
  btn.disabled = true;
  btn.textContent = '检查中…';
  try {
    state.updates = await call('checkUpdates');
    renderSkillList();
    const n = Object.values(state.updates).filter((u) => u.hasUpdate).length;
    const errs = Object.entries(state.updates).filter(([, u]) => u.error);
    if (!silent) {
      toast(n > 0 ? `发现 ${n} 个技能有更新` : '所有技能都是最新的', n > 0 ? 'warn' : 'ok');
      if (errs.length) toast(`${errs.length} 个技能检查失败：${errs[0][1].error}`, 'error', 6000);
    }
  } catch (e) {
    if (!silent) toast(e.message, 'error', 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = '检查更新';
  }
}

$('#btn-check-updates').addEventListener('click', () => checkUpdates());

$('#btn-update-all').addEventListener('click', async () => {
  const btn = $('#btn-update-all');
  btn.disabled = true;
  btn.textContent = '更新中…';
  try {
    const r = await call('updateAll');
    state.updates = {};
    await refreshAll();
    toast(r.updated.length ? `已更新 ${r.updated.length} 项：${r.updated.join('、')}` : '没有需要更新的技能');
    if (r.errors.length) toast(r.errors.join('\n'), 'warn', 8000);
  } catch (e) {
    toast(e.message, 'error', 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = '全部更新';
    $('#btn-update-all').hidden = true;
  }
});

/* ============ 安装弹窗 ============ */

function openInstallModal(prefill = '') {
  state.resolved = null;
  $('#install-input').value = prefill;
  $('#install-step2').hidden = true;
  $('#install-status').textContent = '';
  $('#install-status').classList.remove('error');
  $('#btn-install-next').textContent = '解析仓库';
  $('#btn-install-next').disabled = false;
  $('#modal-install').hidden = false;
  $('#install-input').focus();
}

function closeInstallModal() {
  $('#modal-install').hidden = true;
}

function renderInstallPicks() {
  const r = state.resolved;
  $('#install-found-note').textContent = `（共找到 ${r.skills.length} 个${r.truncated ? '，仅显示前 30 个' : ''}）`;
  $('#install-skill-picks').innerHTML = r.skills
    .map(
      (s, i) => `
      <label class="pick-item">
        <input type="checkbox" data-idx="${i}" ${r.skills.length === 1 ? 'checked' : ''} />
        <span>
          <span class="pick-name">${escapeHtml(s.name)}</span>
          <span class="pick-desc">${escapeHtml(s.subpath || '（仓库根目录）')}${s.description ? ' — ' + escapeHtml(s.description) : ''}</span>
        </span>
      </label>`
    )
    .join('');
  const targets = state.agents.filter((a) => a.detected || a.custom);
  $('#install-target-picks').innerHTML = targets
    .map(
      (a) => `
      <label class="pick-item">
        <input type="checkbox" data-agent="${escapeHtml(a.id)}" ${a.id === 'claude' ? 'checked' : ''} />
        <span><span class="pick-name">${escapeHtml(a.name)}</span></span>
      </label>`
    )
    .join('');
}

$('#btn-install-next').addEventListener('click', async () => {
  const btn = $('#btn-install-next');
  const status = $('#install-status');
  status.classList.remove('error');
  try {
    if (!state.resolved) {
      const input = $('#install-input').value.trim();
      if (!input) return;
      btn.disabled = true;
      status.textContent = '正在解析仓库，查找 SKILL.md…';
      state.resolved = await call('resolveRepo', input);
      renderInstallPicks();
      $('#install-step2').hidden = false;
      status.textContent = '';
      btn.textContent = '安装所选';
      btn.disabled = false;
    } else {
      const selections = $$('#install-skill-picks input:checked').map((el) => {
        const s = state.resolved.skills[Number(el.dataset.idx)];
        return { subpath: s.subpath, dirName: s.dirName };
      });
      const targets = $$('#install-target-picks input:checked').map((el) => el.dataset.agent);
      if (selections.length === 0) { status.textContent = '请至少勾选一个技能。'; return; }
      if (targets.length === 0) { status.textContent = '请至少勾选一个 Agent。'; return; }
      btn.disabled = true;
      status.textContent = '正在下载并安装…';
      const r = await call('installSkills', {
        owner: state.resolved.owner,
        repo: state.resolved.repo,
        ref: state.resolved.ref,
        selections,
        targets,
      });
      state.skills = r.skills;
      renderAll();
      closeInstallModal();
      toast(r.installed.length ? `已安装：${r.installed.join('、')}` : '没有安装任何技能', r.installed.length ? 'ok' : 'warn');
      if (r.errors.length) toast(r.errors.join('\n'), 'warn', 8000);
    }
  } catch (e) {
    status.textContent = e.message;
    status.classList.add('error');
    btn.disabled = false;
  }
});

$('#btn-open-install').addEventListener('click', () => openInstallModal());
$('#btn-install-cancel').addEventListener('click', closeInstallModal);
$('#install-input').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !state.resolved) $('#btn-install-next').click();
});

/* ============ 同步弹窗 ============ */

function openSyncModal(skill) {
  state.syncTarget = { agentId: skill.agentId, dirName: skill.dirName };
  $('#sync-title').textContent = `同步「${skill.title}」到其他 Agent`;
  const others = state.agents.filter((a) => a.id !== skill.agentId && (a.detected || a.custom));
  const existing = new Set(state.skills.filter((s) => s.dirName === skill.dirName).map((s) => s.agentId));
  $('#sync-target-picks').innerHTML = others.length
    ? others
        .map((a) => {
          const has = existing.has(a.id);
          return `
          <label class="pick-item ${has ? 'disabled' : ''}">
            <input type="checkbox" data-agent="${escapeHtml(a.id)}" ${has ? 'disabled' : ''} />
            <span><span class="pick-name">${escapeHtml(a.name)}</span>
            <span class="pick-desc">${has ? '已存在该技能' : escapeHtml(a.dir)}</span></span>
          </label>`;
        })
        .join('')
    : '<div class="empty">没有检测到其他 Agent。可在「设置」中添加自定义目录。</div>';
  $('#sync-status').textContent = '';
  $('#sync-status').classList.remove('error');
  $('#modal-sync').hidden = false;
}

$('#btn-sync-confirm').addEventListener('click', async () => {
  const targets = $$('#sync-target-picks input:checked').map((el) => el.dataset.agent);
  const status = $('#sync-status');
  if (targets.length === 0) { status.textContent = '请勾选至少一个 Agent。'; return; }
  try {
    $('#btn-sync-confirm').disabled = true;
    const r = await call('copySkillTo', state.syncTarget.agentId, state.syncTarget.dirName, targets);
    state.skills = r.skills;
    renderAll();
    $('#modal-sync').hidden = true;
    toast(r.copied.length ? `已同步到：${r.copied.join('、')}` : '没有同步任何 Agent', r.copied.length ? 'ok' : 'warn');
    if (r.errors.length) toast(r.errors.join('\n'), 'warn', 6000);
  } catch (e) {
    status.textContent = e.message;
    status.classList.add('error');
  } finally {
    $('#btn-sync-confirm').disabled = false;
  }
});

$('#btn-sync-cancel').addEventListener('click', () => { $('#modal-sync').hidden = true; });

/* ============ 详情弹窗 ============ */

let detailPath = '';

async function openDetailModal(skill) {
  const d = await call('skillDetail', skill.agentId, skill.dirName);
  detailPath = d.path;
  $('#detail-title').textContent = `${skill.title}（${skill.agentName}）`;
  const src = skill.source
    ? `来源：${skill.source.repo}${skill.source.subpath ? ' / ' + skill.source.subpath : ''} @ ${skill.source.commit.slice(0, 7)}<br>安装：${skill.source.installedAt.slice(0, 10)}　更新：${skill.source.updatedAt.slice(0, 10)}<br>`
    : '来源：本地（无 GitHub 来源记录）<br>';
  $('#detail-meta').innerHTML =
    `${src}路径：${escapeHtml(d.path)}<br>文件：${d.files.length}${d.files.length >= 200 ? '+' : ''} 个（${escapeHtml(d.files.slice(0, 8).join('、'))}${d.files.length > 8 ? '…' : ''}）`;
  $('#detail-content').textContent = d.content;
  $('#modal-detail').hidden = false;
}

$('#btn-detail-open').addEventListener('click', () => { if (detailPath) call('openPath', detailPath); });
$('#btn-detail-close').addEventListener('click', () => { $('#modal-detail').hidden = true; });

/* ============ 发现视图 ============ */

async function searchGithub(query) {
  const listEl = $('#repo-list');
  listEl.innerHTML = '<div class="empty">搜索中…</div>';
  try {
    const repos = await call('searchRepos', query);
    if (repos.length === 0) {
      listEl.innerHTML = '<div class="empty">没有找到相关仓库，换个关键词试试。</div>';
      return;
    }
    listEl.innerHTML = repos
      .map(
        (r) => `
        <div class="repo-row" data-repo="${escapeHtml(r.fullName)}" data-url="${escapeHtml(r.url)}">
          <div class="repo-info">
            <div class="repo-name">${escapeHtml(r.fullName)}</div>
            <div class="repo-desc">${escapeHtml(r.description) || '（无描述）'}</div>
            <div class="repo-meta"><span class="star">★ ${r.stars}</span>　更新于 ${escapeHtml((r.updatedAt || '').slice(0, 10))}</div>
          </div>
          <button class="btn small" data-act="open">打开主页</button>
          <button class="btn small primary" data-act="install">安装</button>
        </div>`
      )
      .join('');
  } catch (e) {
    listEl.innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`;
  }
}

$('#btn-gh-search').addEventListener('click', () => {
  const q = $('#gh-search').value.trim();
  if (q) searchGithub(q);
});
$('#gh-search').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') $('#btn-gh-search').click();
});
$('#repo-list').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const row = ev.target.closest('.repo-row');
  if (btn.dataset.act === 'open') call('openExternal', row.dataset.url);
  else if (btn.dataset.act === 'install') openInstallModal(row.dataset.repo);
});
$('.discover-hint').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-repo]');
  if (btn) openInstallModal(btn.dataset.repo);
});

/* ============ 设置视图 ============ */

function renderSettings() {
  const s = state.settings;
  if (!s) return;
  $('#set-token').value = s.token || '';
  $('#set-auto-update').checked = Boolean(s.autoUpdate);
  $('#set-auto-hours').value = s.autoUpdateHours || 6;

  $('#agent-status-list').innerHTML = state.agents
    .filter((a) => !a.custom)
    .map(
      (a) => `
      <div class="agent-status-row">
        <span class="lamp ${a.detected ? 'ok' : 'off'}" title="${a.detected ? '已检测到' : '未检测到'}"></span>
        <span class="name">${escapeHtml(a.name)}</span>
        <span class="dir">${escapeHtml(a.dir)}</span>
      </div>`
    )
    .join('');

  const custom = s.customAgents || [];
  $('#custom-agent-list').innerHTML = custom.length
    ? custom
        .map(
          (c, i) => `
        <div class="agent-status-row">
          <span class="lamp ok"></span>
          <span class="name">${escapeHtml(c.name)}</span>
          <span class="dir">${escapeHtml(c.dir)}</span>
          <button class="icon-btn danger" data-remove-custom="${i}" title="移除">✕</button>
        </div>`
        )
        .join('')
    : '<p class="muted">还没有自定义目录。任何包含技能子目录（内含 SKILL.md）的文件夹都可以接入。</p>';
}

$('#custom-agent-list').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-remove-custom]');
  if (!btn) return;
  const custom = [...(state.settings.customAgents || [])];
  custom.splice(Number(btn.dataset.removeCustom), 1);
  state.settings = await call('setSettings', { customAgents: custom });
  await refreshAll();
});

$('#btn-add-custom').addEventListener('click', async () => {
  const name = $('#custom-name').value.trim();
  const dir = $('#custom-dir').value.trim();
  if (!dir) { toast('请填写目录路径', 'warn'); return; }
  const custom = [...(state.settings.customAgents || []), { id: 'custom-' + Date.now().toString(36), name: name || dir, dir }];
  state.settings = await call('setSettings', { customAgents: custom });
  $('#custom-name').value = '';
  $('#custom-dir').value = '';
  await refreshAll();
  toast('已添加自定义 Agent 目录');
});

$('#btn-save-settings').addEventListener('click', async () => {
  try {
    state.settings = await call('setSettings', {
      token: $('#set-token').value.trim(),
      autoUpdate: $('#set-auto-update').checked,
      autoUpdateHours: Math.max(1, Number($('#set-auto-hours').value) || 6),
    });
    renderSidebar();
    $('#save-hint').textContent = '已保存 ✓';
    setTimeout(() => { $('#save-hint').textContent = ''; }, 2500);
  } catch (e) {
    toast(e.message, 'error');
  }
});

/* ============ 导航与全局 ============ */

$$('.nav-item').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    $('#modal-install').hidden = true;
    $('#modal-sync').hidden = true;
    $('#modal-detail').hidden = true;
  }
});

// 自动更新结果通知
window.api.onAutoUpdateStatus((p) => {
  if (p.state === 'done' && p.updated && p.updated.length) {
    toast(`自动更新完成：${p.updated.join('、')}`, 'ok', 8000);
    refreshAll();
  } else if (p.state === 'error') {
    toast(`自动更新失败：${p.error}`, 'error', 8000);
  }
});

refreshAll().catch((e) => toast('初始化失败：' + e.message, 'error', 10000));
