(() => {
  const isElectron = Boolean(window.electronAPI && window.electronAPI.isElectron);
  const isAndroidApk = location.protocol === 'file:' || Boolean(window.AndroidBridge);
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0 || isAndroidApk;

  if (!isElectron) {
    document.body.classList.add('is-web');
  }
  if (isTouch) {
    document.body.classList.add('is-touch');
  }

  const COLUMN_NAMES = ['До виконання', 'В роботі', 'Виконано'];
  const DEFAULT_PC_HOST = '100.101.231.78:3456';
  const FALLBACK_HOSTS = [
    '100.101.231.78:3456',
    'liakh-server.tail2f1f7e.ts.net:3456',
    '192.168.23.66:3456'
  ];
  let fallbackHostIdx = 0;

  function getDefaultUserName() {
    const saved = localStorage.getItem('todoom_username');
    if (saved) return saved;
    if (isAndroidApk) return 'Планшет';
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('iphone')) return 'iPhone';
    if (ua.includes('ipad') || ua.includes('android') || ua.includes('tablet')) return 'Планшет';
    return 'Ви';
  }

  const SEED_TIMESTAMP = 1700000000000;

  function getInitialOfflineState() {
    try {
      const saved = localStorage.getItem('todoom_offline_state');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && Array.isArray(parsed.projects) && Array.isArray(parsed.tasks)) {
          if (!parsed.deletedProjects || typeof parsed.deletedProjects !== 'object' || Array.isArray(parsed.deletedProjects)) {
            parsed.deletedProjects = {};
          }
          return parsed;
        }
      }
    } catch (_) {}
    return {
      version: '1.2.1',
      nextTaskId: 17,
      activeProjectId: 'proj-1',
      deletedProjects: {},
      settings: {
        githubRepo: localStorage.getItem('todoom_github_repo') || 'Archyange1/To-Doom',
        githubBranch: localStorage.getItem('todoom_github_branch') || 'main'
      },
      projects: [
        { id: 'proj-1', name: 'Запуск сайту', color: '#22c55e', agentEnabled: true, createdAt: SEED_TIMESTAMP, updatedAt: SEED_TIMESTAMP },
        { id: 'proj-2', name: 'Мобільний додаток', color: '#f59e0b', agentEnabled: false, createdAt: SEED_TIMESTAMP, updatedAt: SEED_TIMESTAMP }
      ],
      tasks: [
        { id: 12, projectId: 'proj-1', title: 'Написати інструкцію з налаштування', epic: 'Документація', column: 0, progress: 40, assignee: 'Codex', dotColor: '#a855f7', order: 0, deleted: false, updatedAt: SEED_TIMESTAMP },
        { id: 13, projectId: 'proj-1', title: 'Підключити ШІ-агентів (MCP)', epic: 'Інтеграція', column: 1, progress: 75, assignee: 'Codex', dotColor: '#f59e0b', order: 0, deleted: false, updatedAt: SEED_TIMESTAMP },
        { id: 14, projectId: 'proj-1', title: 'Перевірити сценарій онбордингу', epic: 'UX', column: 1, progress: 45, assignee: 'Claude', dotColor: '#a855f7', order: 1, deleted: false, updatedAt: SEED_TIMESTAMP },
        { id: 15, projectId: 'proj-1', title: 'Створити дошку проєкту', epic: 'Ядро', column: 2, progress: 100, assignee: 'Ви', dotColor: '#22c55e', order: 0, deleted: false, updatedAt: SEED_TIMESTAMP },
        { id: 16, projectId: 'proj-1', title: 'Підготувати чекліст релізу', epic: 'Реліз', column: 0, progress: 10, assignee: 'Ви', dotColor: '#f59e0b', order: 1, deleted: false, updatedAt: SEED_TIMESTAMP }
      ]
    };
  }

  let currentUserName = getDefaultUserName();
  let clientId = null;
  let boardState = getInitialOfflineState();
  let hasDirtyOfflineChanges = localStorage.getItem('todoom_dirty') === '1';
  let awaitingHelloSync = false;
  const recentClientDeletePushes = new Map();
  let peers = [];
  let peerPresence = new Map();
  let activeMobileCol = 0;
  let draggedTaskId = null;
  let isScrubbingProgress = false;
  let ws = null;
  let reconnectTimer = null;
  let remotePcHost = localStorage.getItem('todoom_pc_host') || DEFAULT_PC_HOST;

  function saveOfflineState(markDirty = false) {
    try {
      localStorage.setItem('todoom_offline_state', JSON.stringify(boardState));
      if (boardState.settings && boardState.settings.githubRepo) {
        localStorage.setItem('todoom_github_repo', boardState.settings.githubRepo);
        localStorage.setItem('todoom_github_branch', boardState.settings.githubBranch || 'main');
      }
      if (markDirty) {
        hasDirtyOfflineChanges = true;
        localStorage.setItem('todoom_dirty', '1');
      }
    } catch (_) {}
  }

  function clearDirtyFlag() {
    hasDirtyOfflineChanges = false;
    try {
      localStorage.removeItem('todoom_dirty');
    } catch (_) {}
  }

  function getApiBase() {
    if (isAndroidApk) {
      return `http://${remotePcHost}`;
    }
    return '';
  }

  function cleanGithubRepo(input) {
    let s = (input || '').trim();
    s = s.replace(/^https?:\/\/(www\.)?github\.com\//i, '');
    s = s.replace(/\.git$/i, '');
    s = s.replace(/\/+$/, '');
    const parts = s.split('/').filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    return s;
  }

  // DOM Elements
  const tuckTab = document.getElementById('tuck-tab');
  const appShell = document.getElementById('app-shell');
  const appVersionBadge = document.getElementById('app-version-badge');
  const btnUpdateHeader = document.getElementById('btn-update-header');
  const btnViewList = document.getElementById('btn-view-list');
  const btnViewBoard = document.getElementById('btn-view-board');
  const btnTuck = document.getElementById('btn-tuck');
  const btnMinimize = document.getElementById('btn-minimize');
  const btnClose = document.getElementById('btn-close');

  const projectTabsEl = document.getElementById('project-tabs');
  const btnToggleProjectAi = document.getElementById('btn-toggle-project-ai');
  const aiProjectStatusText = document.getElementById('ai-project-status-text');
  const btnSettings = document.getElementById('btn-settings');
  const btnNewProject = document.getElementById('btn-new-project');

  const taskForm = document.getElementById('task-form');
  const inputTaskTitle = document.getElementById('input-task-title');
  const inputTaskEpic = document.getElementById('input-task-epic');
  const inputPeerBadge = document.getElementById('input-peer-badge');
  const epicsDatalist = document.getElementById('epics-datalist');

  const projectPercentEl = document.getElementById('project-percent');
  const projectCountsEl = document.getElementById('project-counts');
  const btnPeersBadge = document.getElementById('btn-peers-badge');
  const peerCountText = document.getElementById('peer-count-text');
  const btnDeleted = document.getElementById('btn-deleted');
  const deletedCountEl = document.getElementById('deleted-count');
  const btnShare = document.getElementById('btn-share');

  const boardEl = document.getElementById('board');
  const colLists = [
    document.getElementById('col-list-0'),
    document.getElementById('col-list-1'),
    document.getElementById('col-list-2')
  ];
  const colCounts = [
    document.getElementById('col-count-0'),
    document.getElementById('col-count-1'),
    document.getElementById('col-count-2')
  ];
  const mobCounts = [
    document.getElementById('mob-count-0'),
    document.getElementById('mob-count-1'),
    document.getElementById('mob-count-2')
  ];

  const toastContainer = document.getElementById('toast-container');

  function showToast(message) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = message;
    toastContainer.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      t.style.transition = 'opacity 0.25s ease';
      setTimeout(() => t.remove(), 260);
    }, 2800);
  }

  // Electron Window Controls & Universal Tuck-to-edge
  let webSavedBounds = null;

  function toggleWebTuck(forceUntuck = false) {
    const currentlyTucked = document.body.classList.contains('web-tucked');
    const nextTucked = forceUntuck ? false : !currentlyTucked;
    if (nextTucked) {
      document.body.classList.add('web-tucked');
      tuckTab.classList.remove('hidden');
      try {
        webSavedBounds = {
          x: window.screenX,
          y: window.screenY,
          w: window.outerWidth,
          h: window.outerHeight
        };
        const availW = window.screen.availWidth;
        const availH = window.screen.availHeight;
        window.resizeTo(120, 220);
        window.moveTo(availW - 60, Math.round((availH - 220) / 2));
      } catch (_) {}
    } else {
      document.body.classList.remove('web-tucked');
      tuckTab.classList.add('hidden');
      if (webSavedBounds) {
        try {
          window.resizeTo(webSavedBounds.w, webSavedBounds.h);
          window.moveTo(webSavedBounds.x, webSavedBounds.y);
        } catch (_) {}
      }
    }
  }

  if (isElectron) {
    btnMinimize.addEventListener('click', () => window.electronAPI.minimize());
    btnClose.addEventListener('click', () => window.electronAPI.close());
    btnTuck.addEventListener('click', () => window.electronAPI.toggleTuck());
    tuckTab.addEventListener('click', () => window.electronAPI.untuck());

    window.electronAPI.onTuckChanged((isTucked) => {
      if (isTucked) {
        appShell.classList.add('hidden');
        tuckTab.classList.remove('hidden');
      } else {
        tuckTab.classList.add('hidden');
        appShell.classList.remove('hidden');
      }
    });

    const chkAot = document.getElementById('chk-always-on-top');
    window.electronAPI.getWindowState().then((st) => {
      if (st && chkAot) chkAot.checked = Boolean(st.isAlwaysOnTop);
    });
    if (chkAot) {
      chkAot.addEventListener('change', () => {
        window.electronAPI.toggleAlwaysOnTop();
      });
    }
    window.electronAPI.onAotChanged((isAot) => {
      if (chkAot) chkAot.checked = Boolean(isAot);
    });
  } else {
    btnTuck.addEventListener('click', () => toggleWebTuck(false));
    tuckTab.addEventListener('click', () => toggleWebTuck(true));
  }

  window.addEventListener('keydown', (e) => {
    if (e.altKey && (e.code === 'KeyS' || e.key.toLowerCase() === 's' || e.key.toLowerCase() === 'і' || e.key.toLowerCase() === 'ї')) {
      e.preventDefault();
      if (isElectron) {
        window.electronAPI.toggleTuck();
      } else {
        toggleWebTuck(false);
      }
    }
  });

  // View Mode Switcher
  btnViewList.addEventListener('click', () => {
    boardEl.classList.add('compact-mode');
    btnViewList.classList.add('active');
    btnViewBoard.classList.remove('active');
  });

  btnViewBoard.addEventListener('click', () => {
    boardEl.classList.remove('compact-mode');
    btnViewBoard.classList.add('active');
    btnViewList.classList.remove('active');
  });

  // Mobile Column Switcher
  document.querySelectorAll('.mob-col-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeMobileCol = Number(btn.dataset.col);
      document.querySelectorAll('.mob-col-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.board-column').forEach((colEl) => {
        colEl.classList.toggle('active-mobile-col', Number(colEl.dataset.column) === activeMobileCol);
      });
    });
  });

  // Local offline mutation engine
  function applyLocalAction(type, payload = {}, isConnected = false) {
    if (type === 'SET_ACTIVE_PROJECT') {
      boardState.activeProjectId = payload.projectId;
    } else if (type === 'UPDATE_SETTINGS') {
      if (!boardState.settings) boardState.settings = {};
      if (typeof payload.githubRepo === 'string') {
        boardState.settings.githubRepo = cleanGithubRepo(payload.githubRepo);
      }
      if (typeof payload.githubBranch === 'string' && payload.githubBranch.trim()) {
        boardState.settings.githubBranch = payload.githubBranch.trim();
      }
    } else if (type === 'CREATE_PROJECT') {
      const newProj = {
        id: payload.id || ('proj-' + Date.now()),
        name: payload.name,
        color: payload.color || '#22c55e',
        agentEnabled: typeof payload.agentEnabled === 'boolean' ? payload.agentEnabled : true,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      if (!boardState.deletedProjects || typeof boardState.deletedProjects !== 'object') {
        boardState.deletedProjects = {};
      }
      delete boardState.deletedProjects[newProj.id];
      boardState.projects.push(newProj);
      boardState.activeProjectId = newProj.id;
    } else if (type === 'UPDATE_PROJECT') {
      const p = boardState.projects.find(x => x.id === payload.projectId);
      if (p) {
        if (payload.name) p.name = payload.name;
        if (payload.color) p.color = payload.color;
        if (typeof payload.agentEnabled === 'boolean') p.agentEnabled = payload.agentEnabled;
        p.updatedAt = Date.now();
      }
    } else if (type === 'TOGGLE_PROJECT_AGENT') {
      const pId = payload.projectId || boardState.activeProjectId;
      const p = boardState.projects.find(x => x.id === pId);
      if (p) {
        p.agentEnabled = typeof payload.agentEnabled === 'boolean' ? payload.agentEnabled : !p.agentEnabled;
        p.updatedAt = Date.now();
      }
    } else if (type === 'DELETE_PROJECT') {
      if (boardState.projects.length > 1) {
        const targetProj = boardState.projects.find(x => x.id === payload.projectId);
        if (!boardState.deletedProjects || typeof boardState.deletedProjects !== 'object') {
          boardState.deletedProjects = {};
        }
        const delTs = Math.max(
          Number(payload.deletedAt) || Date.now(),
          Number((targetProj && (targetProj.updatedAt || targetProj.createdAt)) || 0) + 1
        );
        boardState.deletedProjects[payload.projectId] = Math.max(Number(boardState.deletedProjects[payload.projectId]) || 0, delTs);
        boardState.projects = boardState.projects.filter(x => x.id !== payload.projectId);
        boardState.tasks = boardState.tasks.filter(t => t.projectId !== payload.projectId);
        if (boardState.projects.length > 0 && !boardState.projects.some(x => x.id === boardState.activeProjectId)) {
          boardState.activeProjectId = boardState.projects[0].id;
        }
      }
    } else if (type === 'CREATE_TASK') {
      const task = {
        id: boardState.nextTaskId || (Math.max(0, ...boardState.tasks.map(t => t.id)) + 1),
        clientUid: payload.clientUid || ('uid-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)),
        createdOffline: !isConnected,
        projectId: payload.projectId || boardState.activeProjectId,
        title: payload.title,
        epic: payload.epic || '',
        column: payload.column ?? 0,
        progress: payload.progress ?? 0,
        assignee: payload.assignee || currentUserName,
        dotColor: '#22c55e',
        order: boardState.tasks.length,
        deleted: false,
        updatedAt: Date.now()
      };
      boardState.nextTaskId = task.id + 1;
      boardState.tasks.push(task);
    } else if (type === 'UPDATE_TASK') {
      const id = Number(payload.id ?? payload.task_id);
      const t = boardState.tasks.find(x => x.id === id);
      if (t) {
        if (typeof payload.title === 'string') t.title = payload.title;
        if (typeof payload.epic === 'string') t.epic = payload.epic;
        if (typeof payload.assignee === 'string') t.assignee = payload.assignee;
        if (typeof payload.column === 'number') {
          t.column = payload.column;
          if (t.column === 2 && typeof payload.progress !== 'number') t.progress = 100;
        }
        if (typeof payload.progress === 'number') t.progress = payload.progress;
        t.updatedAt = Date.now();
      }
    } else if (type === 'DELETE_TASK') {
      const id = Number(payload.id ?? payload.task_id);
      const t = boardState.tasks.find(x => x.id === id);
      if (t) {
        t.deleted = true;
        t.updatedAt = Date.now();
      }
    } else if (type === 'RESTORE_TASK') {
      const id = Number(payload.id ?? payload.task_id);
      const t = boardState.tasks.find(x => x.id === id);
      if (t) {
        t.deleted = false;
        t.updatedAt = Date.now();
      }
    } else if (type === 'EMPTY_TRASH') {
      boardState.tasks = boardState.tasks.filter(t => !(t.deleted && t.projectId === boardState.activeProjectId));
    }
    saveOfflineState(!isConnected);
    renderAll();
  }

  function applyClientTombstones(incomingState, activeSocket = null) {
    if (!incomingState || !Array.isArray(incomingState.projects)) return incomingState;
    const mergedTombstones = {
      ...((boardState && boardState.deletedProjects) || {}),
      ...((incomingState && incomingState.deletedProjects) || {})
    };
    for (const [k, v] of Object.entries((boardState && boardState.deletedProjects) || {})) {
      const sv = Number((incomingState.deletedProjects || {})[k]) || 0;
      const lv = Number(v) || 0;
      if (lv > sv) mergedTombstones[k] = lv;
    }

    const filteredProjects = [];
    for (const p of incomingState.projects) {
      if (!p || !p.id) continue;
      const delTs = Number(mergedTombstones[p.id]) || 0;
      const projTs = Number(p.updatedAt || p.createdAt || 0);
      if (delTs > 0 && delTs >= projTs) {
        if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
          const lastPush = recentClientDeletePushes.get(p.id) || 0;
          if (Date.now() - lastPush > 3000) {
            recentClientDeletePushes.set(p.id, Date.now());
            try {
              activeSocket.send(JSON.stringify({
                type: 'ACTION',
                action: { type: 'DELETE_PROJECT', payload: { projectId: p.id, deletedAt: delTs } }
              }));
            } catch (_) {}
          }
        }
        continue;
      }
      if (delTs > 0 && projTs > delTs) {
        delete mergedTombstones[p.id];
      }
      filteredProjects.push(p);
    }

    if (filteredProjects.length > 0) {
      incomingState.projects = filteredProjects;
      const survivingIds = new Set(filteredProjects.map(p => p.id));
      if (Array.isArray(incomingState.tasks)) {
        incomingState.tasks = incomingState.tasks.filter(t => survivingIds.has(t.projectId));
      }
      if (!survivingIds.has(incomingState.activeProjectId)) {
        incomingState.activeProjectId = filteredProjects[0].id;
      }
    }
    incomingState.deletedProjects = mergedTombstones;
    return incomingState;
  }

  // WebSocket Connection & Sync
  function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, 3500);
  }

  function connectWebSocket() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      const oldWs = ws;
      ws = null;
      try { oldWs.close(); } catch (_) {}
    }

    let wsUrl = '';
    if (isAndroidApk) {
      let host = (remotePcHost || DEFAULT_PC_HOST).replace(/^https?:\/\//, '').replace(/^ws:\/\//, '');
      if (!host.includes(':')) host = `${host}:3456`;
      wsUrl = `ws://${host}`;
    } else {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = `${proto}//${location.host}`;
    }

    let socket;
    try {
      socket = new WebSocket(wsUrl);
      ws = socket;
    } catch (_) {
      scheduleReconnect();
      return;
    }

    socket.addEventListener('open', () => {
      if (ws !== socket) return;
      if (isAndroidApk && remotePcHost) {
        try { localStorage.setItem('todoom_pc_host', remotePcHost); } catch (_) {}
      }
      const hadDirty = hasDirtyOfflineChanges;
      awaitingHelloSync = hadDirty;
      const helloMsg = {
        type: 'HELLO',
        name: currentUserName,
        deviceType: isAndroidApk ? 'tablet' : 'desktop'
      };
      if (hadDirty) {
        helloMsg.offlineState = boardState;
        clearDirtyFlag();
      }
      socket.send(JSON.stringify(helloMsg));
      if (hadDirty && boardState.deletedProjects) {
        for (const [delProjId, delTs] of Object.entries(boardState.deletedProjects)) {
          if (Number(delTs) > 0) {
            socket.send(JSON.stringify({
              type: 'ACTION',
              action: { type: 'DELETE_PROJECT', payload: { projectId: delProjId, deletedAt: Number(delTs) } }
            }));
          }
        }
      }
      renderPeersBadge();
    });

    socket.addEventListener('message', (ev) => {
      if (ws !== socket) return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'INIT') {
          clientId = msg.clientId;
          if (!hasDirtyOfflineChanges && !awaitingHelloSync) {
            boardState = applyClientTombstones(msg.state, socket);
            saveOfflineState(false);
          }
          peers = msg.peers || [];
          renderAll();
        } else if (msg.type === 'STATE_UPDATE') {
          awaitingHelloSync = false;
          if (!isScrubbingProgress) {
            boardState = applyClientTombstones(msg.state, socket);
            if (msg.peers) peers = msg.peers;
            saveOfflineState(false);
            renderAll(msg.event);
          }
          if (msg.source === 'mcp' && msg.event && msg.event.task) {
            const t = msg.event.task;
            showToast(`ШІ-агент оновив #${t.id} «${t.title}» → ${COLUMN_NAMES[t.column]} (${t.progress}%)`);
          }
        } else if (msg.type === 'PEERS_UPDATE') {
          peers = msg.peers || [];
          renderPeersBadge();
        } else if (msg.type === 'PRESENCE_UPDATE') {
          peerPresence.set(msg.peerId, {
            name: msg.name,
            color: msg.color || '#8b5cf6',
            activeTaskId: msg.activeTaskId,
            focusedField: msg.focusedField,
            draggingProgress: msg.draggingProgress,
            ts: Date.now()
          });
          renderPresenceIndicators();
        } else if (msg.type === 'APP_UPDATED') {
          showToast(`Оновлено до v${msg.version || 'нової версії'}! Перезавантаження...`);
          setTimeout(() => location.reload(), 900);
        }
      } catch (_) {}
    });

    socket.addEventListener('close', () => {
      if (ws !== socket) return;
      ws = null;
      peers = [];
      // On Android APK, if primary host is unreachable and user didn't lock a custom IP, cycle through liakh-server -> MagicDNS -> local Wi-Fi
      if (isAndroidApk && !localStorage.getItem('todoom_pc_host_locked')) {
        fallbackHostIdx = (fallbackHostIdx + 1) % FALLBACK_HOSTS.length;
        remotePcHost = FALLBACK_HOSTS[fallbackHostIdx];
      }
      renderPeersBadge();
      scheduleReconnect();
    });

    socket.addEventListener('error', () => {});
  }

  function sendAction(type, payload = {}) {
    const isConnected = Boolean(ws && ws.readyState === WebSocket.OPEN);
    if (type === 'CREATE_TASK' && !payload.clientUid) {
      payload.clientUid = 'uid-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    }
    if (type === 'CREATE_PROJECT' && !payload.id) {
      payload.id = 'proj-' + Date.now();
    }
    if (type === 'DELETE_PROJECT' && !payload.deletedAt) {
      payload.deletedAt = Date.now();
    }

    applyLocalAction(type, payload, isConnected);

    const action = { type, payload };
    if (isConnected) {
      ws.send(JSON.stringify({ type: 'ACTION', action }));
    } else if (!isAndroidApk) {
      fetch(`${getApiBase()}/api/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action)
      })
        .then(r => r.json())
        .then(res => {
          if (res && res.state) {
            boardState = res.state;
            saveOfflineState(false);
            renderAll();
          }
        })
        .catch(() => {});
    }
  }

  function sendPresence(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'PRESENCE',
        name: currentUserName,
        ...data
      }));
    }
  }

  inputTaskTitle.addEventListener('focus', () => sendPresence({ focusedField: 'task-title' }));
  inputTaskTitle.addEventListener('blur', () => sendPresence({ focusedField: null }));

  function renderPresenceIndicators() {
    let focusedPeer = null;
    for (const p of peerPresence.values()) {
      if (Date.now() - p.ts < 12000 && p.focusedField === 'task-title') {
        focusedPeer = p;
      }
    }
    if (focusedPeer) {
      inputPeerBadge.textContent = focusedPeer.name;
      inputPeerBadge.style.background = focusedPeer.color || '#22c55e';
      inputPeerBadge.classList.remove('hidden');
    } else {
      inputPeerBadge.classList.add('hidden');
    }

    document.querySelectorAll('.task-card').forEach((cardEl) => {
      const tId = Number(cardEl.dataset.taskId);
      const existing = cardEl.querySelector('.peer-floating-badge');
      let activePeer = null;
      for (const p of peerPresence.values()) {
        if (Date.now() - p.ts < 8000 && Number(p.activeTaskId) === tId) {
          activePeer = p;
        }
      }
      if (activePeer) {
        if (!existing) {
          const badge = document.createElement('div');
          badge.className = 'peer-floating-badge';
          badge.textContent = activePeer.name;
          badge.style.background = activePeer.color || '#8b5cf6';
          cardEl.appendChild(badge);
        } else {
          existing.textContent = activePeer.name;
        }
        if (typeof activePeer.draggingProgress === 'number') {
          const fill = cardEl.querySelector('.card-progress-fill');
          const pctTxt = cardEl.querySelector('.task-pct-text');
          if (fill) fill.style.width = `${activePeer.draggingProgress}%`;
          if (pctTxt) pctTxt.textContent = `${activePeer.draggingProgress}%`;
        }
      } else if (existing) {
        existing.remove();
      }
    });
  }

  function renderPeersBadge() {
    const isWsConnected = Boolean(ws && ws.readyState === WebSocket.OPEN);
    if (isAndroidApk) {
      btnPeersBadge.classList.remove('hidden');
      if (isWsConnected) {
        btnPeersBadge.style.borderColor = 'rgba(34, 197, 94, 0.35)';
        btnPeersBadge.style.background = 'rgba(34, 197, 94, 0.12)';
        btnPeersBadge.style.color = '#4ade80';
        peerCountText.textContent = `Синхр. (${remotePcHost.split(':')[0]})`;
      } else {
        btnPeersBadge.style.borderColor = 'rgba(245, 158, 11, 0.35)';
        btnPeersBadge.style.background = 'rgba(245, 158, 11, 0.12)';
        btnPeersBadge.style.color = '#fbbf24';
        peerCountText.textContent = hasDirtyOfflineChanges ? 'Офлайн (є зміни)' : 'Офлайн';
      }
      return;
    }

    const remoteCount = Math.max(0, peers.length - 1);
    if (remoteCount > 0) {
      btnPeersBadge.classList.remove('hidden');
      const names = peers
        .filter(p => p.id !== clientId)
        .map(p => p.name)
        .join(', ');
      peerCountText.textContent =
        remoteCount === 1
          ? `1 пристрій (${names || 'онлайн'})`
          : `${remoteCount} пристрої (${names})`;
    } else {
      btnPeersBadge.classList.add('hidden');
    }
  }

  // Render Project Tabs & Active Project AI Toggle Pill
  function renderProjects() {
    projectTabsEl.innerHTML = '';
    const projects = boardState.projects || [];
    const activeProj = projects.find(p => p.id === boardState.activeProjectId) || projects[0];

    if (appVersionBadge && boardState.version) {
      appVersionBadge.textContent = `v${boardState.version}`;
    }

    // Update active project AI pill
    if (activeProj && btnToggleProjectAi) {
      const enabled = activeProj.agentEnabled !== false;
      btnToggleProjectAi.classList.toggle('active', enabled);
      aiProjectStatusText.textContent = enabled ? 'ШІ: Увімк.' : 'ШІ: Вимк.';
    }

    projects.forEach((proj) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'project-tab' + (proj.id === boardState.activeProjectId ? ' active' : '');
      btn.title = 'Натисніть для переходу • Подвійний клік для редагування проєкту';

      const nameSpan = document.createElement('span');
      nameSpan.textContent = proj.name;

      const dotSpan = document.createElement('span');
      dotSpan.className = 'proj-dot';
      dotSpan.style.background = proj.color || '#22c55e';

      btn.appendChild(nameSpan);
      if (proj.agentEnabled !== false) {
        const aiMini = document.createElement('span');
        aiMini.className = 'proj-ai-mini';
        aiMini.textContent = '🤖';
        aiMini.title = 'ШІ-агенту дозволено керувати цим проєктом';
        btn.appendChild(aiMini);
      }
      btn.appendChild(dotSpan);

      btn.addEventListener('click', () => {
        if (boardState.activeProjectId !== proj.id) {
          sendAction('SET_ACTIVE_PROJECT', { projectId: proj.id });
        }
      });

      btn.addEventListener('dblclick', () => {
        openProjectModal(proj);
      });

      projectTabsEl.appendChild(btn);
    });
  }

  // Toggle AI Agent permission for the active project directly from the bar
  if (btnToggleProjectAi) {
    btnToggleProjectAi.addEventListener('click', () => {
      const activeProj = (boardState.projects || []).find(p => p.id === boardState.activeProjectId);
      if (!activeProj) return;
      const nextState = activeProj.agentEnabled === false;
      sendAction('TOGGLE_PROJECT_AGENT', {
        projectId: activeProj.id,
        agentEnabled: nextState
      });
      showToast(
        nextState
          ? `🤖 ШІ-агенту дозволено керувати проєктом «${activeProj.name}»`
          : `🔒 Керування ШІ-агентом для проєкту «${activeProj.name}» вимкнено`
      );
      renderSettingsProjectAiList();
    });
  }

  function updateProgressSummary() {
    const activeTasks = (boardState.tasks || []).filter(
      t => !t.deleted && t.projectId === boardState.activeProjectId
    );
    const deletedTasks = (boardState.tasks || []).filter(
      t => t.deleted && t.projectId === boardState.activeProjectId
    );

    const total = activeTasks.length;
    const doneCount = activeTasks.filter(t => t.column === 2 || t.progress === 100).length;
    const avgProgress = total === 0
      ? 0
      : Math.round(activeTasks.reduce((sum, t) => sum + (Number(t.progress) || 0), 0) / total);

    projectPercentEl.textContent = `${avgProgress}%`;
    const isNarrow = window.innerWidth <= 480;
    projectCountsEl.textContent = isNarrow
      ? `${doneCount} з ${total} виконано`
      : `Прогрес проєкту · ${doneCount} з ${total} виконано`;
    deletedCountEl.textContent = String(deletedTasks.length);

    const epics = Array.from(new Set(activeTasks.map(t => t.epic).filter(Boolean)));
    epicsDatalist.innerHTML = epics.map(e => `<option value="${escapeHtml(e)}"></option>`).join('');
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderBoard(lastEvent = null) {
    const activeTasks = (boardState.tasks || []).filter(
      t => !t.deleted && t.projectId === boardState.activeProjectId
    );

    for (let col = 0; col < 3; col++) {
      const colTasks = activeTasks
        .filter(t => Number(t.column) === col)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id - b.id);

      colCounts[col].textContent = String(colTasks.length);
      mobCounts[col].textContent = String(colTasks.length);

      const listEl = colLists[col];
      listEl.innerHTML = '';

      if (colTasks.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-col-placeholder';
        empty.textContent = 'Перетягніть картку сюди або додайте задачу';
        listEl.appendChild(empty);
        continue;
      }

      colTasks.forEach((task) => {
        const card = createTaskCardElement(task, lastEvent);
        listEl.appendChild(card);
      });
    }

    renderPresenceIndicators();
  }

  function createTaskCardElement(task, lastEvent) {
    const card = document.createElement('article');
    card.className = 'task-card';
    if (lastEvent && lastEvent.task && Number(lastEvent.task.id) === Number(task.id)) {
      card.classList.add('mcp-highlight');
    }
    card.dataset.taskId = String(task.id);
    card.draggable = true;

    const top = document.createElement('div');
    top.className = 'card-top';

    const titleEl = document.createElement('div');
    titleEl.className = 'card-title';
    titleEl.textContent = task.title;
    titleEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      openEditTaskModal(task);
    });

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    // Left column button for convenient 1-tap moving on iPhone/touch
    if (task.column > 0) {
      const prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.className = 'card-action-btn';
      prevBtn.title = `Перемістити в «${COLUMN_NAMES[task.column - 1]}»`;
      prevBtn.textContent = '←';
      prevBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const prevCol = task.column - 1;
        sendAction('UPDATE_TASK', {
          id: task.id,
          column: prevCol,
          progress: task.progress === 100 && prevCol < 2 ? 75 : task.progress
        });
      });
      actions.appendChild(prevBtn);
    }

    if (task.column < 2) {
      const nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'card-action-btn';
      nextBtn.title = `Перемістити в «${COLUMN_NAMES[task.column + 1]}»`;
      nextBtn.textContent = '→';
      nextBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const nextCol = task.column + 1;
        sendAction('UPDATE_TASK', {
          id: task.id,
          column: nextCol,
          progress: nextCol === 2 ? 100 : task.progress
        });
      });
      actions.appendChild(nextBtn);
    }

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'card-action-btn';
    editBtn.title = 'Редагувати задачу';
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditTaskModal(task);
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'card-action-btn del';
    delBtn.title = 'Видалити в кошик';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      sendAction('DELETE_TASK', { id: task.id });
    });

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    top.appendChild(titleEl);
    top.appendChild(actions);

    const progZone = document.createElement('div');
    progZone.className = 'card-progress-zone';
    progZone.title = 'Потягніть смужку вліво/вправо, щоб змінити прогрес';

    const progTrack = document.createElement('div');
    progTrack.className = 'card-progress-track';

    const progFill = document.createElement('div');
    progFill.className = 'card-progress-fill';
    progFill.style.width = `${task.progress}%`;

    progTrack.appendChild(progFill);
    progZone.appendChild(progTrack);

    const footer = document.createElement('div');
    footer.className = 'card-footer';

    const metaLeft = document.createElement('div');
    metaLeft.className = 'card-meta-left';

    const idBadge = document.createElement('span');
    idBadge.className = 'task-id-badge';
    idBadge.textContent = `#${task.id}`;

    const pctText = document.createElement('span');
    pctText.className = 'task-pct-text';
    pctText.textContent = `${task.progress}%`;

    const assigneeText = document.createElement('span');
    assigneeText.className = 'task-assignee';
    assigneeText.textContent = `· ${task.assignee || 'Ви'}`;

    metaLeft.appendChild(idBadge);
    metaLeft.appendChild(pctText);
    metaLeft.appendChild(assigneeText);

    if (task.epic) {
      const epicChip = document.createElement('span');
      epicChip.className = 'task-epic-chip';
      epicChip.textContent = task.epic;
      metaLeft.appendChild(epicChip);
    }

    const dot = document.createElement('span');
    dot.className = 'task-dot';
    dot.style.background = task.dotColor || '#a855f7';

    footer.appendChild(metaLeft);
    footer.appendChild(dot);

    card.appendChild(top);
    card.appendChild(progZone);
    card.appendChild(footer);

    setupProgressScrubbing(progZone, progTrack, progFill, pctText, task, card);

    card.addEventListener('dragstart', (e) => {
      if (isScrubbingProgress) {
        e.preventDefault();
        return;
      }
      draggedTaskId = task.id;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(task.id));
      sendPresence({ activeTaskId: task.id });
    });

    card.addEventListener('dragend', () => {
      draggedTaskId = null;
      card.classList.remove('dragging');
      document.querySelectorAll('.board-column').forEach(c => c.classList.remove('drag-over'));
      sendPresence({ activeTaskId: null });
    });

    return card;
  }

  function setupProgressScrubbing(progZone, progTrack, progFill, pctText, task, cardEl) {
    let currentPct = task.progress;

    const calcPctFromEvent = (clientX) => {
      const rect = progTrack.getBoundingClientRect();
      const rel = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return Math.round((rel * 100) / 5) * 5;
    };

    progZone.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      isScrubbingProgress = true;
      cardEl.draggable = false;
      progZone.classList.add('scrubbing');
      progZone.setPointerCapture(e.pointerId);

      currentPct = calcPctFromEvent(e.clientX);
      progFill.style.width = `${currentPct}%`;
      pctText.textContent = `${currentPct}%`;
      task.progress = currentPct;
      updateProgressSummary();
      sendPresence({ activeTaskId: task.id, draggingProgress: currentPct });
    });

    progZone.addEventListener('pointermove', (e) => {
      if (!isScrubbingProgress || !progZone.hasPointerCapture(e.pointerId)) return;
      e.stopPropagation();
      const nextPct = calcPctFromEvent(e.clientX);
      if (nextPct !== currentPct) {
        currentPct = nextPct;
        progFill.style.width = `${currentPct}%`;
        pctText.textContent = `${currentPct}%`;
        task.progress = currentPct;
        updateProgressSummary();
        sendPresence({ activeTaskId: task.id, draggingProgress: currentPct });
      }
    });

    const finishScrub = (e) => {
      if (!isScrubbingProgress) return;
      isScrubbingProgress = false;
      cardEl.draggable = true;
      progZone.classList.remove('scrubbing');
      try { progZone.releasePointerCapture(e.pointerId); } catch (_) {}

      sendAction('UPDATE_TASK', {
        id: task.id,
        progress: currentPct,
        actor: currentUserName
      });
      sendPresence({ activeTaskId: null, draggingProgress: null });
    };

    progZone.addEventListener('pointerup', finishScrub);
    progZone.addEventListener('pointercancel', finishScrub);
  }

  document.querySelectorAll('.board-column').forEach((colEl) => {
    const colIndex = Number(colEl.dataset.column);

    colEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      colEl.classList.add('drag-over');
    });

    colEl.addEventListener('dragleave', (e) => {
      if (!colEl.contains(e.relatedTarget)) {
        colEl.classList.remove('drag-over');
      }
    });

    colEl.addEventListener('drop', (e) => {
      e.preventDefault();
      colEl.classList.remove('drag-over');
      const idStr = e.dataTransfer.getData('text/plain') || String(draggedTaskId || '');
      const taskId = Number(idStr);
      if (!taskId) return;

      const task = boardState.tasks.find(t => t.id === taskId);
      if (!task) return;

      const newProgress = colIndex === 2 ? 100 : task.progress;
      sendAction('UPDATE_TASK', {
        id: taskId,
        column: colIndex,
        progress: newProgress,
        actor: currentUserName
      });
    });
  });

  taskForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = inputTaskTitle.value.trim();
    const epic = inputTaskEpic.value.trim();
    if (!title) {
      inputTaskTitle.focus();
      return;
    }

    sendAction('CREATE_TASK', {
      projectId: boardState.activeProjectId,
      title,
      epic,
      column: 0,
      progress: 0,
      assignee: currentUserName
    });

    inputTaskTitle.value = '';
    inputTaskEpic.value = '';
    inputTaskTitle.focus();
  });

  function renderAll(lastEvent = null) {
    renderProjects();
    updateProgressSummary();
    renderBoard(lastEvent);
    renderPeersBadge();
  }

  function openModal(id) {
    document.getElementById(id).classList.remove('hidden');
  }

  function closeModal(id) {
    document.getElementById(id).classList.add('hidden');
  }

  document.querySelectorAll('.modal-close').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });

  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) backdrop.classList.add('hidden');
    });
  });

  // Share / Wi-Fi & Tailscale Sync Modal
  const qrContainer = document.getElementById('qr-container');
  const syncUrlInput = document.getElementById('sync-url-input');
  const selectNetworkIp = document.getElementById('select-network-ip');
  const lanDiscoveredList = document.getElementById('lan-discovered-list');

  async function autoScanSubnetForPc() {
    showToast('Пошук ПК у мережі Wi-Fi...');
    let prefix = '192.168.23.';
    if (window.AndroidBridge && window.AndroidBridge.getDeviceIp) {
      const devIp = window.AndroidBridge.getDeviceIp();
      if (devIp && devIp.includes('.')) {
        prefix = devIp.split('.').slice(0, 3).join('.') + '.';
      }
    }
    const batchSize = 32;
    for (let start = 1; start <= 254; start += batchSize) {
      const promises = [];
      for (let i = start; i < Math.min(255, start + batchSize); i++) {
        const candidate = `${prefix}${i}:3456`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 650);
        promises.push(
          fetch(`http://${candidate}/api/state`, { signal: ctrl.signal })
            .then(r => r.json())
            .then(d => {
              clearTimeout(timer);
              return d && d.ok ? candidate : null;
            })
            .catch(() => {
              clearTimeout(timer);
              return null;
            })
        );
      }
      const results = await Promise.all(promises);
      const found = results.find(Boolean);
      if (found) {
        remotePcHost = found;
        localStorage.setItem('todoom_pc_host', remotePcHost);
        document.getElementById('input-peer-ip').value = remotePcHost;
        connectWebSocket();
        showToast(`Знайдено ПК: ${found}`);
        return found;
      }
    }
    showToast('ПК не знайдено у поточній Wi-Fi мережі.');
    return null;
  }

  async function loadNetworkInfo(preferredIp = '') {
    document.getElementById('input-peer-ip').value = remotePcHost;

    if (isAndroidApk) {
      qrContainer.innerHTML = `<div style="text-align:center;font-size:12px;color:#4ade80;padding:12px;">Планшетний додаток<br/><br/>Сервер синхронізації:<br/><strong>${escapeHtml(remotePcHost)}</strong></div>`;
      syncUrlInput.value = `http://${remotePcHost}`;
      lanDiscoveredList.innerHTML = `
        <div class="lan-peer-item">
          <span>🌐 <strong>liakh-server</strong> (100.101.231.78:3456)</span>
          <button type="button" class="btn-accent-outline btn-sm" data-connect-ip="100.101.231.78:3456">Обрати</button>
        </div>
        <div class="lan-peer-item">
          <span>🌐 <strong>liakh-server.tail2f1f7e.ts.net</strong></span>
          <button type="button" class="btn-secondary btn-sm" data-connect-ip="liakh-server.tail2f1f7e.ts.net:3456">Обрати</button>
        </div>
        <div class="lan-peer-item">
          <span>🏠 <strong>Домашній ПК</strong> (192.168.23.66:3456)</span>
          <button type="button" class="btn-secondary btn-sm" data-connect-ip="192.168.23.66:3456">Обрати</button>
        </div>
        <div class="lan-peer-item">
          <span>Автопошук ПК у Wi-Fi мережі</span>
          <button type="button" id="btn-autoscan-pc" class="btn-secondary btn-sm">Знайти ПК</button>
        </div>
      `;
      const scanBtn = document.getElementById('btn-autoscan-pc');
      if (scanBtn) scanBtn.addEventListener('click', autoScanSubnetForPc);
      lanDiscoveredList.querySelectorAll('[data-connect-ip]').forEach((b) => {
        b.addEventListener('click', () => connectPeerByAddress(b.dataset.connectIp));
      });
    }

    try {
      const q = preferredIp ? `?ip=${encodeURIComponent(preferredIp)}` : '';
      const res = await fetch(`${getApiBase()}/api/network${q}`);
      const data = await res.json();
      if (!data.ok) return;

      qrContainer.innerHTML = data.qrSvg || 'QR недоступний';
      syncUrlInput.value = data.syncUrl;

      selectNetworkIp.innerHTML = data.ips
        .map(item => `<option value="${item.address}" ${item.address === data.chosenIp ? 'selected' : ''}>${item.name} — ${item.address}</option>`)
        .join('');

      if (!isAndroidApk) {
        const presetsHtml = `
          <div class="lan-peer-item">
            <span>🌐 <strong>liakh-server</strong> (100.101.231.78:3456)</span>
            <button type="button" class="btn-accent-outline btn-sm" data-connect-ip="100.101.231.78:3456">Підключити</button>
          </div>
          <div class="lan-peer-item">
            <span>🌐 <strong>liakh-server.tail2f1f7e.ts.net</strong> (:3456)</span>
            <button type="button" class="btn-secondary btn-sm" data-connect-ip="liakh-server.tail2f1f7e.ts.net:3456">Підключити</button>
          </div>
        `;
        const discoveredHtml = (data.discoveredLanPeers || [])
          .map(p => `
            <div class="lan-peer-item">
              <span>🖥 <strong>${escapeHtml(p.hostname)}</strong> (${p.ip}:${p.port})</span>
              <button type="button" class="btn-secondary btn-sm" data-connect-ip="${p.ip}:${p.port}">З'єднати</button>
            </div>
          `)
          .join('');
        lanDiscoveredList.innerHTML = presetsHtml + discoveredHtml;
        lanDiscoveredList.querySelectorAll('[data-connect-ip]').forEach((b) => {
          b.addEventListener('click', () => connectPeerByAddress(b.dataset.connectIp));
        });
      }

      const mcpPreview = document.getElementById('mcp-config-preview');
      if (mcpPreview && data.mcpServerPath) {
        const mcpConfig = {
          mcpServers: {
            'to-doom': {
              command: 'node',
              args: [data.mcpServerPath]
            }
          }
        };
        mcpPreview.textContent = JSON.stringify(mcpConfig, null, 2);
      }
    } catch (_) {}
  }

  selectNetworkIp.addEventListener('change', () => {
    loadNetworkInfo(selectNetworkIp.value);
  });

  btnShare.addEventListener('click', () => {
    loadNetworkInfo();
    openModal('modal-share');
  });

  btnPeersBadge.addEventListener('click', () => {
    loadNetworkInfo();
    openModal('modal-share');
  });

  document.getElementById('btn-copy-url').addEventListener('click', () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(syncUrlInput.value);
      showToast('Посилання скопійовано!');
    }
  });

  async function connectPeerByAddress(addr) {
    if (!addr) return;
    let clean = addr.trim().replace(/^https?:\/\//, '').replace(/^ws:\/\//, '');
    if (!clean.includes(':')) clean = `${clean}:3456`;

    remotePcHost = clean;
    localStorage.setItem('todoom_pc_host', remotePcHost);

    if (isAndroidApk) {
      connectWebSocket();
      closeModal('modal-share');
      showToast(`Збережено адресу сервера: ${remotePcHost}`);
      return;
    }

    const res = await fetch('/api/connect-peer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerUrl: clean })
    }).then(r => r.json()).catch(() => ({ ok: false, error: 'Не вдалося з\'єднатися' }));
    if (res.ok) {
      showToast(`Підключено до ${res.peerUrl}`);
      closeModal('modal-share');
    } else {
      showToast(`Помилка: ${res.error}`);
    }
  }

  document.getElementById('btn-connect-peer').addEventListener('click', () => {
    const val = document.getElementById('input-peer-ip').value.trim();
    connectPeerByAddress(val);
  });

  // =========================================================
  // Settings, Per-Project AI Control, & GitHub Auto-Update
  // =========================================================
  const inputUserName = document.getElementById('input-user-name');
  const inputGithubRepo = document.getElementById('input-github-repo');
  const inputGithubBranch = document.getElementById('input-github-branch');
  const githubUpdateStatus = document.getElementById('github-update-status');
  const projectAiListEl = document.getElementById('project-ai-list');

  function renderSettingsProjectAiList() {
    if (!projectAiListEl) return;
    projectAiListEl.innerHTML = '';
    (boardState.projects || []).forEach((proj) => {
      const enabled = proj.agentEnabled !== false;
      const row = document.createElement('div');
      row.className = 'project-ai-row';

      const info = document.createElement('div');
      info.className = 'project-ai-info';
      info.innerHTML = `
        <span class="proj-dot" style="background:${proj.color || '#22c55e'}"></span>
        <strong>${escapeHtml(proj.name)}</strong>
        <span class="task-id-badge">${escapeHtml(proj.id)}</span>
      `;

      const act = document.createElement('div');
      act.className = 'project-ai-actions';

      const copyPromptBtn = document.createElement('button');
      copyPromptBtn.type = 'button';
      copyPromptBtn.className = 'btn-secondary btn-sm';
      copyPromptBtn.title = 'Скопіювати інструкцію для ШІ-агента саме під цей проєкт';
      copyPromptBtn.textContent = 'Підказка для ШІ';
      copyPromptBtn.addEventListener('click', () => {
        const promptText = `Використовуй MCP to-doom для керування задачами проєкту "${proj.name}" (project_id: "${proj.id}").`;
        if (navigator.clipboard) {
          navigator.clipboard.writeText(promptText);
          showToast(`Скопійовано інструкцію для проєкту «${proj.name}»!`);
        }
      });

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = enabled ? 'btn-accent-outline btn-sm' : 'btn-secondary btn-sm';
      toggleBtn.textContent = enabled ? '🤖 Дозволено' : '🔒 Вимкнено';
      toggleBtn.addEventListener('click', () => {
        sendAction('TOGGLE_PROJECT_AGENT', {
          projectId: proj.id,
          agentEnabled: !enabled
        });
        renderSettingsProjectAiList();
      });

      act.appendChild(copyPromptBtn);
      act.appendChild(toggleBtn);
      row.appendChild(info);
      row.appendChild(act);
      projectAiListEl.appendChild(row);
    });
  }

  function openSettingsModal() {
    inputUserName.value = currentUserName;
    const repo = (boardState.settings && boardState.settings.githubRepo) || localStorage.getItem('todoom_github_repo') || 'Archyange1/To-Doom';
    const branch = (boardState.settings && boardState.settings.githubBranch) || localStorage.getItem('todoom_github_branch') || 'main';
    inputGithubRepo.value = repo;
    inputGithubBranch.value = branch;
    renderSettingsProjectAiList();
    loadNetworkInfo();
    openModal('modal-settings');
  }

  btnSettings.addEventListener('click', openSettingsModal);
  if (btnUpdateHeader) {
    btnUpdateHeader.addEventListener('click', openSettingsModal);
  }

  document.getElementById('btn-save-github').addEventListener('click', () => {
    const repo = cleanGithubRepo(inputGithubRepo.value);
    const branch = inputGithubBranch.value.trim() || 'main';
    inputGithubRepo.value = repo;
    localStorage.setItem('todoom_github_repo', repo);
    localStorage.setItem('todoom_github_branch', branch);
    sendAction('UPDATE_SETTINGS', { githubRepo: repo, githubBranch: branch });
    showToast(repo ? `Збережено GitHub: ${repo} (${branch})` : 'Репозиторій очищено');
  });

  // Check for Updates on GitHub
  document.getElementById('btn-check-update').addEventListener('click', async () => {
    const repo = cleanGithubRepo(inputGithubRepo.value);
    const branch = inputGithubBranch.value.trim() || 'main';
    if (!repo || !repo.includes('/')) {
      showToast('Спочатку введіть власник/репозиторій GitHub');
      inputGithubRepo.focus();
      return;
    }

    localStorage.setItem('todoom_github_repo', repo);
    localStorage.setItem('todoom_github_branch', branch);
    sendAction('UPDATE_SETTINGS', { githubRepo: repo, githubBranch: branch });

    githubUpdateStatus.classList.remove('hidden');
    githubUpdateStatus.textContent = 'Перевірка оновлень на GitHub...';

    try {
      // Try server check first, or direct GitHub fetch if on standalone Android APK
      let data = null;
      if (!isAndroidApk) {
        const res = await fetch(`/api/update/check?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`);
        data = await res.json();
      } else {
        const pkgRes = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/package.json?t=${Date.now()}`);
        if (!pkgRes.ok) throw new Error(`HTTP ${pkgRes.status} — перевірте назву репозиторію або гілки`);
        const remotePkg = await pkgRes.json();
        data = {
          ok: true,
          repo,
          branch,
          localVersion: boardState.version || '1.2.1',
          remoteVersion: remotePkg.version || '1.2.1',
          hasUpdate: remotePkg.version !== (boardState.version || '1.2.1')
        };
      }

      if (!data.ok) {
        githubUpdateStatus.innerHTML = `<span style="color:#f87171">Помилка: ${escapeHtml(data.error)}</span>`;
        return;
      }

      const commitLine = data.latestCommit
        ? `<br/>Останній коміт: <code>${escapeHtml(data.latestCommit.sha)}</code> — ${escapeHtml(data.latestCommit.message)}`
        : '';
      const apkLine = data.apkReleaseUrl
        ? `<br/><a href="${escapeHtml(data.apkReleaseUrl)}" target="_blank" style="color:#38bdf8;text-decoration:underline;">Завантажити новий .apk з GitHub Releases</a>`
        : '';

      if (data.hasUpdate) {
        btnUpdateHeader.classList.add('has-update');
        githubUpdateStatus.innerHTML = `
          <strong style="color:#4ade80">Доступна нова версія v${escapeHtml(data.remoteVersion)}!</strong> (поточна: v${escapeHtml(data.localVersion)})
          ${commitLine}
          ${apkLine}
        `;
      } else {
        githubUpdateStatus.innerHTML = `
          <span>Встановлено актуальну версію <strong>v${escapeHtml(data.localVersion)}</strong> (GitHub: v${escapeHtml(data.remoteVersion)}). Ви все одно можете натиснути «Оновити з GitHub», щоб підтягнути останні файли.</span>
          ${commitLine}
          ${apkLine}
        `;
      }
    } catch (err) {
      githubUpdateStatus.innerHTML = `<span style="color:#f87171">Не вдалося перевірити: ${escapeHtml(err.message)}</span>`;
    }
  });

  // Apply Update from GitHub (Works on PC, Mini-Server, iPhone, and OTA on Android Tablet APK!)
  document.getElementById('btn-apply-update').addEventListener('click', async () => {
    const repo = cleanGithubRepo(inputGithubRepo.value);
    const branch = inputGithubBranch.value.trim() || 'main';
    if (!repo || !repo.includes('/')) {
      showToast('Спочатку введіть власник/репозиторій GitHub');
      inputGithubRepo.focus();
      return;
    }

    localStorage.setItem('todoom_github_repo', repo);
    localStorage.setItem('todoom_github_branch', branch);
    sendAction('UPDATE_SETTINGS', { githubRepo: repo, githubBranch: branch });

    githubUpdateStatus.classList.remove('hidden');
    githubUpdateStatus.textContent = 'Завантаження та встановлення оновлення з GitHub...';

    try {
      if (isAndroidApk && window.AndroidBridge && window.AndroidBridge.saveOtaFile) {
        // Direct Over-The-Air update inside the Android APK!
        const otaFiles = ['index.html', 'styles.css', 'app.js', 'icon.svg', 'manifest.json'];
        for (const fName of otaFiles) {
          const r = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/public/${fName}?t=${Date.now()}`);
          if (!r.ok) throw new Error(`Не вдалося завантажити public/${fName} (HTTP ${r.status})`);
          const text = await r.text();
          window.AndroidBridge.saveOtaFile(fName, text);
        }
        try {
          const pkgRes = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/package.json?t=${Date.now()}`);
          if (pkgRes.ok) {
            const pkg = await pkgRes.json();
            if (pkg.version) {
              boardState.version = pkg.version;
              saveOfflineState(false);
            }
          }
        } catch (_) {}

        githubUpdateStatus.innerHTML = `<strong style="color:#4ade80">Планшетний додаток успішно оновлено з GitHub! Перезавантаження...</strong>`;
        showToast('Оновлення встановлено! Перезавантаження...');
        setTimeout(() => window.AndroidBridge.reloadOta(), 800);
        return;
      }

      // Server / PC / Mini-Server update
      const res = await fetch(`${getApiBase()}/api/update/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo, branch })
      });
      const data = await res.json();
      if (!data.ok) {
        githubUpdateStatus.innerHTML = `<span style="color:#f87171">Помилка оновлення: ${escapeHtml(data.error)}</span>`;
        return;
      }

      githubUpdateStatus.innerHTML = `<strong style="color:#4ade80">Успішно оновлено до v${escapeHtml(data.version)}! Перезавантаження...</strong>`;
      showToast(`Оновлено до v${data.version}!`);
      setTimeout(() => location.reload(), 900);
    } catch (err) {
      githubUpdateStatus.innerHTML = `<span style="color:#f87171">Помилка: ${escapeHtml(err.message)}</span>`;
    }
  });

  document.getElementById('btn-save-username').addEventListener('click', () => {
    const val = inputUserName.value.trim();
    if (val) {
      currentUserName = val;
      localStorage.setItem('todoom_username', val);
      sendPresence({ name: currentUserName });
      showToast(`Ім'я змінено на «${currentUserName}»`);
    }
  });

  document.getElementById('btn-Copy-mcp').addEventListener('click', () => {
    const text = document.getElementById('mcp-config-preview').textContent;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text);
      showToast('Конфігурацію MCP скопійовано!');
    }
  });

  document.getElementById('btn-simulate-mcp').addEventListener('click', () => {
    const activeProj = (boardState.projects || []).find(p => p.id === boardState.activeProjectId);
    if (activeProj && activeProj.agentEnabled === false) {
      showToast(`🔒 Для проєкту «${activeProj.name}» керування ШІ вимкнено! Увімкніть перемикач ШІ.`);
      return;
    }
    const candidates = boardState.tasks.filter(
      t => !t.deleted && t.projectId === boardState.activeProjectId && t.column < 2
    );
    const target = candidates[0] || boardState.tasks.find(t => !t.deleted && t.projectId === boardState.activeProjectId);
    if (!target) {
      showToast('Спочатку додайте хоча б одну задачу');
      return;
    }
    closeModal('modal-settings');
    sendAction('UPDATE_TASK', {
      task_id: target.id,
      column: 2,
      progress: 100,
      assignee: 'Claude',
      actor: 'Claude'
    });
    showToast(`ШІ-агент оновив #${target.id} «${target.title}» → Виконано (100%)`);
  });

  // Trash Modal
  const trashListEl = document.getElementById('trash-list');
  function renderTrashModal() {
    const deleted = (boardState.tasks || []).filter(
      t => t.deleted && t.projectId === boardState.activeProjectId
    );
    if (deleted.length === 0) {
      trashListEl.innerHTML = `<div class="empty-col-placeholder">У кошику порожньо</div>`;
      return;
    }
    trashListEl.innerHTML = '';
    deleted.forEach((t) => {
      const row = document.createElement('div');
      row.className = 'trash-item';
      row.innerHTML = `
        <div>
          <span class="task-id-badge">#${t.id}</span>
          <strong style="margin-left:6px;">${escapeHtml(t.title)}</strong>
        </div>
      `;
      const restoreBtn = document.createElement('button');
      restoreBtn.className = 'btn-secondary btn-sm';
      restoreBtn.textContent = 'Відновити';
      restoreBtn.addEventListener('click', () => {
        sendAction('RESTORE_TASK', { id: t.id });
        setTimeout(renderTrashModal, 100);
      });
      row.appendChild(restoreBtn);
      trashListEl.appendChild(row);
    });
  }

  btnDeleted.addEventListener('click', () => {
    renderTrashModal();
    openModal('modal-trash');
  });

  document.getElementById('btn-empty-trash').addEventListener('click', () => {
    sendAction('EMPTY_TRASH', { projectId: boardState.activeProjectId });
    closeModal('modal-trash');
    showToast('Кошик очищено');
  });

  // Project Modal (with independent AI Agent checkbox)
  let selectedProjColor = '#22c55e';
  const editProjIdInput = document.getElementById('edit-project-id');
  const inputProjName = document.getElementById('input-project-name');
  const chkProjAgentEnabled = document.getElementById('chk-project-agent-enabled');
  const btnDeleteProj = document.getElementById('btn-delete-project');

  document.querySelectorAll('#project-color-picker .color-swatch').forEach((sw) => {
    sw.addEventListener('click', () => {
      selectedProjColor = sw.dataset.color;
      document.querySelectorAll('#project-color-picker .color-swatch').forEach(s => s.classList.toggle('selected', s === sw));
    });
  });

  function openProjectModal(proj = null) {
    if (proj) {
      document.getElementById('modal-project-title').textContent = 'Редагувати проєкт';
      editProjIdInput.value = proj.id;
      inputProjName.value = proj.name;
      selectedProjColor = proj.color || '#22c55e';
      if (chkProjAgentEnabled) chkProjAgentEnabled.checked = proj.agentEnabled !== false;
      btnDeleteProj.classList.toggle('hidden', boardState.projects.length <= 1);
    } else {
      document.getElementById('modal-project-title').textContent = 'Новий проєкт';
      editProjIdInput.value = '';
      inputProjName.value = '';
      selectedProjColor = '#22c55e';
      if (chkProjAgentEnabled) chkProjAgentEnabled.checked = true;
      btnDeleteProj.classList.add('hidden');
    }
    document.querySelectorAll('#project-color-picker .color-swatch').forEach(s => {
      s.classList.toggle('selected', s.dataset.color === selectedProjColor);
    });
    openModal('modal-project');
    setTimeout(() => inputProjName.focus(), 50);
  }

  btnNewProject.addEventListener('click', () => openProjectModal(null));

  document.getElementById('form-project').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = inputProjName.value.trim();
    if (!name) return;
    const editId = editProjIdInput.value;
    const agentEnabled = chkProjAgentEnabled ? chkProjAgentEnabled.checked : true;
    if (editId) {
      sendAction('UPDATE_PROJECT', { projectId: editId, name, color: selectedProjColor, agentEnabled });
    } else {
      sendAction('CREATE_PROJECT', { name, color: selectedProjColor, agentEnabled });
    }
    closeModal('modal-project');
  });

  btnDeleteProj.addEventListener('click', () => {
    const editId = editProjIdInput.value;
    if (editId) {
      sendAction('DELETE_PROJECT', { projectId: editId });
      closeModal('modal-project');
    }
  });

  // Task Edit Modal
  const editTaskId = document.getElementById('edit-task-id');
  const editTaskTitle = document.getElementById('edit-task-title');
  const editTaskEpic = document.getElementById('edit-task-epic');
  const editTaskAssignee = document.getElementById('edit-task-assignee');
  const editTaskColumn = document.getElementById('edit-task-column');
  const editTaskProgress = document.getElementById('edit-task-progress');
  const editTaskProgressVal = document.getElementById('edit-task-progress-val');

  editTaskProgress.addEventListener('input', () => {
    editTaskProgressVal.textContent = `${editTaskProgress.value}%`;
  });

  function openEditTaskModal(task) {
    document.getElementById('modal-task-heading').textContent = `Редагувати задачу #${task.id}`;
    editTaskId.value = String(task.id);
    editTaskTitle.value = task.title;
    editTaskEpic.value = task.epic || '';
    editTaskAssignee.value = task.assignee || 'Ви';
    editTaskColumn.value = String(task.column);
    editTaskProgress.value = String(task.progress);
    editTaskProgressVal.textContent = `${task.progress}%`;
    openModal('modal-edit-task');
  }

  document.getElementById('form-edit-task').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = Number(editTaskId.value);
    sendAction('UPDATE_TASK', {
      id,
      title: editTaskTitle.value.trim(),
      epic: editTaskEpic.value.trim(),
      assignee: editTaskAssignee.value.trim() || 'Ви',
      column: Number(editTaskColumn.value),
      progress: Number(editTaskProgress.value)
    });
    closeModal('modal-edit-task');
  });

  document.getElementById('btn-delete-task-modal').addEventListener('click', () => {
    const id = Number(editTaskId.value);
    sendAction('DELETE_TASK', { id });
    closeModal('modal-edit-task');
  });

  window.addEventListener('resize', updateProgressSummary);

  renderAll();
  connectWebSocket();
})();
