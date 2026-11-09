const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dgram = require('dgram');
const zlib = require('zlib');
const { WebSocketServer, WebSocket } = require('ws');
const QRCode = require('qrcode');

const APP_VERSION = '1.2.2';
const SEED_TIMESTAMP = 1700000000000;

// Share data directory between D:\To Doom and project folder if available
const SHARED_DATA_DIR = 'D:\\To Doom\\data';
const DATA_DIR = fs.existsSync('D:\\To Doom') ? SHARED_DATA_DIR : path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'board-state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_PORT = parseInt(process.env.PORT || '3456', 10);
const UDP_PORT = 3457;
const DEFAULT_TAILSCALE_SERVER = process.env.TODOOM_SERVER !== undefined ? process.env.TODOOM_SERVER : '100.101.231.78:3456';

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getInitialState() {
  return {
    version: APP_VERSION,
    nextTaskId: 17,
    activeProjectId: 'proj-1',
    deletedProjects: {},
    settings: {
      githubRepo: 'Archyange1/To-Doom',
      githubBranch: 'main',
      lastUpdateCheck: null
    },
    projects: [
      {
        id: 'proj-1',
        name: 'Запуск сайту',
        color: '#22c55e',
        agentEnabled: true,
        createdAt: SEED_TIMESTAMP,
        updatedAt: SEED_TIMESTAMP
      },
      {
        id: 'proj-2',
        name: 'Мобільний додаток',
        color: '#f59e0b',
        agentEnabled: false,
        createdAt: SEED_TIMESTAMP,
        updatedAt: SEED_TIMESTAMP
      }
    ],
    tasks: [
      {
        id: 12,
        projectId: 'proj-1',
        title: 'Написати інструкцію з налаштування',
        epic: 'Документація',
        column: 0,
        progress: 40,
        assignee: 'Codex',
        dotColor: '#a855f7',
        order: 0,
        deleted: false,
        updatedAt: SEED_TIMESTAMP
      },
      {
        id: 13,
        projectId: 'proj-1',
        title: 'Підключити ШІ-агентів (MCP)',
        epic: 'Інтеграція',
        column: 1,
        progress: 75,
        assignee: 'Codex',
        dotColor: '#f59e0b',
        order: 0,
        deleted: false,
        updatedAt: SEED_TIMESTAMP
      },
      {
        id: 14,
        projectId: 'proj-1',
        title: 'Перевірити сценарій онбордингу',
        epic: 'UX',
        column: 1,
        progress: 45,
        assignee: 'Claude',
        dotColor: '#a855f7',
        order: 1,
        deleted: false,
        updatedAt: SEED_TIMESTAMP
      },
      {
        id: 15,
        projectId: 'proj-1',
        title: 'Створити дошку проєкту',
        epic: 'Ядро',
        column: 2,
        progress: 100,
        assignee: 'Ви',
        dotColor: '#22c55e',
        order: 0,
        deleted: false,
        updatedAt: SEED_TIMESTAMP
      },
      {
        id: 16,
        projectId: 'proj-1',
        title: 'Підготувати чекліст релізу',
        epic: 'Реліз',
        column: 0,
        progress: 10,
        assignee: 'Ви',
        dotColor: '#f59e0b',
        order: 1,
        deleted: false,
        updatedAt: SEED_TIMESTAMP
      },
      {
        id: 10,
        projectId: 'proj-2',
        title: 'Адаптувати верстку під iPhone та планшет',
        epic: 'Мобільна версія',
        column: 1,
        progress: 80,
        assignee: 'Ви',
        dotColor: '#22c55e',
        order: 0,
        deleted: false,
        updatedAt: SEED_TIMESTAMP
      },
      {
        id: 11,
        projectId: 'proj-2',
        title: 'Синхронізація по Wi-Fi через QR-код',
        epic: 'Мережа',
        column: 2,
        progress: 100,
        assignee: 'Claude',
        dotColor: '#a855f7',
        order: 0,
        deleted: false,
        updatedAt: SEED_TIMESTAMP
      }
    ]
  };
}

let state = getInitialState();

function normalizeState(st) {
  if (!st.settings) {
    st.settings = { githubRepo: 'Archyange1/To-Doom', githubBranch: 'main', lastUpdateCheck: null };
  }
  if (!st.settings.githubRepo) {
    st.settings.githubRepo = 'Archyange1/To-Doom';
  }
  if (!st.settings.githubBranch) {
    st.settings.githubBranch = 'main';
  }
  if (!st.deletedProjects || typeof st.deletedProjects !== 'object' || Array.isArray(st.deletedProjects)) {
    st.deletedProjects = {};
  }
  st.version = APP_VERSION;
  if (Array.isArray(st.projects)) {
    const surviving = st.projects.filter((p) => {
      if (!p || !p.id) return false;
      const delTs = Number(st.deletedProjects[p.id]) || 0;
      const projTs = Number(p.updatedAt || p.createdAt || 0);
      return !(delTs > 0 && delTs >= projTs);
    });
    if (surviving.length > 0) {
      st.projects = surviving;
    }
    st.projects.forEach((p, idx) => {
      if (typeof p.agentEnabled !== 'boolean') {
        p.agentEnabled = idx === 0;
      }
    });
    if (st.projects.length > 0 && !st.projects.some(p => p.id === st.activeProjectId)) {
      st.activeProjectId = st.projects[0].id;
    }
  }
  return st;
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.projects) && Array.isArray(parsed.tasks)) {
        state = normalizeState(parsed);
        return;
      }
    }
  } catch (err) {
    console.error('Помилка читання стану, використовуємо початковий:', err.message);
  }
  saveState(false);
}

let isSaving = false;
function saveState(notify = true) {
  try {
    isSaving = true;
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    setTimeout(() => { isSaving = false; }, 120);
    if (notify) {
      broadcastState();
    }
  } catch (err) {
    console.error('Помилка збереження стану:', err.message);
  }
}

loadState();

