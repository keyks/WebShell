/**
 * ═══════════════════════════════════════════════════════════
 * 高危指令管理模块 (Dangerous Command Manager)
 * ═══════════════════════════════════════════════════════════
 *
 * 统一的命令风险检测与管理中心，负责：
 *   1. 定义所有高危/中危命令的匹配规则，分类管理
 *   2. 本地快速预判，避免每次击键都调用后端 API
 *   3. 调用后端 /api/ai/analyze-command 进行最终风险分析
 *   4. 管理安全确认弹窗流程（确认 / 取消 / 超时）
 *
 * 与 app.js 的集成点：
 *   - term.onData 逐字缓冲 → Enter 时调用 DCM.isPotentiallyRisky(cmd)
 *   - 命中后调用 DCM.analyzeAndPrompt(sessionId, cmd) 走完整流程
 *
 * 依赖：window.App (toast, socket, authHeaders, openModal, closeModal)
 *      DOM: securityConfirmModal 弹窗元素
 */

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════
    //  规则分类
    // ═══════════════════════════════════════════════════════
    const CATEGORY = {
        DELETION:         'deletion',          // 文件/目录删除
        FILESYSTEM:       'filesystem',        // 文件系统格式化/写入
        DISK_PARTITION:   'disk_partition',    // 磁盘分区操作
        SYSTEM_CONTROL:   'system_control',    // 关机/重启/运行级别
        PERMISSION:       'permission',        // 权限变更
        FIREWALL:         'firewall',          // 防火墙规则清空
        PROCESS_KILL:     'process_kill',      // 进程终止
        USER_MANAGEMENT:  'user_management',   // 用户/密码管理
        CRONTAB:          'crontab',           // 定时任务删除
        DEVICE_WRITE:     'device_write',      // 直接写入磁盘设备
    };

    // ═══════════════════════════════════════════════════════
    //  本地预判规则 —— 匹配到任一条即调用后端 API 分析
    // ═══════════════════════════════════════════════════════
    const LOCAL_PRE_FILTER = [
        // ── 文件/目录删除 ──────────────────────────────────
        { pattern: /\brm\b/,               cat: CATEGORY.DELETION,        note: '删除文件/目录' },
        { pattern: /\brmdir\b/,            cat: CATEGORY.DELETION,        note: '删除空目录' },
        { pattern: /\bunlink\b/,           cat: CATEGORY.DELETION,        note: '删除文件链接' },
        { pattern: /\bshred\b/,            cat: CATEGORY.DELETION,        note: '安全粉碎文件（多次覆写）' },
        { pattern: /\btruncate\s+-s\s+0/,  cat: CATEGORY.DELETION,        note: '清空文件内容' },
        { pattern: /\bwipefs\b/,           cat: CATEGORY.DELETION,        note: '擦除文件系统签名' },

        // ── 文件系统格式化/写入 ─────────────────────────────
        { pattern: /\bdd\s+if=/,           cat: CATEGORY.FILESYSTEM,      note: '磁盘写入操作' },
        { pattern: /\bmkfs\b/,             cat: CATEGORY.FILESYSTEM,      note: '格式化文件系统' },
        { pattern: /\bmke2fs\b/,           cat: CATEGORY.FILESYSTEM,      note: '格式化 ext 文件系统' },
        { pattern: /\bmkswap\b/,           cat: CATEGORY.FILESYSTEM,      note: '创建交换分区' },
        { pattern: /\bfsck\b/,             cat: CATEGORY.FILESYSTEM,      note: '文件系统检查与修复' },

        // ── 磁盘分区操作 ────────────────────────────────────
        { pattern: /\bfdisk\b/,            cat: CATEGORY.DISK_PARTITION,  note: '磁盘分区操作' },
        { pattern: /\bparted\b/,           cat: CATEGORY.DISK_PARTITION,  note: '磁盘分区操作' },

        // ── 系统控制 ────────────────────────────────────────
        { pattern: /\bshutdown\b/,         cat: CATEGORY.SYSTEM_CONTROL,  note: '关机操作' },
        { pattern: /\breboot\b/,           cat: CATEGORY.SYSTEM_CONTROL,  note: '重启操作' },
        { pattern: /\bhalt\b/,             cat: CATEGORY.SYSTEM_CONTROL,  note: '停机操作' },
        { pattern: /\bpoweroff\b/,         cat: CATEGORY.SYSTEM_CONTROL,  note: '关机操作' },
        { pattern: /\binit\s+[06]\b/,      cat: CATEGORY.SYSTEM_CONTROL,  note: '切换运行级别' },

        // ── 权限变更 ────────────────────────────────────────
        { pattern: /\bchmod\s+-R\s+777/,   cat: CATEGORY.PERMISSION,      note: '递归赋予所有权限' },
        { pattern: /\bchown\s+-R/,         cat: CATEGORY.PERMISSION,      note: '递归修改文件所有者' },

        // ── 防火墙清空 ──────────────────────────────────────
        { pattern: /\biptables\s+-[FX]/,   cat: CATEGORY.FIREWALL,        note: '清空/删除防火墙规则' },

        // ── 进程终止 ────────────────────────────────────────
        { pattern: /\bkill\s+-9\b/,        cat: CATEGORY.PROCESS_KILL,    note: '强制终止进程' },

        // ── 用户管理 ────────────────────────────────────────
        { pattern: /\bpasswd\b/,           cat: CATEGORY.USER_MANAGEMENT, note: '修改用户密码' },
        { pattern: /\buserdel\b/,          cat: CATEGORY.USER_MANAGEMENT, note: '删除用户' },

        // ── 定时任务 ────────────────────────────────────────
        { pattern: /\bcrontab\s+-r\b/,     cat: CATEGORY.CRONTAB,         note: '删除所有定时任务' },

        // ── 直接写入磁盘设备 ────────────────────────────────
        { pattern: />\s*\/dev\/sd/,        cat: CATEGORY.DEVICE_WRITE,    note: '直接写入磁盘设备' },
        { pattern: /\bcat\s+\/dev\/null\s*>\s*\/dev\/sd/, cat: CATEGORY.DEVICE_WRITE, note: '清空磁盘设备' },
        { pattern: /\bmv\s+\S+\s+\/dev\/null/, cat: CATEGORY.DEVICE_WRITE, note: '移入黑洞' },
        { pattern: /\bsystemctl\s+(stop|disable)/, cat: CATEGORY.SYSTEM_CONTROL, note: '停止/禁用系统服务' },
    ];

    // ═══════════════════════════════════════════════════════
    //  内部状态
    // ═══════════════════════════════════════════════════════
    let _confirmTimer = null;

    // ═══════════════════════════════════════════════════════
    //  公共 API
    // ═══════════════════════════════════════════════════════

    const DCM = {

        // ── 规则查询 ────────────────────────────────────────

        /** 返回所有规则的只读副本（用于审计面板展示） */
        getRules() {
            return LOCAL_PRE_FILTER.map(r => ({ ...r }));
        },

        /** 按类别获取规则 */
        getRulesByCategory(cat) {
            return LOCAL_PRE_FILTER.filter(r => r.cat === cat);
        },

        /** 获取所有类别 */
        getCategories() {
            return { ...CATEGORY };
        },

        // ── 风险检测 ────────────────────────────────────────

        /**
         * 本地快速预判：命令是否可能具有风险
         * 命中任一规则 → 需要后端 API 做最终分析
         *
         * @param {string} cmd - 完整命令行
         * @returns {boolean}
         */
        isPotentiallyRisky(cmd) {
            if (!cmd || cmd.length < 2) return false;
            return LOCAL_PRE_FILTER.some(r => r.pattern.test(cmd));
        },

        /**
         * 调用后端 API 分析命令风险，根据结果决定操作：
         *   critical → 阻止执行，发送 Ctrl+C 取消当前行
         *   high     → 弹出安全确认弹窗
         *   medium   → Toast 提醒 + 放行
         *   low/safe → 直接放行
         *
         * @param {string} sessionId - 终端会话 ID
         * @param {string} cmd       - 完整命令行
         */
        analyzeAndPrompt(sessionId, cmd) {
            const App = window.App;
            if (!App) {
                DCM._sendEnter(sessionId);
                return;
            }

            fetch('/api/ai/analyze-command', {
                method: 'POST',
                headers: App.authHeaders(),
                body: JSON.stringify({ command: cmd })
            })
            .then(r => r.json())
            .then(result => {
                if (result.status !== 'ok' || !result.data || !result.data.risk) {
                    DCM._sendEnter(sessionId);
                    return;
                }

                const risk = result.data.risk;

                switch (risk.level) {
                    case 'critical':
                        DCM._handleCritical(sessionId, cmd, risk);
                        break;

                    case 'high':
                        DCM._handleHigh(sessionId, cmd, risk);
                        break;

                    case 'medium':
                        DCM._handleMedium(sessionId, cmd, risk);
                        break;

                    default:
                        DCM._sendEnter(sessionId);
                        break;
                }
            })
            .catch(() => {
                // API 异常时放行，避免阻塞正常操作
                DCM._sendEnter(sessionId);
            });
        },

        // ── 工具方法 ────────────────────────────────────────

        /**
         * 发送 Enter 键到后端 PTY
         * @param {string} sessionId
         */
        sendEnter(sessionId) {
            DCM._sendEnter(sessionId);
        },

        /**
         * 发送 Ctrl+C 到后端 PTY（取消当前行）
         * @param {string} sessionId
         */
        sendCtrlC(sessionId) {
            const App = window.App;
            if (App && App.socket) {
                App.socket.emit('terminal_input', { session_id: sessionId, data: '\x03' });
            }
        },

        // ═══════════════════════════════════════════════════
        //  内部方法
        // ═══════════════════════════════════════════════════

        _sendEnter(sessionId) {
            const App = window.App;
            if (App && App.socket) {
                App.socket.emit('terminal_input', { session_id: sessionId, data: '\r' });
            }
        },

        /** critical：阻止执行，发送 Ctrl+C */
        _handleCritical(sessionId, cmd, risk) {
            const App = window.App;
            if (App) {
                App.toast('⛔ 极度危险命令已阻止: ' + (risk.description || cmd), 'error', 8000);
            }
            DCM.sendCtrlC(sessionId);
        },

        /** high：弹出安全确认弹窗，确认 / 取消 / 超时 */
        _handleHigh(sessionId, cmd, risk) {
            const App = window.App;
            const modal = document.getElementById('securityConfirmModal');

            if (!modal || !App) {
                // 降级：浏览器原生 confirm
                const msg = '⚠️ 高危命令:\n\n' + cmd +
                    '\n\n风险: ' + (risk.description || '-') +
                    '\n建议: ' + (risk.suggestion || '请仔细核对命令后再执行') +
                    '\n\n是否确认执行？';
                if (confirm(msg)) {
                    DCM._sendEnter(sessionId);
                } else {
                    DCM.sendCtrlC(sessionId);
                }
                return;
            }

            // 填充弹窗内容
            const badge = document.getElementById('secRiskBadge');
            const label = document.getElementById('secRiskLabel');
            if (badge) badge.className = 'security-risk-badge ' + (risk.level || 'high');
            if (label) label.textContent = (risk.level || 'high').toUpperCase();

            const cmdText = document.getElementById('secCmdText');
            const desc    = document.getElementById('secDescription');
            const suggest = document.getElementById('secSuggestion');
            if (cmdText) cmdText.textContent = cmd || '';
            if (desc)    desc.textContent    = risk.description || '-';
            if (suggest) suggest.textContent = risk.suggestion || '请仔细核对命令后再执行';

            // 按钮事件绑定
            const confirmBtn = document.getElementById('secConfirmBtn');
            const cancelBtn  = document.getElementById('secCancelBtn');
            const overlayEl  = modal.querySelector('.modal-overlay');

            const cleanup = () => {
                if (confirmBtn) confirmBtn.replaceWith(confirmBtn.cloneNode(true));
                if (cancelBtn)  cancelBtn.replaceWith(cancelBtn.cloneNode(true));
                if (overlayEl)  overlayEl.replaceWith(overlayEl.cloneNode(true));
                App.closeModal('securityConfirmModal');
                DCM._clearTimer();
            };

            document.getElementById('secConfirmBtn').addEventListener('click', () => {
                cleanup();
                DCM._sendEnter(sessionId);
                App.toast('✅ 命令已确认并发送', 'success');
            });

            document.getElementById('secCancelBtn').addEventListener('click', () => {
                cleanup();
                DCM.sendCtrlC(sessionId);
                App.toast('❌ 命令已取消', 'info');
            });

            // 60 秒超时自动取消
            _confirmTimer = setTimeout(() => {
                cleanup();
                App.toast('⏰ 确认超时，请重新输入命令', 'warning');
            }, 60000);

            App.openModal('securityConfirmModal');
        },

        /** medium：Toast 提醒 + 直接放行 */
        _handleMedium(sessionId, cmd, risk) {
            const App = window.App;
            if (App) {
                App.toast('⚠️ 中危操作: ' + (risk.description || cmd) + ' — ' +
                    (risk.suggestion || '请确认是否安全'), 'warning', 6000);
            }
            DCM._sendEnter(sessionId);
        },

        _clearTimer() {
            if (_confirmTimer) {
                clearTimeout(_confirmTimer);
                _confirmTimer = null;
            }
        },
    };

    // ═══════════════════════════════════════════════════════
    //  挂载到全局
    // ═══════════════════════════════════════════════════════
    window.DangerousCommandManager = DCM;

})();
