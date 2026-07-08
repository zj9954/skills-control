// 主流 AI Agent 的技能目录注册表：内置已知工具 + 用户自定义目录
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

// 均采用 Agent Skills 开放标准（目录内含 SKILL.md）
const KNOWN_AGENTS = [
  { id: 'claude', name: 'Claude Code', configDir: path.join(HOME, '.claude'), dir: path.join(HOME, '.claude', 'skills') },
  { id: 'codex', name: 'OpenAI Codex CLI', configDir: path.join(HOME, '.codex'), dir: path.join(HOME, '.codex', 'skills') },
  { id: 'gemini', name: 'Gemini CLI', configDir: path.join(HOME, '.gemini'), dir: path.join(HOME, '.gemini', 'skills') },
  { id: 'opencode', name: 'OpenCode', configDir: path.join(HOME, '.config', 'opencode'), dir: path.join(HOME, '.config', 'opencode', 'skills') },
  { id: 'cursor', name: 'Cursor', configDir: path.join(HOME, '.cursor'), dir: path.join(HOME, '.cursor', 'skills') },
  { id: 'copilot', name: 'GitHub Copilot CLI', configDir: path.join(HOME, '.copilot'), dir: path.join(HOME, '.copilot', 'skills') },
  { id: 'qwen', name: 'Qwen Code', configDir: path.join(HOME, '.qwen'), dir: path.join(HOME, '.qwen', 'skills') },
];

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

// customAgents: [{ id, name, dir }]（来自设置）
function getAgents(customAgents = []) {
  const list = KNOWN_AGENTS.map((a) => ({
    id: a.id,
    name: a.name,
    dir: a.dir,
    disabledDir: a.dir + '-disabled',
    custom: false,
    // 检测到 = 该工具的配置目录存在（说明用户装过这个工具）
    detected: exists(a.configDir),
    hasSkillsDir: exists(a.dir),
  }));
  for (const c of customAgents) {
    if (!c || !c.dir) continue;
    list.push({
      id: c.id || 'custom-' + Buffer.from(c.dir).toString('hex').slice(0, 8),
      name: c.name || c.dir,
      dir: c.dir,
      disabledDir: c.dir + '-disabled',
      custom: true,
      detected: exists(c.dir),
      hasSkillsDir: exists(c.dir),
    });
  }
  return list;
}

function getAgent(agentId, customAgents = []) {
  const agent = getAgents(customAgents).find((a) => a.id === agentId);
  if (!agent) throw new Error(`未知的 Agent：${agentId}`);
  return agent;
}

module.exports = { KNOWN_AGENTS, getAgents, getAgent };