fs.watchFile(STATE_FILE, { interval: 400 }, () => {
  if (isSaving) return;
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.tasks)) {
      state = normalizeState(parsed);
      broadcastState({ source: 'mcp' });
    }
  } catch (_) {}
});

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, netList] of Object.entries(interfaces)) {
    if (!netList) continue;
    const lower = name.toLowerCase();
    const isTailscale = lower.includes('tailscale');
    const isVirtual =
      !isTailscale && (
        lower.includes('vethernet') ||
        lower.includes('wsl') ||
        lower.includes('docker') ||
        lower.includes('vbox') ||
        lower.includes('vmware') ||
        lower.includes('hyper-v') ||
        lower.includes('loopback')
      );

    for (const net of netList) {
      if (net.family === 'IPv4' && !net.internal) {
        let priority = 10;
        let label = name;
        if (isTailscale || net.address.startsWith('100.')) {
          priority = 90;
          label = `${name} (Tailscale — будь-де)`;
        } else if (isVirtual) {
          priority = 1;
        } else if (lower.includes('wi-fi') || lower.includes('wlan') || lower.includes('wireless') || lower.includes('безпровідн')) {
          priority = 100;
          label = `${name} (Домашній Wi-Fi)`;
        } else if (net.address.startsWith('192.168.')) {
          priority = 80;
        } else if (net.address.startsWith('10.') || net.address.startsWith('172.')) {
          priority = 60;
        }
        candidates.push({
          name: label,
          address: net.address,
          priority,
          isVirtual
        });
      }
    }
  }
  candidates.sort((a, b) => b.priority - a.priority);
  if (candidates.length === 0) {
    candidates.push({ name: 'Localhost', address: '127.0.0.1', priority: 0, isVirtual: false });
  }
  return candidates;
}

function getDotColorForAssignee(assignee) {
  const lower = (assignee || '').toLowerCase();
  if (lower.includes('claude') || lower.includes('antigravity') || lower.includes('ai')) return '#a855f7';
  if (lower.includes('codex') || lower.includes('gpt') || lower.includes('cursor')) return '#f59e0b';
  if (lower.includes('iphone') || lower.includes('ipad') || lower.includes('планшет')) return '#38bdf8';
  return '#22c55e';
}

function mergeOfflineState(incoming) {
  if (!incoming) return false;
  let changed = false;
  if (!state.deletedProjects || typeof state.deletedProjects !== 'object' || Array.isArray(state.deletedProjects)) {
    state.deletedProjects = {};
  }

  if (incoming.settings && incoming.settings.githubRepo && !state.settings.githubRepo) {
    state.settings.githubRepo = incoming.settings.githubRepo;
    state.settings.githubBranch = incoming.settings.githubBranch || 'main';
    changed = true;
  }

  // 1. Merge project deletion tombstones FIRST so deleted projects stay deleted across all devices
  if (incoming.deletedProjects && typeof incoming.deletedProjects === 'object' && !Array.isArray(incoming.deletedProjects)) {
    for (const [projId, rawTs] of Object.entries(incoming.deletedProjects)) {
      const delTs = Number(rawTs) || 0;
      if (!projId || delTs <= 0) continue;
      const prevDelTs = Number(state.deletedProjects[projId]) || 0;
      if (delTs > prevDelTs) {
        state.deletedProjects[projId] = delTs;
        changed = true;
      }
      const effectiveDelTs = Math.max(prevDelTs, delTs);
      const existingIdx = state.projects.findIndex(p => p.id === projId);
      if (existingIdx !== -1) {
        const existingProj = state.projects[existingIdx];
        const projTs = Number(existingProj.updatedAt || existingProj.createdAt || 0);
        const hasSurvivingIncomingProj = Array.isArray(incoming.projects) && incoming.projects.some((ip) => {
          if (!ip || !ip.id || ip.id === projId) return false;
          const ipDel = Math.max(Number(state.deletedProjects[ip.id] || 0), Number((incoming.deletedProjects || {})[ip.id] || 0));
          const ipTs = Number(ip.updatedAt || ip.createdAt || 0);
          return !(ipDel > 0 && ipDel >= ipTs);
        });
        if (effectiveDelTs >= projTs && (state.projects.length > 1 || hasSurvivingIncomingProj)) {
          state.projects.splice(existingIdx, 1);
          state.tasks = state.tasks.filter(t => t.projectId !== projId);
          changed = true;
        }
      }
    }
  }

  // 2. Merge active projects (skipping any blocked by a deletion tombstone)
  if (Array.isArray(incoming.projects)) {
    for (const incProj of incoming.projects) {
      if (!incProj || !incProj.id) continue;
      const delTs = Number(state.deletedProjects[incProj.id]) || 0;
      const incTs = Number(incProj.updatedAt || incProj.createdAt || 0);
      if (delTs > 0 && delTs >= incTs) {
        continue;
      }
      if (delTs > 0 && incTs > delTs) {
        delete state.deletedProjects[incProj.id];
        changed = true;
      }

      const existing = state.projects.find(p => p.id === incProj.id);
      if (!existing) {
        state.projects.push({
          ...incProj,
          agentEnabled: typeof incProj.agentEnabled === 'boolean' ? incProj.agentEnabled : true
        });
        changed = true;
      } else if (incTs > (existing.updatedAt || 0)) {
        existing.name = incProj.name || existing.name;
        existing.color = incProj.color || existing.color;
        if (typeof incProj.agentEnabled === 'boolean') {
          existing.agentEnabled = incProj.agentEnabled;
        }
        existing.updatedAt = incTs;
        changed = true;
      }
    }
  }

  if (state.projects.length > 0 && !state.projects.some(p => p.id === state.activeProjectId)) {
    state.activeProjectId = state.projects[0].id;
    changed = true;
  }

  // 3. Merge tasks (skip tasks whose parent project is deleted)
  if (Array.isArray(incoming.tasks)) {
    for (const incTask of incoming.tasks) {
      if (!incTask || !incTask.title) continue;
      const projDelTs = Number(state.deletedProjects[incTask.projectId]) || 0;
      if (projDelTs > 0 && projDelTs >= (incTask.updatedAt || 0)) {
        continue;
      }
      let existing = null;
      if (incTask.clientUid) {
        existing = state.tasks.find(t => t.clientUid === incTask.clientUid);
      }
      if (!existing && typeof incTask.id === 'number') {
        existing = state.tasks.find(t => t.id === incTask.id);
        if (existing && incTask.createdOffline && existing.title !== incTask.title) {
          existing = null;
        }
      }

      if (!existing) {
        const maxId = state.tasks.reduce((m, t) => Math.max(m, t.id || 0), 16);
        const newId = Math.max(state.nextTaskId || 17, maxId + 1);
        const mergedTask = {
          ...incTask,
          id: state.tasks.some(t => t.id === incTask.id) ? newId : (incTask.id || newId),
          createdOffline: false
        };
        state.nextTaskId = Math.max(state.nextTaskId || 17, mergedTask.id + 1);
        state.tasks.push(mergedTask);
        changed = true;
      } else if ((incTask.updatedAt || 0) > (existing.updatedAt || 0)) {
        existing.title = incTask.title;
        existing.epic = incTask.epic ?? existing.epic;
        existing.column = typeof incTask.column === 'number' ? incTask.column : existing.column;
        existing.progress = typeof incTask.progress === 'number' ? incTask.progress : existing.progress;
        existing.assignee = incTask.assignee || existing.assignee;
        existing.dotColor = incTask.dotColor || existing.dotColor;
        existing.deleted = Boolean(incTask.deleted);
        existing.updatedAt = incTask.updatedAt;
        changed = true;
      }
    }
  }

  if (changed) {
    saveState(false);
  }
  return changed;
}

