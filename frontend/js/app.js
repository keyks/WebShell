/**
 * WebTerminal 主应用 v2.4
 * ✅ 弹窗→抽屉（连接编辑、文件编辑器）
 * ✅ 顶部运维下拉菜单
 * ✅ 全局进度条
 * ✅ 命令面板 Ctrl+Shift+P
 * ✅ 复制连接
 * ✅ 打开终端到此路径
 * ✅ 私钥客户端预检
 * ✅ 实时字段校验
 * ✅ 分屏视图
 * ✅ 断线重连增强
 */

// ══════════════════════════════════════════
//  Dashboard 仪表盘控制器（在 App 之前定义，确保引用安全）
// ══════════════════════════════════════════
const Dashboard = {
    _refreshTimer: null,
    _uptimeTimer: null,
    _serverStartTime: null,
    _token: '',

    _getHeaders() {
        const t = localStorage.getItem('wt_token') || '';
        return { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' };
    },

    init() {
        this._token = localStorage.getItem('wt_token') || '';
        if (!this._token) return;
        this.refresh();
        this._startAutoRefresh();
    },

    stop() {
        if (this._refreshTimer) {
            clearInterval(this._refreshTimer);
            this._refreshTimer = null;
        }
        if (this._uptimeTimer) {
            clearInterval(this._uptimeTimer);
            this._uptimeTimer = null;
        }
    },

    _startAutoRefresh() {
        this.stop();
        this._refreshTimer = setInterval(() => this.refresh(), 30000); // 30秒刷新
    },

    _startUptimeTicker() {
        if (this._uptimeTimer) clearInterval(this._uptimeTimer);
        this._tickUptime(); // 立即刷新一次
        this._uptimeTimer = setInterval(() => this._tickUptime(), 1000);
    },

    _tickUptime() {
        if (!this._serverStartTime) return;
        const s = Math.floor((Date.now() - this._serverStartTime) / 1000);
        const d = Math.floor(s / 86400);
        const h = Math.floor((s % 86400) / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        this._setHTML('dashUptime', `${d}天 ${h}小时 ${m}分钟 ${sec}秒`);
    },

    async refresh() {
        if (!this._token) {
            this._token = localStorage.getItem('wt_token') || '';
            if (!this._token) return;
        }
        try {
            // 统计数据
            await this._loadStats();
            // 最近连接
            await this._loadRecentConns();
            // 告警摘要
            await this.loadAlerts();
            // 审计日志
            await this.loadAuditLogs();
            // 系统信息
            await this._loadSysInfo();
        } catch (e) {
            console.error('Dashboard refresh error:', e);
        }
    },

    async _loadStats() {
        try {
            const res = await fetch('/api/connections', { headers: this._getHeaders() });
            if (!res.ok) return;
            const data = await res.json();
            // 🔧 修复：明确检查 API 返回状态，避免掩盖错误
            if (data.status !== 'ok') return;
            const conns = data.data || [];
            const total = Array.isArray(conns) ? conns.length : 0;
            const activeCount = typeof App !== 'undefined' && App.activeSession ? 1 :
                (typeof App !== 'undefined' && App.sessions ? Object.keys(App.sessions).length : 0);
            const groups = typeof App !== 'undefined' && Array.isArray(App.groups) ? App.groups.length : 0;

            this._setText('dashTotalNodes', total);
            this._setText('dashOnlineSessions', activeCount);
            this._setText('dashGroupCount', groups);

            // 未处理告警
            try {
                const alertRes = await fetch('/api/alerts', { headers: this._getHeaders() });
                if (alertRes.ok) {
                    const alertData = await alertRes.json();
                    if (alertData.status === 'ok') {
                        const alerts = alertData.data || [];
                        const unread = Array.isArray(alerts) ? alerts.filter(a => !a.read).length : 0;
                        this._setText('dashAlertCount', unread);
                    }
                }
            } catch (e) { /* ignore */ }
        } catch (e) { /* ignore */ }
    },

    async _loadRecentConns() {
        const el = document.getElementById('dashRecentConns');
        if (!el) return;
        try {
            const res = await fetch('/api/connections', { headers: this._getHeaders() });
            if (!res.ok) { el.innerHTML = '<div style="padding:16px;color:var(--text-secondary);">加载失败</div>'; return; }
            const data = await res.json();
            // 🔧 修复：明确检查 API 返回状态
            if (data.status !== 'ok') { el.innerHTML = '<div style="padding:16px;color:var(--text-secondary);">加载失败</div>'; return; }
            const conns = data.data || [];
            const list = Array.isArray(conns) ? conns.slice(0, 5) : [];
            if (list.length === 0) {
                el.innerHTML = '<div style="padding:16px;color:var(--text-secondary);text-align:center;">暂无连接</div>';
                return;
            }
            el.innerHTML = list.map(c => `
                <div class="dash-conn-row" ondblclick="typeof App!=='undefined' && App.openConnection('${c.id}')"
                     style="display:flex;align-items:center;gap:10px;padding:10px 16px;cursor:pointer;
                            border-bottom:1px solid var(--border-color);transition:background 0.15s;"
                     onmouseenter="this.style.background='var(--bg-tertiary)'"
                     onmouseleave="this.style.background=''">
                    <span style="width:8px;height:8px;border-radius:50%;background:${c.color || '#00b894'};flex-shrink:0;"></span>
                    <span style="flex:1;font-weight:500;color:var(--text-bright);font-size:13px;">${c.name || c.host}</span>
                    <span style="color:var(--text-secondary);font-size:11px;">${c.host}:${c.port || 22}</span>
                </div>
            `).join('');
        } catch (e) {
            el.innerHTML = '<div style="padding:16px;color:var(--text-secondary);">加载失败</div>';
        }
    },

    async loadAuditLogs() {
        const el = document.getElementById('dashAuditLogs');
        if (!el) return;
        try {
            const res = await fetch('/api/audit-logs?limit=10', { headers: this._getHeaders() });
            if (!res.ok) { el.innerHTML = '<div style="padding:16px;color:var(--text-secondary);">暂无记录</div>'; return; }
            const data = await res.json();
            // 🔧 修复：明确检查 API 返回状态
            if (data.status !== 'ok') { el.innerHTML = '<div style="padding:16px;color:var(--text-secondary);">暂无记录</div>'; return; }
            const logs = data.data || [];
            const list = Array.isArray(logs) ? logs.slice(0, 10) : [];
            if (list.length === 0) {
                el.innerHTML = '<div style="padding:16px;color:var(--text-secondary);text-align:center;">暂无操作记录</div>';
                return;
            }
            el.innerHTML = list.map(l => {
                const action = l.action || l.operation || '操作';
                const user = l.user || l.username || '--';
                const ts = l.created_at || l.timestamp || l.time || '';
                const time = ts ? new Date(ts).toLocaleString('zh-CN') : '--';
                return `<div style="display:flex;justify-content:space-between;align-items:center;
                              padding:8px 16px;border-bottom:1px solid var(--border-color);font-size:12px;">
                    <span style="color:var(--text-bright);">${action}</span>
                    <span style="color:var(--text-secondary);">${user} · ${time}</span>
                </div>`;
            }).join('');
        } catch (e) {
            el.innerHTML = '<div style="padding:16px;color:var(--text-secondary);">加载失败</div>';
        }
    },

    async loadAlerts() {
        const el = document.getElementById('dashAlertList');
        if (!el) return;
        try {
            const res = await fetch('/api/alerts', { headers: this._getHeaders() });
            if (!res.ok) { el.innerHTML = '<div style="padding:16px;color:var(--text-secondary);">暂无告警</div>'; return; }
            const data = await res.json();
            // 🔧 修复：明确检查 API 返回状态
            if (data.status !== 'ok') { el.innerHTML = '<div style="padding:16px;color:var(--text-secondary);">暂无告警</div>'; return; }
            const alerts = data.data || [];
            const list = Array.isArray(alerts) ? alerts.slice(0, 5) : [];
            if (list.length === 0) {
                el.innerHTML = '<div style="padding:16px;color:var(--success-color);text-align:center;"><i class="fas fa-check-circle"></i> 暂无告警</div>';
                return;
            }
            el.innerHTML = list.map(a => {
                const level = a.level || a.severity || 'info';
                const colors = { critical: 'var(--danger-color)', warning: 'var(--warning-color)', info: 'var(--accent-color)' };
                const color = colors[level] || colors.info;
                const msg = a.message || a.title || a.msg || '告警';
                const ts = a.timestamp || a.created_at || a.time || '';
                const time = ts ? new Date(ts).toLocaleString('zh-CN') : '--';
                return `<div style="display:flex;align-items:center;gap:8px;padding:8px 16px;
                              border-bottom:1px solid var(--border-color);font-size:12px;">
                    <span style="width:6px;height:6px;border-radius:50%;background:${color};flex-shrink:0;"></span>
                    <span style="flex:1;color:var(--text-bright);">${msg}</span>
                    <span style="color:var(--text-secondary);font-size:11px;">${time}</span>
                </div>`;
            }).join('');
        } catch (e) {
            el.innerHTML = '<div style="padding:16px;color:var(--text-secondary);">加载失败</div>';
        }
    },

    async _loadSysInfo() {
        try {
            // 服务器运行时间
            const res = await fetch('/api/status', { headers: this._getHeaders() });
            if (res.ok) {
                const data = await res.json();
                if (data.status === 'ok') {
                    const status = data.data || data;
                    if (status.uptime) {
                        // 反推服务器启动时间，启动每秒自增（无需重复请求 API）
                        this._serverStartTime = Date.now() - Math.floor(status.uptime) * 1000;
                        this._startUptimeTicker();
                    } else {
                        this._setHTML('dashUptime', '--');
                        this._serverStartTime = null;
                    }
                    // AI 状态
                    if (typeof status.ai_ready !== 'undefined') {
                        this._setHTML('dashAiStatus',
                            status.ai_ready
                                ? '<i class="fas fa-check-circle" style="color:var(--success-color);"></i> 就绪'
                                : '<i class="fas fa-times-circle" style="color:var(--danger-color);"></i> 未配置');
                    } else {
                        this._setHTML('dashAiStatus', '<i class="fas fa-question-circle" style="color:var(--text-secondary);"></i> 未知');
                    }
                }
            }
        } catch (e) { /* ignore */ }

        // 当前用户
        const user = localStorage.getItem('wt_username') || '--';
        this._setText('dashCurrentUser', user);

        // 时间
        this._setText('dashboardTime', new Date().toLocaleString('zh-CN', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        }));
    },

    _setText(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    },
    _setHTML(id, html) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = html;
    },

    openInspection() {
        const sid = (typeof App !== 'undefined') ? App.activeSession : null;
        if (!sid) { App.toast('请先打开一个终端会话', 'warning'); return; }
        if (typeof AIDiagnose !== 'undefined') AIDiagnose.open(sid);
    },
    openAlerts() {
        if (typeof App !== 'undefined') App.showAlerts();
    }
};

window.Dashboard = Dashboard;

