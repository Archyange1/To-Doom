#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const http = require('http');

const SHARED_DATA_DIR = 'D:\\To Doom\\data';
const DATA_DIR = fs.existsSync('D:\\To Doom') ? SHARED_DATA_DIR : path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'board-state.json');
const PORT = parseInt(process.env.PORT || '3456', 10);

const COLUMN_NAMES = ['До виконання', 'В роботі', 'Виконано'];

// Optional CLI argument --project <id_or_name>
let pinnedProjectArg = process.env.TODOOM_PROJECT || null;
for (let i = 2; i < process.argv.length; i++) {
  if ((process.argv[i] === '--project' || process.argv[i] === '-p') && process.argv[i + 1]) {
    pinnedProjectArg = process.argv[i + 1];
    break;
  }
}

function readStateFallback() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (_) {}
  return { projects: [], tasks: [], nextTaskId: 1 };
}

function writeStateFallback(state) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function callServerHost(host, port, method, endpoint, bodyObj = null) {
  return new Promise((resolve) => {
    const payload = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = http.request({
      hostname: host,
      port,
      path: endpoint,
      method,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      } : {},
      timeout: 1200
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (_) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function callRunningServer(method, endpoint, bodyObj = null) {
  const localRes = await callServerHost('127.0.0.1', PORT, method, endpoint, bodyObj);
  if (localRes) return localRes;
  // Fallback directly to liakh-server over Tailscale if local window is closed
  return await callServerHost('100.101.231.78', PORT, method, endpoint, bodyObj);
}

async function getBoardState() {
  const live = await callRunningServer('GET', '/api/state');
  if (live && live.ok && live.state) return live.state;
  return readStateFallback();
}

function resolveProject(state, projectIdentifier) {
  const projects = state.projects || [];
  const query = (projectIdentifier || pinnedProjectArg || '').trim().toLowerCase();

  if (query) {
    const found = projects.find(
      p => p.id.toLowerCase() === query || (p.name || '').toLowerCase() === query || (p.name || '').toLowerCase().includes(query)
    );
    return found || null;
  }

  // Default to active project if agentEnabled, otherwise first agentEnabled project
  const active = projects.find(p => p.id === state.activeProjectId);
  if (active && active.agentEnabled !== false) return active;

  const firstEnabled = projects.find(p => p.agentEnabled !== false);
  return firstEnabled || active || projects[0] || null;
}

async function dispatchBoardAction(action) {
  const live = await callRunningServer('POST', '/api/action', { ...action, source: 'mcp' });
  if (live) return live;

  // Fallback direct file update if desktop/web server is not running
  const state = readStateFallback();
  const { type, payload = {} } = action;

  if (type === 'CREATE_TASK') {
    const proj = resolveProject(state, payload.projectId);
    if (!proj) return { ok: false, error: 'Проєкт не знайдено' };
    if (proj.agentEnabled === false) {
      return { ok: false, error: `Керування ШІ-агентом для проєкту «${proj.name}» вимкнено.` };
    }
    const task = {
      id: state.nextTaskId || 1,
      projectId: proj.id,
      title: payload.title,
      epic: payload.epic || '',
      column: typeof payload.column === 'number' ? payload.column : 0,
      progress: typeof payload.progress === 'number' ? payload.progress : (payload.column === 2 ? 100 : 0),
      assignee: payload.assignee || 'Claude',
      dotColor: '#a855f7',
      order: 0,
      deleted: false,
      updatedAt: Date.now()
    };
    state.nextTaskId = task.id + 1;
    state.tasks.push(task);
    writeStateFallback(state);
    return { ok: true, task, state };
  }
  if (type === 'UPDATE_TASK') {
    const id = Number(payload.task_id ?? payload.id);
    const task = state.tasks.find(t => t.id === id);
    if (!task) return { ok: false, error: `Задачу #${id} не знайдено` };
    const proj = (state.projects || []).find(p => p.id === task.projectId);
    if (proj && proj.agentEnabled === false) {
      return { ok: false, error: `Керування ШІ-агентом для проєкту «${proj.name}» вимкнено.` };
    }
    if (typeof payload.title === 'string') task.title = payload.title;
    if (typeof payload.epic === 'string') task.epic = payload.epic;
    if (typeof payload.assignee === 'string') task.assignee = payload.assignee;
    if (typeof payload.column === 'number') {
      task.column = Math.max(0, Math.min(2, payload.column));
      if (task.column === 2 && typeof payload.progress !== 'number') task.progress = 100;
    }
    if (typeof payload.progress === 'number') {
      task.progress = Math.max(0, Math.min(100, Math.round(payload.progress)));
    }
    task.updatedAt = Date.now();
    writeStateFallback(state);
    return { ok: true, task, state };
  }
  if (type === 'DELETE_TASK') {
    const id = Number(payload.task_id ?? payload.id);
    const task = state.tasks.find(t => t.id === id);
    if (!task) return { ok: false, error: `Задачу #${id} не знайдено` };
    const proj = (state.projects || []).find(p => p.id === task.projectId);
    if (proj && proj.agentEnabled === false) {
      return { ok: false, error: `Керування ШІ-агентом для проєкту «${proj.name}» вимкнено.` };
    }
    task.deleted = true;
    writeStateFallback(state);
    return { ok: true, state };
  }
  return { ok: false, error: 'Невідома дія' };
}

const TOOLS = [
  {
    name: 'list_projects',
    description: 'Отримати список усіх проєктів у To Doom та перевірити, для яких проєктів увімкнено керування ШІ-агентом (agentEnabled).',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'list_tasks',
    description: 'Отримати список задач проєкту на дошці To Doom (разом з їхніми ID, колонками 0=До виконання, 1=В роботі, 2=Виконано та прогресом у %). Працює лише для проєктів, де увімкнено доступ ШІ.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'ID або назва проєкту (якщо не вказано — використовується активний проєкт із дозволом для ШІ)'
        }
      }
    }
  },
  {
    name: 'create_task',
    description: 'Створити нову задачу у вказаному проєкті To Doom (якщо для цього проєкту увімкнено доступ ШІ-агента).',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'ID або назва проєкту (необов\'язково)' },
        title: { type: 'string', description: 'Назва задачі' },
        epic: { type: 'string', description: 'Епік або категорія задачі' },
        column: { type: 'number', description: 'Колонка: 0 = До виконання, 1 = В роботі, 2 = Виконано' },
        progress: { type: 'number', description: 'Прогрес виконання від 0 до 100' },
        assignee: { type: 'string', description: 'Виконавець (наприклад: Claude, Codex, Antigravity)' }
      },
      required: ['title']
    }
  },
  {
    name: 'update_task',
    description: 'Оновити задачу за її числовим ID (перемістити між колонками 0/1/2, змінити прогрес 0-100%, назву або виконавця).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Числовий ID задачі (наприклад, 14 для #14)' },
        column: { type: 'number', description: 'Нова колонка: 0 (До виконання), 1 (В роботі), 2 (Виконано)' },
        progress: { type: 'number', description: 'Новий відсоток прогресу (0 - 100)' },
        title: { type: 'string', description: 'Нова назва задачі (необов\'язково)' },
        epic: { type: 'string', description: 'Новий епік (необов\'язково)' },
        assignee: { type: 'string', description: 'Виконавець (наприклад, Claude або Codex)' }
      },
      required: ['task_id']
    }
  },
  {
    name: 'delete_task',
    description: 'Перемістити задачу в кошик за її ID.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Числовий ID задачі' }
      },
      required: ['task_id']
    }
  }
];