function checkMcpPermission(projectId, source) {
  if (source !== 'mcp') return { allowed: true };
  const proj = state.projects.find(p => p.id === projectId);
  if (!proj) return { allowed: false, error: `Проєкт "${projectId}" не знайдено.` };
  if (!proj.agentEnabled) {
    return {
      allowed: false,
      error: `Керування ШІ-агентом для проєкту «${proj.name}» вимкнено. Увімкніть перемикач «🤖 ШІ» для цього проєкту в додатку To Doom.`
    };
  }
  return { allowed: true, proj };
}

function applyAction(action, meta = {}) {
  const { type, payload = {} } = action;
  const source = meta.source || action.source || 'user';

  switch (type) {
    case 'SYNC_FULL_STATE': {
      if (payload.state && Array.isArray(payload.state.tasks)) {
        state = normalizeState(payload.state);
        saveState(false);
        broadcastState({ source: meta.source || 'peer', excludeWs: meta.ws });
      }
      return { ok: true, state };
    }

    case 'MERGE_OFFLINE_STATE': {
      mergeOfflineState(payload.state);
      broadcastState({ source: meta.source || 'merge' });
      return { ok: true, state };
    }

    case 'UPDATE_SETTINGS': {
      if (!state.settings) state.settings = {};
      if (typeof payload.githubRepo === 'string') {
        state.settings.githubRepo = cleanGithubRepo(payload.githubRepo);
      }
      if (typeof payload.githubBranch === 'string' && payload.githubBranch.trim()) {
        state.settings.githubBranch = payload.githubBranch.trim();
      }
      saveState(true);
      return { ok: true, settings: state.settings, state };
    }

    case 'SET_ACTIVE_PROJECT': {
      if (state.projects.some(p => p.id === payload.projectId)) {
        state.activeProjectId = payload.projectId;
        saveState(true);
      }
      return { ok: true, state };
    }

    case 'CREATE_PROJECT': {
      const name = (payload.name || '').trim();
      if (!name) return { ok: false, error: 'Назва проєкту порожня' };
      const colors = ['#22c55e', '#f59e0b', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6'];
      const color = payload.color || colors[state.projects.length % colors.length];
      const newProj = {
        id: payload.id || ('proj-' + Date.now()),
        name,
        color,
        agentEnabled: typeof payload.agentEnabled === 'boolean' ? payload.agentEnabled : true,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      if (state.deletedProjects && state.deletedProjects[newProj.id]) {
        delete state.deletedProjects[newProj.id];
      }
      state.projects.push(newProj);
      state.activeProjectId = newProj.id;
      saveState(true);
      return { ok: true, project: newProj, state };
    }

    case 'UPDATE_PROJECT': {
      const proj = state.projects.find(p => p.id === payload.projectId);
      if (!proj) return { ok: false, error: 'Проєкт не знайдено' };
      if (typeof payload.name === 'string' && payload.name.trim()) {
        proj.name = payload.name.trim();
      }
      if (payload.color) {
        proj.color = payload.color;
      }
      if (typeof payload.agentEnabled === 'boolean') {
        proj.agentEnabled = payload.agentEnabled;
      }
      proj.updatedAt = Date.now();
      saveState(true);
      return { ok: true, project: proj, state };
    }

    case 'TOGGLE_PROJECT_AGENT': {
      const projId = payload.projectId || state.activeProjectId;
      const proj = state.projects.find(p => p.id === projId);
      if (!proj) return { ok: false, error: 'Проєкт не знайдено' };
      proj.agentEnabled = typeof payload.agentEnabled === 'boolean' ? payload.agentEnabled : !proj.agentEnabled;
      proj.updatedAt = Date.now();
      saveState(true);
      return { ok: true, project: proj, state };
    }

    case 'DELETE_PROJECT': {
      const targetProj = state.projects.find(p => p.id === payload.projectId);
      if (!state.deletedProjects || typeof state.deletedProjects !== 'object' || Array.isArray(state.deletedProjects)) {
        state.deletedProjects = {};
      }
      if (!targetProj) {
        if (payload.projectId && payload.deletedAt) {
          const ts = Number(payload.deletedAt) || Date.now();
          if (ts > (Number(state.deletedProjects[payload.projectId]) || 0)) {
            state.deletedProjects[payload.projectId] = ts;
            saveState(false);
          }
        }
        return { ok: true, state };
      }
      if (state.projects.length <= 1) {
        return { ok: false, error: 'Не можна видалити єдиний проєкт' };
      }
      const now = Math.max(Number(payload.deletedAt) || Date.now(), Number(targetProj.updatedAt || targetProj.createdAt || 0) + 1);
      state.deletedProjects[payload.projectId] = Math.max(Number(state.deletedProjects[payload.projectId]) || 0, now);
      state.projects = state.projects.filter(p => p.id !== payload.projectId);
      state.tasks = state.tasks.filter(t => t.projectId !== payload.projectId);
      if (state.activeProjectId === payload.projectId && state.projects.length > 0) {
        state.activeProjectId = state.projects[0].id;
      }
      saveState(false);
      broadcastState({
        source,
        event: { type: 'project_deleted', projectId: payload.projectId, deletedAt: now }
      });
      return { ok: true, state };
    }

    case 'CREATE_TASK': {
      const title = (payload.title || '').trim();
      if (!title) return { ok: false, error: 'Введіть назву задачі' };
      const projectId = payload.projectId || state.activeProjectId || state.projects[0].id;
      const perm = checkMcpPermission(projectId, source);
      if (!perm.allowed) return { ok: false, error: perm.error };

      const column = typeof payload.column === 'number' ? Math.max(0, Math.min(2, payload.column)) : 0;
      const progress = typeof payload.progress === 'number'
        ? Math.max(0, Math.min(100, Math.round(payload.progress)))
        : (column === 2 ? 100 : 0);
      const assignee = (payload.assignee || 'Ви').trim();
      const epic = (payload.epic || '').trim();
      const colTasks = state.tasks.filter(t => t.projectId === projectId && !t.deleted && t.column === column);
      const task = {
        id: state.nextTaskId++,
        clientUid: payload.clientUid || ('uid-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)),
        projectId,
        title,
        epic,
        column,
        progress,
        assignee,
        dotColor: payload.dotColor || getDotColorForAssignee(assignee),
        order: colTasks.length,
        deleted: false,
        updatedAt: Date.now()
      };
      state.tasks.push(task);
      saveState(false);
      broadcastState({
        source,
        actor: assignee,
        event: { type: 'task_created', task }
      });
      return { ok: true, task, state };
    }

    case 'UPDATE_TASK': {
      const taskId = Number(payload.id ?? payload.task_id);
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) return { ok: false, error: `Задачу #${taskId} не знайдено` };

      const perm = checkMcpPermission(task.projectId, source);
      if (!perm.allowed) return { ok: false, error: perm.error };

      const prevColumn = task.column;
      const prevProgress = task.progress;

      if (typeof payload.title === 'string' && payload.title.trim()) {
        task.title = payload.title.trim();
      }
      if (typeof payload.epic === 'string') {
        task.epic = payload.epic.trim();
      }
      if (typeof payload.assignee === 'string' && payload.assignee.trim()) {
        task.assignee = payload.assignee.trim();
        task.dotColor = payload.dotColor || getDotColorForAssignee(task.assignee);
      }
      if (typeof payload.column === 'number') {
        task.column = Math.max(0, Math.min(2, payload.column));
        if (task.column === 2 && typeof payload.progress !== 'number') {
          task.progress = 100;
        }
      }
      if (typeof payload.progress === 'number') {
        task.progress = Math.max(0, Math.min(100, Math.round(payload.progress)));
      }
      if (typeof payload.order === 'number') {
        task.order = payload.order;
      }
      if (typeof payload.deleted === 'boolean') {
        task.deleted = payload.deleted;
      }
      task.updatedAt = Date.now();

      saveState(false);
      broadcastState({
        source,
        actor: payload.actor || task.assignee,
        event: {
          type: 'task_updated',
          task,
          prevColumn,
          prevProgress
        }
      });
      return { ok: true, task, state };
    }

    case 'DELETE_TASK': {
      const taskId = Number(payload.id ?? payload.task_id);
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) return { ok: false, error: `Задачу #${taskId} не знайдено` };

      const perm = checkMcpPermission(task.projectId, source);
      if (!perm.allowed) return { ok: false, error: perm.error };

      if (payload.permanent) {
        state.tasks = state.tasks.filter(t => t.id !== taskId);
      } else {
        task.deleted = true;
        task.updatedAt = Date.now();
      }
      saveState(true);
      return { ok: true, state };
    }

    case 'RESTORE_TASK': {
      const taskId = Number(payload.id ?? payload.task_id);
      const task = state.tasks.find(t => t.id === taskId);
      if (!task) return { ok: false, error: `Задачу #${taskId} не знайдено` };
      task.deleted = false;
      task.updatedAt = Date.now();
      saveState(true);
      return { ok: true, task, state };
    }

    case 'EMPTY_TRASH': {
      const projectId = payload.projectId || state.activeProjectId;
      state.tasks = state.tasks.filter(t => !(t.deleted && (!projectId || t.projectId === projectId)));
      saveState(true);
      return { ok: true, state };
    }

    default:
      return { ok: false, error: `Невідома дія: ${type}` };
  }
}

// GitHub Update Helpers
function cleanGithubRepo(input) {
  let s = (input || '').trim();
  s = s.replace(/^https?:\/\/(www\.)?github\.com\//i, '');
  s = s.replace(/\.git$/i, '');
  s = s.replace(/\/+$/, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return s;
}

const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function pointInRoundedRectNorm(x, y, rx, ry, rw, rh, rad) {
  if (x < rx || x > rx + rw || y < ry || y > ry + rh) return false;
  const cx = Math.max(rx + rad, Math.min(x, rx + rw - rad));
  const cy = Math.max(ry + rad, Math.min(y, ry + rh - rad));
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= rad * rad;
}

function generateSquareAppIconPng(size) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0;
    const nyCenter = (y + 0.5) / size;
    const barT = Math.max(0, Math.min(1, (nyCenter - 0.22) / 0.55));
    const barR = Math.round(50 - barT * 20);
    const barG = Math.round(212 - barT * 26);
    const barB = Math.round(108 - barT * 24);

    for (let x = 0; x < size; x++) {
      const idx = rowStart + 1 + x * 4;
      const nxCenter = (x + 0.5) / size;
      const dist = Math.min(1, Math.hypot(nxCenter - 0.5, nyCenter - 0.42) * 1.4);
      const bgR = Math.round(18 - dist * 7);
      const bgG = Math.round(41 - dist * 16);
      const bgB = Math.round(28 - dist * 10);

      let hits = 0;
      for (let sy = 0; sy < 4; sy++) {
        const py = (y + (sy + 0.5) / 4) / size;
        for (let sx = 0; sx < 4; sx++) {
          const px = (x + (sx + 0.5) / 4) / size;
          const inBar =
            pointInRoundedRectNorm(px, py, 0.22, 0.40, 0.13, 0.37, 0.048) ||
            pointInRoundedRectNorm(px, py, 0.435, 0.22, 0.13, 0.55, 0.048) ||
            pointInRoundedRectNorm(px, py, 0.65, 0.51, 0.13, 0.26, 0.048);
          if (inBar) hits++;
        }
      }

      if (hits === 0) {
        raw[idx] = bgR;
        raw[idx + 1] = bgG;
        raw[idx + 2] = bgB;
        raw[idx + 3] = 255;
      } else if (hits === 16) {
        raw[idx] = barR;
        raw[idx + 1] = barG;
        raw[idx + 2] = barB;
        raw[idx + 3] = 255;
      } else {
        const cov = hits / 16;
        raw[idx] = Math.round(bgR * (1 - cov) + barR * cov);
        raw[idx + 1] = Math.round(bgG * (1 - cov) + barG * cov);
        raw[idx + 2] = Math.round(bgB * (1 - cov) + barB * cov);
        raw[idx + 3] = 255;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    PNG_HEADER,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', idat),
    makePngChunk('IEND', Buffer.alloc(0))
  ]);
}

const PWA_ICON_SPECS = [
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 }
];

function isValidPngForSize(filePath, expectedSize) {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length < 32) return false;
    if (!buf.subarray(0, 8).equals(PNG_HEADER)) return false;
    if (buf.toString('ascii', 12, 16) !== 'IHDR') return false;
    return buf.readUInt32BE(16) === expectedSize && buf.readUInt32BE(20) === expectedSize;
  } catch (_) {
    return false;
  }
}

