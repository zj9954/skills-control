// GitHub 相关操作 —— 零 API 依赖版本：
// 安装/解析：直接下载 tarball（codeload.github.com）后本地扫描 SKILL.md
// 检查更新：读取仓库 commits 的 Atom 订阅源（github.com/.../commits/分支.atom）比对最新提交
// 仅「搜索发现」仍走 GitHub API（无替代方案），可选 Token 只用于这里
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const skills = require('./skills');
const agents = require('./agents');

const UA = { 'User-Agent': 'skills-control' };

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

function refPath(ref) {
  return ref.split('/').map(encodeURIComponent).join('/');
}

// 通过 commits Atom 订阅源取分支最新提交（公开网页功能，不受 API 速率限制）
// 返回 sha；分支/仓库不存在返回 null
async function atomLatestCommit(owner, repo, ref) {
  const res = await fetch(`https://github.com/${owner}/${repo}/commits/${refPath(ref)}.atom`, { headers: UA });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`获取仓库提交信息失败：${res.status} ${res.statusText}`);
  const text = await res.text();
  const m = text.match(/Grit::Commit\/([0-9a-f]{40})/);
  return m ? m[1] : null;
}

// 确定分支：指定了就验证，没指定就依次探测 main / master
async function resolveRef(owner, repo, ref) {
  const candidates = ref ? [ref] : ['main', 'master'];
  for (const candidate of candidates) {
    const sha = await atomLatestCommit(owner, repo, candidate);
    if (sha) return { ref: candidate, sha };
  }
  throw new Error(
    ref
      ? `找不到分支「${ref}」，或仓库不存在/为私有仓库（暂不支持私有仓库）。`
      : '仓库不存在、为私有仓库（暂不支持），或默认分支不是 main/master —— 可在地址中带上分支，如 user/repo/tree/分支名。'
  );
}

async function downloadAndExtract(owner, repo, ref) {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-control-'));
  const tarPath = path.join(tmpBase, 'repo.tar.gz');
  const res = await fetch(`https://codeload.github.com/${owner}/${repo}/tar.gz/${refPath(ref)}`, { headers: UA });
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

// 「解析」和「安装」共用同一次下载：解析后把解压结果缓存，安装时直接取用
const bundleCache = new Map();

function bundleKey(owner, repo, ref) {
  return `${owner}/${repo}@${ref}`;
}

async function acquireBundle(owner, repo, ref, sha) {
  const key = bundleKey(owner, repo, ref);
  const cached = bundleCache.get(key);
  if (cached) return cached;
  // 只保留最近一份缓存，避免临时目录堆积
  for (const [k, b] of bundleCache) {
    try { b.cleanup(); } catch {}
    bundleCache.delete(k);
  }
  if (!sha) sha = (await resolveRef(owner, repo, ref)).sha;
  const { root, cleanup } = await downloadAndExtract(owner, repo, ref);
  const bundle = { root, cleanup, sha };
  bundleCache.set(key, bundle);
  return bundle;
}

function releaseBundle(owner, repo, ref) {
  const key = bundleKey(owner, repo, ref);
  const b = bundleCache.get(key);
  if (b) {
    try { b.cleanup(); } catch {}
    bundleCache.delete(key);
  }
}

// 在解压后的目录树中找出所有含 SKILL.md 的目录（相对路径）
function scanForSkills(root) {
  const found = [];
  const walk = (dir, rel, depth) => {
    if (depth > 8 || found.length >= 200) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) found.push(rel);
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === '.git' || e.name === 'node_modules') continue;
      walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };
  walk(root, '', 0);
  return found;
}

// 解析仓库：一次下载，本地扫描出所有可安装技能（不消耗任何 API 额度）
async function resolveRepo(input) {
  const target = parseRepoInput(input);
  const { ref, sha } = await resolveRef(target.owner, target.repo, target.ref);
  target.ref = ref;
  releaseBundle(target.owner, target.repo, ref); // 确保拿到全新内容
  const bundle = await acquireBundle(target.owner, target.repo, ref, sha);
  let found = scanForSkills(bundle.root);
  if (target.subpath) {
    found = found.filter((dir) => dir === target.subpath || dir.startsWith(target.subpath + '/'));
  }
  if (found.length === 0) {
    throw new Error('该仓库中没有找到任何 SKILL.md，可能不是技能仓库。');
  }
  const results = found.map((dir) => {
    let meta = {};
    try {
      meta = skills.parseFrontmatter(
        fs.readFileSync(path.join(bundle.root, ...(dir ? dir.split('/') : []), 'SKILL.md'), 'utf8')
      );
    } catch {}
    const defaultName = dir ? dir.split('/').pop() : target.repo;
    return {
      subpath: dir,
      name: meta.name || defaultName,
      dirName: defaultName,
      description: meta.description || '',
    };
  });
  return { ...target, commit: bundle.sha, skills: results, truncated: found.length >= 200 };
}