const App = {
    socket: null,
    connections: [],
    groups: [],
    sessions: {},
    activeSession: null,
    authType: 'password',
    quickAuthType: 'password',
    theme: localStorage.getItem('wt_theme') || 'dark',
    _token: localStorage.getItem('wt_token') || '',
    _quickHistory: [],
    _beforeUnloadHandler: null,
    _splitSessions: {},   // sessionId → { secondary: sessionId }
    _cpItems: [],         // 命令面板条目缓存
    _cpActiveIdx: -1,
    _socketListeners: [], // 存储 socket.on 注册的监听器引用，用于清理
    _distributeTasks: {}, // 🔧 文件分发任务状态持久化: taskId → { status, total, completed, results }
    _editingConnHasPassword: false, // 🔧 编辑连接时记录原是否有密码
    _editingConnHasKey: false,      // 🔧 编辑连接时记录原是否有私钥
    _activePanelTab: {},   // 🆕 面板 Tab 状态持久化: sessionId → tabName
    _DEBUG: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1',

    // 🔧 调试日志封装
    _debugLog(...args) {
        if (this._DEBUG) {
            console.log('[DEBUG]', ...args);
        }
    },

    // ══════════════════════════════
    //  认证头
    // ══════════════════════════════
    authHeaders() {
        const h = { 'Content-Type': 'application/json' };
        if (this._token) h['Authorization'] = `Bearer ${this._token}`;
        return h;
    },

    // ══════════════════════════════
    //  初始化
    // ══════════════════════════════
    async init() {
        this.applyTheme(this.theme);

        // 检查是否已登录
        if (!this._token) {
            this.initSocket();
            // 显示未登录状态的连接列表
            document.getElementById('connectionList').innerHTML = `
                <div style="text-align:center;padding:40px 20px;color:var(--text-secondary);">
                    <i class="fas fa-lock" style="font-size:32px;display:block;margin-bottom:12px;opacity:0.4;"></i>
                    <p style="font-size:13px;">请登录后管理连接</p>
                    <button class="btn btn-primary btn-sm" onclick="App.showSettings()"
                            style="margin-top:12px;">
                        <i class="fas fa-sign-in-alt"></i> 登录
                    </button>
                </div>`;
            this.initSidebarResize();
            this.initKeyboardShortcuts();
            this.initDragDrop();
            this.bindModalEnterKeys();
            this.initCommandPalette();
            this.initSearchBar();
            window.addEventListener('resize', () => {
                if (this.activeSession) this._fitAndSync(this.activeSession);
            });
            this._beforeUnloadHandler = () => {
                if (typeof recoveryManager !== 'undefined') {
                    recoveryManager.saveSessionState();
                }
            };
            window.addEventListener('beforeunload', this._beforeUnloadHandler);
            // 自动弹出登录弹窗
            setTimeout(() => this.showSettings(), 500);
            return;
        }

        this.initSocket();

        if (typeof alertManager !== 'undefined') {
            alertManager.bindSocket(this.socket);
            alertManager.requestNotificationPermission();
        }

        await Promise.all([
            this.loadConnections(),
            this.loadGroups(),
            this.loadQuickHistory(),
            CommandManager.load ? CommandManager.load() : Promise.resolve(),
        ]);

        this.initSidebarResize();
        this.initKeyboardShortcuts();
        this.initDragDrop();
        this.bindModalEnterKeys();
        this.initCommandPalette();
        this.initSearchBar();

        // 点击外部关闭运维菜单
        document.addEventListener('click', (e) => {
            const dd = document.getElementById('opsDropdown');
            if (dd && !dd.contains(e.target)) dd.classList.remove('open');
        });

        window.addEventListener('resize', () => {
            if (this.activeSession) this._fitAndSync(this.activeSession);
        });

        this._beforeUnloadHandler = () => {
            if (typeof recoveryManager !== 'undefined') {
                recoveryManager.saveSessionState();
            }
        };
        window.addEventListener('beforeunload', this._beforeUnloadHandler);

        setTimeout(() => {
            if (typeof recoveryManager !== 'undefined') recoveryManager.init();
        }, 1000);

        // 初始化仪表盘
        window.Dashboard?.init();

        // 启动功能介绍展示页（屏保模式）
        setTimeout(() => window.FeaturePage?.init(), 100);
    },

    // ══════════════════════════════
    //  运维下拉菜单
    // ══════════════════════════════
    toggleOpsMenu() {
        document.getElementById('opsDropdown')?.classList.toggle('open');
    },
    closeOpsMenu() {
        document.getElementById('opsDropdown')?.classList.remove('open');
    },

    // ══════════════════════════════
    //  全局进度条
    // ══════════════════════════════
    showGlobalProgress(indeterminate = true) {
        const el = document.getElementById('globalProgress');
        const bar = document.getElementById('globalProgressBar');
        if (!el || !bar) return;
        if (indeterminate) {
            el.classList.add('indeterminate');
            bar.style.width = '';
        } else {
            el.classList.remove('indeterminate');
            bar.style.width = '0%';
        }
    },

    updateGlobalProgress(pct) {
        const el = document.getElementById('globalProgress');
        const bar = document.getElementById('globalProgressBar');
        if (!el || !bar) return;
        el.classList.remove('indeterminate');
        bar.style.width = Math.min(100, Math.max(0, pct)) + '%';
    },

    hideGlobalProgress() {
        const bar = document.getElementById('globalProgressBar');
        if (bar) {
            bar.style.width = '100%';
            setTimeout(() => {
                bar.style.width = '0%';
                document.getElementById('globalProgress')?.classList.remove('indeterminate');
            }, 300);
        }
    },

    // ══════════════════════════════
    //  Socket.IO
    // ══════════════════════════════
    initSocket() {
        // 🔧 先清理之前的监听器
        this._cleanupSocketListeners();

        this.socket = io(window.location.origin, {
            transports: ['websocket', 'polling'],
            auth: (cb) => cb({ token: localStorage.getItem('wt_token') || this._token || '' }),
            reconnection: true,
            reconnectionAttempts: 10,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            perMessageDeflate: true,  // WebSocket 压缩，终端文本压缩率极高
        });

        const L = this._socketListeners;

        const onConnect = () => {
            this._debugLog('WebSocket 已连接');
            console.info('[WS] 已连接');
            // 通知恢复管理器重连完成
            if (typeof recoveryManager !== 'undefined') {
                recoveryManager.onReconnect();
            }
        };
        this.socket.on('connect', onConnect);
        L.push({ event: 'connect', fn: onConnect });

        const onDisconnect = (reason) => {
            this._debugLog('WebSocket 已断开:', reason);
            console.warn('[WS] 已断开:', reason);
            if (typeof recoveryManager !== 'undefined') {
                recoveryManager.onDisconnect(reason);
            }
        };
        this.socket.on('disconnect', onDisconnect);
        L.push({ event: 'disconnect', fn: onDisconnect });

        const onConnectError = (err) => {
            this._debugLog('WebSocket 连接错误:', err.message);
            console.error('[WS] 连接错误:', err.message);
            if (err.message?.includes('未授权')) {
                this.toast('认证已过期，请重新登录', 'error');
                this._handleAuthExpired();
            }
        };
        this.socket.on('connect_error', onConnectError);
        L.push({ event: 'connect_error', fn: onConnectError });

        const onTerminalConnected = ({ session_id }) => {
            const overlay = document.querySelector(`#panel-${session_id} .connecting-overlay`);
            if (overlay) overlay.remove();
            // 移除重连遮罩
            document.querySelector(`#panel-${session_id} .reconnecting-overlay`)?.remove();
            // 🔧 移除断开连接遮罩
            document.getElementById(`terminal-${session_id}`)?.querySelector('.terminal-disconnected-mask')?.remove();
            // 显示终端和工具栏
            App._showTermToolbar(session_id);
            const s = this.sessions[session_id];
            if (s) this.toast(`已连接到 ${s.connName}`, 'success');
            this.hideGlobalProgress();
            this.updateActiveSessionCount();
            // ✅ 后端会话就绪后启动监控（避免过早调用导致 404）
            if (typeof Monitor !== 'undefined') Monitor.start(session_id);
            // ✅ 会话就绪后检查 AI 状态（此时 DOM 已完全就绪）
            setTimeout(() => this.checkAIStatus(session_id, 0), 500);
        };
        this.socket.on('terminal_connected', onTerminalConnected);
        L.push({ event: 'terminal_connected', fn: onTerminalConnected });

        const onTerminalOutput = ({ data, session_id }) => {
            if (typeof terminalManager !== 'undefined') {
                terminalManager.write(session_id, data);
            }
        };
        this.socket.on('terminal_output', onTerminalOutput);
        L.push({ event: 'terminal_output', fn: onTerminalOutput });

        const onTerminalError = ({ message, session_id }) => {
            this.hideGlobalProgress();
            const overlay = document.querySelector(`#panel-${session_id} .connecting-overlay`);
            if (overlay) {
                const html = this.escapeHtml(message || '未知错误')
                    .replace(/\n/g, '<br>').replace(/ {2}/g, '&nbsp;&nbsp;');
                overlay.innerHTML = `
                    <i class="fas fa-exclamation-triangle"
                       style="font-size:48px;color:var(--danger-color);margin-bottom:16px"></i>
                    <div style="color:var(--danger-color);font-size:15px;font-weight:600;margin-bottom:8px">
                        连接失败
                    </div>
                    <div style="color:var(--text-secondary);font-size:13px;
                                max-width:480px;text-align:left;line-height:1.8;
                                padding:16px;background:var(--bg-tertiary);
                                border-radius:8px;margin-bottom:16px">${html}</div>
                    <div style="display:flex;gap:8px">
                        <button class="btn btn-primary"
                                onclick="App.retrySession('${session_id}')">
                            <i class="fas fa-redo"></i> 重试
                        </button>
                        <button class="btn" onclick="App.closeSession('${session_id}')">
                            <i class="fas fa-times"></i> 关闭
                        </button>
                    </div>`;
            } else {
                // 终端已连接后的运行时错误（包括安全拦截、命令发送失败等）
                const s = this.sessions[session_id];
                const name = s ? s.connName : session_id;
                // 🔧 安全拦截消息使用更长的显示时间
                const isSecurityBlock = message && (message.includes('安全策略拦截') || message.includes('安全审计'));
                this.toast(`[${name}] ${message || '连接失败'}`, 'error', isSecurityBlock ? 8000 : 4000);
            }
        };
        this.socket.on('terminal_error', onTerminalError);
        L.push({ event: 'terminal_error', fn: onTerminalError });

        const onTerminalClosed = ({ session_id, reason }) => {
            console.info('[WS] 终端已关闭:', session_id, reason);
            // 🔧 修复：终端断开后显示错误指示，避免用户输入命令无反应
            const termDiv = document.getElementById(`terminal-${session_id}`);
            if (termDiv) {
                // 添加半透明遮罩提示用户
                let mask = termDiv.querySelector('.terminal-disconnected-mask');
                if (!mask) {
                    mask = document.createElement('div');
                    mask.className = 'terminal-disconnected-mask';
                    mask.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;' +
                        'background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;' +
                        'z-index:10;border-radius:8px;';
                    mask.innerHTML = `
                        <div style="text-align:center;color:#fff;">
                            <i class="fas fa-plug" style="font-size:36px;display:block;margin-bottom:12px;opacity:0.7;"></i>
                            <p style="font-size:14px;margin:0 0 4px;font-weight:600;">SSH 连接已断开</p>
                            <p style="font-size:12px;opacity:0.6;margin:0 0 16px;">${this.escapeHtml(reason || '会话异常关闭')}</p>
                            <button class="btn btn-primary btn-sm" onclick="App.retrySession('${session_id}')"
                                style="padding:6px 20px;">
                                <i class="fas fa-redo"></i> 重新连接
                            </button>
                        </div>`;
                    termDiv.style.position = termDiv.style.position || 'relative';
                    termDiv.appendChild(mask);
                }
            }
            this.toast('SSH 连接已断开', 'warning');
        };
        this.socket.on('terminal_closed', onTerminalClosed);
        L.push({ event: 'terminal_closed', fn: onTerminalClosed });

        // 🔧 监听后端命令确认请求（high 级别命令需要二次确认）
        const onCommandRequiresConfirmation = (payload) => {
            // 使用自定义安全确认弹窗，替代浏览器原生 confirm()
            this._showSecurityConfirm(payload);
        };
        this.socket.on('command_requires_confirmation', onCommandRequiresConfirmation);
        L.push({ event: 'command_requires_confirmation', fn: onCommandRequiresConfirmation });

        // 🔧 监听中危命令提醒（不阻止执行，仅提醒）
        const onCommandMediumRisk = ({ command, risk_level, description, suggestion, message }) => {
            this.toast(message, 'warning', 6000);
            // 同时在通知中心记录（已由 toast 自动处理）
            console.warn('[Security] 中危命令已执行:', command, risk_level);
        };
        this.socket.on('command_medium_risk', onCommandMediumRisk);
        L.push({ event: 'command_medium_risk', fn: onCommandMediumRisk });
    },

    /**
     * 🔧 清理所有已注册的 Socket 监听器
     */
    _cleanupSocketListeners() {
        if (!this.socket) {
            this._socketListeners = [];
            return;
        }
        for (const { event, fn } of this._socketListeners) {
            try { this.socket.off(event, fn); } catch (_) {}
        }
        this._socketListeners = [];
    },

    _handleAuthExpired() {
        this._token = '';
        localStorage.removeItem('wt_token');
        this.toast('请先登录', 'warning', 2000);
        setTimeout(() => { this.showSettings(); }, 800);
    },

    // ══════════════════════════════
    //  设置 / 登录
    // ══════════════════════════════
    showSettings() {
        const token = this._token || localStorage.getItem('wt_token') || '';
        const loggedIn = !!token;
        document.getElementById('settingsLoginSection').style.display = loggedIn ? 'none' : 'block';
        document.getElementById('settingsLoggedInSection').style.display = loggedIn ? 'block' : 'none';
        if (loggedIn) {
            document.getElementById('settingsUsername').textContent = 'admin';
            this._loadAiConfig();
        }
        document.getElementById('loginError').style.display = 'none';
        document.getElementById('loginUsername').value = '';
        document.getElementById('loginPassword').value = '';
        this.openModal('settingsModal');
        if (!loggedIn) {
            setTimeout(() => document.getElementById('loginUsername').focus(), 200);
        }
    },

    async _loadAiConfig() {
        try {
            const r = await fetch('/api/ai/config', { headers: this.authHeaders() });
            const d = await r.json();
            if (d.status === 'ok') {
                const cfg = d.data;
                document.getElementById('settingsAiBaseUrl').value = cfg.base_url || '';
                // 使用后端返回的掩码 Key（如 gsk_abc****xyz），方便用户确认是否正确
                document.getElementById('settingsAiApiKey').value = cfg.api_key || (cfg.has_key ? '••••••••' : '');
                document.getElementById('settingsAiModel').value = cfg.model || '';
                // 存储实际 key 状态
                this._aiKeyMasked = cfg.has_key;
                this._aiKeyOriginal = '';
                // 显示生效信息
                if (d.effective) {
                    const statusEl = document.getElementById('settingsAiStatus');
                    statusEl.style.color = d.effective.ready ? 'var(--success-color)' : 'var(--text-secondary)';
                    statusEl.textContent = d.effective.ready
                        ? `当前使用：${d.effective.model || '默认模型'}`
                        : 'AI 未启用，请配置后保存';
                }
            }
        } catch (e) {
            console.error('加载 AI 配置失败:', e);
        }
    },

    toggleApiKeyVisibility() {
        const input = document.getElementById('settingsAiApiKey');
        const eye = document.getElementById('settingsAiKeyEye');
        if (input.type === 'password') {
            input.type = 'text';
            eye.className = 'fas fa-eye-slash';
            // 如果当前是掩码值，清空让用户输入新 Key（安全考虑不展示完整 Key）
            if (this._isMaskedKey(input.value) && input.value !== '') {
                input.value = '';
                input.placeholder = '输入新的 API Key 替换';
            }
        } else {
            input.type = 'password';
            eye.className = 'fas fa-eye';
        }
    },

    // 判断输入值是否为掩码（含 ****），掩码值不发送给后端
    _isMaskedKey(val) {
        return !val || val === '••••••••' || val.includes('****');
    },

    async saveAiConfig() {
        const baseUrl = document.getElementById('settingsAiBaseUrl').value.trim();
        const apiKeyEl = document.getElementById('settingsAiApiKey');
        const apiKey = apiKeyEl.value.trim();
        const model = document.getElementById('settingsAiModel').value.trim();
        const statusEl = document.getElementById('settingsAiStatus');

        // 构建请求体：如果 key 是掩码值则不发送（保留原有值）
        const body = {};
        if (baseUrl) body.base_url = baseUrl;
        if (model) body.model = model;
        if (!this._isMaskedKey(apiKey)) {
            body.api_key = apiKey;
        }

        if (!baseUrl && !model && this._isMaskedKey(apiKey)) {
            statusEl.style.color = 'var(--warning-color)';
            statusEl.textContent = '请至少填写一项配置';
            return;
        }

        statusEl.style.color = 'var(--text-secondary)';
        statusEl.textContent = '保存中...';

        try {
            const r = await fetch('/api/ai/config', {
                method: 'POST',
                headers: this.authHeaders(),
                body: JSON.stringify(body),
            });
            const d = await r.json();
            if (d.status === 'ok') {
                statusEl.style.color = 'var(--success-color)';
                statusEl.textContent = '✅ AI 配置已保存';
                // 保存成功后刷新配置（后端返回掩码 Key）
                setTimeout(() => this._loadAiConfig(), 500);
            } else {
                statusEl.style.color = 'var(--danger-color)';
                statusEl.textContent = '保存失败: ' + (d.message || '未知错误');
            }
        } catch (e) {
            statusEl.style.color = 'var(--danger-color)';
            statusEl.textContent = '保存失败: ' + e.message;
        }
    },

    async testAiConnection() {
        const statusEl = document.getElementById('settingsAiStatus');
        statusEl.style.color = 'var(--text-secondary)';
        statusEl.textContent = '⏳ 测试连接中...';

        try {
            const r = await fetch('/api/ai/config/test', {
                method: 'POST',
                headers: this.authHeaders(),
            });
            const d = await r.json();
            if (d.status === 'ok') {
                statusEl.style.color = 'var(--success-color)';
                statusEl.textContent = '✅ ' + d.message;
            } else {
                statusEl.style.color = 'var(--danger-color)';
                statusEl.textContent = '❌ ' + d.message;
            }
        } catch (e) {
            statusEl.style.color = 'var(--danger-color)';
            statusEl.textContent = '❌ 测试失败: ' + e.message;
        }
    },

    async doLogin() {
        const username = document.getElementById('loginUsername').value.trim();
        const password = document.getElementById('loginPassword').value;
        const errEl = document.getElementById('loginError');
        const btn = document.getElementById('loginBtn');

        if (!username || !password) {
            errEl.textContent = '请输入用户名和密码';
            errEl.style.display = 'block';
            return;
        }

        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 登录中...';
        errEl.style.display = 'none';

        try {
            const r = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const d = await r.json();
            if (d.status === 'ok') {
                this._token = d.token;
                localStorage.setItem('wt_token', d.token);
                this.toast(`欢迎，${d.username}`, 'success');
                this.closeModal('settingsModal');
                // 重新初始化 WebSocket 和数据
                this.initSocket();
                await Promise.all([
                    this.loadConnections(),
                    this.loadGroups(),
                    this.loadQuickHistory(),
                    CommandManager.load ? CommandManager.load() : Promise.resolve(),
                ]);
                this.renderConnectionList();
            } else {
                errEl.textContent = d.message || '登录失败';
                errEl.style.display = 'block';
            }
        } catch (e) {
            errEl.textContent = '网络错误: ' + e.message;
            errEl.style.display = 'block';
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> 登录';
        }
    },

    doLogout() {
        this._token = '';
        localStorage.removeItem('wt_token');
        this.toast('已退出登录', 'info');
        this.closeModal('settingsModal');
        // 断开 WebSocket
        if (this.socket) {
            this.socket.disconnect();
        }
        // 清空数据
        this.connections = [];
        this.groups = [];
        this._quickHistory = [];
        this.renderConnectionList();
        document.getElementById('connectionList').innerHTML = `
            <div style="text-align:center;padding:40px 20px;color:var(--text-secondary);">
                <i class="fas fa-lock" style="font-size:32px;display:block;margin-bottom:12px;opacity:0.4;"></i>
                <p style="font-size:13px;">请登录后查看连接</p>
                <button class="btn btn-primary btn-sm" onclick="App.showSettings()"
                        style="margin-top:12px;">
                    <i class="fas fa-sign-in-alt"></i> 登录
                </button>
            </div>`;
    },

    // ══════════════════════════════
    //  数据加载
    // ══════════════════════════════
    async loadConnections() {
        try {
            const r = await fetch('/api/connections', { headers: this.authHeaders() });
            const d = await r.json();
            if (d.status === 'ok') {
                this.connections = d.data;
                this.renderConnectionList();
            }
        } catch (e) { console.error('加载连接失败:', e); }
    },

    async loadGroups() {
        try {
            const r = await fetch('/api/groups', { headers: this.authHeaders() });
            const d = await r.json();
            if (d.status === 'ok') {
                this.groups = d.data;
                this.renderConnectionList();
                this.updateGroupSelect();
            }
        } catch (e) { console.error('加载分组失败:', e); }
    },

    async loadQuickHistory() {
        try {
            const r = await fetch('/api/quick-history', { headers: this.authHeaders() });
            const d = await r.json();
            if (d.status === 'ok') {
                this._quickHistory = d.data;
                this.renderQuickHistory();
            }
        } catch (e) { console.error('加载历史失败:', e); }
    },

    // ══════════════════════════════
    //  连接列表渲染
    // ══════════════════════════════
    renderConnectionList() {
        const container = document.getElementById('connectionList');
        if (!container) return;
        const q = (document.getElementById('searchInput')?.value || '').toLowerCase();

        const grouped = { '': [] };
        this.groups.forEach(g => { grouped[g.id] = []; });

        this.connections.forEach(c => {
            if (q) {
                const hit = [c.name, c.host, c.description || '']
                    .some(s => s.toLowerCase().includes(q));
                if (!hit) return;
            }
            const gid = c.group_id || '';
            if (!grouped[gid]) grouped[gid] = [];
            grouped[gid].push(c);
        });

        let html = '';
        if (grouped[''].length > 0 || !q) {
            html += this._renderGroup('', '默认分组', grouped[''] || []);
        }
        this.groups.forEach(g => {
            if ((grouped[g.id] || []).length > 0 || !q) {
                html += this._renderGroup(g.id, g.name, grouped[g.id] || []);
            }
        });

        if (!html) {
            html = `<div style="padding:40px;text-align:center;color:var(--text-secondary)">
                <i class="fas fa-search" style="font-size:32px;display:block;margin-bottom:12px"></i>
                无匹配结果
            </div>`;
        }
        container.innerHTML = html;

        // 🆕 更新侧边栏底部连接计数
        const connCount = document.getElementById('connCount');
        if (connCount) {
            const total = Array.isArray(this.connections) ? this.connections.length : 0;
            connCount.innerHTML = `<i class="fas fa-server"></i> ${total} 个连接`;
        }
    },

    _renderGroup(gid, name, connections) {
        const isDefault = gid === '';
        let html = `
            <div class="conn-group">
                <div class="conn-group-header"
                     onclick="this.classList.toggle('collapsed');
                              this.nextElementSibling.style.display=
                              this.classList.contains('collapsed')?'none':'block'">
                    <i class="fas fa-chevron-down"></i>
                    ${this.escapeHtml(name)}
                    <span class="group-count">${connections.length}</span>
                    ${!isDefault ? `
                    <div class="group-actions" onclick="event.stopPropagation()">
                        <button class="btn btn-icon" title="删除分组"
                                onclick="App.deleteGroup('${gid}')">
                            <i class="fas fa-trash"
                               style="font-size:10px;color:var(--danger-color)"></i>
                        </button>
                    </div>` : ''}
                </div>
                <div class="conn-group-items">`;

        if (connections.length === 0) {
            html += `<div style="padding:8px 12px;font-size:12px;
                                 color:var(--text-secondary);text-align:center">
                        双击连接打开终端
                     </div>`;
        }

        connections.forEach(c => {
            const connected = Object.values(this.sessions).some(s => s.connId === c.id);
            // 最近连接时间
            const lastConn = c.last_connected
                ? (() => {
                    const diff = Date.now() - new Date(c.last_connected).getTime();
                    const h = Math.floor(diff / 3600000);
                    const d = Math.floor(diff / 86400000);
                    if (d > 0) return `${d}天前`;
                    if (h > 0) return `${h}小时前`;
                    return '刚刚';
                  })()
                : null;

            html += `
                <div class="conn-item ${connected ? 'active' : ''}"
                     ondblclick="App.openConnection('${c.id}')"
                     oncontextmenu="event.preventDefault();App._showConnContextMenu(event,'${c.id}')"
                     title="${this.escapeHtml(c.username)}@${this.escapeHtml(c.host)}:${c.port}${c.description ? '\n' + this.escapeHtml(c.description) : ''}">
                    <div class="conn-indicator" style="background:${connected ? 'var(--success-color)' : (c.color || '#00b894')};
                            ${connected ? 'box-shadow:0 0 6px var(--success-color);' : ''}">
                    </div>
                    <i class="fas fa-server conn-icon"></i>
                    <div class="conn-info">
                        <div class="conn-name">${this.escapeHtml(c.name || c.host)}</div>
                        <div class="conn-host">${c.username}@${c.host}:${c.port}</div>
                    </div>
                    <!-- 连接状态标签 -->
                    <div style="display:flex;flex-direction:column;align-items:flex-end;
                                gap:2px;flex-shrink:0;margin-right:4px;">
                        ${connected
                            ? `<span style="font-size:9px;padding:1px 5px;border-radius:6px;
                                            background:rgba(102,187,106,0.15);color:var(--success-color);
                                            font-weight:600;">已连接</span>`
                            : ''}
                        ${lastConn && !connected
                            ? `<span style="font-size:9px;color:var(--text-secondary);">${lastConn}</span>`
                            : ''}
                    </div>
                    <div class="conn-actions">
                        <button class="btn btn-icon btn-sm" title="连接"
                                onclick="event.stopPropagation();App.openConnection('${c.id}')">
                            <i class="fas fa-plug" style="font-size:11px;color:var(--success-color)"></i>
                        </button>
                        <button class="btn btn-icon btn-sm" title="编辑"
                                onclick="event.stopPropagation();App.editConnection('${c.id}')">
                            <i class="fas fa-pen" style="font-size:11px"></i>
                        </button>
                        <button class="btn btn-icon btn-sm" title="复制连接"
                                onclick="event.stopPropagation();App.duplicateConnection('${c.id}')">
                            <i class="fas fa-copy" style="font-size:11px;color:var(--accent-color)"></i>
                        </button>
                        <button class="btn btn-icon btn-sm" title="删除"
                                onclick="event.stopPropagation();App.confirmDeleteConnection('${c.id}','${this.escapeHtml(c.name)}')">
                            <i class="fas fa-trash" style="font-size:11px;color:var(--danger-color)"></i>
                        </button>
                    </div>
                </div>`;
        });

        html += `</div></div>`;
        return html;
    },

    filterConnections() { this.renderConnectionList(); },

    // ══════════════════════════════
    //  连接右键上下文菜单
    // ══════════════════════════════
    _showConnContextMenu(event, connId) {
        document.getElementById('connContextMenu')?.remove();

        const conn = this.connections.find(c => c.id === connId);
        if (!conn) return;

        const menu = document.createElement('div');
        menu.id = 'connContextMenu';
        menu.style.cssText = `
            position: fixed;
            top: ${Math.min(event.clientY, window.innerHeight - 320)}px;
            left: ${Math.min(event.clientX, window.innerWidth - 200)}px;
            z-index: 9999;
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.4);
            padding: 4px;
            min-width: 180px;
            font-size: 13px;
        `;

        const items = [
            { icon:'fa-plug', label:'打开终端',
              color:'var(--success-color)',
              action:() => this.openConnection(connId) },
            { divider:true },
            { icon:'fa-folder-open', label:'文件管理器',
              action:() => { this.openConnection(connId);
                setTimeout(() => { const sid = Object.keys(this.sessions).find(s => this.sessions[s].connId === connId);
                  if (sid) this.switchPanelTab(sid, 'files'); }, 2000); } },
            { icon:'fa-chart-bar', label:'系统监控',
              action:() => { this.openConnection(connId);
                setTimeout(() => { const sid = Object.keys(this.sessions).find(s => this.sessions[s].connId === connId);
                  if (sid) this.switchPanelTab(sid, 'monitor'); }, 2000); } },
            { icon:'fa-stethoscope', label:'AI 诊断',
              action:() => { this.openConnection(connId);
                setTimeout(() => { const sid = Object.keys(this.sessions).find(s => this.sessions[s].connId === connId);
                  if (sid) this.switchPanelTab(sid, 'ai-diagnose'); }, 2000); } },
            { divider:true },
            { icon:'fa-pen', label:'编辑连接',
              action:() => this.editConnection(connId) },
            { icon:'fa-copy', label:'复制连接', color:'var(--accent-color)',
              action:() => this.duplicateConnection(connId) },
            { icon:'fa-clipboard', label:'复制 SSH 命令',
              action:() => { const cmd = `ssh ${conn.username}@${conn.host} -p ${conn.port}`;
                navigator.clipboard.writeText(cmd); this.toast(`已复制: ${cmd}`, 'success'); } },
            { divider:true },
            { icon:'fa-wifi', label:'测试连通性',
              action:async () => { this.toast(`测试 ${conn.host}:${conn.port} ...`, 'info');
                const r = await fetch('/api/test-connection', { method:'POST', headers:this.authHeaders(),
                  body:JSON.stringify({ host:conn.host, port:conn.port }) });
                const d = await r.json();
                this.toast(d.message, d.status==='ok'?'success':'error'); } },
            { divider:true },
            { icon:'fa-trash', label:'删除连接', color:'var(--danger-color)',
              action:() => this.confirmDeleteConnection(connId, conn.name) },
        ];

        items.forEach(item => {
            if (item.divider) {
                const hr = document.createElement('div');
                hr.style.cssText = 'height:1px;background:var(--border-color);margin:3px 0;';
                menu.appendChild(hr);
                return;
            }
            const el = document.createElement('div');
            el.style.cssText = `
                display:flex;align-items:center;gap:10px;
                padding:7px 12px;border-radius:6px;cursor:pointer;
                color:${item.color||'var(--text-primary)'};
                transition:background 0.15s;
            `;
            el.innerHTML = `<i class="fas ${item.icon}" style="width:14px;text-align:center;font-size:12px;"></i>${this.escapeHtml(item.label)}`;
            el.onmouseenter = () => el.style.background = 'var(--bg-hover)';
            el.onmouseleave = () => el.style.background = 'transparent';
            el.onclick = () => { menu.remove(); item.action(); };
            menu.appendChild(el);
        });

        document.body.appendChild(menu);
        const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); } };
        setTimeout(() => document.addEventListener('click', close), 0);
    },

    // ══════════════════════════════
    //  复制连接
    // ══════════════════════════════
    async duplicateConnection(connId) {
        try {
            const r = await fetch(`/api/connections/${connId}`, { headers: this.authHeaders() });
            const d = await r.json();
            if (d.status !== 'ok') return;
            const c = d.data;
            const newConn = {
                name:                  `${c.name || c.host} (副本)`,
                host:                  c.host,
                port:                  c.port,
                username:              c.username,
                password:              c.password || '',
                private_key:           c.private_key || '',
                color:                 c.color || '#00b894',
                description:           c.description || '',
                group_id:              c.group_id || '',
            };
            const res = await fetch('/api/connections', {
                method: 'POST',
                headers: this.authHeaders(),
                body: JSON.stringify(newConn),
            });
            const data = await res.json();
            if (data.status === 'ok') {
                this.toast(`已复制连接「${newConn.name}」`, 'success');
                this.loadConnections();
            }
        } catch (e) {
            this.toast('复制失败: ' + e.message, 'error');
        }
    },

    // ══════════════════════════════
    //  快速连接历史
    // ══════════════════════════════
    renderQuickHistory() {
        const container = document.getElementById('quickHistoryList');
        if (!container) return;
        if (!this._quickHistory?.length) {
            container.innerHTML = `
                <div style="padding:12px;text-align:center;color:var(--text-secondary);font-size:12px">
                    暂无历史记录
                </div>`;
            return;
        }
        container.innerHTML = this._quickHistory.map(h => `
            <div class="quick-hist-item" onclick="App.fillQuickConnect('${h.id}')">
                <div class="qh-info">
                    <div class="qh-host">
                        <i class="fas fa-history" style="color:var(--accent-color)"></i>
                        ${this.escapeHtml(h.username)}@${this.escapeHtml(h.host)}:${h.port}
                    </div>
                    <div class="qh-time">
                        ${h.last_used ? h.last_used.split('T')[0] : ''} · 使用 ${h.use_count} 次
                    </div>
                </div>
                <button class="btn btn-icon btn-sm" title="删除"
                        onclick="event.stopPropagation();App.deleteQuickHistory('${h.id}')">
                    <i class="fas fa-times" style="font-size:10px"></i>
                </button>
            </div>
        `).join('');
    },

    fillQuickConnect(historyId) {
        const h = this._quickHistory.find(x => x.id === historyId);
        if (!h) return;
        document.getElementById('quickHost').value     = h.host;
        document.getElementById('quickPort').value     = h.port;
        document.getElementById('quickUsername').value = h.username;
        document.getElementById('quickPassword').value = '';
        this.setQuickAuthType('password');
        document.getElementById('quickPassword')?.focus();
    },

    async deleteQuickHistory(id) {
        await fetch(`/api/quick-history/${id}`, {
            method: 'DELETE', headers: this.authHeaders()
        });
        this._quickHistory = this._quickHistory.filter(h => h.id !== id);
        this.renderQuickHistory();
    },

    async clearQuickHistory() {
        this.confirm('确定清空所有历史记录吗？', async () => {
            await fetch('/api/quick-history/clear', {
                method: 'POST', headers: this.authHeaders()
            });
            this._quickHistory = [];
            this.renderQuickHistory();
            this.toast('历史记录已清空', 'success');
        });
    },

    // ══════════════════════════════
    //  认证方式切换
    // ══════════════════════════════
    setAuthType(type) {
        this.authType = type;
        document.getElementById('authBtnPassword')?.classList.toggle('active', type === 'password');
        document.getElementById('authBtnKey')?.classList.toggle('active', type === 'key');
        document.getElementById('passwordGroup')?.classList.toggle('hidden', type !== 'password');
        document.getElementById('keyGroup')?.classList.toggle('hidden', type !== 'key');
    },

    setQuickAuthType(type) {
        this.quickAuthType = type;
        document.getElementById('quickAuthBtnPwd')?.classList.toggle('active', type === 'password');
        document.getElementById('quickAuthBtnKey')?.classList.toggle('active', type === 'key');
        document.getElementById('quickPasswordGroup')?.classList.toggle('hidden', type !== 'password');
        document.getElementById('quickKeyGroup')?.classList.toggle('hidden', type !== 'key');
    },

    togglePasswordVisibility(inputId) {
        const el = document.getElementById(inputId);
        if (!el) return;
        el.type = el.type === 'password' ? 'text' : 'password';
        const btn = el.nextElementSibling;
        if (btn) btn.innerHTML = `<i class="fas fa-eye${el.type === 'text' ? '-slash' : ''}"></i>`;
    },

    // ══════════════════════════════
    //  实时校验
    // ══════════════════════════════
    validateConnHost(input) {
        const hint = document.getElementById('connHostHint');
        if (!hint) return;
        const val = input.value.trim();
        if (!val) {
            input.className = input.className.replace(/\binput-(ok|error)\b/g, '').trim();
            hint.textContent = '';
            hint.className = 'field-hint hint-neutral';
            return;
        }
        // 简单格式检查：IP 或 hostname
        const ipRe = /^(\d{1,3}\.){3}\d{1,3}$/;
        const hostRe = /^[a-zA-Z0-9]([a-zA-Z0-9\-\.]{0,253}[a-zA-Z0-9])?$/;
        const valid = ipRe.test(val) || hostRe.test(val);
        input.classList.remove('input-ok', 'input-error');
        input.classList.add(valid ? 'input-ok' : 'input-error');
        hint.textContent = valid ? '格式正确' : '请输入有效的 IP 或主机名';
        hint.className = `field-hint ${valid ? 'hint-ok' : 'hint-error'}`;
    },

    validatePrivateKey(textarea, hintId) {
        const hint = document.getElementById(hintId);
        if (!hint) return;
        const val = textarea.value.trim();
        if (!val) {
            hint.textContent = '支持 RSA、Ed25519、ECDSA、DSS 格式私钥';
            hint.className = 'field-hint hint-neutral';
            textarea.classList.remove('input-ok', 'input-error');
            return;
        }
        const valid = val.startsWith('-----BEGIN') && val.includes('PRIVATE KEY');
        textarea.classList.remove('input-ok', 'input-error');
        textarea.classList.add(valid ? 'input-ok' : 'input-error');
        hint.textContent = valid ? '私钥格式正确' : '私钥格式有误，应以 -----BEGIN ... PRIVATE KEY----- 开头';
        hint.className = `field-hint ${valid ? 'hint-ok' : 'hint-error'}`;
    },

    // ══════════════════════════════
    //  连接操作
    // ══════════════════════════════
    async openConnection(connId) {
        const conn = this.connections.find(c => c.id === connId);
        if (!conn) { this.toast('连接不存在', 'error'); return; }

        this._debugLog('OpenConnection:', { connId, connName: conn.name, host: conn.host, hasPassword: conn.has_password, hasKey: conn.has_key });

        const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        this.sessions[sessionId] = {
            connId,
            connName: conn.name || conn.host,
            color: conn.color || '#00b894',
        };

        this.showGlobalProgress(true);
        this._createSessionUI(sessionId);
        this.socket.emit('open_terminal', { conn_id: connId, session_id: sessionId });
        this.renderConnectionList();
    },

    showQuickConnect() {
        ['quickHost', 'quickPassword', 'quickPrivateKey'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        document.getElementById('quickPort').value     = '22';
        document.getElementById('quickUsername').value = 'root';
        const cb = document.getElementById('quickSaveHistory');
        if (cb) cb.checked = true;
        this.setQuickAuthType('password');
        this.openModal('quickConnectModal');
        this.renderQuickHistory();
        setTimeout(() => document.getElementById('quickHost')?.focus(), 120);
    },

    quickConnect() {
        const host     = document.getElementById('quickHost').value.trim();
        const port     = parseInt(document.getElementById('quickPort').value) || 22;
        const username = document.getElementById('quickUsername').value.trim() || 'root';
        const save     = document.getElementById('quickSaveHistory')?.checked !== false;

        if (!host) { this.toast('请输入主机地址', 'warning'); return; }

        let password = '', privateKey = '';
        if (this.quickAuthType === 'password') {
            // ✅ 密码不做 trim()，SSH 密码可能包含特殊字符
            password = document.getElementById('quickPassword').value;
            if (!password) { this.toast('请输入密码', 'warning'); return; }
            this._debugLog('[QuickConnect] 密码长度(原始):', password.length);
        } else {
            privateKey = document.getElementById('quickPrivateKey').value.trim();
            if (!privateKey) { this.toast('请粘贴私钥内容', 'warning'); return; }
            // 客户端预检
            if (!privateKey.startsWith('-----BEGIN') || !privateKey.includes('PRIVATE KEY')) {
                this.toast('私钥格式有误，请检查', 'error');
                return;
            }
        }

        // 🔧 调试日志
        this._debugLog('QuickConnect:', {
            host, port, username,
            passwordLength: password.length,
            privateKeyLength: privateKey.length,
            authType: this.quickAuthType,
        });

        const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        this.sessions[sessionId] = {
            connId: null,
            connName: `${username}@${host}`,
            color: '#ff9800',
            quickConnInfo: { host, port, username, password, privateKey },  // password 为原始值
        };

        this.showGlobalProgress(true);
        this._createSessionUI(sessionId);
        this.closeModal('quickConnectModal');
        this.socket.emit('quick_connect', {
            session_id:   sessionId,
            host,
            port,
            username,
            password:     password,     // ✅ 原始密码，未经 trim
            private_key:  privateKey,
            save_history: save,
        });

        setTimeout(() => this.loadQuickHistory(), 2000);
    },

    async testQuickConnection() {
        const host = document.getElementById('quickHost').value.trim();
        const port = parseInt(document.getElementById('quickPort').value) || 22;
        if (!host) { this.toast('请输入主机地址', 'warning'); return; }
        const btn  = document.getElementById('testConnBtn');
        const orig = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 测试中...';
        btn.disabled  = true;
        try {
            const r = await fetch('/api/test-connection', {
                method: 'POST', headers: this.authHeaders(),
                body: JSON.stringify({ host, port })
            });
            const d = await r.json();
            this.toast(d.status === 'ok' ? `✅ ${d.message}` : `❌ ${d.message}`,
                       d.status === 'ok' ? 'success' : 'error');
        } catch (e) {
            this.toast('测试失败: ' + e.message, 'error');
        } finally {
            btn.innerHTML = orig;
            btn.disabled  = false;
        }
    },

    async testConnectionFromForm() {
        const host = document.getElementById('connHost').value.trim();
        const port = parseInt(document.getElementById('connPort').value) || 22;
        if (!host) { this.toast('请输入主机地址', 'warning'); return; }
        const btn  = document.getElementById('testConnFormBtn');
        const orig = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 测试中...';
        btn.disabled  = true;
        try {
            const r = await fetch('/api/test-connection', {
                method: 'POST', headers: this.authHeaders(),
                body: JSON.stringify({ host, port })
            });
            const d = await r.json();
            this.toast(d.status === 'ok' ? `✅ ${d.message}` : `❌ ${d.message}`,
                       d.status === 'ok' ? 'success' : 'error');
        } catch (e) {
            this.toast('测试失败: ' + e.message, 'error');
        } finally {
            btn.innerHTML = orig;
            btn.disabled  = false;
        }
    },

    retrySession(sessionId) {
        const session = this.sessions[sessionId];
        if (!session) return;

        this._debugLog('RetrySession:', { sessionId, connName: session.connName, hasConnId: !!session.connId, hasQuickInfo: !!session.quickConnInfo });

        const overlay = document.querySelector(`#panel-${sessionId} .connecting-overlay`);
        if (overlay) {
            overlay.innerHTML = `
                <div class="connecting-spinner"></div>
                <p>正在重新连接到 ${this.escapeHtml(session.connName)}...</p>`;
        }

        this.showGlobalProgress(true);
        this.socket.emit('close_terminal', { session_id: sessionId });
        if (typeof terminalManager !== 'undefined') terminalManager.destroy(sessionId);
        // 🔧 清理断开连接遮罩（如果有）
        document.getElementById(`terminal-${sessionId}`)?.querySelector('.terminal-disconnected-mask')?.remove();

        const termContainer = document.getElementById(`terminal-${sessionId}`);
        if (termContainer && typeof terminalManager !== 'undefined') {
            const term = terminalManager.create(sessionId, termContainer);
            // 🔧 Ctrl+C 选中复制 / Ctrl+V 粘贴
            term.attachCustomKeyEventHandler((e) => {
                if (e.ctrlKey && !e.shiftKey && e.key === 'c' && term.hasSelection()) {
                    // 防抖：300ms 内不重复处理（修复 xterm keydown+keypress 双事件触发）
                    const now = Date.now();
                    if (this._lastCtrlC && now - this._lastCtrlC < 300) return false;
                    this._lastCtrlC = now;
                    const sel = term.getSelection();
                    if (sel) {
                        navigator.clipboard.writeText(sel).then(() => {
                            this.toast('已复制', 'success');
                        }).catch(() => {
                            this.toast('复制失败，请用工具栏按钮', 'warning');
                        });
                    }
                    return false;
                }
                if (e.ctrlKey && !e.shiftKey && e.key === 'v') {
                    navigator.clipboard.readText().then(text => {
                        if (text && this.socket) {
                            this.socket.emit('terminal_input', { session_id: sessionId, data: text });
                        }
                    }).catch(() => {});
                    return false;
                }
                return true;
            });
            // 🔧 右键菜单
            term.element?.addEventListener('contextmenu', (e) => {
                if (term.hasSelection()) {
                    e.preventDefault();
                    const sel = term.getSelection();
                    if (sel) {
                        navigator.clipboard.writeText(sel).then(() => {
                            this.toast('已复制', 'success');
                        }).catch(() => {});
                    }
                } else {
                    e.preventDefault();
                    navigator.clipboard.readText().then(text => {
                        if (text && this.socket) {
                            this.socket.emit('terminal_input', { session_id: sessionId, data: text });
                            this.toast('已粘贴', 'info');
                        }
                    }).catch(() => {});
                }
            });
            // 🔧 高危命令实时监测：逐字符缓冲，回车前调用后端 API 分析风险
            if (!this._termBuffers) this._termBuffers = {};
            this._termBuffers[sessionId] = '';

            term.onData(data => {
                const cleaned = data.replace(/\r\n/g, '\r').replace(/\n/g, '\r');

                // ── Enter 键：检查缓冲命令行风险 ──
                if (cleaned === '\r') {
                    const cmd = (this._termBuffers[sessionId] || '').trim();
                    this._termBuffers[sessionId] = '';
                    if (cmd && this._isCommandPotentiallyRisky(cmd)) {
                        this._checkTerminalRisk(sessionId, cmd);
                        return; // 暂不发送 \r，等待用户确认
                    }
                    this.socket.emit('terminal_input', { session_id: sessionId, data: '\r' });
                    return;
                }

                // ── Ctrl+C：清空缓冲区 ──
                if (cleaned === '\x03') {
                    this._termBuffers[sessionId] = '';
                    this.socket.emit('terminal_input', { session_id: sessionId, data: '\x03' });
                    return;
                }

                // ── 退格键：删除缓冲区最后一个字符 ──
                if (cleaned === '\x7f' || cleaned === '\b') {
                    const buf = this._termBuffers[sessionId] || '';
                    this._termBuffers[sessionId] = buf.slice(0, -1);
                    this.socket.emit('terminal_input', { session_id: sessionId, data: cleaned });
                    return;
                }

                // ── 可打印 ASCII 单字符：添加到缓冲区 ──
                if (cleaned.length === 1) {
                    const code = cleaned.charCodeAt(0);
                    if (code >= 0x20 && code <= 0x7E) {
                        this._termBuffers[sessionId] = (this._termBuffers[sessionId] || '') + cleaned;
                    }
                }
                // 其他控制字符 / 转义序列 / 粘贴：不修改缓冲区，直接发送

                this.socket.emit('terminal_input', { session_id: sessionId, data: cleaned });
            });
            term.onResize(s => {
                this.socket.emit('terminal_resize', { session_id: sessionId, ...s });
            });
        }

        if (session.connId) {
            this.socket.emit('open_terminal', { conn_id: session.connId, session_id: sessionId });
        } else if (session.quickConnInfo) {
            const info = session.quickConnInfo;
            this.socket.emit('quick_connect', {
                session_id:  sessionId,
                host:        info.host,
                port:        info.port,
                username:    info.username,
                password:    info.password || '',
                private_key: info.privateKey || '',
                save_history: false,
            });
        } else {
            this.hideGlobalProgress();
            if (overlay) {
                overlay.innerHTML = `
                    <i class="fas fa-info-circle"
                       style="font-size:48px;color:var(--accent-color);margin-bottom:16px"></i>
                    <p>无法自动重试，请关闭后重新连接</p>
                    <button class="btn" onclick="App.closeSession('${sessionId}')"
                            style="margin-top:16px">
                        <i class="fas fa-times"></i> 关闭
                    </button>`;
            }
        }
    },

    // ══════════════════════════════
    //  分屏视图
    // ══════════════════════════════
    toggleSplitView(sessionId) {
        const existing = this._splitSessions[sessionId];
        if (existing) {
            // 关闭分屏：移除副屏
            this.closeSession(existing.secondary);
            delete this._splitSessions[sessionId];
            // 恢复主面板正常布局
            const panel = document.getElementById(`panel-${sessionId}`);
            if (panel) {
                panel.style.position = '';
                panel.style.width    = '';
            }
            setTimeout(() => this._fitAndSync(sessionId), 100);
            this.toast('分屏已关闭', 'info');
            return;
        }

        // 检查是否有可用会话
        const otherSessions = Object.keys(this.sessions).filter(id => id !== sessionId);
        if (otherSessions.length === 0) {
            this.toast('请先打开第二个会话以使用分屏', 'warning');
            return;
        }

        // 选择第二个会话（取最后打开的）
        const secondaryId = otherSessions[otherSessions.length - 1];
        this._splitSessions[sessionId] = { secondary: secondaryId };

        // 构建分屏容器
        const container = document.getElementById('panelsContainer');
        const primaryPanel   = document.getElementById(`panel-${sessionId}`);
        const secondaryPanel = document.getElementById(`panel-${secondaryId}`);

        if (!primaryPanel || !secondaryPanel) return;

        // 隐藏所有其他面板
        container.querySelectorAll('.panel').forEach(p => { p.style.display = 'none'; });

        // 创建分屏包装容器
        let splitWrap = document.getElementById('splitViewWrap');
        if (splitWrap) splitWrap.remove();

        splitWrap = document.createElement('div');
        splitWrap.id = 'splitViewWrap';
        splitWrap.className = 'split-view';
        splitWrap.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;';

        const pane1 = document.createElement('div');
        pane1.className = 'split-pane';

        const handle = document.createElement('div');
        handle.className = 'resize-handle';

        const pane2 = document.createElement('div');
        pane2.className = 'split-pane';

        // 将面板移入分屏格
        primaryPanel.style.position   = 'relative';
        primaryPanel.style.display    = 'flex';
        secondaryPanel.style.position = 'relative';
        secondaryPanel.style.display  = 'flex';

        pane1.appendChild(primaryPanel);
        pane2.appendChild(secondaryPanel);
        splitWrap.appendChild(pane1);
        splitWrap.appendChild(handle);
        splitWrap.appendChild(pane2);
        container.appendChild(splitWrap);

        // 拖拽分割线
        this._initSplitResize(handle, pane1, pane2, sessionId, secondaryId);

        setTimeout(() => {
            this._fitAndSync(sessionId);
            this._fitAndSync(secondaryId);
        }, 80);

        this.toast(`分屏：${this.sessions[sessionId].connName} | ${this.sessions[secondaryId].connName}`, 'success');
    },

    _initSplitResize(handle, pane1, pane2, id1, id2) {
        let dragging = false, startX = 0, startW = 0;
        handle.addEventListener('mousedown', e => {
            dragging = true;
            startX   = e.clientX;
            startW   = pane1.offsetWidth;
            handle.classList.add('dragging');
            document.body.style.cursor    = 'col-resize';
            document.body.style.userSelect = 'none';
        });
        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            const total = pane1.parentElement.offsetWidth;
            const newW  = Math.min(total - 200, Math.max(200, startW + (e.clientX - startX)));
            pane1.style.flex = 'none';
            pane1.style.width = newW + 'px';
            pane2.style.flex  = '1';
        });
        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('dragging');
            document.body.style.cursor    = '';
            document.body.style.userSelect = '';
            this._fitAndSync(id1);
            this._fitAndSync(id2);
        });
    },

    _closeSplitView() {
        const wrap = document.getElementById('splitViewWrap');
        if (!wrap) return;
        const container = document.getElementById('panelsContainer');
        // 把面板移回容器
        wrap.querySelectorAll('.panel').forEach(p => {
            p.style.position = '';
            p.style.display  = '';
            container.appendChild(p);
        });
        wrap.remove();
    },

    // ══════════════════════════════
    //  打开终端到指定路径
    // ══════════════════════════════
    openTerminalAtPath(sessionId, path) {
        const panel = document.getElementById(`panel-${sessionId}`);
        if (!panel) return;
        // 切换到终端 tab
        const termTab = panel.querySelector('.panel-tab[data-tab="terminal"]');
        if (termTab) this.switchPanelTab(sessionId, 'terminal', termTab);
        // 执行 cd 命令
        setTimeout(() => {
            const escaped = path.replace(/"/g, '\\"');
            this.socket.emit('terminal_input', {
                session_id: sessionId,
                data: `cd "${escaped}"\r`,
            });
            if (typeof terminalManager !== 'undefined') {
                terminalManager.focus(sessionId);
            }
        }, 80);
    },

    // ══════════════════════════════
    //  会话切换
    // ══════════════════════════════
    switchSession(sessionId) {
        // ✅ 不再在 switchSession 中启动/停止 Monitor — 改为生命周期驱动：
        //    - 启动：terminal_connected 事件（后端会话已就绪）
        //    - 停止：closeSession / Monitor.destroy（会话关闭时）
        //    避免 switchSession 过早调用导致 /api/monitor 404
        this.activeSession = sessionId;

        // ✅ 修复：隐藏欢迎页和 FeaturePage（无论何时切换会话）
        document.getElementById('welcomePage').style.display = 'none';
        const fp = document.getElementById('featurePage');
        if (fp) fp.style.display = 'none';

        document.querySelectorAll('.tab-item').forEach(t => t.classList.remove('active'));
        document.getElementById(`tab-${sessionId}`)?.classList.add('active');

        // 如果处于分屏状态，不改变面板显示
        if (!document.getElementById('splitViewWrap')) {
            document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
            document.getElementById(`panel-${sessionId}`)?.classList.add('active');
        }

        // 🆕 切换会话时更新全局智能助手悬浮窗
        const globalFloat = document.getElementById('globalAIFloat');
        if (globalFloat && typeof AIAssistant !== 'undefined') {
            AIAssistant.currentSessionId = sessionId;
            // 更新悬浮窗内容为新会话的聊天面板
            const content = document.getElementById('globalAIFloatContent');
            if (content && AIAssistant._renderChatPanel) {
                if (!AIAssistant._initialized.has(sessionId)) {
                    AIAssistant.init(sessionId);
                }
                content.innerHTML = AIAssistant._renderChatPanel(sessionId);
                AIAssistant._bindChatEvents(sessionId, content);
            }
        }

        setTimeout(() => {
            this._fitAndSync(sessionId);
            if (typeof terminalManager !== 'undefined') terminalManager.focus(sessionId);
        }, 50);
    },

    _fitAndSync(sessionId) {
        if (typeof terminalManager === 'undefined') return;
        const size = terminalManager.fit(sessionId);
        if (size) this.socket.emit('terminal_resize', { session_id: sessionId, ...size });
    },

    closeSession(sessionId) {
        if (typeof Monitor !== 'undefined') Monitor.destroy(sessionId);
        if (typeof AIAssistant !== 'undefined') AIAssistant.destroy(sessionId);
        this.socket.emit('close_terminal', { session_id: sessionId });
        if (typeof terminalManager !== 'undefined') terminalManager.destroy(sessionId);
        if (typeof FileManager !== 'undefined') FileManager.clearState(sessionId);
        // 🔧 清理该会话的悬浮模式状态
        if (typeof AIAssistant !== 'undefined' && AIAssistant._floatingMode) {
            AIAssistant._floatingMode[sessionId] = false;
        }
        // 🔧 清理终端输入缓冲区
        if (this._termBuffers && this._termBuffers[sessionId]) {
            delete this._termBuffers[sessionId];
        }

        // 如果是分屏主屏，先关闭分屏
        if (this._splitSessions[sessionId]) {
            this._closeSplitView();
            delete this._splitSessions[sessionId];
        }
        // 如果是分屏副屏，清理引用
        for (const [primary, info] of Object.entries(this._splitSessions)) {
            if (info.secondary === sessionId) {
                this._closeSplitView();
                delete this._splitSessions[primary];
            }
        }

        document.getElementById(`tab-${sessionId}`)?.remove();
        document.getElementById(`panel-${sessionId}`)?.remove();
        delete this.sessions[sessionId];

        if (typeof recoveryManager !== 'undefined') {
            recoveryManager._clearSavedSession(sessionId);
        }

        const remaining = Object.keys(this.sessions);
        if (remaining.length > 0) {
            this.switchSession(remaining[remaining.length - 1]);
        } else {
            this.activeSession = null;
            document.getElementById('tabBar').classList.remove('visible');
            document.getElementById('panelsContainer').classList.remove('visible');
            document.getElementById('welcomePage').style.display = 'flex';
            window.Dashboard?.init();
            window.FeaturePage?.onAllSessionsClosed();
        }

        this.updateActiveSessionCount();
        this.renderConnectionList();
    },

    updateActiveSessionCount() {
        const count = Object.keys(this.sessions).length;
        const el = document.getElementById('activeSessionCount');
        if (el) el.textContent = count;
        // 🆕 同步更新 session-count 包装器的 title（窗口缩小时 hover 可见）
        const wrap = document.getElementById('sessionCountWrap');
        if (wrap) wrap.title = `活跃会话: ${count}`;
        // 🆕 同步更新侧边栏底部连接计数
        const connCount = document.getElementById('connCount');
        if (connCount) {
            const total = Array.isArray(this.connections) ? this.connections.length : 0;
            connCount.innerHTML = `<i class="fas fa-server"></i> ${total} 个连接`;
        }
    },

    // ══════════════════════════════
    //  抽屉：连接编辑
    // ══════════════════════════════
    _openConnDrawer() {
        this._connDrawerOpen = true;
        document.getElementById('connDrawerOverlay')?.classList.add('visible');
        document.getElementById('connDrawer')?.classList.add('open');
        setTimeout(() => document.getElementById('connHost')?.focus(), 200);
    },

    closeConnDrawer() {
        this._connDrawerOpen = false;
        document.getElementById('connDrawerOverlay')?.classList.remove('visible');
        document.getElementById('connDrawer')?.classList.remove('open');
    },

    showAddConnection() {
        document.getElementById('connDrawerTitle').innerHTML =
            '<i class="fas fa-plus"></i> 新建连接';
        ['connEditId', 'connName', 'connHost', 'connPassword',
         'connPrivateKey', 'connDescription'].forEach(id => {
            const el = document.getElementById(id);
            if (el) { el.value = ''; el.setAttribute('autocomplete', 'new-password'); }
        });
        // 清除校验状态
        ['connHost', 'connPrivateKey'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.remove('input-ok', 'input-error');
        });
        ['connHostHint', 'connKeyHint'].forEach(id => {
            const el = document.getElementById(id);
            if (el) { el.textContent = ''; el.className = 'field-hint hint-neutral'; }
        });
        document.getElementById('connPort').value     = '22';
        document.getElementById('connUsername').value = 'root';
        document.getElementById('connColor').value    = '#00b894';
        this.updateGroupSelect();
        document.getElementById('connGroup').value = '';
        this.setAuthType('password');
        this._openConnDrawer();

        // 🔧 对抗浏览器密码自动填充：Chrome/Edge 会忽略 autocomplete="off"，
        //     在抽屉打开后异步清除密码字段，确保用户看到的是空输入框
        const pwdEl = document.getElementById('connPassword');
        if (pwdEl) {
            // 多次延迟清除，覆盖浏览器异步填充的时机
            [50, 150, 300, 500].forEach(delay => {
                setTimeout(() => {
                    if (!this._connDrawerOpen) return;
                    // 仅在用户尚未手动输入时清除（避免误清用户已输入的内容）
                    const v = pwdEl.value;
                    if (v && v.length <= 1) {
                        console.log('[AntiAutofill] 清除自动填充的密码 (len=' + v.length + '):', v);
                        pwdEl.value = '';
                    }
                }, delay);
            });
        }
    },

    async editConnection(connId) {
        try {
            const r = await fetch(`/api/connections/${connId}`, { headers: this.authHeaders() });
            const d = await r.json();
            if (d.status !== 'ok') return;
            const c = d.data;

            // 🔧 记录原连接是否有密码/私钥（API 不返回明文，仅返回布尔标记）
            this._editingConnHasPassword = c.has_password || false;
            this._editingConnHasKey = c.has_key || false;

            document.getElementById('connDrawerTitle').innerHTML =
                '<i class="fas fa-edit"></i> 编辑连接';
            document.getElementById('connEditId').value       = c.id;
            document.getElementById('connName').value         = c.name || '';
            document.getElementById('connHost').value         = c.host || '';
            document.getElementById('connPort').value         = c.port || 22;
            document.getElementById('connUsername').value     = c.username || 'root';
            // 🔧 有密码则显示占位符，否则留空
            document.getElementById('connPassword').value     = this._editingConnHasPassword ? '••••••••' : '';
            document.getElementById('connPrivateKey').value   = this._editingConnHasKey ? '••••••••' : '';
            document.getElementById('connColor').value        = c.color || '#00b894';
            document.getElementById('connDescription').value  = c.description || '';
            this.updateGroupSelect();
            document.getElementById('connGroup').value = c.group_id || '';
            this.setAuthType(this._editingConnHasKey ? 'key' : 'password');
            this._openConnDrawer();
        } catch (e) {
            this.toast('加载连接信息失败', 'error');
        }
    },

    async saveConnection() {
        const editId = document.getElementById('connEditId').value;
        const passwordVal = document.getElementById('connPassword').value.trim();   // 🔧 trim
        const keyVal = document.getElementById('connPrivateKey').value.trim();      // 🔧 trim

        const data = {
            name:        document.getElementById('connName').value.trim(),
            host:        document.getElementById('connHost').value.trim(),
            port:        parseInt(document.getElementById('connPort').value) || 22,
            username:    document.getElementById('connUsername').value.trim() || 'root',
            color:       document.getElementById('connColor').value,
            description: document.getElementById('connDescription').value.trim(),
            group_id:    document.getElementById('connGroup').value,
        };

        // 🔧 编辑模式：仅当用户显式修改了密码/私钥时才发送对应字段，避免用空值覆盖原有凭据
        if (editId) {
            const passwordChanged = passwordVal && passwordVal !== '••••••••';
            const keyChanged = keyVal && keyVal !== '••••••••';

            // 如果原本有密码，用户没改（仍是占位符或为空），不发送 password 字段 → 后端保留旧值
            // 如果原本没密码，用户输入了新密码，则发送
            // 如果原本有密码，用户输入了新密码（非占位符），则发送
            if (passwordChanged || !this._editingConnHasPassword) {
                data.password = passwordVal;
            }
            // 私钥同理
            if (keyChanged || !this._editingConnHasKey) {
                data.private_key = keyVal;
            }
        } else {
            // 🔧 新建模式：校验必须提供密码或私钥
            const authType = this.authType;
            if (authType === 'password' && !passwordVal) {
                this.toast('请输入密码', 'warning'); return;
            }
            if (authType === 'key' && !keyVal) {
                this.toast('请粘贴私钥内容', 'warning'); return;
            }

            // 🔧 对抗浏览器自动填充：如果密码长度异常短（≤3），极可能是浏览器自动填充的脏数据
            //     弹窗确认，让用户有机会发现密码被篡改
            if (authType === 'password' && passwordVal.length <= 3) {
                const confirmed = await new Promise(resolve => {
                    this.confirm(
                        `⚠️ 密码仅 ${passwordVal.length} 个字符（"${passwordVal}"），可能是浏览器自动填充的脏数据。<br><br>建议重新输入正确密码。是否仍然保存？`,
                        () => resolve(true),
                        () => resolve(false)
                    );
                });
                if (!confirmed) return;  // 用户取消，回到抽屉重新输入
            }

            data.password = passwordVal;
            data.private_key = keyVal;
            console.log('[SaveConnection] 新建 | 密码长度:', passwordVal.length, '| 私钥长度:', keyVal.length);
        }

        if (!data.host) { this.toast('请输入主机地址', 'warning'); return; }

        // 🔧 编辑模式下的校验：使用编辑前的状态判断
        const hasPw = data.hasOwnProperty('password') ? data.password : this._editingConnHasPassword;
        const hasKey = data.hasOwnProperty('private_key') ? data.private_key : this._editingConnHasKey;
        if (!hasPw && !hasKey) {
            this.toast('请输入密码或私钥', 'warning'); return;
        }

        if (data.hasOwnProperty('private_key') && data.private_key) {
            const pk = data.private_key.trim();
            if (!pk.startsWith('-----BEGIN') || !pk.includes('PRIVATE KEY')) {
                this.toast('私钥格式有误，请检查', 'error'); return;
            }
        }
        if (!data.name) data.name = data.host;

        const url    = editId ? `/api/connections/${editId}` : '/api/connections';
        const method = editId ? 'PUT' : 'POST';

        try {
            const r = await fetch(url, {
                method, headers: this.authHeaders(), body: JSON.stringify(data)
            });
            const d = await r.json();
            if (d.status === 'ok') {
                this.toast(editId ? '连接已更新' : '连接已创建', 'success');
                this.closeConnDrawer();
                this.loadConnections();
            } else {
                this.toast(d.message || '保存失败', 'error');
            }
        } catch (e) {
            this.toast('保存失败: ' + e.message, 'error');
        }
    },

    confirmDeleteConnection(connId, name) {
        this.confirm(`确定要删除连接「${name}」吗？`, async () => {
            await fetch(`/api/connections/${connId}`, {
                method: 'DELETE', headers: this.authHeaders()
            });
            this.toast('连接已删除', 'success');
            this.loadConnections();
        });
    },

    // ══════════════════════════════
    //  抽屉：文件编辑器
    // ══════════════════════════════
    openFileDrawer(filename, content) {
        document.getElementById('editorFileName').textContent = filename;
        document.getElementById('fileEditorContent').value    = content;
        document.getElementById('fileDrawerOverlay')?.classList.add('visible');
        document.getElementById('fileDrawer')?.classList.add('open');
    },

    closeFileDrawer() {
        document.getElementById('fileDrawerOverlay')?.classList.remove('visible');
        document.getElementById('fileDrawer')?.classList.remove('open');
    },

    // ══════════════════════════════
    //  分组管理
    // ══════════════════════════════
    updateGroupSelect() {
        const select = document.getElementById('connGroup');
        if (!select) return;
        const current = select.value;
        select.innerHTML = '<option value="">默认分组</option>' +
            this.groups.map(g =>
                `<option value="${g.id}">${this.escapeHtml(g.name)}</option>`
            ).join('');
        select.value = current;
    },

    async showAddGroup() {
        const name = prompt('请输入分组名称:');
        if (!name?.trim()) return;
        try {
            const r = await fetch('/api/groups', {
                method: 'POST', headers: this.authHeaders(),
                body: JSON.stringify({ name: name.trim() })
            });
            const d = await r.json();
            if (d.status === 'ok') {
                this.toast(`分组「${name}」已创建`, 'success');
                await this.loadGroups();
                await this.loadConnections();
            }
        } catch (e) {
            this.toast('创建失败: ' + e.message, 'error');
        }
    },

    async deleteGroup(groupId) {
        this.confirm('确定删除此分组？（连接不会被删除）', async () => {
            await fetch(`/api/groups/${groupId}`, {
                method: 'DELETE', headers: this.authHeaders()
            });
            this.toast('分组已删除', 'success');
            await this.loadGroups();
            await this.loadConnections();
        });
    },

    // ══════════════════════════════
    //  集群运维面板
    // ══════════════════════════════
    showClusterPanel() {
        document.getElementById('welcomePage').style.display = 'none';
        document.getElementById('tabBar').classList.add('visible');
        document.getElementById('panelsContainer').classList.add('visible');

        let panel = document.getElementById('clusterPanel');
        if (!panel) {
            panel = document.createElement('div');
            panel.className = 'panel';
            panel.id = 'clusterPanel';
            panel.innerHTML = `
                <div class="panel-tabs">
                    <div class="panel-tab active" onclick="App.switchClusterTab('overview',this)">
                        <i class="fas fa-server"></i> 节点管理
                    </div>
                    <div class="panel-tab" onclick="App.switchClusterTab('batch',this)">
                        <i class="fas fa-terminal"></i> 批量命令
                    </div>
                    <div class="panel-tab" onclick="App.switchClusterTab('history',this)">
                        <i class="fas fa-history"></i> 任务历史
                    </div>
                </div>
                <div class="cluster-content" id="clusterOverview"
                     style="flex:1;overflow-y:auto;padding:16px">
                    <div id="nodeSelector"></div>
                </div>
                <div class="cluster-content" id="clusterBatch"
                     style="flex:1;overflow-y:auto;padding:16px;display:none">
                    <div style="margin-bottom:16px">
                        <label style="display:block;margin-bottom:6px;font-weight:500">批量执行命令</label>
                        <div style="display:flex;gap:8px">
                            <input type="text" id="batchCommandInput"
                                   placeholder="输入要批量执行的命令..."
                                   style="flex:1;padding:8px 12px;border:1px solid var(--border-color);
                                          background:var(--bg-tertiary);color:var(--text-primary);
                                          border-radius:6px;font-family:Consolas,monospace"
                                   onkeypress="if(event.key==='Enter')App.executeBatchCommand()">
                            <button class="btn btn-primary" onclick="App.executeBatchCommand()">
                                <i class="fas fa-play"></i> 执行
                            </button>
                        </div>
                    </div>
                    <div id="batchResults" style="margin-top:12px;max-height:400px;overflow-y:auto">
                        <div style="text-align:center;color:var(--text-secondary);padding:20px">
                            <i class="fas fa-info-circle"></i> 选择节点后执行批量命令
                        </div>
                    </div>
                </div>
                <div class="cluster-content" id="clusterHistory"
                     style="flex:1;overflow-y:auto;padding:16px;display:none">
                    <div id="taskHistoryList">
                        <div style="text-align:center;color:var(--text-secondary);padding:20px">
                            <i class="fas fa-clock"></i> 暂无任务记录
                        </div>
                    </div>
                </div>
            `;
            document.getElementById('panelsContainer').appendChild(panel);
        }

        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        panel.classList.add('active');

        if (typeof clusterConsole !== 'undefined') {
            clusterConsole.renderNodeSelector('nodeSelector');
        }
        this.toast('集群运维控制台已打开', 'info');
    },

    switchClusterTab(tabName, el) {
        const panel = document.getElementById('clusterPanel');
        if (!panel) return;
        panel.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
        el?.classList.add('active');
        panel.querySelectorAll('.cluster-content').forEach(c => c.style.display = 'none');
        const map = { overview: 'clusterOverview', batch: 'clusterBatch', history: 'clusterHistory' };
        const target = document.getElementById(map[tabName]);
        if (target) target.style.display = 'block';
    },

    executeBatchCommand() {
        const input   = document.getElementById('batchCommandInput');
        const command = input?.value?.trim();
        if (!command) { this.toast('请输入要执行的命令', 'warning'); return; }
        if (typeof clusterConsole !== 'undefined') {
            this.showGlobalProgress(true);
            clusterConsole.executeBatchCommand(command);
            input.value = '';
        } else {
            this.toast('集群控制台未初始化', 'error');
        }
    },

    // ══════════════════════════════
    //  文件分发
    // ══════════════════════════════
    showFileDistribution() {
        document.getElementById('welcomePage').style.display = 'none';
        document.getElementById('tabBar').classList.add('visible');
        document.getElementById('panelsContainer').classList.add('visible');

        let panel = document.getElementById('distributePanel');
        if (!panel) {
            panel = document.createElement('div');
            panel.className = 'panel';
            panel.id = 'distributePanel';
            panel.innerHTML = `
                <div class="panel-tabs">
                    <div class="panel-tab active">
                        <i class="fas fa-copy"></i> 文件分发
                    </div>
                </div>
                <div style="flex:1;overflow-y:auto;padding:20px;max-width:800px;margin:0 auto;width:100%">
                    <div style="background:var(--bg-secondary);border-radius:12px;padding:24px;border:1px solid var(--border-color)">
                        <h4 style="margin-bottom:16px;color:var(--text-bright)">
                            <i class="fas fa-copy" style="color:var(--accent-color)"></i> 分发文件到多台服务器
                        </h4>
                        <div class="form-group">
                            <label>选择目标节点</label>
                            <div id="distributeNodeSelector"
                                 style="max-height:200px;overflow-y:auto;background:var(--bg-tertiary);border-radius:6px;padding:8px">
                                <div style="text-align:center;color:var(--text-secondary);padding:12px">
                                    <i class="fas fa-spinner fa-spin"></i> 加载节点列表...
                                </div>
                            </div>
                        </div>
                        <div class="form-group">
                            <label>源文件路径（本地）</label>
                            <input type="text" id="distributeSource"
                                   placeholder="例如: /home/user/file.txt">
                        </div>
                        <div class="form-group">
                            <label>目标路径（远程服务器）</label>
                            <input type="text" id="distributeTarget"
                                   placeholder="例如: /root/file.txt">
                        </div>
                        <div class="form-row">
                            <div class="form-group flex-1">
                                <label>冲突策略</label>
                                <select id="distributeStrategy">
                                    <option value="overwrite">覆盖</option>
                                    <option value="skip">跳过</option>
                                    <option value="backup">备份后覆盖</option>
                                </select>
                            </div>
                            <div class="form-group flex-1"
                                 style="display:flex;align-items:center;gap:12px;padding-top:20px">
                                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:400">
                                    <input type="checkbox" id="distributeVerify" checked> MD5校验
                                </label>
                                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:400">
                                    <input type="checkbox" id="distributePerms" checked> 保留权限
                                </label>
                            </div>
                        </div>
                        <button class="btn btn-primary" onclick="App.submitFileDistribution()"
                                style="width:100%;padding:12px;margin-top:8px">
                            <i class="fas fa-play"></i> 开始分发
                        </button>
                        <div id="distributeResult" style="margin-top:16px;display:none"></div>
                    </div>
                </div>
            `;
            document.getElementById('panelsContainer').appendChild(panel);
        }

        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        panel.classList.add('active');
        this._loadDistributeNodes();

        // 🔧 恢复之前未完成的分发任务状态
        this._restoreDistributeTasks();

        this.toast('文件分发已打开', 'info');
    },

    /**
     * 🔧 恢复未完成的分发任务状态到 UI
     */
    _restoreDistributeTasks() {
        const resultDiv = document.getElementById('distributeResult');
        if (!resultDiv) return;

        const tasks = Object.values(this._distributeTasks).filter(
            t => t.status !== 'completed' && t.status !== 'failed'
        );
        if (tasks.length === 0) return;

        resultDiv.style.display = 'block';
        resultDiv.innerHTML = tasks.map(t => `
            <div style="padding:12px;background:var(--bg-tertiary);border-radius:6px;border:1px solid var(--border-color);margin-bottom:8px">
                <div style="display:flex;justify-content:space-between">
                    <strong>任务: ${t.task_id}</strong>
                    <span style="font-size:12px;color:var(--text-secondary)">
                        目标: ${t.target || '?'} | 节点: ${t.total_nodes || '?'}台
                    </span>
                </div>
                <button class="btn btn-sm" style="margin-top:8px"
                        onclick="App._checkDistributeStatus('${t.task_id}')">
                    <i class="fas fa-sync-alt"></i> 查看状态
                </button>
            </div>
        `).join('');
    },

    async _loadDistributeNodes() {
        try {
            const res  = await fetch('/api/cluster/nodes', { headers: this.authHeaders() });
            const data = await res.json();
            const container = document.getElementById('distributeNodeSelector');
            if (!container) return;
            if (data.status === 'ok' && data.data?.length > 0) {
                container.innerHTML = data.data.map(node => `
                    <label style="display:flex;align-items:center;gap:8px;padding:6px 10px;
                                  border-radius:4px;cursor:pointer"
                           onmouseenter="this.style.background='var(--bg-hover)'"
                           onmouseleave="this.style.background='transparent'">
                        <input type="checkbox" class="distribute-node-cb" value="${node.node_id}">
                        <span>${this.escapeHtml(node.name || node.host)}</span>
                        <span style="font-size:11px;color:var(--text-secondary);margin-left:auto">
                            ${node.username}@${node.host}:${node.port}
                        </span>
                    </label>
                `).join('');
            } else {
                container.innerHTML = `
                    <div style="text-align:center;color:var(--text-secondary);padding:12px">
                        <i class="fas fa-info-circle"></i> 暂无可用节点，请先添加连接
                    </div>`;
            }
        } catch (e) { console.error('加载分发节点失败:', e); }
    },

    async submitFileDistribution() {
        const source   = document.getElementById('distributeSource')?.value?.trim();
        const target   = document.getElementById('distributeTarget')?.value?.trim();
        const strategy = document.getElementById('distributeStrategy')?.value || 'overwrite';
        const verify   = document.getElementById('distributeVerify')?.checked !== false;
        const perms    = document.getElementById('distributePerms')?.checked !== false;
        const nodeIds  = Array.from(document.querySelectorAll('.distribute-node-cb:checked'))
                             .map(cb => cb.value);

        if (!source)           { this.toast('请输入源文件路径', 'warning'); return; }
        if (!target)           { this.toast('请输入目标路径', 'warning'); return; }
        if (!nodeIds.length)   { this.toast('请至少选择一个目标节点', 'warning'); return; }

        this.showGlobalProgress(true);

        try {
            const res  = await fetch('/api/distribute', {
                method: 'POST',
                headers: this.authHeaders(),
                body: JSON.stringify({
                    source_path: source, target_path: target,
                    node_ids: nodeIds, strategy, verify_md5: verify, preserve_perms: perms
                })
            });
            const data = await res.json();
            this.hideGlobalProgress();

            const resultDiv = document.getElementById('distributeResult');
            if (resultDiv) {
                resultDiv.style.display = 'block';
                if (data.status === 'ok') {
                    // 🔧 持久化任务信息
                    this._distributeTasks[data.task_id] = {
                        task_id: data.task_id,
                        total_nodes: data.total_nodes,
                        source: source,
                        target: target,
                        created_at: Date.now(),
                    };
                    resultDiv.innerHTML = `
                        <div style="padding:12px;background:var(--alert-info-bg);border-radius:6px;border-left:4px solid var(--success-color)">
                            <strong style="color:var(--success-color)">✅ 分发已启动</strong>
                            <div style="margin-top:4px;color:var(--text-secondary);font-size:13px">
                                任务ID: ${data.task_id}<br>目标节点: ${data.total_nodes} 台
                            </div>
                            <button class="btn btn-sm" style="margin-top:8px"
                                    onclick="App._checkDistributeStatus('${data.task_id}')">
                                <i class="fas fa-sync-alt"></i> 查看状态
                            </button>
                        </div>`;
                    this.toast('文件分发已启动', 'success');
                } else {
                    resultDiv.innerHTML = `
                        <div style="padding:12px;background:var(--alert-critical-bg);border-radius:6px;border-left:4px solid var(--danger-color)">
                            <strong style="color:var(--danger-color)">❌ 分发失败</strong>
                            <div style="margin-top:4px;color:var(--text-secondary);font-size:13px">${data.message || '未知错误'}</div>
                        </div>`;
                    this.toast(data.message || '分发失败', 'error');
                }
            }
        } catch (e) {
            this.hideGlobalProgress();
            this.toast('分发失败: ' + e.message, 'error');
        }
    },

    async _checkDistributeStatus(taskId) {
        try {
            const res  = await fetch(`/api/distribute/${taskId}/status`, { headers: this.authHeaders() });
            const data = await res.json();
            if (data.status === 'ok') {
                const info = data.data;
                // 🔧 更新持久化的任务状态
                if (this._distributeTasks[taskId]) {
                    this._distributeTasks[taskId].status = info.status;
                    this._distributeTasks[taskId].completed = info.completed || 0;
                    this._distributeTasks[taskId].total = info.total || 0;
                    this._distributeTasks[taskId].results = info.results || {};
                }
                const pct  = info.total > 0 ? (info.completed / info.total * 100) : 0;
                const resultDiv = document.getElementById('distributeResult');
                if (resultDiv) {
                    resultDiv.innerHTML = `
                        <div style="padding:12px;background:var(--bg-tertiary);border-radius:6px;border:1px solid var(--border-color)">
                            <div style="display:flex;justify-content:space-between">
                                <strong>任务状态: ${info.status}</strong>
                                <span style="font-size:12px;color:var(--text-secondary)">${info.completed||0}/${info.total||0}</span>
                            </div>
                            <div style="width:100%;height:6px;background:var(--progress-bg);border-radius:3px;margin-top:8px;overflow:hidden">
                                <div style="height:100%;width:${pct}%;background:var(--progress-bar-color);border-radius:3px;transition:width 0.3s"></div>
                            </div>
                            ${Object.entries(info.results||{}).map(([nid,r]) => `
                                <div style="padding:4px 8px;margin-top:4px;border-radius:4px;font-size:12px;
                                            background:${r.success?'rgba(102,187,106,0.1)':'rgba(239,83,80,0.1)'}">
                                    ${r.host||nid}: ${r.success?'✅ 成功':'❌ '+(r.error||'失败')}
                                </div>
                            `).join('')}
                        </div>`;
                }
            }
        } catch (e) { this.toast('查询状态失败', 'error'); }
    },

    // ══════════════════════════════
    //  系统巡检
    // ══════════════════════════════
    showInspection() {
        document.getElementById('welcomePage').style.display = 'none';
        document.getElementById('tabBar').classList.add('visible');
        document.getElementById('panelsContainer').classList.add('visible');

        let panel = document.getElementById('inspectionPanel');
        if (!panel) {
            panel = document.createElement('div');
            panel.className = 'panel';
            panel.id = 'inspectionPanel';
            panel.innerHTML = `
                <div class="panel-tabs">
                    <div class="panel-tab active">
                        <i class="fas fa-stethoscope"></i> 系统巡检
                    </div>
                </div>
                <div style="flex:1;overflow-y:auto;padding:20px;max-width:900px;margin:0 auto;width:100%">
                    <div style="background:var(--bg-secondary);border-radius:12px;padding:24px;border:1px solid var(--border-color)">
                        <h4 style="margin-bottom:16px;color:var(--text-bright)">
                            <i class="fas fa-stethoscope" style="color:var(--accent-color)"></i> 集群健康巡检
                        </h4>
                        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">
                            <button class="btn btn-primary" onclick="App.runInspection()">
                                <i class="fas fa-play"></i> 执行巡检
                            </button>
                            <button class="btn" onclick="App.exportInspectionReport()"
                                    id="exportInspectionBtn" disabled>
                                <i class="fas fa-file-excel"></i> 导出报告
                            </button>
                        </div>
                        <div id="inspectionProgress" style="display:none;margin-bottom:16px">
                            <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--text-secondary)">
                                <span>巡检中...</span>
                                <span id="inspectionProgressText">0%</span>
                            </div>
                            <div style="width:100%;height:6px;background:var(--progress-bg);border-radius:3px;margin-top:4px;overflow:hidden">
                                <div id="inspectionProgressBar" style="height:100%;width:0%;background:var(--progress-bar-color);border-radius:3px;transition:width 0.3s"></div>
                            </div>
                        </div>
                        <div id="inspectionResult">
                            <div style="text-align:center;color:var(--text-secondary);padding:30px">
                                <i class="fas fa-info-circle" style="font-size:32px;display:block;margin-bottom:12px"></i>
                                点击"执行巡检"检查所有节点的健康状态
                            </div>
                        </div>
                    </div>
                </div>
            `;
            document.getElementById('panelsContainer').appendChild(panel);
        }

        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        panel.classList.add('active');
        this.toast('系统巡检已打开', 'info');
    },

    async runInspection() {
        const resultDiv   = document.getElementById('inspectionResult');
        const progressDiv = document.getElementById('inspectionProgress');
        const exportBtn   = document.getElementById('exportInspectionBtn');

        try {
            const nodesRes = await fetch('/api/cluster/nodes', { headers: this.authHeaders() });
            const nodesData = await nodesRes.json();
            const nodeIds  = (nodesData.data || []).map(n => n.node_id);

            if (!nodeIds.length) {
                this.toast('没有可巡检的节点，请先添加连接', 'warning');
                return;
            }

            progressDiv.style.display = 'block';
            this.showGlobalProgress(true);
            resultDiv.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:20px"><i class="fas fa-spinner fa-spin"></i> 正在巡检...</div>';
            exportBtn.disabled = true;

            const res  = await fetch('/api/inspection/run', {
                method: 'POST', headers: this.authHeaders(),
                body: JSON.stringify({ node_ids: nodeIds })
            });
            const data = await res.json();

            progressDiv.style.display = 'none';
            this.hideGlobalProgress();
            exportBtn.disabled = false;

            if (data.status === 'ok') {
                const report = data.report;
                this._lastInspectionReport = report;
                resultDiv.innerHTML = `
                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px">
                        ${[
                            ['总节点', report.total_nodes, 'var(--text-bright)'],
                            ['在线',  report.online_nodes, 'var(--success-color)'],
                            ['异常',  report.abnormal_nodes, 'var(--danger-color)'],
                            ['离线',  report.offline_nodes, 'var(--warning-color)'],
                        ].map(([label, val, color]) => `
                            <div style="padding:12px;background:var(--bg-tertiary);border-radius:8px;text-align:center">
                                <div style="font-size:24px;font-weight:700;color:${color}">${val}</div>
                                <div style="font-size:12px;color:var(--text-secondary)">${label}</div>
                            </div>
                        `).join('')}
                    </div>
                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;margin-bottom:16px;font-size:13px">
                        <div style="padding:8px 12px;background:var(--bg-tertiary);border-radius:4px">
                            平均CPU: <strong>${(report.avg_cpu||0).toFixed(1)}%</strong>
                        </div>
                        <div style="padding:8px 12px;background:var(--bg-tertiary);border-radius:4px">
                            平均内存: <strong>${(report.avg_memory||0).toFixed(1)}%</strong>
                        </div>
                        <div style="padding:8px 12px;background:var(--bg-tertiary);border-radius:4px">
                            平均磁盘: <strong>${(report.avg_disk||0).toFixed(1)}%</strong>
                        </div>
                    </div>
                    <div style="max-height:300px;overflow-y:auto">
                        ${(report.nodes||[]).map(node => `
                            <div style="display:flex;align-items:center;padding:8px 12px;margin-bottom:4px;
                                        border-radius:4px;border-left:3px solid ${node.is_abnormal?'var(--danger-color)':node.status==='online'?'var(--success-color)':'var(--warning-color)'};
                                        background:${node.is_abnormal?'var(--alert-critical-bg)':node.status==='online'?'rgba(102,187,106,0.05)':'var(--alert-warning-bg)'}">
                                <span style="flex:1;font-weight:500">${this.escapeHtml(node.name||node.host)}</span>
                                <span style="font-size:12px;color:var(--text-secondary);margin-right:12px">CPU ${node.cpu_percent||0}%</span>
                                <span style="font-size:12px;color:var(--text-secondary);margin-right:12px">内存 ${node.memory_percent||0}%</span>
                                <span style="font-size:12px;color:${node.is_abnormal?'var(--danger-color)':'var(--success-color)'}">
                                    ${node.is_abnormal?'⚠️ '+(node.abnormal_reasons||[]).join(', '):'✅ 正常'}
                                </span>
                            </div>
                        `).join('')}
                    </div>
                `;
                this.toast(`巡检完成: ${report.online_nodes}/${report.total_nodes} 在线`, 'success');
            } else {
                resultDiv.innerHTML = `
                    <div style="padding:12px;background:var(--alert-critical-bg);border-radius:6px;border-left:4px solid var(--danger-color)">
                        <strong style="color:var(--danger-color)">❌ 巡检失败</strong>
                        <div style="margin-top:4px;color:var(--text-secondary);font-size:13px">${data.message||'未知错误'}</div>
                    </div>`;
                this.toast('巡检失败', 'error');
            }
        } catch (e) {
            this.hideGlobalProgress();
            document.getElementById('inspectionProgress').style.display = 'none';
            document.getElementById('exportInspectionBtn').disabled = true;
            this.toast('巡检失败: ' + e.message, 'error');
        }
    },

    async exportInspectionReport() {
        if (!this._lastInspectionReport) { this.toast('请先执行巡检', 'warning'); return; }
        try {
            const res = await fetch('/api/inspection/export', {
                method: 'POST', headers: this.authHeaders(),
                body: JSON.stringify({ report: this._lastInspectionReport })
            });
            if (res.ok) {
                const blob = await res.blob();
                const url  = URL.createObjectURL(blob);
                const a    = document.createElement('a');
                a.href = url;
                a.download = `巡检报告_${new Date().toISOString().slice(0,10)}.xlsx`;
                a.click();
                URL.revokeObjectURL(url);
                this.toast('报告导出成功', 'success');
            } else {
                this.toast('导出失败', 'error');
            }
        } catch (e) { this.toast('导出失败: ' + e.message, 'error'); }
    },

    // ══════════════════════════════
    //  告警管理
    // ══════════════════════════════
    showAlerts() {
        if (typeof alertManager === 'undefined') {
            this.toast('告警管理器未初始化', 'error'); return;
        }
        alertManager.loadAlerts().then(alerts => {
            const modal = document.createElement('div');
            modal.className = 'modal visible';
            modal.id = 'alertsModal';
            modal.innerHTML = `
                <div class="modal-overlay" onclick="document.getElementById('alertsModal').remove()"></div>
                <div class="modal-dialog modal-lg">
                    <div class="modal-header">
                        <h3><i class="fas fa-bell"></i> 告警管理</h3>
                        <button class="modal-close"
                                onclick="document.getElementById('alertsModal').remove()">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                    <div class="modal-body" style="max-height:500px;overflow-y:auto">
                        ${(!alerts || alerts.length === 0)
                            ? '<div style="text-align:center;padding:40px;color:var(--text-secondary)">✅ 暂无告警</div>'
                            : alerts.map(a => `
                                <div style="padding:12px;margin-bottom:8px;border-radius:6px;
                                            background:var(--bg-tertiary);
                                            border-left:4px solid ${
                                                a.severity==='critical'?'var(--alert-critical)':
                                                a.severity==='warning' ?'var(--alert-warning)' :
                                                'var(--alert-info)'
                                            }">
                                    <div style="display:flex;justify-content:space-between;align-items:center">
                                        <span style="font-weight:600;color:var(--text-bright)">
                                            ${this.escapeHtml(a.host||'Unknown')}
                                        </span>
                                        <span style="font-size:11px;color:var(--text-secondary)">
                                            ${(a.created_at||'').replace('T',' ').slice(0,19)}
                                        </span>
                                    </div>
                                    <div style="font-size:13px;color:var(--text-primary);margin-top:4px">
                                        ${this.escapeHtml(a.message)}
                                    </div>
                                    ${a.acknowledged
                                        ? '<div style="font-size:11px;color:var(--success-color);margin-top:4px">✓ 已确认</div>'
                                        : `<button class="btn btn-sm" style="margin-top:6px"
                                                   onclick="alertManager.acknowledgeAlert('${a.id}');
                                                            this.parentElement.insertAdjacentHTML('beforeend',
                                                            '<div style=\\'font-size:11px;color:var(--success-color);margin-top:4px\\'>✓ 已确认</div>');
                                                            this.remove()">
                                               确认
                                           </button>`
                                    }
                                </div>
                            `).join('')
                        }
                    </div>
                    <div class="modal-footer">
                        <button class="btn btn-danger"
                                onclick="alertManager.clearAlertsRemote();document.getElementById('alertsModal').remove()">
                            <i class="fas fa-trash"></i> 清空告警
                        </button>
                        <button class="btn"
                                onclick="document.getElementById('alertsModal').remove()">
                            关闭
                        </button>
                    </div>
                </div>
            `;
            document.getElementById('alertsModal')?.remove();
            document.body.appendChild(modal);
        });
    },

    // ══════════════════════════════
    //  增强命令面板（Ctrl+Shift+P）
    // ══════════════════════════════
    initCommandPalette() {
        // 快捷键在 initKeyboardShortcuts 中注册
    },

    _cpVisible: false,

    toggleCommandPalette() {
        if (this._cpVisible) {
            this._hideCommandPalette();
        } else {
            this._showCommandPalette();
        }
    },

    openCommandPalette() { this._showCommandPalette(); },
    closeCommandPalette() { this._hideCommandPalette(); },

    _showCommandPalette() {
        document.getElementById('commandPalette')?.remove();

        const overlay = document.createElement('div');
        overlay.id = 'commandPalette';
        overlay.style.cssText = `
            position:fixed;inset:0;z-index:99999;
            background:rgba(0,0,0,0.5);
            display:flex;align-items:flex-start;
            justify-content:center;padding-top:80px;
        `;

        overlay.innerHTML = `
            <div style="width:580px;max-width:90vw;
                        background:var(--bg-secondary);
                        border:1px solid var(--border-color);
                        border-radius:12px;
                        box-shadow:0 20px 60px rgba(0,0,0,0.5);
                        overflow:hidden;">
                <div style="display:flex;align-items:center;gap:10px;
                            padding:14px 16px;border-bottom:1px solid var(--border-color);">
                    <i class="fas fa-search" style="color:var(--text-secondary);flex-shrink:0;"></i>
                    <input id="cpInput" placeholder="搜索连接、命令、功能..."
                           autocomplete="off"
                           style="flex:1;background:none;border:none;outline:none;
                                  color:var(--text-bright);font-size:14px;font-family:inherit;">
                    <kbd style="font-size:10px;padding:2px 6px;border-radius:4px;
                                background:var(--bg-tertiary);color:var(--text-secondary);
                                border:1px solid var(--border-color);">ESC</kbd>
                </div>
                <div id="cpResults" style="max-height:400px;overflow-y:auto;padding:4px;"></div>
                <div style="padding:8px 16px;border-top:1px solid var(--border-color);
                            font-size:11px;color:var(--text-secondary);display:flex;gap:16px;">
                    <span><kbd style="padding:1px 5px;border-radius:3px;background:var(--bg-tertiary);border:1px solid var(--border-color);">↑↓</kbd> 选择</span>
                    <span><kbd style="padding:1px 5px;border-radius:3px;background:var(--bg-tertiary);border:1px solid var(--border-color);">Enter</kbd> 执行</span>
                    <span><kbd style="padding:1px 5px;border-radius:3px;background:var(--bg-tertiary);border:1px solid var(--border-color);">ESC</kbd> 关闭</span>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        this._cpVisible   = true;
        this._cpActiveIdx = -1;

        const input = document.getElementById('cpInput');
        input.focus();
        this._cpRender('');

        input.addEventListener('input', () => { this._cpRender(input.value); });
        input.addEventListener('keydown', (e) => {
            const items = document.querySelectorAll('.cp-item');
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this._cpActiveIdx = Math.min(this._cpActiveIdx + 1, items.length - 1);
                this._cpUpdateActive(items);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this._cpActiveIdx = Math.max(this._cpActiveIdx - 1, 0);
                this._cpUpdateActive(items);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const active = items[this._cpActiveIdx] || items[0];
                active?.click();
            } else if (e.key === 'Escape') {
                this._hideCommandPalette();
            }
        });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this._hideCommandPalette();
        });
    },

    _cpUpdateActive(items) {
        items.forEach((el, i) => {
            el.style.background = i === this._cpActiveIdx
                ? 'var(--bg-active)' : 'transparent';
        });
        items[this._cpActiveIdx]?.scrollIntoView({ block: 'nearest' });
    },

    _cpRender(query) {
        const q = query.trim().toLowerCase();
        const results = document.getElementById('cpResults');
        if (!results) return;

        const items = [];

        // 1. 连接项
        this.connections.forEach(c => {
            const score = this._cpScore(q, [c.name, c.host, c.username, c.description || '']);
            if (score >= 0) {
                items.push({
                    score,
                    section:'连接',
                    icon:'fa-server',
                    color:c.color||'#00b894',
                    label:c.name||c.host,
                    desc:`${c.username}@${c.host}:${c.port}`,
                    action:() => { this._hideCommandPalette(); this.openConnection(c.id); },
                });
            }
        });

        // 2. 功能操作
        const actions = [
            { label:'快速连接', desc:'打开快速连接对话框', icon:'fa-plug', color:'var(--success-color)', action:() => this.showQuickConnect() },
            { label:'新建连接', desc:'创建新的 SSH 连接配置', icon:'fa-plus', color:'var(--accent-color)', action:() => this.showAddConnection() },
            { label:'新建分组', desc:'创建连接分组', icon:'fa-folder-plus', color:'var(--accent-color)', action:() => this.showAddGroup() },
            { label:'切换主题', desc:'选择界面主题颜色', icon:'fa-palette', color:'var(--warning-color)', action:() => this.showThemePicker() },
            { label:'AI 智能助手', desc:'打开 AI 运维对话窗口', icon:'fa-robot', color:'var(--accent-color)', action:() => { if(typeof AIAssistant!=='undefined')AIAssistant.toggleGlobalFloat(); } },
            { label:'告警中心', desc:'查看系统告警', icon:'fa-bell', color:'var(--danger-color)', action:() => this.showAlerts() },
            { label:'集群运维', desc:'批量命令与节点管理', icon:'fa-network-wired', color:'var(--accent-color)', action:() => this.showClusterPanel() },
            { label:'文件分发', desc:'分发文件到多台服务器', icon:'fa-copy', color:'var(--accent-color)', action:() => this.showFileDistribution() },
            { label:'系统巡检', desc:'巡检所有节点健康状态', icon:'fa-stethoscope', color:'var(--accent-color)', action:() => this.showInspection() },
            { label:'仪表盘刷新', desc:'刷新首页仪表盘数据', icon:'fa-sync-alt', color:'var(--success-color)', action:() => { if(typeof Dashboard!=='undefined') Dashboard.refresh(); } },
            { label:'通知中心', desc:'查看历史通知记录', icon:'fa-bell', color:'var(--warning-color)', action:() => this.showNotifCenter() },
        ];

        actions.forEach(a => {
            const score = this._cpScore(q, [a.label, a.desc]);
            if (score >= 0) {
                items.push({ score, section:'操作', ...a,
                    action:() => { this._hideCommandPalette(); a.action(); } });
            }
        });

        // 3. 当前会话操作
        if (this.activeSession) {
            const sid = this.activeSession;
            const sessionActions = [
                { label:'切换到终端', icon:'fa-terminal', color:'var(--success-color)',
                  action:() => { const t = document.querySelector(`#panel-${sid} .panel-tab[data-tab="terminal"]`); if(t) this.switchPanelTab(sid,'terminal',t); } },
                { label:'切换到文件', icon:'fa-folder-open', color:'var(--accent-color)',
                  action:() => { const t = document.querySelector(`#panel-${sid} .panel-tab[data-tab="files"]`); if(t) this.switchPanelTab(sid,'files',t); } },
                { label:'切换到监控', icon:'fa-chart-bar', color:'var(--info-color)',
                  action:() => { const t = document.querySelector(`#panel-${sid} .panel-tab[data-tab="monitor"]`); if(t) this.switchPanelTab(sid,'monitor',t); } },
                { label:'关闭当前标签', icon:'fa-times', color:'var(--danger-color)', desc:'Ctrl+W',
                  action:() => this.closeSession(sid) },
            ];
            sessionActions.forEach(a => {
                const score = this._cpScore(q, [a.label, a.desc||'']);
                if (score >= 0) {
                    items.push({ score, section:'当前会话', ...a });
                }
            });
        }

        // 排序
        items.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));

        if (!items.length) {
            results.innerHTML = `<div style="padding:30px;text-align:center;
                color:var(--text-secondary);font-size:13px;">
                <i class="fas fa-search" style="font-size:20px;display:block;margin-bottom:8px;opacity:0.3;"></i>
                没有找到 "${this.escapeHtml(query)}"
            </div>`;
            return;
        }

        // 按分组渲染
        const groups = {};
        items.slice(0, 20).forEach(item => {
            if (!groups[item.section]) groups[item.section] = [];
            groups[item.section].push(item);
        });

        let html = '';
        Object.entries(groups).forEach(([section, gItems]) => {
            html += `<div style="padding:6px 12px 2px;font-size:10px;font-weight:600;
                                 color:var(--text-secondary);text-transform:uppercase;
                                 letter-spacing:0.5px;">${section}</div>`;
            gItems.forEach((item) => {
                html += `<div class="cp-item" style="display:flex;align-items:center;gap:10px;
                             padding:9px 12px;border-radius:6px;cursor:pointer;transition:background 0.1s;"
                        onmouseenter="this.style.background='var(--bg-hover)'"
                        onmouseleave="this.style.background='transparent'"
                        onclick="(${item.action.toString()})()">
                    <i class="fas ${item.icon}"
                       style="font-size:13px;color:${item.color};width:18px;text-align:center;flex-shrink:0;"></i>
                    <div style="flex:1;min-width:0;">
                        <div style="font-size:13px;color:var(--text-bright);
                                    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                            ${this.escapeHtml(item.label)}
                        </div>
                        ${item.desc ? `<div style="font-size:11px;color:var(--text-secondary);
                                                   overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                            ${this.escapeHtml(item.desc)}
                        </div>` : ''}
                    </div>
                </div>`;
            });
        });

        results.innerHTML = html;
        this._cpItems     = items;
        this._cpActiveIdx = 0;
        this._cpUpdateActive(results.querySelectorAll('.cp-item'));
    },

    _cpScore(query, fields) {
        if (!query) return 0;
        const text = fields.join(' ').toLowerCase();
        if (text.includes(query)) return query.length * 2;
        const words = query.split(' ');
        const allMatch = words.every(w => text.includes(w));
        return allMatch ? query.length : -1;
    },

    _cpExec(idx) {
        const item = this._cpItems[idx];
        if (item) {
            this._hideCommandPalette();
            item.action();
        }
    },

    _hideCommandPalette() {
        document.getElementById('commandPalette')?.remove();
        // Also hide old overlay if exists
        document.getElementById('commandPaletteOverlay')?.classList.remove('visible');
        this._cpVisible = false;
    },

    // ══════════════════════════════
    //  拖拽上传
    // ══════════════════════════════
    initDragDrop() {
        document.addEventListener('dragover', e => {
            if (this.activeSession) e.preventDefault();
        });
        document.addEventListener('drop', e => {
            e.preventDefault();
            if (!this.activeSession) return;
            const panel = document.getElementById(`panel-${this.activeSession}`);
            if (!panel?.querySelector('.file-manager.active')) return;
            const files = Array.from(e.dataTransfer?.files || []);
            if (files.length > 0 && typeof FileManager !== 'undefined') {
                FileManager.uploadFileList(files);
            }
        });
    },

    // ══════════════════════════════
    //  键盘快捷键
    // ══════════════════════════════
    initKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            const ctrl  = e.ctrlKey || e.metaKey;
            const shift = e.shiftKey;
            const alt   = e.altKey;
            const key   = e.key;

            // ── Ctrl+Shift+P：命令面板 ──
            if (ctrl && shift && key === 'P') {
                e.preventDefault();
                this.openCommandPalette();
                return;
            }

            // ── Ctrl+Shift+N：新建连接 ──
            if (ctrl && shift && key === 'N') {
                e.preventDefault();
                this.showAddConnection();
                return;
            }

            // ── Ctrl+Shift+Q：快速连接 ──
            if (ctrl && shift && key === 'Q') {
                e.preventDefault();
                this.showQuickConnect();
                return;
            }

            // ── Ctrl+W：关闭当前会话 ──
            if (ctrl && key === 'w' && this.activeSession) {
                if (!['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) {
                    e.preventDefault();
                    this.closeSession(this.activeSession);
                    return;
                }
            }

            // ── Ctrl+Tab / Ctrl+Shift+Tab：切换标签页 ──
            if (ctrl && key === 'Tab') {
                e.preventDefault();
                const sids = Object.keys(this.sessions);
                if (sids.length < 2) return;
                const cur = sids.indexOf(this.activeSession);
                const next = shift
                    ? (cur - 1 + sids.length) % sids.length
                    : (cur + 1) % sids.length;
                this.switchSession(sids[next]);
                return;
            }

            // ── Ctrl+1~9：切换到第N个标签 ──
            if (ctrl && key >= '1' && key <= '9') {
                const sids = Object.keys(this.sessions);
                const idx  = parseInt(key) - 1;
                if (idx < sids.length) {
                    e.preventDefault();
                    this.switchSession(sids[idx]);
                }
                return;
            }

            // ── Escape：关闭弹窗/菜单 ──
            if (key === 'Escape') {
                document.getElementById('connContextMenu')?.remove();
                document.getElementById('themePicker')?.remove();
                document.getElementById('notifCenter')?.remove();
                const overlay = document.getElementById('commandPaletteOverlay');
                if (overlay?.classList.contains('visible')) {
                    this.closeCommandPalette(); return;
                }
                this.closeOpsMenu?.();
                document.querySelectorAll('.modal.visible').forEach(m => {
                    m.classList.remove('visible');
                });
                if (document.getElementById('connDrawer')?.classList.contains('open')) {
                    this.closeConnDrawer();
                }
                if (document.getElementById('fileDrawer')?.classList.contains('open')) {
                    this.closeFileDrawer();
                }
                return;
            }

            // ── F5：刷新仪表盘（欢迎页时）──
            if (key === 'F5' && !this.activeSession) {
                e.preventDefault();
                if (typeof Dashboard !== 'undefined') Dashboard.refresh();
                return;
            }

            // ── Alt+1~4：切换面板 Tab ──
            if (alt && key >= '1' && key <= '4' && this.activeSession) {
                e.preventDefault();
                const sid = this.activeSession;
                const tabs = ['terminal', 'files', 'monitor', 'ai-diagnose'];
                const tab  = tabs[parseInt(key) - 1];
                if (tab) {
                    const el = document.querySelector(`#panel-${sid} .panel-tab[data-tab="${tab}"]`);
                    if (el) this.switchPanelTab(sid, tab, el);
                }
                return;
            }
        });
    },

    // ══════════════════════════════
    //  侧边栏拖拽
    // ══════════════════════════════
    initSidebarResize() {
        const sidebar = document.getElementById('sidebar');
        const handle  = document.getElementById('sidebarResize');
        if (!sidebar || !handle) return;

        let dragging = false, startX = 0, startW = 0;
        handle.addEventListener('mousedown', e => {
            dragging = true;
            startX   = e.clientX;
            startW   = sidebar.offsetWidth;
            document.body.style.cursor    = 'col-resize';
            document.body.style.userSelect = 'none';
        });
        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            const w = Math.min(500, Math.max(200, startW + (e.clientX - startX)));
            sidebar.style.width = w + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            document.body.style.cursor    = '';
            document.body.style.userSelect = '';
            if (this.activeSession) setTimeout(() => this._fitAndSync(this.activeSession), 100);
        });
    },

    // ══════════════════════════════
    //  搜索栏增强（Ctrl+F 聚焦）
    // ══════════════════════════════
    initSearchBar() {
        const input = document.getElementById('searchInput');
        if (!input) return;

        // Ctrl+F 聚焦搜索框
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                const active = document.activeElement;
                if (['INPUT', 'TEXTAREA'].includes(active?.tagName) &&
                    active.id !== 'searchInput') return;
                e.preventDefault();
                input.focus();
                input.select();
            }
        });

        // Escape 清空搜索
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                input.value = '';
                this.renderConnectionList();
                input.blur();
            }
            // Enter 打开第一个匹配的连接
            if (e.key === 'Enter') {
                const q = input.value.trim().toLowerCase();
                if (!q) return;
                const match = this.connections.find(c =>
                    [c.name, c.host, c.description || ''].some(s =>
                        s.toLowerCase().includes(q)
                    )
                );
                if (match) this.openConnection(match.id);
            }
        });
    },

    // ══════════════════════════════
    //  Modal Enter 键绑定
    // ══════════════════════════════
    bindModalEnterKeys() {
        // 连接抽屉 - Enter 触发保存
        document.getElementById('connHost')?.addEventListener('keypress', e => {
            if (e.key === 'Enter') this.saveConnection();
        });

        // 快速连接 - Enter
        document.getElementById('quickHost')?.addEventListener('keypress', e => {
            if (e.key === 'Enter') document.getElementById('quickPassword')?.focus();
        });
        document.getElementById('quickPassword')?.addEventListener('keypress', e => {
            if (e.key === 'Enter') this.quickConnect();
        });
        document.getElementById('quickPrivateKey')?.addEventListener('keypress', e => {
            if (e.key === 'Enter' && !e.shiftKey) this.quickConnect();
        });

        // 快捷命令 - Ctrl+Enter
        document.getElementById('cmdAddCommand')?.addEventListener('keydown', e => {
            if (e.ctrlKey && e.key === 'Enter') {
                if (typeof CommandManager !== 'undefined') CommandManager.submitAdd();
            }
        });

        // 批量命令 - Enter
        document.getElementById('batchCommandInput')?.addEventListener('keypress', e => {
            if (e.key === 'Enter') this.executeBatchCommand();
        });
    },

    // ══════════════════════════════
    //  主题（多主题支持）
    // ══════════════════════════════
    _themes: {
        dark: {
            label:'暗黑', icon:'fa-moon',
            vars: {
                '--bg-primary':'#1a1d23','--bg-secondary':'#21252b','--bg-tertiary':'#282c34',
                '--bg-hover':'#2c313a','--bg-active':'#2c313a',
                '--text-primary':'#abb2bf','--text-bright':'#ffffff','--text-secondary':'#5c6370',
                '--border-color':'#333843',
                '--accent-color':'#4fc3f7','--success-color':'#66bb6a','--warning-color':'#ffa726',
                '--danger-color':'#ef5350','--info-color':'#42a5f5',
            },
            terminal:{ background:'#1a1d23', foreground:'#abb2bf', cursor:'#4fc3f7' },
        },
        light: {
            label:'亮白', icon:'fa-sun',
            vars: {
                '--bg-primary':'#ffffff','--bg-secondary':'#f5f5f5','--bg-tertiary':'#eeeeee',
                '--bg-hover':'#e8e8e8','--bg-active':'#e0e0e0',
                '--text-primary':'#383a42','--text-bright':'#000000','--text-secondary':'#9e9e9e',
                '--border-color':'#e0e0e0',
                '--accent-color':'#0184bc','--success-color':'#50a14f','--warning-color':'#986801',
                '--danger-color':'#e45649','--info-color':'#0997b3',
            },
            terminal:{ background:'#ffffff', foreground:'#383a42', cursor:'#0184bc' },
        },
        dracula: {
            label:'Dracula', icon:'fa-skull',
            vars: {
                '--bg-primary':'#282a36','--bg-secondary':'#1e1f29','--bg-tertiary':'#252634',
                '--bg-hover':'#44475a','--bg-active':'#44475a',
                '--text-primary':'#f8f8f2','--text-bright':'#ffffff','--text-secondary':'#6272a4',
                '--border-color':'#44475a',
                '--accent-color':'#bd93f9','--success-color':'#50fa7b','--warning-color':'#ffb86c',
                '--danger-color':'#ff5555','--info-color':'#8be9fd',
            },
            terminal:{ background:'#282a36', foreground:'#f8f8f2', cursor:'#bd93f9' },
        },
        nord: {
            label:'Nord', icon:'fa-snowflake',
            vars: {
                '--bg-primary':'#2e3440','--bg-secondary':'#3b4252','--bg-tertiary':'#434c5e',
                '--bg-hover':'#4c566a','--bg-active':'#4c566a',
                '--text-primary':'#d8dee9','--text-bright':'#eceff4','--text-secondary':'#616e88',
                '--border-color':'#4c566a',
                '--accent-color':'#88c0d0','--success-color':'#a3be8c','--warning-color':'#ebcb8b',
                '--danger-color':'#bf616a','--info-color':'#81a1c1',
            },
            terminal:{ background:'#2e3440', foreground:'#d8dee9', cursor:'#88c0d0' },
        },
    },

    applyTheme(themeName) {
        const theme = this._themes[themeName] || this._themes.dark;
        this.theme = themeName;
        localStorage.setItem('wt_theme', themeName);

        const root = document.documentElement;
        Object.entries(theme.vars).forEach(([k, v]) => {
            root.style.setProperty(k, v);
        });
        root.setAttribute('data-theme',
            themeName === 'light' ? 'light' : 'dark'
        );

        const icon = document.getElementById('themeIcon');
        if (icon) icon.className = `fas ${theme.icon}`;

        if (typeof terminalManager !== 'undefined') {
            Object.values(terminalManager.terminals || {}).forEach(({ term }) => {
                if (term?.options) {
                    term.options.theme = {
                        ...theme.terminal,
                        selectionBackground: '#264f78',
                        selectionForeground: '#ffffff',
                        selection: '#264f78',
                    };
                }
            });
        }


        // 更新顶栏按钮标签 + 动态 title（窗口缩小时 hover 可见）
        const label = document.getElementById('themeLabel');
        if (label) {
            const labelText = this._themes[themeName]?.label || '';
            label.textContent = labelText;
            const btn = document.getElementById('themePickerBtn');
            if (btn) btn.title = `主题: ${labelText}`;
        }
    },

    showThemePicker() {
        // 已存在则关闭（toggle 行为）
        const existing = document.getElementById('themePickerDrop');
        if (existing) {
            existing.remove();
            return;
        }

        // 找到主题按钮的位置
        const triggerBtn = document.querySelector('[onclick*="showThemePicker"]');
        if (!triggerBtn) return;

        const rect = triggerBtn.getBoundingClientRect();

        const drop = document.createElement('div');
        drop.id = 'themePickerDrop';
        drop.style.cssText = `
            position: fixed;
            top: ${rect.bottom + 6}px;
            left: ${rect.left}px;
            z-index: 9999;
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            border-radius: 10px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.35);
            padding: 6px;
            min-width: 170px;
            animation: dropIn 0.15s ease;
        `;

        // 主题列表（顺序固定）
        const themeOrder = ['dark', 'light', 'dracula', 'nord'];

        drop.innerHTML = `
            <div style="font-size:10px;font-weight:600;color:var(--text-secondary);
                        padding:4px 10px 6px;text-transform:uppercase;letter-spacing:0.5px;">
                界面主题
            </div>
            ${themeOrder.map(key => {
                const t = App._themes[key];
                const isActive = App.theme === key;
                // 主题色预览点
                const previewColors = [
                    t.vars['--bg-primary'],
                    t.vars['--accent-color'],
                    t.vars['--success-color'],
                    t.vars['--danger-color'],
                ];
                return `
                    <div onclick="App._selectTheme('${key}')"
                         class="theme-drop-item ${isActive ? 'active' : ''}"
                         style="display:flex;align-items:center;gap:10px;
                                padding:8px 10px;border-radius:7px;cursor:pointer;
                                background:${isActive ? 'var(--bg-active)' : 'transparent'};
                                transition:background 0.15s;"
                         onmouseenter="this.style.background='var(--bg-hover)'"
                         onmouseleave="this.style.background='${isActive ? 'var(--bg-active)' : 'transparent'}'">
                        <!-- 主题色预览 -->
                        <div style="display:flex;gap:2px;flex-shrink:0;">
                            ${previewColors.map(c =>
                                '<div style="width:10px;height:10px;border-radius:50%;background:' + c +
                                            ';border:1px solid rgba(255,255,255,0.1);"></div>'
                            ).join('')}
                        </div>
                        <!-- 主题名 -->
                        <span style="flex:1;font-size:13px;
                                     color:${isActive ? 'var(--text-bright)' : 'var(--text-primary)'};">
                            ${t.label}
                        </span>
                        <!-- 当前选中勾 -->
                        ${isActive
                            ? '<i class="fas fa-check" style="font-size:10px;color:var(--accent-color);"></i>'
                            : ''}
                    </div>
                `;
            }).join('')}

            <div style="height:1px;background:var(--border-color);margin:4px 0;"></div>

            <!-- 字体大小调节 -->
            <div style="padding:6px 10px;display:flex;align-items:center;gap:8px;">
                <span style="font-size:11px;color:var(--text-secondary);flex:1;">
                    <i class="fas fa-text-height" style="margin-right:4px;"></i>字号
                </span>
                <button onclick="App._globalFontSize(-1)"
                        style="width:22px;height:22px;border-radius:5px;border:1px solid var(--border-color);
                               background:var(--bg-tertiary);color:var(--text-primary);
                               cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center;">
                    <i class="fas fa-minus" style="font-size:8px;"></i>
                </button>
                <span id="globalFontSizeLabel"
                      style="font-size:11px;color:var(--text-bright);min-width:24px;text-align:center;">
                    ${parseInt(localStorage.getItem('wt_fontSize') || '14')}
                </span>
                <button onclick="App._globalFontSize(1)"
                        style="width:22px;height:22px;border-radius:5px;border:1px solid var(--border-color);
                               background:var(--bg-tertiary);color:var(--text-primary);
                               cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center;">
                    <i class="fas fa-plus" style="font-size:8px;"></i>
                </button>
            </div>
        `;

        document.body.appendChild(drop);

        // 边界检测：超出右侧则向右对齐
        requestAnimationFrame(() => {
            const dropRect = drop.getBoundingClientRect();
            if (dropRect.right > window.innerWidth - 8) {
                drop.style.left = 'auto';
                drop.style.right = '8px';
            }
        });

        // 点击外部关闭
        const close = (e) => {
            if (!drop.contains(e.target) &&
                !e.target.closest('[onclick*="showThemePicker"]')) {
                drop.remove();
                document.removeEventListener('click', close);
            }
        };
        setTimeout(() => document.addEventListener('click', close), 0);
    },

    // 选择主题并关闭下拉
    _selectTheme(themeName) {
        this.applyTheme(themeName);
        document.getElementById('themePickerDrop')?.remove();
        this.toast('已切换到 ' + (this._themes[themeName]?.label || themeName) + ' 主题', 'success', 1500);
    },

    // 全局字体大小调节（影响所有终端）
    _globalFontSize(delta) {
        const cur  = parseInt(localStorage.getItem('wt_fontSize') || '14');
        const next = Math.min(22, Math.max(10, cur + delta));
        localStorage.setItem('wt_fontSize', next);

        // 更新所有终端字号
        if (typeof terminalManager !== 'undefined') {
            Object.keys(terminalManager.terminals || {}).forEach(sid => {
                const t = terminalManager.terminals[sid];
                if (t?.term) {
                    t.term.options.fontSize = next;
                    try { t.fitAddon?.fit(); } catch (_) {}
                }
            });
        }

        // 更新显示
        const label = document.getElementById('globalFontSizeLabel');
        if (label) label.textContent = next;

        // 同步各终端单独字号显示
        Object.keys(App.sessions || {}).forEach(sid => {
            const el = document.getElementById('termFontSize-' + sid);
            if (el) el.textContent = next;
        });
    },

    // ══════════════════════════════
    //  终端工具栏功能
    // ══════════════════════════════
    _termClear(sessionId) {
        if (this.socket) {
            this.socket.emit('terminal_input', { session_id: sessionId, data: '\x0c' });
        }
    },

    _termCopy(sessionId) {
        const t = terminalManager.get(sessionId);
        if (!t) return;
        const sel = t.term.getSelection();
        if (sel) {
            navigator.clipboard.writeText(sel);
            this.toast('已复制', 'success');
        } else {
            this.toast('请先选中文本', 'info');
        }
    },

    async _termPaste(sessionId) {
        try {
            const text = await navigator.clipboard.readText();
            if (text && this.socket) {
                this.socket.emit('terminal_input', { session_id: sessionId, data: text });
                terminalManager.focus(sessionId);
            }
        } catch (e) {
            this.toast('粘贴失败，请使用键盘 Ctrl+V', 'warning');
        }
    },

    _termFontSize(sessionId, delta) {
        const t = terminalManager.get(sessionId);
        if (!t) return;
        const cur = t.term.options.fontSize || 14;
        const next = Math.min(24, Math.max(8, cur + delta));
        t.term.options.fontSize = next;
        const el = document.getElementById(`termFontSize-${sessionId}`);
        if (el) el.textContent = next;
        try { t.fitAddon.fit(); } catch (_) {}
        this.socket?.emit('terminal_resize', {
            session_id: sessionId,
            cols: t.term.cols,
            rows: t.term.rows
        });
    },

    _showTermToolbar(sessionId) {
        const toolbar = document.getElementById(`termToolbar-${sessionId}`);
        const termDiv = document.getElementById(`terminal-${sessionId}`);
        if (toolbar) toolbar.style.display = 'flex';
        if (termDiv) termDiv.style.display = 'block';
        // 🔧 终端从 display:none → visible 后必须重新 fit，
        //    否则 xterm Canvas 尺寸为 0×0，鼠标坐标映射错误导致无法选中文本
        setTimeout(() => this._fitAndSync(sessionId), 60);
    },

    toggleTheme() { this.applyTheme(this.theme === 'dark' ? 'light' : 'dark'); },

    // ══════════════════════════════
    //  Modal 工具（保留用于确认弹窗）
    // ══════════════════════════════
    openModal(id)  { document.getElementById(id)?.classList.add('visible'); },
    closeModal(id) {
        document.getElementById(id)?.classList.remove('visible');
        if (id === 'confirmModal' && this._confirmOnCancel) {
            const cb = this._confirmOnCancel;
            this._confirmOnCancel = null;
            cb();
        }
    },

    confirm(message, onOk, onCancel) {
        document.getElementById('confirmMessage').innerHTML = message;
        const btn    = document.getElementById('confirmBtn');
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener('click', () => {
            // 🔧 先清除取消回调再关闭弹窗，避免 closeModal 误触发 onCancel
            this._confirmOnCancel = null;
            this.closeModal('confirmModal');
            onOk?.();
        });
        // 🔧 支持取消回调：监听关闭（取消按钮或遮罩层）
        this._confirmOnCancel = onCancel;
        this.openModal('confirmModal');
    },

    /**
     * 安全确认弹窗（高危命令二次确认）
     * @param {Object} opts - { session_id, command, risk_level, score, description, suggestion, confirm_token, message }
     */
    _showSecurityConfirm(opts) {
        const modal = document.getElementById('securityConfirmModal');
        if (!modal) return;

        // 填充数据
        const badge = document.getElementById('secRiskBadge');
        const label = document.getElementById('secRiskLabel');
        badge.className = 'security-risk-badge ' + (opts.risk_level || 'high');
        label.textContent = (opts.risk_level || 'high').toUpperCase();

        document.getElementById('secCmdText').textContent = opts.command || '';
        document.getElementById('secDescription').textContent = opts.description || '-';
        document.getElementById('secSuggestion').textContent = opts.suggestion || '请仔细核对命令后再执行';

        // 绑定确认按钮（一次性）
        const confirmBtn = document.getElementById('secConfirmBtn');
        const cancelBtn  = document.getElementById('secCancelBtn');
        const overlay    = modal.querySelector('.modal-overlay');

        const cleanup = () => {
            confirmBtn.replaceWith(confirmBtn.cloneNode(true));
            cancelBtn.replaceWith(cancelBtn.cloneNode(true));
            overlay.replaceWith(overlay.cloneNode(true));
            this.closeModal('securityConfirmModal');
        };

        document.getElementById('secConfirmBtn').addEventListener('click', () => {
            cleanup();
            // 重新发送命令到终端，携带后端签发的确认 token
            // 🔧 使用 \r（CR）而非 \n，与终端 onData 的换行格式一致
            this.socket.emit('terminal_input', {
                session_id: opts.session_id,
                data: opts.command + '\r',
                _risk_confirmed: true,
                _confirm_token: opts.confirm_token || ''
            });
            this.toast('✅ 命令已确认并发送', 'success');
        });

        document.getElementById('secCancelBtn').addEventListener('click', () => {
            cleanup();
            this.toast('❌ 命令已取消', 'info');
        });

        // 60 秒超时自动关闭（与后端 token 过期时间一致）
        this._secConfirmTimer = setTimeout(() => {
            cleanup();
            this.toast('⏰ 确认超时，请重新执行命令', 'warning');
        }, 60000);

        this.openModal('securityConfirmModal');
    },

    /**
     * 🔧 快速本地命令风险预判（避免不必要的 API 调用）
     * 匹配高危/中危命令关键字，命中则交由后端 API 做最终判定
     */
    _isCommandPotentiallyRisky(cmd) {
        if (!cmd || cmd.length < 2) return false;
        const patterns = [
            /\brm\s+-r[fF]\b/,     /\bdd\s+if=/,            /\bmkfs\b/,
            /\bmke2fs\b/,           /\bshutdown\b/,          /\breboot\b/,
            /\bhalt\b/,             /\bpoweroff\b/,          /\bfdisk\b/,
            /\bparted\b/,           /\bchmod\s+-R\s+777/,    /\bchown\s+-R/,
            /\biptables\s+-[FX]/,   /\bkill\s+-9\b/,         /\binit\s+[06]\b/,
            /\bpasswd\b/,           /\buserdel\b/,           /\bcrontab\s+-r\b/,
            /\btruncate\s+-s\s+0/,  /\bwipefs\b/,           /\bmkswap\b/,
            /'>'\s*\/dev\/sd/,       /\bcat\s+\/dev\/null\s*>\s*\/dev\/sd/,
            /\bmv\s+\S+\s+\/dev\/null/,  /\bsystemctl\s+(stop|disable)/,
        ];
        return patterns.some(p => p.test(cmd));
    },

    /**
     * 🔧 调用后端 API 进行命令风险分析
     * critical → 直接阻止，发送 Ctrl+C 取消当前行
     * high     → 弹出自定义安全确认弹窗
     * medium   → Toast 提醒 + 放行
     */
    _checkTerminalRisk(sessionId, cmd) {
        fetch('/api/ai/analyze-command', {
            method: 'POST',
            headers: this.authHeaders(),
            body: JSON.stringify({ command: cmd })
        })
        .then(r => r.json())
        .then(result => {
            if (result.status !== 'ok' || !result.data || !result.data.risk) {
                this._sendTerminalEnter(sessionId);
                return;
            }
            const risk = result.data.risk;

            if (risk.level === 'critical') {
                this.toast('⛔ 极度危险命令已阻止: ' + risk.description, 'error', 8000);
                this.socket.emit('terminal_input', { session_id: sessionId, data: '\x03' });
                return;
            }

            if (risk.level === 'high') {
                this._showTerminalRiskConfirm(sessionId, cmd, risk);
                return;
            }

            if (risk.level === 'medium') {
                this.toast('⚠️ 中危命令: ' + risk.description, 'warning', 5000);
            }

            this._sendTerminalEnter(sessionId);
        })
        .catch(() => {
            // API 异常时放行，避免阻塞正常操作
            this._sendTerminalEnter(sessionId);
        });
    },

    /**
     * 🔧 发送 Enter 键到后端 PTY
     */
    _sendTerminalEnter(sessionId) {
        this.socket.emit('terminal_input', { session_id: sessionId, data: '\r' });
    },

    /**
     * 🔧 终端手打命令风险确认弹窗（与 _showSecurityConfirm 的区别：
     *   这里只发送 \r，因为命令字符已在逐字键入时发送到 PTY）
     */
    _showTerminalRiskConfirm(sessionId, cmd, risk) {
        const modal = document.getElementById('securityConfirmModal');
        if (!modal) {
            // 降级：浏览器原生确认
            const msg = '⚠️ 高危命令:\n\n' + cmd + '\n\n风险: ' + risk.description + '\n建议: ' + risk.suggestion + '\n\n是否确认执行？';
            if (confirm(msg)) {
                this._sendTerminalEnter(sessionId);
            } else {
                this.socket.emit('terminal_input', { session_id: sessionId, data: '\x03' });
            }
            return;
        }

        // 填充弹窗数据
        const badge = document.getElementById('secRiskBadge');
        const label = document.getElementById('secRiskLabel');
        badge.className = 'security-risk-badge ' + (risk.level || 'high');
        label.textContent = (risk.level || 'high').toUpperCase();

        document.getElementById('secCmdText').textContent = cmd || '';
        document.getElementById('secDescription').textContent = risk.description || '-';
        document.getElementById('secSuggestion').textContent = risk.suggestion || '请仔细核对命令后再执行';

        // 绑定按钮事件
        const confirmBtn = document.getElementById('secConfirmBtn');
        const cancelBtn  = document.getElementById('secCancelBtn');
        const overlayEl  = modal.querySelector('.modal-overlay');

        const cleanup = () => {
            confirmBtn.replaceWith(confirmBtn.cloneNode(true));
            cancelBtn.replaceWith(cancelBtn.cloneNode(true));
            overlayEl.replaceWith(overlayEl.cloneNode(true));
            this.closeModal('securityConfirmModal');
            if (this._secConfirmTimer) {
                clearTimeout(this._secConfirmTimer);
                this._secConfirmTimer = null;
            }
        };

        document.getElementById('secConfirmBtn').addEventListener('click', () => {
            cleanup();
            this._sendTerminalEnter(sessionId);
            this.toast('✅ 命令已确认并发送', 'success');
        });

        document.getElementById('secCancelBtn').addEventListener('click', () => {
            cleanup();
            this.socket.emit('terminal_input', { session_id: sessionId, data: '\x03' });
            this.toast('❌ 命令已取消', 'info');
        });

        // 60 秒超时自动取消
        this._secConfirmTimer = setTimeout(() => {
            cleanup();
            this.toast('⏰ 确认超时，请重新输入命令', 'warning');
        }, 60000);

        this.openModal('securityConfirmModal');
    },

    // ══════════════════════════════
    //  Toast 通知 + 通知中心
    // ══════════════════════════════
    _notifications: [],
    _notifMaxCount: 50,

    toast(message, type = 'info', duration = 3000) {
        // 仅在严重级别（error/warning）写入通知中心，避免信息过载
        // Toast 弹窗本身不受影响，仍然给用户即时视觉反馈
        if (type === 'error' || type === 'warning') {
            this._addNotification(message, type);
        }

        // ── 去重：同一消息 500ms 内不重复弹 ──
        const dedupKey = `${type}:${message}`;
        const now = Date.now();
        if (!this._toastTimers) this._toastTimers = {};
        if (this._toastTimers[dedupKey] && now - this._toastTimers[dedupKey] < 500) {
            return;  // 去重跳过
        }
        this._toastTimers[dedupKey] = now;

        // 渲染 toast
        let container = document.getElementById('toastContainer');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toastContainer';
            container.style.cssText = `
                position:fixed;bottom:20px;right:20px;
                z-index:99999;display:flex;flex-direction:column;
                gap:8px;max-width:360px;
            `;
            document.body.appendChild(container);
        }

        const colors = {
            success:'var(--success-color)', error:'var(--danger-color)',
            warning:'var(--warning-color)', info:'var(--accent-color)',
        };
        const icons = {
            success:'fa-check-circle', error:'fa-times-circle',
            warning:'fa-exclamation-triangle', info:'fa-info-circle',
        };

        const toast = document.createElement('div');
        toast.style.cssText = `
            display:flex;align-items:flex-start;gap:10px;
            padding:12px 14px;
            background:var(--bg-secondary);
            border:1px solid var(--border-color);
            border-left:3px solid ${colors[type]||colors.info};
            border-radius:8px;
            box-shadow:0 4px 20px rgba(0,0,0,0.3);
            font-size:13px;color:var(--text-primary);
            animation:toastIn 0.25s ease;
            max-width:360px;word-break:break-word;
        `;
        toast.innerHTML = `
            <i class="fas ${icons[type]||icons.info}"
               style="color:${colors[type]||colors.info};margin-top:1px;flex-shrink:0;"></i>
            <span style="flex:1;">${this.escapeHtml(message)}</span>
            <button onclick="this.parentElement.remove()"
                    style="background:none;border:none;color:var(--text-secondary);
                           cursor:pointer;padding:0;font-size:12px;flex-shrink:0;">
                <i class="fas fa-times"></i>
            </button>
        `;
        container.appendChild(toast);

        if (duration > 0) {
            setTimeout(() => {
                toast.style.animation = 'toastOut 0.25s ease forwards';
                setTimeout(() => toast.remove(), 250);
            }, duration);
        }
    },

    _addNotification(message, type) {
        this._notifications.unshift({
            id: Date.now(), message, type,
            time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
            read: false,
        });
        if (this._notifications.length > this._notifMaxCount) {
            this._notifications = this._notifications.slice(0, this._notifMaxCount);
        }
        this._updateNotifBadge();
    },

    _updateNotifBadge() {
        const unread = this._notifications.filter(n => !n.read).length;
        const badge = document.getElementById('notifBadge');
        if (badge) {
            badge.textContent = unread > 99 ? '99+' : unread;
            badge.style.display = unread > 0 ? 'flex' : 'none';
        }
    },

    showNotifCenter() {
        document.getElementById('notifCenter')?.remove();
        this._notifications.forEach(n => n.read = true);
        this._updateNotifBadge();

        const panel = document.createElement('div');
        panel.id = 'notifCenter';
        panel.style.cssText = `
            position:fixed;top:48px;right:8px;
            width:340px;max-height:480px;z-index:9998;
            background:var(--bg-secondary);
            border:1px solid var(--border-color);
            border-radius:10px;
            box-shadow:0 8px 32px rgba(0,0,0,0.4);
            display:flex;flex-direction:column;overflow:hidden;
        `;
        const colors = {
            success:'var(--success-color)', error:'var(--danger-color)',
            warning:'var(--warning-color)', info:'var(--accent-color)',
        };

        panel.innerHTML = `
            <div style="display:flex;align-items:center;padding:12px 16px;
                        border-bottom:1px solid var(--border-color);flex-shrink:0;">
                <span style="font-size:13px;font-weight:600;color:var(--text-bright);">
                    <i class="fas fa-bell" style="color:var(--accent-color);margin-right:6px;"></i>
                    通知记录
                </span>
                <button onclick="App._notifications=[];App._updateNotifBadge();
                                 document.getElementById('notifCenter').remove()"
                        class="btn btn-sm" style="margin-left:auto;font-size:11px;">清空</button>
            </div>
            <div style="overflow-y:auto;flex:1;">
                ${this._notifications.length === 0
                    ? `<div style="padding:40px;text-align:center;color:var(--text-secondary);font-size:13px;">
                           <i class="fas fa-bell-slash" style="font-size:24px;display:block;margin-bottom:8px;opacity:0.3;"></i>
                           暂无通知
                       </div>`
                    : this._notifications.map(n => `
                        <div style="display:flex;align-items:flex-start;gap:10px;
                                    padding:10px 16px;border-bottom:1px solid var(--border-color);
                                    font-size:12px;">
                            <div style="width:6px;height:6px;border-radius:50%;
                                        background:${colors[n.type]||colors.info};
                                        margin-top:4px;flex-shrink:0;"></div>
                            <div style="flex:1;min-width:0;">
                                <div style="color:var(--text-primary);word-break:break-word;">
                                    ${this.escapeHtml(n.message)}
                                </div>
                                <div style="color:var(--text-secondary);font-size:10px;margin-top:2px;">
                                    ${n.time}
                                </div>
                            </div>
                        </div>
                    `).join('')}
            </div>
        `;
        document.body.appendChild(panel);

        setTimeout(() => {
            const close = (e) => {
                if (!panel.contains(e.target) &&
                    !e.target.closest('[onclick*="showNotifCenter"]')) {
                    panel.remove();
                    document.removeEventListener('click', close);
                }
            };
            document.addEventListener('click', close);
        }, 0);
    },

    // ══════════════════════════════
    //  工具
    // ══════════════════════════════
    escapeHtml(text) {
        if (text == null) return '';
        const d = document.createElement('div');
        d.textContent = String(text);
        return d.innerHTML;
    },

    /**
     * 格式化诊断/摘要文本：去缩进 + 自动补句号
     */
    _formatDiagnosisText(text) {
        if (text == null || typeof text !== 'string' || !text.trim()) return '';
        let t = text.trim();
        // 末尾如果不是标点符号则补中文句号
        const last = t[t.length - 1];
        if (!/[。！？.!?…~」』）\)"」】〗\u2026\u203C\u2047-\u2049]$/.test(last)) {
            t += '。';
        }
        return t;
    },

    destroy() {
        if (this._beforeUnloadHandler) {
            window.removeEventListener('beforeunload', this._beforeUnloadHandler);
            this._beforeUnloadHandler = null;
        }
        // 🔧 清理所有 Socket 监听器
        this._cleanupSocketListeners();
        if (this.socket) { this.socket.disconnect(); this.socket = null; }
        Object.keys(this.sessions).forEach(sid => {
            if (typeof Monitor !== 'undefined') Monitor.destroy(sid);
            if (typeof terminalManager !== 'undefined') terminalManager.destroy(sid);
        });
        this.sessions     = {};
        this.activeSession = null;
    },
    /**
     * 创建会话 UI - 添加 AI 诊断 Tab
     * 替换原有的 _createSessionUI 方法
     */
    _createSessionUI(sessionId) {
        window.Dashboard?.stop();
        window.FeaturePage?.onSessionOpen();
        const quickPrompts = [
            '检查系统健康状态',
            '内存占用最高的进程',
            '检查磁盘空间',
            '查看最近的系统错误',
        ];
        const quickHtml = quickPrompts.map(q => `
            <span onclick="AIAssistant.sendQuick('${sessionId}', '${q.replace(/'/g, "\\'")}')"
                style="font-size:11px;padding:3px 10px;border-radius:12px;
                        cursor:pointer;background:var(--bg-tertiary);
                        color:var(--text-secondary);
                        border:1px solid var(--border-color);
                        transition:all 0.2s;user-select:none;"
                onmouseenter="this.style.borderColor='var(--accent-color)';
                                this.style.color='var(--accent-color)'"
                onmouseleave="this.style.borderColor='var(--border-color)';
                                this.style.color='var(--text-secondary)'">
                ${q}
            </span>
        `).join('');
        const session = this.sessions[sessionId];

        document.getElementById('tabBar').classList.add('visible');
        document.getElementById('panelsContainer').classList.add('visible');
        document.getElementById('welcomePage').style.display = 'none';

        // 标签
        const tab = document.createElement('div');
        tab.className = 'tab-item';
        tab.id = `tab-${sessionId}`;
        tab.onclick = () => this.switchSession(sessionId);
        tab.innerHTML = `
            <div class="tab-indicator" style="background:${session.color}"></div>
            <span class="tab-name">${this.escapeHtml(session.connName)}</span>
            <span class="tab-split-btn" title="分屏"
                onclick="event.stopPropagation();App.toggleSplitView('${sessionId}')">
                <i class="fas fa-columns"></i>
            </span>
            <span class="tab-close"
                onclick="event.stopPropagation();App.closeSession('${sessionId}')">
                <i class="fas fa-times"></i>
            </span>`;
        document.getElementById('tabList').appendChild(tab);

        // 面板
        const panel = document.createElement('div');
        panel.className = 'panel';
        panel.id = `panel-${sessionId}`;
        panel.innerHTML = `
            <div class="panel-tabs">
                <div class="panel-tab active" data-tab="terminal"
                    onclick="App.switchPanelTab('${sessionId}','terminal')">
                    <i class="fas fa-terminal"></i> <span>终端</span>
                </div>
                <div class="panel-tab" data-tab="files"
                    onclick="App.switchPanelTab('${sessionId}','files')">
                    <i class="fas fa-folder-open"></i> <span>文件</span>
                </div>
                <div class="panel-tab" data-tab="monitor"
                    onclick="App.switchPanelTab('${sessionId}','monitor')">
                    <i class="fas fa-chart-line"></i> <span>监控</span>
                </div>
                <div class="panel-tab" data-tab="commands"
                    onclick="App.switchPanelTab('${sessionId}','commands')">
                    <i class="fas fa-bolt"></i> <span>命令</span>
                </div>
                <div class="panel-tab" data-tab="ai-diagnose"
                    onclick="App.switchPanelTab('${sessionId}','ai-diagnose')">
                    <i class="fas fa-robot" style="color: var(--accent-color);"></i> <span>AI 助手</span>
                </div>
                <div class="panel-tab" data-tab="topology"
                    onclick="App.switchPanelTab('${sessionId}','topology')">
                    <i class="fas fa-project-diagram"></i> <span>拓扑图</span>
                </div>
                <div class="panel-tab" data-tab="knowledge"
                    onclick="App.switchPanelTab('${sessionId}','knowledge')">
                    <i class="fas fa-book"></i> <span>知识库</span>
                </div>
                <!-- 右侧：全局悬浮窗按钮 -->
                <div class="panel-tabs-right">
                    <button class="btn-icon" onclick="AIAssistant.toggleGlobalFloat()"
                            title="智能助手悬浮窗" id="panelFloatBtn-${sessionId}">
                        <i class="fas fa-comment-dots"></i>
                    </button>
                </div>
            </div>

            <!-- ===== 终端面板 ===== -->
            <div class="panel-content active" id="panel-terminal-${sessionId}">
            <div class="terminal-wrapper" style="display:flex;flex-direction:column;flex:1;min-height:0;">

                <!-- 连接中遮罩 -->
                <div class="connecting-overlay" style="display:flex;flex-direction:column;
                     align-items:center;justify-content:center;flex:1;">
                    <div class="connecting-spinner"></div>
                    <p>正在连接到 ${this.escapeHtml(session.connName)}...</p>
                </div>

                <!-- 终端容器 -->
                <div id="terminal-${sessionId}" style="flex:1;min-height:0;display:none;"></div>

                <!-- 终端底部快捷栏 -->
                <div class="terminal-toolbar" id="termToolbar-${sessionId}"
                     style="display:none;">
                    <div class="term-toolbar-left">
                        <button class="term-tool-btn" title="清屏 (Ctrl+L)"
                                onclick="App._termClear('${sessionId}')">
                            <i class="fas fa-eraser"></i>
                        </button>
                        <button class="term-tool-btn" title="复制选中内容"
                                onclick="App._termCopy('${sessionId}')">
                            <i class="fas fa-copy"></i>
                        </button>
                        <button class="term-tool-btn" title="粘贴"
                                onclick="App._termPaste('${sessionId}')">
                            <i class="fas fa-paste"></i>
                        </button>
                        <div class="term-tool-sep"></div>
                        <button class="term-tool-btn" title="字体缩小"
                                onclick="App._termFontSize('${sessionId}', -1)">
                            <i class="fas fa-search-minus"></i>
                        </button>
                        <span id="termFontSize-${sessionId}"
                              style="font-size:11px;color:var(--text-secondary);min-width:28px;text-align:center;">
                            14
                        </span>
                        <button class="term-tool-btn" title="字体放大"
                                onclick="App._termFontSize('${sessionId}', 1)">
                            <i class="fas fa-search-plus"></i>
                        </button>
                        <div class="term-tool-sep"></div>
                        <button class="term-tool-btn" title="分屏"
                                onclick="App.toggleSplitView('${sessionId}')">
                            <i class="fas fa-columns"></i>
                        </button>
                    </div>
                    <div class="term-toolbar-right">
                        <span id="termConnStatus-${sessionId}"
                              style="font-size:10px;color:var(--success-color);">
                            <i class="fas fa-circle" style="font-size:7px;"></i> 已连接
                        </span>
                        <span style="font-size:10px;color:var(--text-secondary);margin-left:8px;"
                              id="termSessionId-${sessionId}">
                            ${sessionId.slice(-8)}
                        </span>
                    </div>
                </div>
            </div>
            </div>

            <!-- ===== 文件管理器 ===== -->
            <div class="panel-content" id="panel-files-${sessionId}">
            <div class="file-manager" id="files-${sessionId}">
                <div class="fm-toolbar">
                    <button class="btn btn-sm" onclick="FileManager.goBack()" title="后退">
                        <i class="fas fa-arrow-left"></i>
                    </button>
                    <button class="btn btn-sm" onclick="FileManager.goForward()" title="前进">
                        <i class="fas fa-arrow-right"></i>
                    </button>
                    <button class="btn btn-sm" onclick="FileManager.goUp()" title="上级">
                        <i class="fas fa-level-up-alt"></i>
                    </button>
                    <div class="fm-path">
                        <input type="text" class="fm-path-input" value="/"
                            onkeypress="if(event.key==='Enter')FileManager.goToPath(this)">
                    </div>
                    <button class="btn btn-sm" onclick="FileManager.refresh()" title="刷新">
                        <i class="fas fa-sync-alt"></i>
                    </button>
                    <button class="btn btn-sm" onclick="FileManager.createFolder()" title="新建文件夹">
                        <i class="fas fa-folder-plus"></i>
                    </button>
                    <button class="btn btn-sm btn-primary" onclick="FileManager.uploadFile()">
                        <i class="fas fa-upload"></i> 上传
                    </button>
                </div>
                <div class="fm-content"></div>
            </div>
            </div>

            <!-- ===== 系统监控 ===== -->
            <div class="panel-content" id="panel-monitor-${sessionId}">
            <div class="system-monitor" id="monitor-${sessionId}">
                <div class="fm-empty" style="margin-top:80px">
                    <i class="fas fa-chart-line"
                    style="font-size:48px;display:block;margin-bottom:16px;
                            color:var(--text-secondary)"></i>
                    <p style="color:var(--text-secondary)">加载监控数据...</p>
                </div>
            </div>
            </div>

            <!-- ===== 快捷命令 ===== -->
            <div class="panel-content" id="panel-commands-${sessionId}">
            <div class="cmd-panel" id="cmd-${sessionId}">
                <div class="cmd-panel-header">
                    <h4><i class="fas fa-bolt"></i> 快捷命令</h4>
                    <button class="btn btn-sm btn-primary"
                            onclick="CommandManager.showAddDialog()">
                        <i class="fas fa-plus"></i> 添加
                    </button>
                </div>
                <div class="cmd-list"></div>
            </div>
            </div>

            <!-- ===== AI 诊断面板 ===== -->
            <div class="panel-content" id="panel-ai-diagnose-${sessionId}">
            <div class="ai-diagnose-panel" id="ai-diagnose-${sessionId}" style="display:flex;">
                <div class="ai-diagnose-container">
                    <!-- ══ Header 区：标题 + 状态（固定） ══ -->
                    <div class="ai-diagnose-header">
                        <div class="ai-diagnose-title">
                            <div class="ai-header-icon diagnose">
                                <i class="fas fa-robot"></i>
                            </div>
                            <div>
                                <h3>AI 运维副驾驶</h3>
                                <span class="ai-subtitle">基于 Groq LLM 的智能诊断，自动分析系统状态并给出修复建议</span>
                            </div>
                        </div>
                        <div class="ai-status" id="aiStatus-${sessionId}">
                            <span class="status-dot loading"></span>
                            <span class="status-text">检查中...</span>
                        </div>
                    </div>

                    <!-- ══ 操作栏：按钮 + 提示（固定） ══ -->
                    <div class="ai-diagnose-actions">
                        <div class="action-buttons">
                            <button class="ai-btn-primary diagnose" onclick="App.runAIDiagnosis('${sessionId}')"
                                    id="aiDiagnoseBtn-${sessionId}">
                                <i class="fas fa-stethoscope"></i> 开始诊断
                            </button>
                            <button class="ai-btn-secondary" onclick="App.exportDiagnosisReport('${sessionId}')"
                                    id="aiExportBtn-${sessionId}" disabled>
                                <i class="fas fa-file-export"></i> 导出报告
                            </button>
                        </div>
                        <div class="action-hint">
                            <i class="fas fa-info-circle"></i> 诊断将收集 top, df -h, dmesg 等数据
                        </div>
                    </div>

                    <!-- ══ 快捷问题（固定） ══ -->
                    <div class="ai-diagnose-quick">
                        <span class="quick-label">
                            <i class="fas fa-bolt"></i> 快捷诊断：
                        </span>
                        ${quickHtml}
                    </div>

                    <!-- ══ 诊断结果（可滚动） ══ -->
                    <div class="ai-diagnose-result" id="diagnosisResult-${sessionId}">
                        <div class="ai-empty-state">
                            <div class="ai-empty-icon diagnose">
                                <i class="fas fa-robot"></i>
                            </div>
                            <p style="font-size:14px;font-weight:600;color:var(--text-bright);margin:0 0 6px;">
                                准备好了吗？
                            </p>
                            <p style="font-size:13px;color:var(--text-secondary);margin:0;line-height:1.6;">
                                点击「开始诊断」让 AI 分析系统状态<br>分析结果将包含诊断摘要、详细分析和修复命令
                            </p>
                        </div>
                    </div>
                </div>
            </div>
            </div>

            <!-- ===== 拓扑图面板 ===== -->
            <div class="panel-content" id="panel-topology-${sessionId}">
            <div class="topology-panel" id="topology-${sessionId}"
                style="display:flex; flex:1; overflow-y:auto; padding:20px; background: var(--bg-primary);">
            </div>
            </div>

            <!-- ===== 知识库面板 ===== -->
            <div class="panel-content" id="panel-knowledge-${sessionId}">
            <div class="knowledge-panel" id="knowledge-${sessionId}"
                style="display:flex; flex:1; overflow-y:auto; padding:20px; background: var(--bg-primary);">
            </div>
            </div>
        `;
        document.getElementById('panelsContainer').appendChild(panel);

        // ✅ 直接保存 AI 状态元素的 DOM 引用，避免 getElementById 找不到的问题
        session._aiStatusEl = panel.querySelector(`[id="aiStatus-${sessionId}"]`);

        // 初始化终端
        const termContainer = document.getElementById(`terminal-${sessionId}`);
        if (typeof terminalManager !== 'undefined') {
            const term = terminalManager.create(sessionId, termContainer);
            // 🔧 Ctrl+C 选中复制 / Ctrl+V 粘贴（不再依赖后端 SIGINT 处理复制场景）
            term.attachCustomKeyEventHandler((e) => {
                if (e.ctrlKey && !e.shiftKey && e.key === 'c' && term.hasSelection()) {
                    // 防抖：300ms 内不重复处理（修复 xterm keydown+keypress 双事件触发）
                    const now = Date.now();
                    if (this._lastCtrlC && now - this._lastCtrlC < 300) return false;
                    this._lastCtrlC = now;
                    const sel = term.getSelection();
                    if (sel) {
                        navigator.clipboard.writeText(sel).then(() => {
                            this.toast('已复制', 'success');
                        }).catch(() => {
                            this.toast('复制失败，请用工具栏按钮', 'warning');
                        });
                    }
                    return false; // 阻止事件传递到终端，不发 SIGINT
                }
                if (e.ctrlKey && !e.shiftKey && e.key === 'v') {
                    navigator.clipboard.readText().then(text => {
                        if (text && this.socket) {
                            this.socket.emit('terminal_input', { session_id: sessionId, data: text });
                        }
                    }).catch(() => {});
                    return false;
                }
                return true; // 其他按键正常传递
            });
            // 🔧 终端右键菜单：有选中文本时复制，无选中时粘贴
            term.element?.addEventListener('contextmenu', (e) => {
                if (term.hasSelection()) {
                    e.preventDefault();
                    const sel = term.getSelection();
                    if (sel) {
                        navigator.clipboard.writeText(sel).then(() => {
                            this.toast('已复制', 'success');
                        }).catch(() => {});
                    }
                } else {
                    e.preventDefault();
                    navigator.clipboard.readText().then(text => {
                        if (text && this.socket) {
                            this.socket.emit('terminal_input', { session_id: sessionId, data: text });
                            this.toast('已粘贴', 'info');
                        }
                    }).catch(() => {});
                }
            });
            // 🔧 高危命令实时监测：逐字符缓冲，回车前调用后端 API 分析风险
            if (!this._termBuffers) this._termBuffers = {};
            this._termBuffers[sessionId] = '';

            term.onData(data => {
                const cleaned = data.replace(/\r\n/g, '\r').replace(/\n/g, '\r');

                // ── Enter 键：检查缓冲命令行风险 ──
                if (cleaned === '\r') {
                    const cmd = (this._termBuffers[sessionId] || '').trim();
                    this._termBuffers[sessionId] = '';
                    if (cmd && this._isCommandPotentiallyRisky(cmd)) {
                        this._checkTerminalRisk(sessionId, cmd);
                        return;
                    }
                    this.socket.emit('terminal_input', { session_id: sessionId, data: '\r' });
                    return;
                }

                // ── Ctrl+C：清空缓冲区 ──
                if (cleaned === '\x03') {
                    this._termBuffers[sessionId] = '';
                    this.socket.emit('terminal_input', { session_id: sessionId, data: '\x03' });
                    return;
                }

                // ── 退格键 ──
                if (cleaned === '\x7f' || cleaned === '\b') {
                    const buf = this._termBuffers[sessionId] || '';
                    this._termBuffers[sessionId] = buf.slice(0, -1);
                    this.socket.emit('terminal_input', { session_id: sessionId, data: cleaned });
                    return;
                }

                // ── 可打印 ASCII 单字符 ──
                if (cleaned.length === 1) {
                    const code = cleaned.charCodeAt(0);
                    if (code >= 0x20 && code <= 0x7E) {
                        this._termBuffers[sessionId] = (this._termBuffers[sessionId] || '') + cleaned;
                    }
                }

                this.socket.emit('terminal_input', { session_id: sessionId, data: cleaned });
            });
            term.onResize(s => {
                this.socket.emit('terminal_resize', { session_id: sessionId, cols: s.cols, rows: s.rows });
            });
        }

        this.switchSession(sessionId);
        setTimeout(() => {
            if (typeof AIAssistant !== 'undefined') {
                AIAssistant.init(sessionId);
            }
        }, 300);
        this.updateActiveSessionCount();
        
        // ✅ AI 状态检查统一由 terminal_connected 回调触发（此时会话完全就绪）
    },
    
    /**
     * 检查 AI 服务状态
     * @param {string} sessionId - 会话 ID
     * @param {number} retryCount - 内部重试计数（含元素查找 + API 重试）
     */
    async checkAIStatus(sessionId, retryCount = 0) {
        // ✅ 优先使用创建 panel 时保存的直接 DOM 引用，避免 getElementById 找不到
        const session = this.sessions[sessionId];
        let statusEl = session?._aiStatusEl;
        
        // 兜底：如果引用丢失，尝试 DOM 查找
        if (!statusEl) {
            statusEl = document.getElementById(`aiStatus-${sessionId}`);
        }

        // 元素不存在则直接跳过（不再重试，避免控制台日志洪水）
        if (!statusEl) {
            return;
        }

        // API 请求最多重试 2 次
        const MAX_API_RETRIES = 2;
        if (retryCount >= MAX_API_RETRIES) {
            statusEl.innerHTML = `<span class="status-dot error"></span><span class="status-text">检查超时</span>`;
            return;
        }

        const attemptLabel = retryCount > 0 ? ` (重试${retryCount})` : '';
        statusEl.innerHTML = `<span class="status-dot loading"></span><span class="status-text">检查中${attemptLabel}...</span>`;

        try {
            console.log(`[AI状态] 正在检查 AI 状态${attemptLabel}...`);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => {
                console.warn('[AI状态] fetch 超时，主动中止');
                controller.abort();
            }, 8000);

            let response;
            try {
                response = await fetch('/api/ai/status', {
                    headers: this.authHeaders(),
                    signal: controller.signal,
                });
            } finally {
                clearTimeout(timeoutId);
            }

            console.log('[AI状态] 响应状态:', response.status);

            const contentType = response.headers.get('content-type') || '';
            if (!contentType.includes('application/json')) {
                const text = await response.text();
                console.error('[AI状态] 非 JSON 响应:', text.substring(0, 200));
                throw new Error(`服务器返回异常 (HTTP ${response.status})`);
            }

            const data = await response.json();
            console.log('[AI状态] 响应数据:', data);

            if (data.status === 'ok' && data.data) {
                const info = data.data;
                if (info.ready) {
                    statusEl.innerHTML = `<span class="status-dot ready"></span><span class="status-text">Groq 已就绪 (${info.model || '默认模型'})</span>`;
                } else {
                    const reason = info.message || info.error || 'AI 服务未启用';
                    if (reason.includes('未配置') || reason.includes('API Key') || reason.includes('api_key')) {
                        statusEl.innerHTML = `<span class="status-dot error"></span><span class="status-text">请配置 AI (设置→AI配置)</span>`;
                    } else {
                        statusEl.innerHTML = `<span class="status-dot error"></span><span class="status-text">${reason}</span>`;
                    }
                }
            } else {
                throw new Error(data.message || data.error || 'API 返回异常状态');
            }
        } catch (e) {
            console.error('[AI状态] 检查失败:', e.name, e.message);
            // 失败时自动重试（最多重试 2 次）
            if (retryCount < MAX_API_RETRIES - 1) {
                setTimeout(() => this.checkAIStatus(sessionId, retryCount + 1), 1500);
                return;
            }
            // 重试耗尽，显示错误
            if (e.name === 'AbortError' || (e.message && e.message.includes('timeout'))) {
                statusEl.innerHTML = `<span class="status-dot error"></span><span class="status-text">连接超时</span>`;
            } else if (e.message && e.message.includes('HTTP 5')) {
                statusEl.innerHTML = `<span class="status-dot error"></span><span class="status-text">服务器错误</span>`;
            } else {
                statusEl.innerHTML = `<span class="status-dot error"></span><span class="status-text">${e.message || '连接失败'}</span>`;
            }
        }
    },

    /**
     * 运行 AI 诊断
     */
    async runAIDiagnosis(sessionId) {
        const btnEl = document.getElementById(`aiDiagnoseBtn-${sessionId}`);
        const resultContainer = document.getElementById(`diagnosisResult-${sessionId}`);
        const exportBtn = document.getElementById(`aiExportBtn-${sessionId}`);
        if (!resultContainer) return;

        // 显示加载状态
        if (btnEl) {
            btnEl.disabled = true;
            btnEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 诊断中...';
        }

        resultContainer.innerHTML = `
            <div class="ai-loading-state">
                <div class="ai-loading-spinner"></div>
                <p style="font-size:14px;font-weight:600;color:var(--text-bright);margin:0 0 6px;">
                    AI 正在分析系统状态...
                </p>
                <p style="font-size:12px;color:var(--text-secondary);margin:0;">
                    正在采集 top · df -h · dmesg · netstat 等数据，预计 15~30 秒
                </p>
            </div>`;

        try {
            const response = await fetch('/api/ai/diagnose', {
                method: 'POST',
                headers: this.authHeaders(),
                body: JSON.stringify({ session_id: sessionId })
            });

            // ✅ 先检查 Content-Type，防止解析 HTML
            const contentType = response.headers.get('content-type') || '';
            if (!contentType.includes('application/json')) {
                throw new Error(`服务器返回非 JSON 响应 (HTTP ${response.status})，请检查后端日志`);
            }

            const data = await response.json();

            if (!response.ok || data.status !== 'ok') {
                throw new Error(data.message || `请求失败 (HTTP ${response.status})`);
            }

            const report = data.data;
            this._lastDiagnosisReport = report;
            this._lastDiagnosisSessionId = sessionId;
            this._lastDiagnosisTimestamp = Date.now();  // 🔧 记录诊断时间戳，用于过期校验

            if (exportBtn) exportBtn.disabled = false;

            this._renderDiagnosisReport(sessionId, report);
            this.toast('AI 诊断完成', 'success');

        } catch (error) {
            console.error('[AI Diagnose] 失败:', error);
            resultContainer.innerHTML = `
                <div class="ai-error-state" style="text-align:center;">
                    <i class="fas fa-exclamation-circle"
                    style="color:var(--danger-color); font-size:28px; display:block; margin-bottom:12px;"></i>
                    <div style="color:var(--danger-color); font-weight:700; font-size:14px; margin-bottom:6px;">诊断失败</div>
                    <div style="color:var(--text-secondary); font-size:13px; line-height:1.6; margin-bottom:12px;">
                        ${this.escapeHtml(error.message)}
                    </div>
                    <div style="font-size:12px; color:var(--text-secondary); text-align:left;
                                display:inline-block; margin-bottom:14px;">
                        <strong style="color:var(--text-bright);">排查建议：</strong><br>
                        <span style="line-height:1.8;">1. 确认后端已设置 <code>GROQ_API_KEY</code> 环境变量</span><br>
                        <span style="line-height:1.8;">2. 确认 <code>AI_ENABLED=true</code></span><br>
                        <span style="line-height:1.8;">3. 确认当前会话仍处于连接状态</span><br>
                        <span style="line-height:1.8;">4. 查看后端控制台日志</span>
                    </div>
                    <br>
                    <button class="ai-btn-secondary" onclick="App.runAIDiagnosis('${sessionId}')">
                        <i class="fas fa-redo"></i> 重试
                    </button>
                </div>`;
            this.toast('AI 诊断失败: ' + error.message, 'error');
        } finally {
            if (btnEl) {
                btnEl.disabled = false;
                btnEl.innerHTML = '<i class="fas fa-stethoscope"></i> 开始诊断';
            }
        }
    },

    /**
     * 渲染诊断报告
     */
    _renderDiagnosisReport(sessionId, report) {
        const resultContainer = document.getElementById(`diagnosisResult-${sessionId}`);
        if (!resultContainer) return;

        // 构建命令 HTML
        let commandsHtml = '';
        if (report.commands && report.commands.length > 0) {
            commandsHtml = `
                <div style="margin-top:18px;">
                    <h4 style="color: var(--text-bright); margin:0 0 10px; font-size:14px; font-weight:700;">
                        <i class="fas fa-terminal" style="color: var(--success-color); margin-right:6px;"></i>建议修复命令
                    </h4>
                    ${report.commands.map((cmd, idx) => `
                        <div style="display:flex; align-items:center; gap:10px; background: var(--bg-tertiary); padding:12px 14px; border-radius:10px; margin-bottom:7px; border-left:3px solid var(--success-color);">
                            <span style="color: var(--text-secondary); font-weight:600; font-size:11px; min-width:24px;">#${idx + 1}</span>
                            <code style="flex:1; color: var(--text-bright); font-family: 'Consolas', monospace; font-size:12px; word-break:break-all;">${this.escapeHtml(cmd)}</code>
                            <button class="btn btn-sm btn-primary" onclick="App.executeAIDiagnosisCommand('${sessionId}', '${this.escapeHtml(cmd)}')" style="flex-shrink:0;border-radius:8px;">
                                <i class="fas fa-play"></i> 执行
                            </button>
                        </div>
                    `).join('')}
                    <div style="font-size:11px; color: var(--text-secondary); margin-top:8px; display:flex; align-items:center; gap:4px;">
                        <i class="fas fa-shield-alt"></i> 执行命令前请仔细确认，建议在测试环境先验证
                    </div>
                </div>
            `;
        }

        // 构建建议 HTML
        let recommendationsHtml = '';
        if (report.recommendations && report.recommendations.length > 0) {
            recommendationsHtml = `
                <div style="margin-top:14px;">
                    <h4 style="color: var(--text-bright); margin:0 0 10px; font-size:14px; font-weight:700;">
                        <i class="fas fa-lightbulb" style="color: var(--warning-color); margin-right:6px;"></i>修复建议
                    </h4>
                    <ul style="margin:0; padding:14px 14px 14px 36px; color: var(--text-primary); background: var(--bg-tertiary); border-radius:10px; border:1px solid var(--border-color);">
                        ${report.recommendations.map(rec => `<li style="margin-bottom:4px;">${this.escapeHtml(rec)}</li>`).join('')}
                    </ul>
                </div>
            `;
        }

        resultContainer.innerHTML = `
            <div class="ai-card" style="padding:28px;">
                <!-- 摘要 -->
                <div style="display:flex; align-items:flex-start; gap:14px; margin-bottom:18px; padding-bottom:18px; border-bottom:1px solid var(--border-color);">
                    <div style="width:44px; height:44px; background: linear-gradient(135deg,rgba(79,195,247,0.15),rgba(79,195,247,0.05)); border-radius:14px; display:flex; align-items:center; justify-content:center; flex-shrink:0; box-shadow:0 4px 14px rgba(79,195,247,0.1);">
                        <i class="fas fa-robot" style="color: var(--accent-color); font-size:20px;"></i>
                    </div>
                    <div style="flex:1;">
                        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                            <span style="font-size:11px; background: rgba(80,200,120,0.12); color:var(--success-color); padding:3px 12px; border-radius:20px; font-weight:600;">✓ 诊断完成</span>
                            <span style="font-size:11px; color: var(--text-secondary);">
                                <i class="far fa-clock" style="margin-right:3px;"></i>${new Date().toLocaleString()}
                            </span>
                        </div>
                        <div style="font-size:1rem; font-weight:700; color: var(--text-bright); margin-top:6px;">
                            ${this.escapeHtml(report.summary || '诊断报告')}
                        </div>
                    </div>
                </div>

                <!-- 诊断详情 -->
                <div style="margin-bottom:14px;">
                    <h4 style="color: var(--text-bright); margin:0 0 10px; font-size:14px; font-weight:700;">
                        <i class="fas fa-search" style="color: var(--info-color); margin-right:6px;"></i>诊断详情
                    </h4>
                    <div style="color: var(--text-primary); line-height:1.8; white-space:pre-wrap; background: var(--bg-tertiary); padding:16px; border-radius:10px; font-size:13px; border:1px solid var(--border-color);">
                        ${this.escapeHtml(report.diagnosis || '无详细信息')}
                    </div>
                </div>

                <!-- 建议 -->
                ${recommendationsHtml}

                <!-- 命令 -->
                ${commandsHtml}

                <!-- 免责声明 -->
                <div style="margin-top:18px; padding:14px 18px; background: rgba(255,167,38,0.06); border-radius:12px; border:1px solid rgba(255,167,38,0.15); font-size:12px; color: var(--text-secondary); display:flex; align-items:flex-start; gap:8px;">
                    <i class="fas fa-exclamation-triangle" style="color: var(--warning-color); margin-top:1px; flex-shrink:0;"></i>
                    <span>AI 生成的诊断结果仅供参考，请结合实际情况判断。高危操作建议先在测试环境验证。</span>
                </div>
            </div>
        `;
    },

    /**
     * 执行 AI 诊断建议的命令
     */
    executeAIDiagnosisCommand(sessionId, command) {
        if (!sessionId || !command) return;
        
        // 二次确认 - 显示更详细的确认对话框
        if (!confirm(`⚠️ 确认执行以下命令？\n\n${command}\n\n请确认你了解此命令的作用和潜在风险。`)) return;
        
        // 发送命令到终端
        this.socket.emit('terminal_input', {
            session_id: sessionId,
            data: command + '\n'
        });
        
        // 切换到终端标签页
        const panel = document.getElementById(`panel-${sessionId}`);
        if (panel) {
            const termTab = panel.querySelector('.panel-tab[data-tab="terminal"]');
            if (termTab) {this.switchPanelTab(sessionId, 'terminal', termTab);}
            else {
                // 降级：直接切换到终端
                App.switchSession(sessionId);
            }
        }
        this.toast('命令已发送到终端', 'success');
    },

    /**
     * 导出诊断报告
     */
    exportDiagnosisReport(sessionId) {
        // 🔧 修复：增加 sessionId 和时间戳校验，防止导出过时或错误的诊断报告
        if (!this._lastDiagnosisReport) {
            this.toast('没有可导出的报告，请先执行诊断', 'warning');
            return;
        }

        // 校验 sessionId 是否匹配
        if (this._lastDiagnosisSessionId && this._lastDiagnosisSessionId !== sessionId) {
            this.toast('当前诊断报告属于其他会话，请对该会话重新执行诊断', 'warning');
            return;
        }

        // 校验报告是否过期（超过 30 分钟）
        if (this._lastDiagnosisTimestamp) {
            const age = Date.now() - this._lastDiagnosisTimestamp;
            if (age > 30 * 60 * 1000) {
                this.toast('诊断报告已过期（超过30分钟），请重新执行诊断', 'warning');
                return;
            }
        }

        const report = this._lastDiagnosisReport;
        const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
        const session = this.sessions[sessionId];
        const hostname = session ? session.connName : 'unknown';
        
        // 生成 Markdown 格式报告
        let markdown = `# AI 诊断报告\n\n`;
        markdown += `**生成时间**: ${new Date().toLocaleString()}\n`;
        markdown += `**目标主机**: ${hostname}\n\n`;
        markdown += `---\n\n`;
        markdown += `## 📊 诊断摘要\n\n${report.summary || '无'}\n\n`;
        markdown += `## 🔍 诊断详情\n\n${report.diagnosis || '无'}\n\n`;
        
        if (report.recommendations && report.recommendations.length > 0) {
            markdown += `## 💡 修复建议\n\n`;
            report.recommendations.forEach((rec, i) => {
                markdown += `${i + 1}. ${rec}\n`;
            });
            markdown += '\n';
        }
        
        if (report.commands && report.commands.length > 0) {
            markdown += `## 🛠️ 建议命令\n\n`;
            report.commands.forEach((cmd, i) => {
                markdown += `${i + 1}. \`${cmd}\`\n`;
            });
            markdown += '\n';
        }
        
        markdown += `---\n`;
        markdown += `*🤖 本报告由 WebTerminal AI 运维副驾驶生成*\n`;
        markdown += `*⚠️ 诊断结果仅供参考，请结合实际情况判断*\n`;

        // 下载报告 - 使用 Blob
        try {
            const blob = new Blob([markdown], { 
                type: 'text/markdown;charset=utf-8' 
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `诊断报告_${hostname}_${timestamp}.md`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            
            // 延迟释放 URL
            setTimeout(() => URL.revokeObjectURL(url), 30000);
            
            this.toast('报告导出成功', 'success');
        } catch (error) {
            console.error('导出报告失败:', error);
            this.toast('导出报告失败: ' + error.message, 'error');
        }
    },

    /**
     * 🆕 切换面板 Tab（v2.5 增强版 — 使用统一 panel-content 架构 + 状态持久化）
     */
    switchPanelTab(sessionId, tabName, el) {
        const panel = document.getElementById(`panel-${sessionId}`);
        if (!panel) return;

        // 0. 🔧 清理所有内层面板状态（移除 active 类 + 重置 inline display，防止叠加）
        ['.terminal-wrapper', '.file-manager', '.system-monitor',
         '.cmd-panel', '.ai-diagnose-panel', '.topology-panel', '.knowledge-panel'
        ].forEach(sel => {
            const inner = panel.querySelector(sel);
            if (inner) { inner.classList.remove('active'); inner.style.display = ''; }
        });

        // 1. 更新 Tab 高亮
        panel.querySelectorAll('.panel-tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === tabName);
        });

        // 2. 切换 panel-content 包裹层
        panel.querySelectorAll('.panel-content').forEach(c => {
            c.classList.remove('active');
        });
        const target = panel.querySelector(`#panel-${tabName}-${sessionId}`);
        if (target) {
            target.classList.add('active');
        }

        // 3. 🔧 激活内层面板（直接查询内层元素，不再用 target || fallback）
        switch (tabName) {
            case 'terminal': {
                const tw = panel.querySelector('.terminal-wrapper');
                if (tw) { tw.style.display = 'flex'; tw.classList.add('active'); }
                setTimeout(() => {
                    this._fitAndSync(sessionId);
                    if (typeof terminalManager !== 'undefined') terminalManager.focus(sessionId);
                }, 50);
                break;
            }
            case 'files': {
                const fm = panel.querySelector('.file-manager');
                if (fm) fm.classList.add('active');
                if (typeof FileManager !== 'undefined') {
                    FileManager.currentSessionId = sessionId;
                    FileManager.init(sessionId);
                }
                break;
            }
            case 'monitor': {
                const sm = panel.querySelector('.system-monitor');
                if (sm) sm.classList.add('active');
                if (typeof Monitor !== 'undefined') {
                    Monitor.start(sessionId);
                    setTimeout(() => Monitor.resize(sessionId), 50);
                }
                break;
            }
            case 'commands': {
                const cp = panel.querySelector('.cmd-panel');
                if (cp) cp.classList.add('active');
                if (typeof CommandManager !== 'undefined') CommandManager.renderPanel();
                break;
            }
            case 'ai-diagnose': {
                const aiPanel = panel.querySelector('.ai-diagnose-panel');
                if (aiPanel && typeof AIAssistant !== 'undefined') {
                    AIAssistant.init(sessionId);
                }
                break;
            }
            case 'topology': {
                const topoPanel = panel.querySelector('.topology-panel');
                if (topoPanel) {
                    topoPanel.classList.add('active');
                    if (!this._topoInitialized) this._topoInitialized = {};
                    if (!this._topoInitialized[sessionId]) {
                        this._topoInitialized[sessionId] = true;
                        if (typeof AIAssistant !== 'undefined') {
                            topoPanel.innerHTML = AIAssistant._renderTopologyPanel(sessionId);
                        }
                    }
                }
                break;
            }
            case 'knowledge': {
                const kbPanel = panel.querySelector('.knowledge-panel');
                if (kbPanel) {
                    kbPanel.classList.add('active');
                    if (!this._kbInitialized) this._kbInitialized = {};
                    if (!this._kbInitialized[sessionId]) {
                        this._kbInitialized[sessionId] = true;
                        if (typeof AIAssistant !== 'undefined') {
                            kbPanel.innerHTML = AIAssistant._renderKnowledgePanel(sessionId);
                            setTimeout(() => AIAssistant.loadKB(sessionId, ''), 300);
                        }
                    }
                }
                break;
            }
        }

        // 4. 持久化状态
        this._activePanelTab[sessionId] = tabName;
    },

    /**
     * 🆕 移动端侧边栏切换
     */
    toggleSidebar() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebarOverlay');
        if (!sidebar) return;
        sidebar.classList.toggle('open');
        if (overlay) overlay.classList.toggle('visible');
    },
    
};
// 1. 修复会话恢复 - 增加重连超时处理
App._originalRetry = App.retrySession;
App.retrySession = function(sessionId) {
    const session = this.sessions[sessionId];
    if (!session) return;

    // 限制重连次数
    if (!session._retryCount) session._retryCount = 0;
    if (session._retryCount >= 3) {
        this.toast('重连次数过多，请手动重新连接', 'error');
        return;
    }
    session._retryCount++;

    this._originalRetry(sessionId);
};