async function handleRequest(msg) {
  const { id, method, params = {} } = msg;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'to-doom-mcp',
          version: '1.2.0'
        }
      }
    };
  }

  if (method === 'notifications/initialized') {
    return null;
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS }
    };
  }

  if (method === 'tools/call') {
    const toolName = params.name;
    const args = params.arguments || {};

    if (toolName === 'list_projects') {
      const state = await getBoardState();
      const lines = (state.projects || []).map(p => {
        const count = (state.tasks || []).filter(t => !t.deleted && t.projectId === p.id).length;
        const status = p.agentEnabled !== false ? '🤖 ШІ ДОЗВОЛЕНО' : '🔒 ШІ ВИМКНЕНО';
        const activeMark = p.id === state.activeProjectId ? ' (активний)' : '';
        return `- [${p.id}] "${p.name}"${activeMark} — ${status} (${count} задач)`;
      });
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: 'Проєкти To Doom:\n' + (lines.join('\n') || 'Проєктів немає.') }]
        }
      };
    }

    if (toolName === 'list_tasks') {
      const state = await getBoardState();
      const proj = resolveProject(state, args.project_id);
      if (!proj) {
        return {
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: 'Проєкт не знайдено.' }] }
        };
      }
      if (proj.agentEnabled === false) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{
              type: 'text',
              text: `Керування ШІ-агентом для проєкту «${proj.name}» (${proj.id}) вимкнено користувачем. Увімкніть перемикач «🤖 ШІ» для цього проєкту в To Doom.`
            }]
          }
        };
      }
      const tasks = (state.tasks || []).filter(t => !t.deleted && t.projectId === proj.id);
      const lines = tasks.map(t =>
        `#${t.id} [${COLUMN_NAMES[t.column] || 'До виконання'}] ${t.title} — ${t.progress}% · ${t.assignee}${t.epic ? ` (${t.epic})` : ''}`
      );
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: `Проєкт: ${proj.name} (${proj.id}) [🤖 ШІ ДОЗВОЛЕНО]\n` + (lines.join('\n') || 'Задач немає.')
            }
          ]
        }
      };
    }

    if (toolName === 'create_task') {
      const state = await getBoardState();
      const proj = resolveProject(state, args.project_id);
      if (!proj) {
        return {
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: 'Проєкт не знайдено.' }] }
        };
      }
      if (proj.agentEnabled === false) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{
              type: 'text',
              text: `Керування ШІ-агентом для проєкту «${proj.name}» вимкнено користувачем.`
            }]
          }
        };
      }
      const res = await dispatchBoardAction({
        type: 'CREATE_TASK',
        payload: {
          projectId: proj.id,
          title: args.title,
          epic: args.epic || '',
          column: args.column ?? 0,
          progress: args.progress ?? (args.column === 2 ? 100 : 0),
          assignee: args.assignee || 'Claude'
        }
      });
      if (!res.ok) {
        return {
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: res.error || 'Помилка' }] }
        };
      }
      const t = res.task;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: `[${proj.name}] #${t.id} ${t.title} -> ${COLUMN_NAMES[t.column]} · ${t.progress}%`
            }
          ]
        }
      };
    }

    if (toolName === 'update_task') {
      const res = await dispatchBoardAction({
        type: 'UPDATE_TASK',
        payload: {
          task_id: args.task_id,
          column: args.column,
          progress: args.progress,
          title: args.title,
          epic: args.epic,
          assignee: args.assignee,
          actor: args.assignee || 'MCP Agent'
        }
      });
      if (!res.ok) {
        return {
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: res.error || 'Помилка' }] }
        };
      }
      const t = res.task;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: `#${t.id} ${t.title} -> ${COLUMN_NAMES[t.column]} · ${t.progress}%`
            }
          ]
        }
      };
    }

    if (toolName === 'delete_task') {
      const res = await dispatchBoardAction({
        type: 'DELETE_TASK',
        payload: { task_id: args.task_id }
      });
      if (!res.ok) {
        return {
          jsonrpc: '2.0',
          id,
          result: { isError: true, content: [{ type: 'text', text: res.error || 'Помилка' }] }
        };
      }
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `Задачу #${args.task_id} переміщено у видалені.` }]
        }
      };
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Невідомий інструмент: ${toolName}` }
    };
  }

  if (id !== undefined) {
    return {
      jsonrpc: '2.0',
      id,
      result: {}
    };
  }
  return null;
}

let buffer = '';
let useContentLength = false;

function sendResponse(obj) {
  if (!obj) return;
  const json = JSON.stringify(obj);
  if (useContentLength) {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
  } else {
    process.stdout.write(json + '\n');
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buffer += chunk;

  while (true) {
    if (buffer.startsWith('Content-Length:')) {
      useContentLength = true;
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) break;
      const contentLen = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (Buffer.byteLength(buffer.slice(bodyStart), 'utf8') < contentLen) break;

      const bodyBuf = Buffer.from(buffer.slice(bodyStart), 'utf8');
      const jsonStr = bodyBuf.slice(0, contentLen).toString('utf8');
      const remaining = bodyBuf.slice(contentLen).toString('utf8');
      buffer = remaining;

      try {
        const msg = JSON.parse(jsonStr);
        const resp = await handleRequest(msg);
        sendResponse(resp);
      } catch (_) {}
    } else {
      const nlIndex = buffer.indexOf('\n');
      if (nlIndex === -1) break;
      const line = buffer.slice(0, nlIndex).trim();
      buffer = buffer.slice(nlIndex + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const resp = await handleRequest(msg);
        sendResponse(resp);
      } catch (_) {}
    }
  }
});
