const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const skills = require('./lib/skills');
const github = require('./lib/github');

let win = null;
let autoUpdateTimer = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: '#131820',
    autoHideMenuBar: true,
    title: 'Skills Control',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

function notify(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// 定时自动更新：按设置的间隔检查 GitHub，有新提交就直接更新并通知界面
async function runAutoUpdate(reason) {
  const settings = skills.getSettings();
  if (!settings.autoUpdate) return;
  try {
    notify('auto-update:status', { state: 'checking', reason });
    const report = await github.updateAll();
    notify('auto-update:status', { state: 'done', reason, ...report });
  } catch (e) {
    notify('auto-update:status', { state: 'error', reason, error: e.message });
  }
}

function scheduleAutoUpdate() {
  if (autoUpdateTimer) clearInterval(autoUpdateTimer);
  const settings = skills.getSettings();
  if (!settings.autoUpdate) return;
  const hours = Math.max(1, Number(settings.autoUpdateHours) || 6);
  autoUpdateTimer = setInterval(() => runAutoUpdate('interval'), hours * 3600 * 1000);
}

// IPC：统一包一层 try/catch，返回 { ok, data | error }
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
}

handle('skills:list', () => skills.listSkills());
handle('skills:agents', () => skills.getAgentList());
handle('skills:toggle', (agentId, dirName, enable) => skills.toggleSkill(agentId, dirName, enable));
handle('skills:delete', (agentId, dirName) => skills.deleteSkill(agentId, dirName));
handle('skills:detail', (agentId, dirName) => skills.getDetail(agentId, dirName));
handle('skills:copyTo', (agentId, dirName, targets) => skills.copySkillTo(agentId, dirName, targets));

handle('github:resolve', (input) => github.resolveRepo(input));
handle('github:install', (payload) => github.installSkills(payload));
handle('github:checkUpdates', () => github.checkUpdates());
handle('github:update', (key) => github.updateSkill(key));
handle('github:updateAll', () => github.updateAll());
handle('github:search', (query) => github.searchRepos(query, skills.getSettings().token));

handle('settings:get', () => skills.getSettings());
handle('settings:set', (patch) => {
  const s = skills.setSettings(patch);
  scheduleAutoUpdate();
  return s;
});
handle('shell:openExternal', (url) => {
  if (!/^https:\/\//.test(url)) throw new Error('只允许打开 https 链接');
  return shell.openExternal(url);
});
handle('shell:openPath', (p) => shell.openPath(p));

// 单实例锁：重复启动时聚焦已有窗口，避免两个实例争抢缓存与清单文件
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  scheduleAutoUpdate();
  // 启动 10 秒后做一次自动更新检查（若已开启），避免拖慢首屏
  setTimeout(() => runAutoUpdate('startup'), 10 * 1000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
