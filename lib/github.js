// GitHub 相关操作：解析仓库地址、发现仓库内的技能、下载安装到多个 Agent、检查/执行更新、搜索
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const skills = require('./skills');
const agents = require('./agents');

const API = 'https://api.github.com';

function headers(token) {
  const h = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'skills-control',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function ghJson(url, token) {
  const res = await fetch(url, { headers: headers(token) });
  if (res.status === 403 || res.status === 429) {
    throw new Error('GitHub API 速率受限。可在「设置」中填入 Personal Access Token 提高额度。');
  }
  if (res.status === 404) throw new Error('仓库或路径不存在（404）。请检查地址是否正确、仓库是否公开。');
  if (!res.ok) throw new Error(`GitHub API 请求失败：${res.status} ${res.statusText}`);
  return res.json();
}

// 支持的输入：user/repo、完整 URL、带 /tree/分支/子目录 的 URL
function parseRepoInput(input) {
  let s = input.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  s = s.replace(/^git@github\.com:/, '');
  s = s.replace(/^https?:\/\/(www\.)?github\.com\//, '');
  const treeMatch = s.match(/^([^/]+)\/([^/]+)\/(?:tree|blob)\/([^/]+)(?:\/(.*))?$/);
  if (treeMatch) {
    return {
      owner: treeMatch[1],
      repo: treeMatch[2],
      ref: treeMatch[3],
      subpath: treeMatch[4] || '',
    };
  }
  const plain = s.match(/^([^/]+)\/([^/]+)$/);
  if (plain) return { owner: plain[1], repo: plain[2], ref: '', subpath: '' };
  throw new Error('无法识别的地址。支持「user/repo」或完整的 GitHub 仓库链接。');
}

// 在仓库文件树中找出所有 SKILL.md，返回可安装的技能列表
async function resolveRepo(input, token) {
  const target = parseRepoInput(input);
  if (!target.ref) {
    const repoInfo = await ghJson(`${API}/repos/${target.owner}/${target.repo}`, token);
    target.ref = repoInfo.default_branch;
  }
  const tree = await ghJson(
    `${API}/repos/${target.owner}/${target.repo}/git/trees/${encodeURIComponent(target.ref)}?recursive=1`,
    token
  );
  const found = [];
  for (const item of tree.tree || []) {
    if (item.type !== 'blob') continue;
    if (!/(^|\/)SKILL\.md$/.test(item.path)) continue;
    const dir = item.path.replace(/\/?SKILL\.md$/, '');
    if (target.subpath && dir !== target.subpath && !dir.startsWith(target.subpath + '/')) continue;
    found.push(dir);
  }
  if (found.length === 0) {
    throw new Error('该仓库中没有找到任何 SKILL.md，可能不是技能仓库。');
  }
  // 拉取每个 SKILL.md 的 frontmatter 以显示名称和描述（最多 30 个，避免刷爆请求）
  const results = [];
  for (const dir of found.slice(0, 30)) {
    const mdPath = dir ? `${dir}/SKILL.md` : 'SKILL.md';
    let meta = {};
    try {
      const raw = await fetch(
        `https://raw.githubusercontent.com/${target.owner}/${target.repo}/${target.ref}/${mdPath}`,
        { headers: { 'User-Agent': 'skills-control' } }
      );
      if (raw.ok) meta = skills.parseFrontmatter(await raw.text());
    } catch {}
    const defaultName = dir ? dir.split('/').pop() : target.repo;
    results.push({
      subpath: dir,
      name: meta.name || defaultName,
      dirName: defaultName,
      description: meta.description || '',
    });
  }
  return { ...target, skills: results, truncated: found.length > 30 };
}

async function latestCommit(owner, repo, ref, subpath, token) {
  const url =
    `${API}/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(ref)}&per_page=1` +
    (subpath ? `&path=${encodeURIComponent(subpath)}` : '');
  const commits = await ghJson(url, token);
  return commits[0] ? commits[0].sha : '';
}

async function downloadAndExtract(owner, repo, ref) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-control-'));
  const tarPath = path.join(tmpBase, 'repo.tar.gz');
  const res = await fetch(`https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`, {
    headers: { 'User-Agent': 'skills-control' },
  });
  if (!res.ok) throw new Error(`下载仓库失败：${res.status} ${res.statusText}`);
  fs.writeFileSync(tarPath, Buffer.from(await res.arrayBuffer()));
  const extractDir = path.join(tmpBase, 'x');
  fs.mkdirSync(extractDir);
  // Windows 10+/macOS/Linux 都自带 tar
  execFileSync('tar', ['-xzf', tarPath, '-C', extractDir]);
  const top = fs.readdirSync(extractDir).find((n) => fs.statSync(path.join(extractDir, n)).isDirectory());
  if (!top) throw new Error('压缩包解压后为空。');
  return { root: path.join(extractDir, top), cleanup: () => fs.rmSync(tmpBase, { recursive: true, force: true }) };
}

// selections: [{ subpath, dirName }]；targets: 要安装到的 agentId 数组
async function installSkills({ owner, repo, ref, selections, targets }, token) {
  if (!targets || targets.length === 0) throw new Error('请至少选择一个要接入的 Agent。');
  // 按子路径记录提交，与 checkUpdates 的比对口径一致，避免安装后误报“有更新”
  const commitCache = {};
  const commitFor = async (subpath) => {
    const k = subpath || '';
    if (!(k in commitCache)) commitCache[k] = await latestCommit(owner, repo, ref, k, token);
    return commitCache[k];
  };
  const { root, cleanup } = await downloadAndExtract(owner, repo, ref);
  const manifest = skills.readManifest();
  const installed = [];
  const errors = [];
  try {
    for (const sel of selections) {
      const src = sel.subpath ? path.join(root, ...sel.subpath.split('/')) : root;
      if (!fs.existsSync(path.join(src, 'SKILL.md'))) {
        errors.push(`${sel.dirName}：源目录中没有 SKILL.md，已跳过`);
        continue;
      }
      for (const agentId of targets) {
        let agent;
        try {
          agent = agents.getAgent(agentId, manifest.settings.customAgents);
        } catch (e) {
          errors.push(e.message);
          continue;
        }
        const key = skills.installKey(agentId, sel.dirName);
        const existing = manifest.installs[key];
        const dest = path.join(agent.dir, sel.dirName);
        const disabledDest = path.join(agent.disabledDir, sel.dirName);
        if (fs.existsSync(dest) && !existing) {
          errors.push(`${agent.name} / ${sel.dirName}：本地已存在同名技能（非本工具安装），已跳过以免覆盖`);
          continue;
        }
        // 更新时：若技能处于禁用状态，就地更新禁用目录，保持禁用状态不变
        const targetPath = existing && fs.existsSync(disabledDest) && !fs.existsSync(dest) ? disabledDest : dest;
        if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.cpSync(src, targetPath, { recursive: true });
        const now = new Date().toISOString();
        manifest.installs[key] = {
          owner,
          repo,
          ref,
          subpath: sel.subpath || '',
          commit: await commitFor(sel.subpath),
          installedAt: existing ? existing.installedAt : now,
          updatedAt: now,
        };
        installed.push(`${agent.name} / ${sel.dirName}`);
      }
    }
    skills.writeManifest(manifest);
  } finally {
    cleanup();
  }
  return { installed, errors, skills: skills.listSkills() };
}

// 检查所有通过本工具安装的技能是否有更新（按 仓库+分支+子路径 去重比对最新提交）
async function checkUpdates(token) {
  const manifest = skills.readManifest();
  const result = {};
  const headCache = {};
  for (const [key, rec] of Object.entries(manifest.installs)) {
    try {
      const cacheKey = `${rec.owner}/${rec.repo}@${rec.ref}#${rec.subpath || ''}`;
      if (!(cacheKey in headCache)) {
        headCache[cacheKey] = await latestCommit(rec.owner, rec.repo, rec.ref, rec.subpath, token);
      }
      const latest = headCache[cacheKey];
      result[key] = { hasUpdate: Boolean(latest) && latest !== rec.commit, latest };
    } catch (e) {
      result[key] = { error: e.message };
    }
  }
  return result;
}

// key 形如 "claude:pptx"
async function updateSkill(key, token) {
  const manifest = skills.readManifest();
  const rec = manifest.installs[key];
  if (!rec) throw new Error('该技能不是通过本工具从 GitHub 安装的，无法自动更新。');
  const sep = key.indexOf(':');
  const agentId = key.slice(0, sep);
  const dirName = key.slice(sep + 1);
  return installSkills(
    {
      owner: rec.owner,
      repo: rec.repo,
      ref: rec.ref,
      selections: [{ subpath: rec.subpath, dirName }],
      targets: [agentId],
    },
    token
  );
}

// 检查并更新所有有新版本的技能，返回更新报告（供自动更新与手动“全部更新”使用）
async function updateAll(token) {
  const updates = await checkUpdates(token);
  const updated = [];
  const errors = [];
  for (const [key, info] of Object.entries(updates)) {
    if (!info.hasUpdate) continue;
    try {
      const r = await updateSkill(key, token);
      updated.push(...r.installed);
      errors.push(...r.errors);
    } catch (e) {
      errors.push(`${key}：${e.message}`);
    }
  }
  return { updated, errors, checked: Object.keys(updates).length };
}

async function searchRepos(query, token) {
  const q = encodeURIComponent(`${query} claude skill`.trim());
  const data = await ghJson(`${API}/search/repositories?q=${q}&sort=stars&order=desc&per_page=20`, token);
  return (data.items || []).map((r) => ({
    fullName: r.full_name,
    description: r.description || '',
    stars: r.stargazers_count,
    updatedAt: r.pushed_at,
    url: r.html_url,
  }));
}

module.exports = {
  parseRepoInput,
  resolveRepo,
  installSkills,
  checkUpdates,
  updateSkill,
  updateAll,
  searchRepos,
};