// 目录内容哈希：用于判断技能文件是否真的变了（仓库其他文件的提交不算）
function dirHash(dir) {
  const hash = crypto.createHash('sha1');
  const walk = (d, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else {
        hash.update(r + '\0');
        try { hash.update(fs.readFileSync(path.join(d, e.name))); } catch {}
        hash.update('\0');
      }
    }
  };
  walk(dir, '');
  return hash.digest('hex');
}

// selections: [{ subpath, dirName }]；targets: 要安装到的 agentId 数组
// 返回 installed（新装/有变化）、unchanged（内容没变只更新记录）、errors
async function installSkills({ owner, repo, ref, selections, targets }) {
  if (!targets || targets.length === 0) throw new Error('请至少选择一个要接入的 Agent。');
  const bundle = await acquireBundle(owner, repo, ref);
  const manifest = skills.readManifest();
  const installed = [];
  const unchanged = [];
  const errors = [];
  try {
    for (const sel of selections) {
      const src = sel.subpath ? path.join(bundle.root, ...sel.subpath.split('/')) : bundle.root;
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
        const now = new Date().toISOString();
        const record = {
          owner,
          repo,
          ref,
          subpath: sel.subpath || '',
          commit: bundle.sha,
          installedAt: existing ? existing.installedAt : now,
          updatedAt: now,
        };
        // 仓库有新提交但技能文件本身没变：只刷新记录，不动文件
        if (existing && fs.existsSync(targetPath) && dirHash(src) === dirHash(targetPath)) {
          record.updatedAt = existing.updatedAt;
          manifest.installs[key] = record;
          unchanged.push(`${agent.name} / ${sel.dirName}`);
          continue;
        }
        if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.cpSync(src, targetPath, { recursive: true });
        manifest.installs[key] = record;
        installed.push(`${agent.name} / ${sel.dirName}`);
      }
    }
    skills.writeManifest(manifest);
  } finally {
    releaseBundle(owner, repo, ref);
  }
  return { installed, unchanged, errors, skills: skills.listSkills() };
}

// 检查所有通过本工具安装的技能是否有更新（按 仓库@分支 去重，每个仓库只请求一次 Atom 源）
async function checkUpdates() {
  const manifest = skills.readManifest();
  const result = {};
  const headCache = {};
  for (const [key, rec] of Object.entries(manifest.installs)) {
    try {
      const cacheKey = bundleKey(rec.owner, rec.repo, rec.ref);
      if (!(cacheKey in headCache)) {
        headCache[cacheKey] = await atomLatestCommit(rec.owner, rec.repo, rec.ref);
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
async function updateSkill(key) {
  const manifest = skills.readManifest();
  const rec = manifest.installs[key];
  if (!rec) throw new Error('该技能不是通过本工具从 GitHub 安装的，无法自动更新。');
  const sep = key.indexOf(':');
  const agentId = key.slice(0, sep);
  const dirName = key.slice(sep + 1);
  return installSkills({
    owner: rec.owner,
    repo: rec.repo,
    ref: rec.ref,
    selections: [{ subpath: rec.subpath, dirName }],
    targets: [agentId],
  });
}

// 检查并更新所有有新提交的技能（自动更新与手动「全部更新」共用）
async function updateAll() {
  const updates = await checkUpdates();
  const updated = [];
  const unchanged = [];
  const errors = [];
  for (const [key, info] of Object.entries(updates)) {
    if (!info.hasUpdate) continue;
    try {
      const r = await updateSkill(key);
      updated.push(...r.installed);
      unchanged.push(...r.unchanged);
      errors.push(...r.errors);
    } catch (e) {
      errors.push(`${key}：${e.message}`);
    }
  }
  return { updated, unchanged, errors, checked: Object.keys(updates).length };
}

// 搜索发现：GitHub API 无免额度替代（未登录约 10 次/分钟，正常使用足够）
async function searchRepos(query, token) {
  const q = encodeURIComponent(`${query} claude skill`.trim());
  const headers = { ...UA, Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=20`, {
    headers,
  });
  if (res.status === 403 || res.status === 429) {
    throw new Error('搜索请求过于频繁，请稍等一分钟再试（或在「设置」填入 Token 提高限额）。');
  }
  if (!res.ok) throw new Error(`搜索失败：${res.status} ${res.statusText}`);
  const data = await res.json();
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