function ensurePwaIcons(force = false) {
  try {
    fs.mkdirSync(PUBLIC_DIR, { recursive: true });
    for (const spec of PWA_ICON_SPECS) {
      const targetPath = path.join(PUBLIC_DIR, spec.file);
      if (force || !isValidPngForSize(targetPath, spec.size)) {
        fs.writeFileSync(targetPath, generateSquareAppIconPng(spec.size));
      }
    }
  } catch (_) {}
}

function httpsGetBuffer(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'To-Doom-Updater/1.2.2',
        'Cache-Control': 'no-cache'
      },
      timeout: 10000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpsGetBuffer(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} для ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Таймаут запиту до GitHub')); });
  });
}

async function httpsGetText(url) {
  const buf = await httpsGetBuffer(url);
  return buf.toString('utf8');
}

async function resolveGithubCommit(repo, branch) {
  try {
    const commitJson = await httpsGetText(`https://api.github.com/repos/${repo}/commits/${branch}`);
    const commitObj = JSON.parse(commitJson);
    if (commitObj && commitObj.sha) {
      return {
        shaFull: commitObj.sha,
        latestCommit: {
          sha: commitObj.sha.slice(0, 7),
          message: ((commitObj.commit && commitObj.commit.message) || '').split('\n')[0],
          date: commitObj.commit && commitObj.commit.committer && commitObj.commit.committer.date
        }
      };
    }
  } catch (_) {}
  return { shaFull: null, latestCommit: null };
}