// 2. 修复 Socket 重连 - 自动恢复会话
App._originalInitSocket = App.initSocket;
App.initSocket = function() {
    this._originalInitSocket();

    // 监听重连成功
    this.socket.on('reconnect', () => {
        this.toast('已重新连接服务器', 'success');
        // 恢复所有活跃会话
        Object.keys(this.sessions).forEach(sid => {
            const session = this.sessions[sid];
            if (session.connId) {
                // 标准连接：通过 connId 重新打开终端
                this.socket.emit('open_terminal', { 
                    conn_id: session.connId, 
                    session_id: sid 
                });
            } else if (session.quickConnInfo) {
                // 🔧 修复：快速连接会话也需恢复
                const info = session.quickConnInfo;
                this.socket.emit('quick_connect', {
                    session_id:  sid,
                    host:        info.host,
                    port:        info.port,
                    username:    info.username,
                    password:    info.password,
                    private_key: info.privateKey,
                });
            }

            // 🔧 修复：恢复 AI 助手状态
            if (typeof AIAssistant !== 'undefined' && AIAssistant._initialized?.has(sid)) {
                AIAssistant._initialized.delete(sid);
                setTimeout(() => AIAssistant.init(sid), 500);
            }

            // 🔧 修复：恢复文件管理器当前路径
            if (typeof FileManager !== 'undefined' && FileManager._currentPath?.[sid]) {
                setTimeout(() => {
                    FileManager.currentSessionId = sid;
                    FileManager.init(sid);
                }, 800);
            }

            // 🔧 修复：恢复监控面板（如果之前处于监控 Tab）
            const panel = document.getElementById(`panel-${sid}`);
            const activeMonitorTab = panel?.querySelector('.panel-tab[data-tab="monitor"].active');
            if (activeMonitorTab && typeof Monitor !== 'undefined') {
                setTimeout(() => Monitor.start(sid), 1000);
            }
        });
    });

    this.socket.on('reconnect_error', () => {
        this.toast('连接失败，正在重试...', 'warning');
    });

    this.socket.on('reconnect_failed', () => {
        this.toast('无法连接到服务器，请刷新页面', 'error');
    });
};

