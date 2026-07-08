// 本地技能的扫描与管理（跨多个 Agent）：列表、启用/禁用、删除、详情、同步复制、清单读写
const fs = require('fs');
const path = require('path');
const os = require('os');
const agents = require('./agents');

const MANIFEST_PATH = path.join(os.homedir(), '.skills-control.json');

const DEFAULT_SETTINGS = {
  token: '',
  autoUpdate: false,
  autoUpdateHours: 6,
  customAgents: [],
};

function readManifest() {
  try {
    const data = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    return {
      settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
      installs: data.installs || {},
    };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, installs: {} };
  }
}

function writeManifest(manifest) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
}

function installKey(agentId, dirName) {
  return `${agentId}:${dirName}`;
}

// 解析 SKILL.md 顶部 --- 包围的 frontmatter，只取一层 key: value
function parseFrontmatter(content) {
  const meta = {};
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return meta;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return meta;
}

function getAgentList() {
  return agents.getAgents(readManifest().settings.customAgents);
}

function scanDir(agent, dir, enabled, manifest) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const skillPath = path.join(dir, ent.name);
    let meta = {};
    let hasSkillMd = false;
    try {
      meta = parseFrontmatter(fs.readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8'));
      hasSkillMd = true;
    } catch {}
    if (!hasSkillMd) continue; // 不是技能目录（如插件缓存等），跳过
    const record = manifest.installs[installKey(agent.id, ent.name)] || null;
    out.push({
      agentId: agent.id,
      agentName: agent.name,
      dirName: ent.name,
      title: meta.name || ent.name,
      description: meta.description || '',
      enabled,
      path: skillPath,
      source: record
        ? {
            repo: `${record.owner}/${record.repo}`,
            ref: record.ref,
            subpath: record.subpath || '',
            commit: record.commit || '',
            installedAt: record.installedAt || '',
            updatedAt: record.updatedAt || '',
          }
        : null,
    });
  }
  return out;
}

// 扫描所有检测到的 Agent 的技能目录（含禁用目录）
function listSkills() {
  const manifest = readManifest();
  const all = [];
  for (const agent of agents.getAgents(manifest.settings.customAgents)) {
    if (!agent.detected && !agent.hasSkillsDir) continue;
    all.push(...scanDir(agent, agent.dir, true, manifest));
    all.push(...scanDir(agent, agent.disabledDir, false, manifest));
  }
  return all.sort((a, b) => a.dirName.localeCompare(b.dirName) || a.agentId.localeCompare(b.agentId));
}

function toggleSkill(agentId, dirName, enable) {
  const agent = agents.getAgent(agentId, readManifest().settings.customAgents);
  const from = path.join(enable ? agent.disabledDir : agent.dir, dirName);
  const to = path.join(enable ? agent.dir : agent.disabledDir, dirName);
  if (!fs.existsSync(from)) throw new Error(`找不到技能目录：${from}`);
  if (fs.existsSync(to)) throw new Error(`目标位置已存在同名目录：${to}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  return listSkills();
}

function deleteSkill(agentId, dirName) {
  const agent = agents.getAgent(agentId, readManifest().settings.customAgents);
  for (const base of [agent.dir, agent.disabledDir]) {
    const p = path.join(base, dirName);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  }
  const manifest = readManifest();
  if (manifest.installs[installKey(agentId, dirName)]) {
    delete manifest.installs[installKey(agentId, dirName)];
    writeManifest(manifest);
  }
  return listSkills();
}

// 把某个已安装技能复制到其他 Agent 的技能目录（接入其他工具）
function copySkillTo(agentId, dirName, targetAgentIds) {
  const manifest = readManifest();
  const custom = manifest.settings.customAgents;
  const srcAgent = agents.getAgent(agentId, custom);
  let src = path.join(srcAgent.dir, dirName);
  if (!fs.existsSync(src)) src = path.join(srcAgent.disabledDir, dirName);
  if (!fs.existsSync(src)) throw new Error(`找不到技能目录：${dirName}`);
  const copied = [];
  const errors = [];
  for (const targetId of targetAgentIds) {
    try {
      const target = agents.getAgent(targetId, custom);
      const dest = path.join(target.dir, dirName);
      if (fs.existsSync(dest)) {
        errors.push(`${target.name}：已存在同名技能，已跳过`);
        continue;
      }
      fs.mkdirSync(target.dir, { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
      // 若源技能有 GitHub 来源记录，同步到目标，便于后续统一更新
      const srcRecord = manifest.installs[installKey(agentId, dirName)];
      if (srcRecord) manifest.installs[installKey(targetId, dirName)] = { ...srcRecord };
      copied.push(target.name);
    } catch (e) {
      errors.push(`${targetId}：${e.message}`);
    }
  }
  writeManifest(manifest);
  return { copied, errors, skills: listSkills() };
}

function getDetail(agentId, dirName) {
  const agent = agents.getAgent(agentId, readManifest().settings.customAgents);
  const base = fs.existsSync(path.join(agent.dir, dirName)) ? agent.dir : agent.disabledDir;
  const skillPath = path.join(base, dirName);
  let content = '';
  try {
    content = fs.readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8');
  } catch {
    content = '（该目录没有 SKILL.md 文件）';
  }
  const files = [];
  const walk = (dir, prefix) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (files.length < 200) walk(path.join(dir, ent.name), rel);
      } else {
        files.push(rel);
      }
      if (files.length >= 200) return;
    }
  };
  try {
    walk(skillPath, '');
  } catch {}
  return { agentId, dirName, path: skillPath, content, files };
}

function getSettings() {
  return readManifest().settings;
}

function setSettings(patch) {
  const manifest = readManifest();
  manifest.settings = { ...manifest.settings, ...patch };
  writeManifest(manifest);
  return manifest.settings;
}

module.exports = {
  MANIFEST_PATH,
  readManifest,
  writeManifest,
  installKey,
  parseFrontmatter,
  getAgentList,
  listSkills,
  toggleSkill,
  deleteSkill,
  copySkillTo,
  getDetail,
  getSettings,
  setSettings,
};
