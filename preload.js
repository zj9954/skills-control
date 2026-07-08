const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  listSkills: invoke('skills:list'),
  listAgents: invoke('skills:agents'),
  toggleSkill: invoke('skills:toggle'),
  deleteSkill: invoke('skills:delete'),
  skillDetail: invoke('skills:detail'),
  copySkillTo: invoke('skills:copyTo'),

  resolveRepo: invoke('github:resolve'),
  installSkills: invoke('github:install'),
  checkUpdates: invoke('github:checkUpdates'),
  updateSkill: invoke('github:update'),
  updateAll: invoke('github:updateAll'),
  searchRepos: invoke('github:search'),

  getSettings: invoke('settings:get'),
  setSettings: invoke('settings:set'),
  openExternal: invoke('shell:openExternal'),
  openPath: invoke('shell:openPath'),

  onAutoUpdateStatus: (callback) => {
    ipcRenderer.on('auto-update:status', (_event, payload) => callback(payload));
  },
});