// 3. 增加全局错误处理
window.addEventListener('unhandledrejection', (e) => {
    console.error('Unhandled Promise Rejection:', e.reason);
    App.toast('发生错误，请查看控制台', 'error');
});

// 4. 增加连接超时检测
App._checkConnectionTimeout = function(sessionId) {
    const session = this.sessions[sessionId];
    if (!session) return;

    if (!session._connectStart) {
        session._connectStart = Date.now();
    }

    const elapsed = Date.now() - session._connectStart;
    if (elapsed > 30000) {
        this.toast('连接超时，请检查服务器状态', 'error');
        const overlay = document.querySelector(`#panel-${sessionId} .connecting-overlay`);
        if (overlay) {
            overlay.innerHTML = `
                <i class="fas fa-clock" style="font-size:48px;color:var(--warning-color);margin-bottom:16px"></i>
                <div style="color:var(--warning-color);font-size:15px;font-weight:600;margin-bottom:8px">连接超时</div>
                <div style="color:var(--text-secondary);font-size:13px;margin-bottom:16px">服务器响应超时，请检查网络和服务器状态</div>
                <button class="btn btn-primary" onclick="App.closeSession('${sessionId}')">
                    <i class="fas fa-times"></i> 关闭
                </button>
            `;
        }
        this.hideGlobalProgress();
        return true;
    }
    return false;
};