async function checkGithubUpdate(repoInput, branchInput) {
  const repo = cleanGithubRepo(repoInput || (state.settings && state.settings.githubRepo) || '');
  const branch = (branchInput || (state.settings && state.settings.githubBranch) || 'main').trim();
  if (!repo || !repo.includes('/')) {
    return { ok: false, error: 'Вкажіть ваш GitHub репозиторій у форматі власник/репозиторій' };
  }

  let localVersion = APP_VERSION;
  try {
    const localPkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    if (localPkg.version) localVersion = localPkg.version;
  } catch (_) {}

  const { shaFull, latestCommit } = await resolveGithubCommit(repo, branch);
  const rawRef = shaFull || branch;
  const rawPkgUrl = `https://raw.githubusercontent.com/${repo}/${rawRef}/package.json?t=${Date.now()}`;
  const rawPkgText = await httpsGetText(rawPkgUrl);
  const remotePkg = JSON.parse(rawPkgText);
  const remoteVersion = remotePkg.version || '1.0.0';

  let apkReleaseUrl = null;
  try {
    const relJson = await httpsGetText(`https://api.github.com/repos/${repo}/releases/latest`);
    const relObj = JSON.parse(relJson);
    if (relObj && Array.isArray(relObj.assets)) {
      const apkAsset = relObj.assets.find(a => a.name && a.name.toLowerCase().endsWith('.apk'));
      if (apkAsset) apkReleaseUrl = apkAsset.browser_download_url;
    }
  } catch (_) {}

  return {
    ok: true,
    repo,
    branch,
    localVersion,
    remoteVersion,
    hasUpdate: remoteVersion !== localVersion,
    latestCommit,
    apkReleaseUrl
  };
}

async function applyGithubUpdate(repoInput, branchInput) {
  const repo = cleanGithubRepo(repoInput || (state.settings && state.settings.githubRepo) || '');
  const branch = (branchInput || (state.settings && state.settings.githubBranch) || 'main').trim();
  if (!repo || !repo.includes('/')) {
    return { ok: false, error: 'Вкажіть ваш GitHub репозиторій у форматі власник/репозиторій' };
  }

  const { shaFull } = await resolveGithubCommit(repo, branch);
  const rawRef = shaFull || branch;

  const filesToUpdate = [
    'package.json',
    'server.js',
    'main.js',
    'preload.js',
    'mcp-server.js',
    'public/index.html',
    'public/styles.css',
    'public/app.js',
    'public/manifest.json',
    'public/icon.svg',
    'public/apple-touch-icon.png',
    'public/icon-192.png',
    'public/icon-512.png'
  ];

  const downloaded = new Map();
  for (const relPath of filesToUpdate) {
    const url = `https://raw.githubusercontent.com/${repo}/${rawRef}/${relPath}?t=${Date.now()}`;
    try {
      const contentBuf = await httpsGetBuffer(url);
      downloaded.set(relPath, contentBuf);
    } catch (err) {
      // Require text core files; allow optional icon files if updating from older commits
      if (relPath === 'package.json' || (relPath.startsWith('public/') && !relPath.endsWith('.png'))) {
        throw new Error(`Не вдалося завантажити ${relPath}: ${err.message}`);
      }
    }
  }

  // Target directories to update on this machine
  const targetDirs = [__dirname];
  if (fs.existsSync('D:\\To Doom\\resources\\app') && path.resolve(__dirname) !== path.resolve('D:\\To Doom\\resources\\app')) {
    targetDirs.push('D:\\To Doom\\resources\\app');
  }
  if (fs.existsSync('D:\\Проєкти\\To Doom') && path.resolve(__dirname) !== path.resolve('D:\\Проєкти\\To Doom')) {
    targetDirs.push('D:\\Проєкти\\To Doom');
  }

  for (const baseDir of targetDirs) {
    for (const [relPath, contentBuf] of downloaded.entries()) {
      const fullPath = path.join(baseDir, ...relPath.split('/'));
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, contentBuf);
    }
  }

  ensurePwaIcons(false);

  let newVersion = APP_VERSION;
  try {
    const pkg = JSON.parse(downloaded.get('package.json').toString('utf8'));
    if (pkg.version) newVersion = pkg.version;
  } catch (_) {}

  state.version = newVersion;
  state.settings.githubRepo = repo;
  state.settings.githubBranch = branch;
  state.settings.lastUpdateCheck = Date.now();
  saveState(false);

  broadcast({
    type: 'APP_UPDATED',
    version: newVersion
  });

  scheduleRuntimeRestartAfterUpdate(newVersion);

  return {
    ok: true,
    version: newVersion,
    updatedFiles: Array.from(downloaded.keys())
  };
}

let activeHttpServer = null;
let activeWssServer = null;
let activePingTimer = null;

function scheduleRuntimeRestartAfterUpdate(newVersion) {
  try {
    process.emit('todoom-app-updated', newVersion);
  } catch (_) {}

  if (require.main !== module) return;

  setTimeout(() => {
    const finishRestart = () => {
      try {
        const inDocker = fs.existsSync('/.dockerenv');
        const inSystemd = Boolean(process.env.INVOCATION_ID);
        if (!inDocker && !inSystemd) {
          const { spawn } = require('child_process');
          const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
            cwd: __dirname,
            detached: true,
            stdio: 'ignore',
            windowsHide: true
          });
          child.unref();
        }
      } catch (_) {}
      process.exit(0);
    };

    try { if (activePingTimer) clearInterval(activePingTimer); } catch (_) {}
    try { if (activeWssServer) activeWssServer.close(); } catch (_) {}
    if (activeHttpServer) {
      let exited = false;
      activeHttpServer.close(() => {
        if (!exited) {
          exited = true;
          setTimeout(finishRestart, 250);
        }
      });
      setTimeout(() => {
        if (!exited) {
          exited = true;
          finishRestart();
        }
      }, 900);
    } else {
      finishRestart();
    }
  }, 700);
}

const clients = new Map();
let outboundPeerWs = null;
let outboundPeerUrl = null;
let outboundReconnectTimer = null;
const discoveredLanPeers = new Map();

function getPeersSummary() {
  const list = [];
  for (const info of clients.values()) {
    list.push({
      id: info.id,
      name: info.name,
      deviceType: info.deviceType,
      color: info.color,
      activeTaskId: info.activeTaskId || null,
      focusedField: info.focusedField || null
    });
  }
  if (outboundPeerWs && outboundPeerWs.readyState === WebSocket.OPEN) {
    list.push({
      id: 'outbound-peer',
      name: outboundPeerUrl,
      deviceType: 'pc-peer',
      color: '#38bdf8'
    });
  }
  return list;
}

function broadcast(msgObj, excludeWs = null) {
  const data = JSON.stringify(msgObj);
  for (const ws of clients.keys()) {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
  if (outboundPeerWs && outboundPeerWs !== excludeWs && outboundPeerWs.readyState === WebSocket.OPEN) {
    if (msgObj.type === 'STATE_UPDATE') {
      if (msgObj.event && msgObj.event.type === 'project_deleted' && msgObj.source !== 'peer') {
        outboundPeerWs.send(JSON.stringify({
          type: 'ACTION',
          action: {
            type: 'DELETE_PROJECT',
            payload: { projectId: msgObj.event.projectId, deletedAt: msgObj.event.deletedAt }
          }
        }));
      }
      outboundPeerWs.send(JSON.stringify({
        type: 'ACTION',
        action: { type: 'MERGE_OFFLINE_STATE', payload: { state: msgObj.state } }
      }));
    } else if (msgObj.type === 'PRESENCE_UPDATE') {
      outboundPeerWs.send(data);
    }
  }
}

function broadcastState(extra = {}) {
  broadcast({
    type: 'STATE_UPDATE',
    state,
    peers: getPeersSummary(),
    source: extra.source || 'server',
    actor: extra.actor || null,
    event: extra.event || null
  }, extra.excludeWs || null);
}

function broadcastPeers() {
  broadcast({
    type: 'PEERS_UPDATE',
    peers: getPeersSummary()
  });
}

function connectToPeerServer(peerUrl, autoRetry = true) {
  if (outboundReconnectTimer) {
    clearTimeout(outboundReconnectTimer);
    outboundReconnectTimer = null;
  }
  if (outboundPeerWs) {
    const old = outboundPeerWs;
    outboundPeerWs = null;
    try { old.close(); } catch (_) {}
  }
  let formatted = (peerUrl || '').trim();
  if (!formatted) return { ok: false, error: 'Порожня адреса' };
  if (!formatted.startsWith('ws://') && !formatted.startsWith('wss://')) {
    formatted = formatted.replace(/^https?:\/\//, '');
    if (!formatted.includes(':')) formatted = `${formatted}:${DEFAULT_PORT}`;
    formatted = `ws://${formatted}`;
  }
  outboundPeerUrl = formatted;

  try {
    const ws = new WebSocket(formatted, { handshakeTimeout: 4000 });
    outboundPeerWs = ws;

    ws.on('open', () => {
      if (outboundPeerWs !== ws) return;
      ws.send(JSON.stringify({
        type: 'HELLO',
        name: os.hostname(),
        deviceType: 'Windows PC',
        color: '#38bdf8',
        offlineState: state
      }));
      broadcastPeers();
    });

    const lastPeerDeleteSync = new Map();
    ws.on('message', (raw) => {
      if (outboundPeerWs !== ws) return;
      try {
        const msg = JSON.parse(raw.toString());
        if ((msg.type === 'STATE_UPDATE' || msg.type === 'INIT') && msg.state) {
          // If the remote server is on an older build without deletedProjects support, push DELETE_PROJECT for stale projects
          if (Array.isArray(msg.state.projects) && state.deletedProjects) {
            for (const incProj of msg.state.projects) {
              if (!incProj || !incProj.id) continue;
              const delTs = Number(state.deletedProjects[incProj.id]) || 0;
              const incTs = Number(incProj.updatedAt || incProj.createdAt || 0);
              if (delTs > 0 && delTs >= incTs) {
                const lastSent = lastPeerDeleteSync.get(incProj.id) || 0;
                if (Date.now() - lastSent > 3000) {
                  lastPeerDeleteSync.set(incProj.id, Date.now());
                  ws.send(JSON.stringify({
                    type: 'ACTION',
                    action: {
                      type: 'DELETE_PROJECT',
                      payload: { projectId: incProj.id, deletedAt: delTs }
                    }
                  }));
                }
              }
            }
          }
          // Merge server state into local (respecting deletedProjects tombstones)
          const changed = mergeOfflineState(msg.state);
          if (changed) {
            broadcastState({ source: msg.source === 'mcp' ? 'mcp' : 'peer', excludeWs: ws, event: msg.event });
          }
        }
      } catch (_) {}
    });

    const schedulePeerRetry = () => {
      if (outboundPeerWs === ws) {
        outboundPeerWs = null;
        broadcastPeers();
        if (autoRetry && outboundPeerUrl) {
          outboundReconnectTimer = setTimeout(() => {
            connectToPeerServer(outboundPeerUrl, true);
          }, 6000);
        }
      }
    };

    ws.on('close', schedulePeerRetry);
    ws.on('error', schedulePeerRetry);

    return { ok: true, peerUrl: formatted };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (_) {
        resolve({});
      }
    });
  });
}