// 5. 修复 AI 诊断 - 添加超时和错误处理
App._originalRunDiagnosis = App.runAIDiagnosis;
App.runAIDiagnosis = async function(sessionId) {
    const btnEl = document.getElementById(`aiDiagnoseBtn-${sessionId}`);
    const resultContainer = document.getElementById(`diagnosisResult-${sessionId}`);
    if (!resultContainer) return;

    // 检查会话状态
    if (!this.sessions[sessionId]) {
        this.toast('会话不存在，请重新连接', 'error');
        return;
    }

    // 检查AI状态
    try {
        const statusRes = await fetch('/api/ai/status', { headers: this.authHeaders() });
        const statusData = await statusRes.json();
        if (statusData.status === 'ok' && !statusData.data.ready) {
            this.toast(statusData.data.message || 'AI服务不可用', 'warning');
            if (btnEl) {
                btnEl.disabled = false;
                btnEl.innerHTML = '<i class="fas fa-stethoscope"></i> 开始诊断';
            }
            return;
        }
    } catch (e) {
        this.toast('无法检查AI服务状态', 'warning');
    }

    this._originalRunDiagnosis(sessionId);
};

console.log('✅ App 增强修复已加载');

// 主题切换增强 - 支持系统主题
App._originalApplyTheme = App.applyTheme;
App.applyTheme = function(theme) {
    // 支持 'system' 自动检测
    if (theme === 'system') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        theme = prefersDark ? 'dark' : 'light';
    }
    this._originalApplyTheme(theme);
};