let activeServerPort = DEFAULT_PORT;

async function handleApi(req, res) {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      state,
      peers: getPeersSummary()
    }));
    return;
  }

  if (pathname === '/api/action' && req.method === 'POST') {
    const body = await parseBody(req);
    const result = applyAction(body, { source: body.source || 'http' });
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
    return;
  }

  if (pathname === '/api/update/check' && req.method === 'GET') {
    try {
      const repo = urlObj.searchParams.get('repo') || '';
      const branch = urlObj.searchParams.get('branch') || '';
      const result = await checkGithubUpdate(repo, branch);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (pathname === '/api/update/apply' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const result = await applyGithubUpdate(body.repo, body.branch);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (pathname === '/api/network' && req.method === 'GET') {
    const ips = getLocalIPs();
    // Always include the user's Tailscale server (liakh-server) in the selector so QR code can be generated for it too
    if (!ips.some(x => x.address === '100.101.231.78')) {
      ips.unshift({
        name: 'liakh-server (Tailscale IP)',
        address: '100.101.231.78',
        priority: 120,
        isVirtual: false
      });
    }
    if (!ips.some(x => x.address === 'liakh-server.tail2f1f7e.ts.net')) {
      ips.splice(1, 0, {
        name: 'liakh-server (Tailscale MagicDNS)',
        address: 'liakh-server.tail2f1f7e.ts.net',
        priority: 115,
        isVirtual: false
      });
    }
    const chosenIp = urlObj.searchParams.get('ip') || ips[0].address;
    const syncUrl = `http://${chosenIp}:${activeServerPort}`;
    let qrSvg = '';
    try {
      qrSvg = await QRCode.toString(syncUrl, {
        type: 'svg',
        margin: 1,
        width: 200,
        color: {
          dark: '#10b981',
          light: '#0d0f12'
        }
      });
    } catch (_) {}

    const now = Date.now();
    for (const [key, val] of discoveredLanPeers.entries()) {
      if (now - val.updatedAt > 15000) discoveredLanPeers.delete(key);
    }

    const mcpPath = fs.existsSync('D:\\To Doom\\resources\\app\\mcp-server.js')
      ? 'D:\\To Doom\\resources\\app\\mcp-server.js'
      : path.join(__dirname, 'mcp-server.js');

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      hostname: os.hostname(),
      port: activeServerPort,
      ips,
      chosenIp,
      syncUrl,
      qrSvg,
      peers: getPeersSummary(),
      outboundPeerUrl,
      discoveredLanPeers: Array.from(discoveredLanPeers.values()),
      mcpServerPath: mcpPath
    }));
    return;
  }

  if (pathname === '/api/connect-peer' && req.method === 'POST') {
    const body = await parseBody(req);
    const result = connectToPeerServer(body.peerUrl);
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
    return;
  }

  if (pathname === '/api/disconnect-peer' && req.method === 'POST') {
    if (outboundPeerWs) {
      try { outboundPeerWs.close(); } catch (_) {}
      outboundPeerWs = null;
      outboundPeerUrl = null;
      broadcastPeers();
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'Маршрут не знайдено' }));
}

function checkExistingServerOnPort(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/state`, { timeout: 600 }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function startServer(port = DEFAULT_PORT) {
  return new Promise(async (resolve) => {
    ensurePwaIcons(false);
    const alreadyRunning = await checkExistingServerOnPort(port);
    if (alreadyRunning) {
      activeServerPort = port;
      resolve({ server: null, port, reused: true });
      return;
    }

    const APPLE_ICON_ALIASES = new Set([
      '/apple-touch-icon.png',
      '/apple-touch-icon-precomposed.png',
      '/apple-touch-icon-180x180.png',
      '/apple-touch-icon-180x180-precomposed.png',
      '/apple-touch-icon-152x152.png',
      '/apple-touch-icon-120x120.png'
    ]);

    const server = http.createServer(async (req, res) => {
      if (req.url.startsWith('/api/')) {
        await handleApi(req, res);
        return;
      }

      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      let reqPath = urlObj.pathname === '/' ? '/index.html' : urlObj.pathname;
      const lowerReqPath = reqPath.toLowerCase();
      if (APPLE_ICON_ALIASES.has(lowerReqPath)) {
        reqPath = '/apple-touch-icon.png';
      } else if (lowerReqPath === '/favicon.ico') {
        reqPath = '/icon-192.png';
      }
      const safePath = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, '');
      const filePath = path.join(PUBLIC_DIR, safePath);

      if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      fs.readFile(filePath, (err, content) => {
        if (err) {
          fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, fallback) => {
            if (err2) {
              res.writeHead(404);
              res.end('Not found');
            } else {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(fallback);
            }
          });
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache'
        });
        res.end(content);
      });
    });

    const wss = new WebSocketServer({ server });
    wss.on('error', () => {});
    activeHttpServer = server;
    activeWssServer = wss;

    const pingInterval = setInterval(() => {
      for (const ws of clients.keys()) {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.ping(); } catch (_) {}
        }
      }
    }, 25000);
    activePingTimer = pingInterval;

    wss.on('close', () => clearInterval(pingInterval));

    wss.on('connection', (ws, req) => {
      const clientId = 'peer-' + Math.random().toString(36).slice(2, 9);
      const ua = (req.headers['user-agent'] || '').toLowerCase();
      let defaultName = 'Ви';
      let deviceType = 'desktop';
      let color = '#22c55e';

      if (ua.includes('iphone')) {
        defaultName = 'iPhone';
        deviceType = 'iphone';
        color = '#38bdf8';
      } else if (ua.includes('ipad') || ua.includes('android') || ua.includes('tablet')) {
        defaultName = 'Планшет';
        deviceType = 'tablet';
        color = '#f59e0b';
      } else if (!ua.includes('electron')) {
        defaultName = 'Браузер';
        deviceType = 'web';
        color = '#a855f7';
      }

      clients.set(ws, {
        id: clientId,
        name: defaultName,
        deviceType,
        color,
        activeTaskId: null,
        focusedField: null
      });

      ws.send(JSON.stringify({
        type: 'INIT',
        clientId,
        state,
        peers: getPeersSummary()
      }));

      broadcastPeers();

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          const client = clients.get(ws);

          if (msg.type === 'HELLO' && client) {
            if (msg.name) client.name = msg.name;
            if (msg.deviceType) client.deviceType = msg.deviceType;
            if (msg.color) client.color = msg.color;
            if (msg.offlineState) {
              mergeOfflineState(msg.offlineState);
              broadcastState({ source: 'merge' });
            } else {
              broadcastPeers();
            }
          } else if (msg.type === 'ACTION') {
            applyAction(msg.action, {
              source: msg.source || (client ? client.deviceType : 'ws'),
              ws
            });
          } else if (msg.type === 'PRESENCE' && client) {
            client.activeTaskId = msg.activeTaskId || null;
            client.focusedField = msg.focusedField || null;
            if (msg.name) client.name = msg.name;
            broadcast({
              type: 'PRESENCE_UPDATE',
              peerId: client.id,
              name: client.name,
              color: client.color,
              activeTaskId: client.activeTaskId,
              focusedField: client.focusedField,
              draggingProgress: msg.draggingProgress ?? null
            }, ws);
          }
        } catch (_) {}
      });

      ws.on('close', () => {
        clients.delete(ws);
        broadcastPeers();
      });

      ws.on('error', () => {});
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve({ server: null, port, reused: true });
      }
    });

    server.listen(port, '0.0.0.0', () => {
      activeServerPort = server.address().port;
      setupUdpDiscovery(activeServerPort);
      // Automatically link with liakh-server (100.101.231.78:3456) unless we ARE running on liakh-server
      const myAddrs = new Set(getLocalIPs().map(x => x.address));
      const hostLower = os.hostname().toLowerCase();
      if (!hostLower.includes('liakh-server') && !myAddrs.has('100.101.231.78') && DEFAULT_TAILSCALE_SERVER) {
        connectToPeerServer(DEFAULT_TAILSCALE_SERVER, true);
      }
      resolve({ server, port: activeServerPort, reused: false });
    });
  });
}

function setupUdpDiscovery(httpPort) {
  try {
    const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const myIps = new Set(getLocalIPs().map(x => x.address));

    udp.on('error', () => {});
    udp.on('message', (msg, rinfo) => {
      if (myIps.has(rinfo.address)) return;
      try {
        const data = JSON.parse(msg.toString());
        if (data && data.app === 'to-doom' && data.port) {
          const key = `${rinfo.address}:${data.port}`;
          discoveredLanPeers.set(key, {
            ip: rinfo.address,
            port: data.port,
            hostname: data.hostname || rinfo.address,
            updatedAt: Date.now()
          });
        }
      } catch (_) {}
    });

    udp.bind(UDP_PORT, () => {
      try {
        udp.setBroadcast(true);
        setInterval(() => {
          const packet = Buffer.from(JSON.stringify({
            app: 'to-doom',
            hostname: os.hostname(),
            port: httpPort
          }));
          udp.send(packet, 0, packet.length, UDP_PORT, '255.255.255.255', () => {});
        }, 5000);
      } catch (_) {}
    });
  } catch (_) {}
}

if (require.main === module) {
  startServer(DEFAULT_PORT).then(({ port }) => {
    const ips = getLocalIPs();
    console.log(`To Doom сервер запущено:`);
    console.log(`  Локально:   http://localhost:${port}`);
    for (const ip of ips) {
      console.log(`  Мережа:     http://${ip.address}:${port} (${ip.name})`);
    }
  });
}

function closeServer() {
  try { if (activePingTimer) clearInterval(activePingTimer); } catch (_) {}
  try { if (outboundReconnectTimer) clearTimeout(outboundReconnectTimer); } catch (_) {}
  try { if (outboundPeerWs) outboundPeerWs.close(); } catch (_) {}
  try { if (activeWssServer) activeWssServer.close(); } catch (_) {}
  try { if (activeHttpServer) activeHttpServer.close(); } catch (_) {}
}

module.exports = { startServer, applyAction, getLocalIPs, closeServer, ensurePwaIcons };