// 监听系统主题变化
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (localStorage.getItem('wt_theme') === 'system') {
        App.applyTheme('system');
    }
});

// ══════════════════════════════════════════
//  AI 诊断弹窗控制器
//  设计原则：一次性诊断，独立 Modal，不与终端共界面
// ══════════════════════════════════════════

const AIDiagnose = {

    _sessionId: null,
    _report:    null,

    // ── 打开弹窗 ──
    open(sessionId) {
        this._sessionId = sessionId;
        this._report    = null;

        const modal = document.getElementById('aiDiagnoseModal');
        if (!modal) return;

        // 更新标题
        const session = App.sessions?.[sessionId];
        const target  = document.getElementById('aiDiagnoseTarget');
        if (target && session) {
            target.textContent = '目标：' + (session.connName || sessionId);
        } else if (target) {
            target.textContent = '采集系统信息并分析';
        }

        // 重置为初始状态
        this._showState('idle');
        this._hideActionBtns();

        // 重置按钮
        const runBtn   = document.getElementById('aiDiagnoseRunBtn');
        const rerunBtn = document.getElementById('aiDiagnoseRerunBtn');
        if (runBtn)   runBtn.style.display   = '';
        if (rerunBtn) rerunBtn.style.display  = 'none';

        // 清空时间
        const timeEl = document.getElementById('aiDiagnoseTime');
        if (timeEl) timeEl.textContent = '';

        // 显示弹窗
        modal.style.display = 'flex';

        // ESC 关闭
        this._escHandler = (e) => {
            if (e.key === 'Escape') this.close();
        };
        document.addEventListener('keydown', this._escHandler);

        // 点击遮罩关闭
        modal.onclick = (e) => {
            if (e.target === modal) this.close();
        };
    },

    // ── 关闭弹窗 ──
    close() {
        const modal = document.getElementById('aiDiagnoseModal');
        if (modal) modal.style.display = 'none';
        if (this._escHandler) {
            document.removeEventListener('keydown', this._escHandler);
            this._escHandler = null;
        }
    },

    // ── 执行诊断 ──
    async run() {
        if (!this._sessionId) {
            App.toast('没有活跃的终端会话', 'warning');
            return;
        }

        // 切换到加载状态
        this._showState('loading');
        this._hideActionBtns();

        // 按钮状态
        const runBtn   = document.getElementById('aiDiagnoseRunBtn');
        const rerunBtn = document.getElementById('aiDiagnoseRerunBtn');
        if (runBtn)   runBtn.style.display  = 'none';
        if (rerunBtn) rerunBtn.style.display = 'none';

        // 进度提示轮换
        const progressEl = document.getElementById('aiDiagnoseProgress');
        const steps = [
            '正在采集 CPU 使用率...',
            '正在采集内存信息...',
            '正在采集磁盘状态...',
            '正在采集网络连接...',
            '正在采集系统日志...',
            'AI 正在分析数据...',
            '正在生成诊断报告...',
        ];
        let stepIdx = 0;
        const stepTimer = setInterval(() => {
            if (progressEl && stepIdx < steps.length) {
                progressEl.innerHTML =
                    '<i class="fas fa-circle-notch fa-spin" style="margin-right:6px;"></i>' +
                    steps[stepIdx++];
            }
        }, 3000);

        const startTime = Date.now();

        try {
            const res  = await fetch('/api/ai/diagnose', {
                method:  'POST',
                headers: App.authHeaders(),
                body:    JSON.stringify({ session_id: this._sessionId }),
            });

            clearInterval(stepTimer);

            if (!res.ok) {
                const errText = await res.text();
                throw new Error('HTTP ' + res.status + ': ' + errText.slice(0, 200));
            }

            const ct = res.headers.get('content-type') || '';
            if (!ct.includes('application/json')) {
                throw new Error('服务器返回了非 JSON 响应，请检查后端日志');
            }

            const data = await res.json();
            if (data.status !== 'ok') {
                throw new Error(data.message || '诊断失败');
            }

            this._report = data.data;

            // 计算耗时
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const timeEl  = document.getElementById('aiDiagnoseTime');
            if (timeEl) {
                timeEl.textContent = '耗时 ' + elapsed + 's · ' + new Date().toLocaleTimeString();
            }

            // 渲染结果
            this._renderResult(this._report);
            this._showState('result');
            this._showActionBtns();

            // 显示重新诊断按钮
            if (rerunBtn) rerunBtn.style.display = '';

            App.toast('AI 诊断完成', 'success');

        } catch (e) {
            clearInterval(stepTimer);
            this._renderError(e.message);
            this._showState('error');
            if (rerunBtn) rerunBtn.style.display = '';
            App.toast('诊断失败: ' + e.message, 'error');
        }
    },

    // ── 渲染诊断结果 ──
    _renderResult(report) {
        const div = document.getElementById('aiDiagnoseResult');
        if (!div) return;

        const cmdsHtml = (report.commands || []).map((cmd, i) => {
            const escaped = App.escapeHtml(cmd);
            return '<div style="display:flex;align-items:center;gap:10px;' +
                        'background:var(--bg-tertiary);padding:10px 14px;' +
                        'border-radius:8px;margin-bottom:6px;' +
                        'border-left:3px solid var(--success-color);' +
                        'transition:background 0.15s;"' +
                 ' onmouseenter="this.style.background=\'var(--bg-hover)\'"' +
                 ' onmouseleave="this.style.background=\'var(--bg-tertiary)\'">' +
                    '<span style="color:var(--text-secondary);font-size:11px;' +
                             'min-width:20px;font-weight:600;flex-shrink:0;">' +
                        '#' + (i + 1) +
                    '</span>' +
                    '<code style="flex:1;color:var(--text-bright);' +
                             'font-family:Consolas,monospace;font-size:13px;' +
                             'word-break:break-all;">' +
                        escaped +
                    '</code>' +
                    '<button onclick="AIDiagnose._copyCmd(\'' + escaped.replace(/'/g, "\\'") + '\')"' +
                            ' class="btn btn-icon btn-sm" title="复制"' +
                            ' style="flex-shrink:0;opacity:0.5;"' +
                            ' onmouseenter="this.style.opacity=\'1\'"' +
                            ' onmouseleave="this.style.opacity=\'0.5\'">' +
                        '<i class="fas fa-copy" style="font-size:10px;"></i>' +
                    '</button>' +
                    '<button onclick="AIDiagnose._execCmd(\'' + escaped.replace(/'/g, "\\'") + '\')"' +
                            ' class="btn btn-sm btn-primary"' +
                            ' style="flex-shrink:0;font-size:11px;">' +
                        '<i class="fas fa-play" style="font-size:9px;"></i> 执行' +
                    '</button>' +
                '</div>';
        }).join('');

        const recsHtml = (report.recommendations || []).map((r, i) =>
            '<div style="display:flex;gap:10px;padding:6px 0;' +
                        'border-bottom:1px solid var(--border-color);align-items:flex-start;">' +
                '<span style="color:var(--warning-color);font-size:12px;' +
                             'flex-shrink:0;margin-top:1px;">' + (i + 1) + '.</span>' +
                '<span style="font-size:13px;color:var(--text-primary);line-height:1.6;">' +
                    App.escapeHtml(r) +
                '</span>' +
            '</div>'
        ).join('');

        const summary = App.escapeHtml(report.summary || '诊断完成');
        const diagnosis = App.escapeHtml(report.diagnosis || '无详细信息');

        div.innerHTML =
            '<!-- 摘要卡片 -->' +
            '<div style="background:linear-gradient(135deg,rgba(79,195,247,0.08),rgba(79,195,247,0.02));' +
                        'border:1px solid rgba(79,195,247,0.2);border-radius:10px;' +
                        'padding:16px 20px;margin-bottom:20px;">' +
                '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">' +
                    '<i class="fas fa-robot" style="color:var(--accent-color);font-size:18px;"></i>' +
                    '<span style="font-size:15px;font-weight:600;color:var(--text-bright);">' +
                        '诊断摘要' +
                    '</span>' +
                '</div>' +
                '<p style="font-size:13px;color:var(--text-primary);line-height:1.7;margin:0;">' +
                    summary +
                '</p>' +
            '</div>' +

            '<!-- 详细分析 -->' +
            '<div style="margin-bottom:20px;">' +
                '<div style="font-size:13px;font-weight:600;color:var(--text-bright);' +
                            'margin-bottom:10px;display:flex;align-items:center;gap:6px;">' +
                    '<i class="fas fa-search" style="color:var(--info-color);"></i>' +
                    '详细分析' +
                '</div>' +
                '<div style="background:var(--bg-tertiary);padding:14px 16px;' +
                            'border-radius:8px;font-size:13px;line-height:1.8;' +
                            'color:var(--text-primary);white-space:pre-line;' +
                            'border:1px solid var(--border-color);">' +
                    this._formatDiagnosisText(diagnosis) +
                '</div>' +
            '</div>' +

            // 修复建议
            (recsHtml ?
            '<div style="margin-bottom:20px;">' +
                '<div style="font-size:13px;font-weight:600;color:var(--text-bright);' +
                            'margin-bottom:10px;display:flex;align-items:center;gap:6px;">' +
                    '<i class="fas fa-lightbulb" style="color:var(--warning-color);"></i>' +
                    '修复建议' +
                    '<span style="font-size:11px;font-weight:400;' +
                                 'color:var(--text-secondary);margin-left:4px;">' +
                        '(' + report.recommendations.length + ' 条)' +
                    '</span>' +
                '</div>' +
                '<div style="background:var(--bg-tertiary);border-radius:8px;' +
                            'padding:8px 14px;border:1px solid var(--border-color);">' +
                    recsHtml +
                '</div>' +
            '</div>' : '') +

            // 建议命令
            (cmdsHtml ?
            '<div>' +
                '<div style="font-size:13px;font-weight:600;color:var(--text-bright);' +
                            'margin-bottom:10px;display:flex;align-items:center;gap:6px;">' +
                    '<i class="fas fa-terminal" style="color:var(--success-color);"></i>' +
                    '建议执行的命令' +
                    '<span style="font-size:11px;font-weight:400;' +
                                 'color:var(--text-secondary);margin-left:4px;">' +
                        '(' + report.commands.length + ' 条)' +
                    '</span>' +
                '</div>' +
                cmdsHtml +
                '<div style="font-size:11px;color:var(--text-secondary);margin-top:8px;">' +
                    '<i class="fas fa-shield-alt" style="margin-right:4px;"></i>' +
                    '执行前请确认命令安全性，高危命令会触发二次确认' +
                '</div>' +
            '</div>' : '');
    },

    // ── 渲染错误 ──
    _renderError(message) {
        const div = document.getElementById('aiDiagnoseError');
        if (!div) return;
        div.innerHTML =
            '<div style="background:rgba(239,83,80,0.08);border:1px solid var(--danger-color);' +
                        'border-radius:10px;padding:24px;text-align:center;">' +
                '<i class="fas fa-exclamation-circle"' +
                   ' style="font-size:36px;color:var(--danger-color);display:block;margin-bottom:12px;"></i>' +
                '<div style="font-size:14px;font-weight:600;color:var(--danger-color);margin-bottom:8px;">' +
                    '诊断失败' +
                '</div>' +
                '<div style="font-size:13px;color:var(--text-secondary);line-height:1.6;">' +
                    App.escapeHtml(message) +
                '</div>' +
            '</div>';
    },

    // ── 状态切换 ──
    _showState(state) {
        var states = ['idle', 'loading', 'error', 'result'];
        for (var i = 0; i < states.length; i++) {
            var s = states[i];
            var el = document.getElementById('aiDiagnose' + s.charAt(0).toUpperCase() + s.slice(1));
            if (el) el.style.display = s === state ? 'block' : 'none';
        }
    },

    _showActionBtns() {
        var exportBtn = document.getElementById('aiDiagnoseExportBtn');
        var saveBtn = document.getElementById('aiDiagnoseSaveBtn');
        if (exportBtn) exportBtn.style.display = '';
        if (saveBtn) saveBtn.style.display = '';
    },

    _hideActionBtns() {
        var exportBtn = document.getElementById('aiDiagnoseExportBtn');
        var saveBtn = document.getElementById('aiDiagnoseSaveBtn');
        if (exportBtn) exportBtn.style.display = 'none';
        if (saveBtn) saveBtn.style.display = 'none';
    },

    // ── 复制命令 ──
    _copyCmd(cmd) {
        navigator.clipboard.writeText(cmd);
        App.toast('已复制', 'success', 1500);
    },

    // ── 执行命令到终端 ──
    _execCmd(cmd) {
        var sid = this._sessionId;
        if (!sid || !App.socket) {
            App.toast('请先打开终端会话', 'warning');
            return;
        }
        App.socket.emit('terminal_input', {
            session_id: sid,
            data: cmd + '\n',
        });
        App.toast('命令已发送到终端', 'success', 1500);
    },

    // ── 导出报告 ──
    export() {
        var report = this._report;
        if (!report) { App.toast('请先执行诊断', 'warning'); return; }

        var session = App.sessions?.[this._sessionId] || {};
        var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

        var md = '# AI 诊断报告\n\n';
        md += '**主机**: ' + (session.connName || this._sessionId) + '\n';
        md += '**时间**: ' + new Date().toLocaleString() + '\n\n---\n\n';
        md += '## 诊断摘要\n\n' + report.summary + '\n\n';
        md += '## 详细分析\n\n' + report.diagnosis + '\n\n';

        if (report.recommendations && report.recommendations.length) {
            md += '## 修复建议\n\n';
            report.recommendations.forEach(function(r, i) {
                md += (i + 1) + '. ' + r + '\n';
            });
            md += '\n';
        }
        if (report.commands && report.commands.length) {
            md += '## 建议命令\n\n```bash\n';
            report.commands.forEach(function(c) { md += c + '\n'; });
            md += '```\n';
        }

        var blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
        var url  = URL.createObjectURL(blob);
        var a    = document.createElement('a');
        a.href     = url;
        a.download = '诊断报告_' + ts + '.md';
        a.click();
        setTimeout(function() { URL.revokeObjectURL(url); }, 5000);
        App.toast('报告已导出', 'success');
    },

    // ── 保存到知识库 ──
    async saveToKB() {
        var report  = this._report;
        var session = App.sessions?.[this._sessionId] || {};
        if (!report) return;

        var content = [
            '## 诊断摘要\n' + report.summary,
            '## 详细分析\n' + report.diagnosis,
            report.recommendations && report.recommendations.length
                ? '## 修复建议\n' + report.recommendations.map(function(r, i) { return (i+1) + '. ' + r; }).join('\n')
                : '',
            report.commands && report.commands.length
                ? '## 修复命令\n```bash\n' + report.commands.join('\n') + '\n```'
                : '',
        ].filter(Boolean).join('\n\n');

        try {
            var res  = await fetch('/api/ai/knowledge', {
                method:  'POST',
                headers: App.authHeaders(),
                body:    JSON.stringify({
                    title:    '诊断报告 · ' + (session.connName || this._sessionId) + ' · ' + new Date().toLocaleDateString(),
                    content: content,
                    tags:     ['诊断', session.connName || ''],
                    category: 'fault',
                }),
            });
            var data = await res.json();
            if (data.status === 'ok') {
                App.toast('已保存到知识库', 'success');
            } else {
                App.toast('保存失败: ' + data.message, 'error');
            }
        } catch (e) {
            App.toast('保存失败: ' + e.message, 'error');
        }
    },
};

window.AIDiagnose = AIDiagnose;

// ══════════════════════════════════════════
//  产品功能介绍展示页控制器
//  逻辑：进入 → 展示介绍页 → 点击 → 控制台
//        控制台无操作 5 分钟 → 自动恢复介绍页
// ══════════════════════════════════════════

const FeaturePage = {

    // 无操作超时时间（毫秒），默认 5 分钟
    IDLE_TIMEOUT: 5 * 60 * 1000,

    // 轮播切换间隔（毫秒）
    CAROUSEL_INTERVAL: 4000,

    _idleTimer:     null,
    _carouselTimer: null,
    _carouselPaused: false,
    _currentGroup:  0,
    _dismissed:     false,

    // ══════════════════════════════════════
    //  功能数据（每组3个卡片，共3组 = 9个功能）
    // ══════════════════════════════════════
    _features: [
        // 第0组 — 核心能力
        [
            {
                icon:  'fa-terminal',
                color: 'var(--accent-color)',
                bg:    'rgba(79,195,247,0.12)',
                title: 'SSH 终端',
                desc:  '基于 xterm.js 的浏览器终端模拟器，多标签分屏、窗口自适应、密码/私钥双认证，连接信息 Fernet 加密存储。',
                tags:  ['多标签', '会话恢复', '双认证'],
            },
            {
                icon:  'fa-robot',
                color: '#a78bfa',
                bg:    'rgba(167,139,250,0.12)',
                title: 'AI 智能运维',
                desc:  '多轮对话助手、一键系统诊断、容量预测、安全漏洞扫描、拓扑发现，AI 全程辅助运维决策。',
                tags:  ['LLM 驱动', '诊断报告', '风险分析'],
            },
            {
                icon:  'fa-folder-open',
                color: 'var(--warning-color)',
                bg:    'rgba(255,167,38,0.1)',
                title: '文件管理',
                desc:  '可视化 SFTP 文件浏览器，上传下载、在线编辑、权限管理、流式传输，支持 500MB+ 大文件。',
                tags:  ['拖拽上传', '在线编辑', '权限管理'],
            },
        ],
        // 第1组 — 批量运维
        [
            {
                icon:  'fa-layer-group',
                color: 'var(--success-color)',
                bg:    'rgba(102,187,106,0.12)',
                title: '集群运维',
                desc:  '批量命令下发、节点分组管理、任务并发调度，支持延时执行、失败重试、实时进度跟踪。',
                tags:  ['批量命令', '并发调度', '失败重试'],
            },
            {
                icon:  'fa-chart-bar',
                color: 'var(--info-color)',
                bg:    'rgba(66,165,245,0.12)',
                title: '系统监控',
                desc:  'CPU / 内存 / 磁盘 / 网络实时图表，自定义告警阈值、进程监控、冷却时间，异常自动通知。',
                tags:  ['实时监控', '告警引擎', '进程监控'],
            },
            {
                icon:  'fa-shield-alt',
                color: 'var(--danger-color)',
                bg:    'rgba(239,83,80,0.1)',
                title: '安全防护',
                desc:  '全链路操作审计日志，高危命令五级风险分析，critical 级直接拦截，会话录制与回放追溯。',
                tags:  ['命令拦截', '审计追溯', '会话录制'],
            },
        ],
        // 第2组 — 高级运维
        [
            {
                icon:  'fa-book',
                color: '#f59e0b',
                bg:    'rgba(245,158,11,0.1)',
                title: '知识库',
                desc:  '故障案例沉淀、操作手册管理，AI 自动生成知识条目，全文搜索，团队经验共享。',
                tags:  ['AI 生成', '全文搜索', '团队共享'],
            },
            {
                icon:  'fa-cloud-upload-alt',
                color: '#10b981',
                bg:    'rgba(16,185,129,0.12)',
                title: '文件分发',
                desc:  '一次上传同步分发至多节点，支持覆盖/跳过/备份策略，MD5 校验确保数据完整。',
                tags:  ['多节点同步', 'MD5 校验', '策略分发'],
            },
            {
                icon:  'fa-clipboard-check',
                color: '#f59e0b',
                bg:    'rgba(245,158,11,0.12)',
                title: '巡检报告',
                desc:  '自定义巡检项，多节点批量健康检查，自动生成 Excel 报告，历史对比追踪，一键导出打印。',
                tags:  ['健康检查', 'Excel 导出', '历史对比'],
            },
        ],
    ],

    // ══════════════════════════════════════
    //  初始化（App.init() 时调用）
    // ══════════════════════════════════════
    init() {
        // 只在欢迎页（无活跃会话）时显示
        if (Object.keys(App.sessions || {}).length > 0) return;

        // 🔧 修复：停止 Dashboard 自动刷新，与介绍页可见状态同步
        window.Dashboard?.stop();

        this._carouselPaused = false;
        this._renderCarousel(0);
        this._renderDots();
        this._show();
        this._startCarousel();
    },

    // ══════════════════════════════════════
    //  显示介绍页
    // ══════════════════════════════════════
    _show() {
        const page = document.getElementById('featurePage');
        const welcome = document.getElementById('welcomePage');
        if (!page) return;

        page.style.display = 'flex';
        if (welcome) welcome.style.display = 'none';

        this._dismissed = false;
    },

    // ══════════════════════════════════════
    //  用户点击 → 进入控制台
    // ══════════════════════════════════════
    dismiss() {
        if (this._dismissed) return;
        this._dismissed = true;

        const page    = document.getElementById('featurePage');
        const welcome = document.getElementById('welcomePage');

        // 淡出动画
        if (page) {
            page.style.transition = 'opacity 0.3s ease';
            page.style.opacity = '0';
            setTimeout(() => {
                page.style.display = 'none';
                page.style.opacity = '1';
                page.style.transition = '';
            }, 300);
        }

        // 显示控制台
        if (welcome) {
            welcome.style.display = 'flex';
            welcome.style.opacity = '0';
            welcome.style.transition = 'opacity 0.3s ease';
            setTimeout(() => {
                welcome.style.opacity = '1';
                setTimeout(() => {
                    welcome.style.transition = '';
                }, 300);
            }, 100);
        }

        this._carouselPaused = false;
        this._stopCarousel();

        // 初始化 Dashboard
        if (App._token) {
            setTimeout(() => window.Dashboard?.init(), 200);
        }

        // 启动空闲检测
        this._startIdleDetection();
    },

    // ══════════════════════════════════════
    //  空闲检测：长时间无操作恢复介绍页
    // ══════════════════════════════════════
    _startIdleDetection() {
        this._stopIdleDetection();

        const reset = () => this._resetIdleTimer();

        // 监听用户活动事件
        const events = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'];
        events.forEach(ev => document.addEventListener(ev, reset, { passive: true }));
        this._idleEvents = events;
        this._idleReset  = reset;

        this._resetIdleTimer();
    },

    _resetIdleTimer() {
        clearTimeout(this._idleTimer);

        // 只在欢迎页（无活跃会话）时才自动恢复
        if (Object.keys(App.sessions || {}).length > 0) return;

        this._idleTimer = setTimeout(() => {
            // 无活跃会话时，恢复介绍页
            if (Object.keys(App.sessions || {}).length === 0) {
                this._restoreFeaturePage();
            }
        }, this.IDLE_TIMEOUT);
    },

    _stopIdleDetection() {
        clearTimeout(this._idleTimer);
        if (this._idleEvents && this._idleReset) {
            this._idleEvents.forEach(ev =>
                document.removeEventListener(ev, this._idleReset)
            );
        }
        this._idleEvents = null;
        this._idleReset  = null;
    },

    // ══════════════════════════════════════
    //  恢复介绍页（空闲超时后调用）
    // ══════════════════════════════════════
    _restoreFeaturePage() {
        // 停止 Dashboard 自动刷新
        window.Dashboard?.stop();

        const welcome = document.getElementById('welcomePage');
        const page    = document.getElementById('featurePage');

        // 淡出控制台
        if (welcome) {
            welcome.style.transition = 'opacity 0.4s ease';
            welcome.style.opacity = '0';
            setTimeout(() => {
                welcome.style.display = 'none';
                welcome.style.opacity = '1';
                welcome.style.transition = '';
            }, 400);
        }

        // 淡入介绍页
        setTimeout(() => {
            this._carouselPaused = false;
            this._renderCarousel(0);
            this._show();
            this._startCarousel();
            this._stopIdleDetection();
        }, 350);
    },

    // ══════════════════════════════════════
    //  轮播控制
    // ══════════════════════════════════════
    _renderCarousel(groupIdx) {
        this._currentGroup = groupIdx;

        const carousel = document.getElementById('featureCarousel');
        if (!carousel) return;

        const group = this._features[groupIdx] || this._features[0];

        // 淡出再淡入
        carousel.style.opacity = '0';

        setTimeout(() => {
            carousel.innerHTML = group.map(f => `
                <div style="background:var(--bg-secondary);
                            border:1px solid var(--border-color);
                            border-radius:12px;padding:20px;
                            transition:transform 0.2s,box-shadow 0.2s;
                            cursor:default;"
                     onmouseenter="this.style.transform='translateY(-3px)';
                                   this.style.boxShadow='0 8px 24px rgba(0,0,0,0.2)'"
                     onmouseleave="this.style.transform='';
                                   this.style.boxShadow=''">

                    <!-- 图标 -->
                    <div style="width:44px;height:44px;border-radius:12px;
                                background:${f.bg};display:flex;
                                align-items:center;justify-content:center;
                                margin-bottom:14px;flex-shrink:0;">
                        <i class="fas ${f.icon}"
                           style="font-size:20px;color:${f.color};"></i>
                    </div>

                    <!-- 标题 -->
                    <div style="font-size:15px;font-weight:600;
                                color:var(--text-bright);margin-bottom:8px;">
                        ${App.escapeHtml(f.title)}
                    </div>

                    <!-- 描述 -->
                    <div style="font-size:12px;color:var(--text-secondary);
                                line-height:1.7;margin-bottom:12px;">
                        ${App.escapeHtml(f.desc)}
                    </div>

                    <!-- 标签 -->
                    <div style="display:flex;flex-wrap:wrap;gap:5px;">
                        ${f.tags.map(t => `
                            <span style="font-size:10px;padding:2px 8px;
                                         border-radius:10px;
                                         background:${f.bg};
                                         color:${f.color};
                                         border:1px solid ${f.color}33;">
                                ${App.escapeHtml(t)}
                            </span>
                        `).join('')}
                    </div>
                </div>
            `).join('');

            carousel.style.opacity = '1';
        }, 250);

        // 更新指示点
        this._updateDots(groupIdx);
    },

    _renderDots() {
        const dots = document.getElementById('featureDots');
        if (!dots) return;

        dots.innerHTML = this._features.map((_, i) => `
            <div onclick="event.stopPropagation();FeaturePage._goToGroup(${i})"
                 style="width:${i === 0 ? '20' : '6'}px;height:6px;
                        border-radius:3px;cursor:pointer;
                        background:${i === 0 ? 'var(--accent-color)' : 'var(--border-color)'};
                        transition:all 0.3s ease;"
                 id="featureDot-${i}">
            </div>
        `).join('');
    },

    _updateDots(activeIdx) {
        this._features.forEach((_, i) => {
            const dot = document.getElementById(`featureDot-${i}`);
            if (!dot) return;
            if (i === activeIdx) {
                dot.style.width      = '20px';
                dot.style.background = 'var(--accent-color)';
            } else {
                dot.style.width      = '6px';
                dot.style.background = 'var(--border-color)';
            }
        });
    },

    _goToGroup(idx) {
        this._renderCarousel(idx);
        // 如果鼠标正悬停在卡片上，不重启自动轮播
        if (this._carouselPaused) return;
        this._stopCarousel();
        this._startCarousel();
    },

    _goPrev() {
        const prev = (this._currentGroup - 1 + this._features.length) % this._features.length;
        this._goToGroup(prev);
    },

    _goNext() {
        const next = (this._currentGroup + 1) % this._features.length;
        this._goToGroup(next);
    },

    _startCarousel() {
        this._stopCarousel();
        this._carouselTimer = setInterval(() => {
            const next = (this._currentGroup + 1) % this._features.length;
            this._renderCarousel(next);
        }, this.CAROUSEL_INTERVAL);
    },

    _stopCarousel() {
        clearInterval(this._carouselTimer);
        this._carouselTimer = null;
    },

    _pauseCarousel() {
        if (this._carouselTimer) {
            this._carouselPaused = true;
            this._stopCarousel();
        }
    },

    _resumeCarousel() {
        if (this._carouselPaused) {
            this._carouselPaused = false;
            this._startCarousel();
        }
    },

    // ══════════════════════════════════════
    //  外部调用：打开终端后停止空闲检测
    // ══════════════════════════════════════
    onSessionOpen() {
        this._carouselPaused = false;
        this._stopIdleDetection();
        this._stopCarousel();
    },

    // 所有会话关闭时重新启动空闲检测
    onAllSessionsClosed() {
        // 延迟1秒后开始，避免会话切换时误触发
        setTimeout(() => {
            if (Object.keys(App.sessions || {}).length === 0) {
                this._startIdleDetection();
            }
        }, 1000);
    },
};

window.FeaturePage = FeaturePage;

document.addEventListener('DOMContentLoaded', () => { App.init(); });