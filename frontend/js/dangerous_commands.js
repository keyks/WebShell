/**
 * ═══════════════════════════════════════════════════════════
 * 高危指令管理模块 (Dangerous Command Manager) v2
 * ═══════════════════════════════════════════════════════════
 *
 * 纯本地规则引擎，零 API 依赖，实时同步响应：
 *   critical → 直接阻止执行 + 发送 Ctrl+C + 错误提示
 *   high     → 弹出安全确认弹窗（确认/取消/60s超时）
 *   medium   → Toast 警告提示 + 放行执行
 *
 * 与 app.js 的集成点：
 *   term.onData 逐字缓冲 → Enter 时调用 DCM.checkAndBlock(sessionId, cmd)
 *   → 返回 true 表示命令被拦截（内部已处理 confirm/block/toast）
 *   → 返回 false 表示安全，调用方自行发送 \r
 *
 * 规则排列规则：specific（critical）→ generic（medium），先匹配先生效
 *
 * 依赖：window.App (toast, socket, openModal, closeModal)
 *      DOM: #securityConfirmModal 弹窗元素
 */

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════
    //  风险等级常量
    // ═══════════════════════════════════════════════════════
    const LEVEL = {
        CRITICAL: 'critical',   // 直接阻止，不可绕过
        HIGH:     'high',       // 弹窗二次确认
        MEDIUM:   'medium',     // Toast 提醒后放行
    };

    // ═══════════════════════════════════════════════════════
    //  完整规则表（按优先级排列：critical > high > medium）
    //  每条规则: { level, pattern, description, suggestion }
    // ═══════════════════════════════════════════════════════

    // ── CRITICAL：极度危险，直接阻止 ─────────────────────
    const R_CRIT = LEVEL.CRITICAL;
    const CRITICAL_RULES = [
        // 根目录递归删除
        { pat: /\brm\s+-rf\s+\//,            desc: '递归强制删除根目录',                          sugg: '请指定明确的子目录路径' },
        { pat: /\brm\s+-rf\s+\/\*/,           desc: '删除根目录下所有内容',                        sugg: '请指定明确的子目录路径' },
        { pat: /\brm\s+-[rR][fF]\s+~?\/[\s;$|&]/, desc: '删除根目录或家目录',                   sugg: '请指定明确的子目录路径' },
        // 磁盘清零 / 随机写入
        { pat: /\bdd\s+if=\/dev\/(zero|random|urandom)/, desc: '向磁盘写入零字节/随机数据',       sugg: '请确认目标设备正确' },
        // 格式化文件系统
        { pat: /\bmkfs\b/,                    desc: '格式化文件系统，将清空所有数据',               sugg: '请先备份数据' },
        { pat: /\bmke2fs\b/,                  desc: '格式化 ext 文件系统，将清空所有数据',          sugg: '请先备份数据' },
        // 直接写入磁盘设备
        { pat: />\s*\/dev\/sd[a-z]/,          desc: '重定向写入磁盘设备',                          sugg: '极度危险，请勿执行' },
        { pat: /\bcat\s+\/dev\/null\s*>\s*\/dev\/sd/, desc: '清空磁盘设备',                        sugg: '极度危险，请勿执行' },
        // Fork 炸弹
        { pat: /:\(\)\{.*\}.*:/,              desc: 'Fork 炸弹，将导致系统崩溃',                   sugg: '这是恶意代码，请勿执行' },
        // 杀 init / 杀所有进程
        { pat: /\bkill\s+-9\s+1\b/,           desc: '杀死 init(PID=1)进程，导致系统崩溃',          sugg: '请勿执行此操作' },
        { pat: /\bkill\s+-9\s+-1\b/,          desc: '杀死所有进程，导致系统崩溃',                  sugg: '请勿执行此操作' },
    ];

    // ── HIGH：高危操作，弹窗确认 ─────────────────────────
    const R_HIGH = LEVEL.HIGH;
    const HIGH_RULES = [
        // 递归删除
        { pat: /\brm\s+-rf\s+/,               desc: '递归强制删除目录，可能造成数据丢失',           sugg: '请确认目标目录无误，建议先 ls 查看' },
        { pat: /\brm\s+-[rR][fF]\s+/,          desc: '递归强制删除目录，可能造成数据丢失',           sugg: '请确认目标目录无误' },
        { pat: /\brm\s+-[rR]\s+/,              desc: '递归删除目录，可能造成数据丢失',               sugg: '请确认目标目录无误' },
        { pat: /\brm\s+-[fF]\s+/,              desc: '强制删除文件，跳过确认提示',                   sugg: '请确认要删除的文件' },
        // 安全粉碎
        { pat: /\bshred\b/,                    desc: '安全粉碎文件（多次覆写后删除），不可恢复',      sugg: '请先备份重要文件' },
        // 权限变更
        { pat: /\bchmod\s+-R\s+777/,           desc: '递归赋予所有权限(777)，存在严重安全风险',      sugg: '请使用最小必要权限' },
        { pat: /\bchmod\s+777\s+\//,           desc: '给根目录赋予全部权限',                         sugg: '这会导致严重安全漏洞' },
        { pat: /\bchown\s+-R\s+\S+\s+\//,      desc: '递归修改根目录所有者',                         sugg: '请指定具体子目录' },
        { pat: /\bchown\s+-R\s+root:root\s+\//, desc: '递归修改根目录所有者为 root',                 sugg: '请指定具体子目录' },
        // 移入黑洞
        { pat: /\bmv\s+\S+\s+\/dev\/null/,     desc: '将文件移入黑洞(/dev/null)，数据不可恢复',       sugg: '请使用 rm 并先备份' },
        // 磁盘分区
        { pat: /\bfdisk\b/,                    desc: '磁盘分区操作，可能导致数据丢失',                 sugg: '请先备份重要数据，确认目标磁盘' },
        { pat: /\bparted\b/,                   desc: '磁盘分区操作，可能导致数据丢失',                 sugg: '请先备份重要数据，确认目标磁盘' },
        // 关机/重启
        { pat: /\bshutdown\b/,                 desc: '关机操作，将中断所有服务',                      sugg: '请确认非生产环境' },
        { pat: /\breboot\b/,                   desc: '重启操作，将中断所有服务',                      sugg: '请确认非生产环境' },
        { pat: /\bhalt\b/,                     desc: '停机操作，将中断所有服务',                      sugg: '请确认非生产环境' },
        { pat: /\bpoweroff\b/,                 desc: '关机操作，将中断所有服务',                      sugg: '请确认非生产环境' },
        { pat: /\binit\s+[06]\b/,              desc: '切换运行级别，可能关机/重启',                   sugg: '请确认非生产环境' },
        // 防火墙清空
        { pat: /\biptables\s+-F/,              desc: '清空防火墙规则，暴露所有端口',                   sugg: '请确认有其他安全措施后再操作' },
        { pat: /\biptables\s+-X/,              desc: '删除自定义防火墙链',                            sugg: '请确认有其他安全措施后再操作' },
        // 覆盖写入磁盘
        { pat: /\bdd\s+if=/,                   desc: '磁盘写入操作(if=)，可能覆盖磁盘数据',           sugg: '请确认输入/输出设备正确' },
        // 命令行语句 rm -rf ...; ...（管道后跟高危删除）
    ];

    // ── MEDIUM：中危操作，Toast 提醒后放行 ───────────────
    const R_MED = LEVEL.MEDIUM;
    const MEDIUM_RULES = [
        // 普通删除
        { pat: /\brm\s+/,                      desc: '删除文件，不可恢复',                            sugg: '请确认要删除的文件' },
        { pat: /\brmdir\b/,                    desc: '删除空目录',                                    sugg: '请确认目录为空且不再需要' },
        { pat: /\bunlink\b/,                   desc: '删除文件链接',                                  sugg: '请确认不再需要此文件' },
        { pat: /\btruncate\s+-s\s+0/,          desc: '清空文件内容',                                  sugg: '请先备份文件' },
        { pat: /\bwipefs\b/,                   desc: '擦除文件系统签名',                              sugg: '可能导致数据丢失，请确认设备' },
        // 创建交换分区
        { pat: /\bmkswap\b/,                   desc: '创建交换分区',                                  sugg: '请确认目标设备正确' },
        // 进程管理
        { pat: /\bkill\s+-9\b/,                desc: '强制终止进程(kill -9)',                         sugg: '请先尝试 kill（不带-9），确认进程可安全终止' },
        // 系统服务控制
        { pat: /\bsystemctl\s+stop\s+/,        desc: '停止系统服务',                                  sugg: '请确认服务可以安全停止，非关键依赖' },
        { pat: /\bsystemctl\s+disable/,         desc: '禁用系统服务（开机不启动）',                     sugg: '请确认服务非关键依赖' },
        // 用户/密码管理
        { pat: /\bpasswd\b/,                   desc: '修改用户密码',                                   sugg: '请记录新密码并妥善保管' },
        { pat: /\buserdel\s+-r/,               desc: '删除用户及主目录',                              sugg: '请先备份用户数据' },
        { pat: /\buserdel\b/,                  desc: '删除用户',                                      sugg: '请确认用户不再需要' },
        // 定时任务
        { pat: /\bcrontab\s+-r\b/,             desc: '删除所有 crontab 定时任务',                      sugg: '请先备份 crontab -l > backup.cron' },
        // 清除历史
        { pat: /\bhistory\s+-c\b/,             desc: '清除命令历史记录',                               sugg: '此操作不可恢复' },
        // 文件系统修复
        { pat: /\bfsck\b/,                     desc: '文件系统检查与修复',                             sugg: '建议先卸载目标分区' },
        // 递归修改权限（非 777）
        { pat: /\bchmod\s+-R\b/,               desc: '递归修改权限',                                  sugg: '请确认目录范围正确' },
        { pat: /\bchown\s+-R\b/,               desc: '递归修改所有者',                                sugg: '请确认目录范围正确' },
    ];

    // ═══════════════════════════════════════════════════════
    //  合并所有规则，critical 优先 → high → medium
    // ═══════════════════════════════════════════════════════
    const ALL_RULES = [
        ...CRITICAL_RULES.map(r => ({ ...r, level: R_CRIT })),
        ...HIGH_RULES.map(r     => ({ ...r, level: R_HIGH })),
        ...MEDIUM_RULES.map(r   => ({ ...r, level: R_MED })),
    ];

    // ═══════════════════════════════════════════════════════
    //  内部状态
    // ═══════════════════════════════════════════════════════
    let _confirmTimer = null;

    // ═══════════════════════════════════════════════════════
    //  公共 API
    // ═══════════════════════════════════════════════════════

    const DCM = {

        // ── 核心方法：检测并拦截 ──────────────────────────

        /**
         * 检查命令风险等级并根据等级执行对应操作（同步，无 API 依赖）
         *
         * @param {string} sessionId - 终端会话 ID
         * @param {string} cmd       - 完整命令行
         * @returns {boolean} true=已拦截（内部已处理），false=安全可执行
         */
        checkAndBlock(sessionId, cmd) {
            if (!cmd || cmd.length < 2) return false;

            const rule = DCM._matchRule(cmd);
            if (!rule) return false;

            switch (rule.level) {
                case LEVEL.CRITICAL:
                    DCM._blockCritical(sessionId, cmd, rule);
                    return true;

                case LEVEL.HIGH:
                    return DCM._showConfirm(sessionId, cmd, rule); // 确认→false(放行), 取消→true(拦截)

                case LEVEL.MEDIUM:
                    DCM._warnAndPass(sessionId, cmd, rule);
                    return false; // Toast 警告但仍然放行，调用方应发送 \r

                default:
                    return false;
            }
        },

        /**
         * 纯检测：命令是否匹配任何规则（保留兼容旧 API）
         * @param {string} cmd
         * @returns {boolean}
         */
        isPotentiallyRisky(cmd) {
            return !!DCM._matchRule(cmd);
        },

        /**
         * 获取匹配到的规则详情
         * @param {string} cmd
         * @returns {object|null} {level, desc, sugg} 或 null
         */
        getMatchedRule(cmd) {
            const r = DCM._matchRule(cmd);
            return r ? { level: r.level, description: r.desc, suggestion: r.sugg } : null;
        },

        // ── 终端控制 ──────────────────────────────────────

        sendEnter(sessionId) {
            const App = window.App;
            if (App && App.socket) {
                App.socket.emit('terminal_input', { session_id: sessionId, data: '\r' });
            }
        },

        sendCtrlC(sessionId) {
            const App = window.App;
            if (App && App.socket) {
                App.socket.emit('terminal_input', { session_id: sessionId, data: '\x03' });
            }
        },

        // ── 规则查询 ──────────────────────────────────────

        getRules() {
            return ALL_RULES.map(r => ({ ...r }));
        },

        getLevels() {
            return { ...LEVEL };
        },

        // ═══════════════════════════════════════════════════
        //  内部方法
        // ═══════════════════════════════════════════════════

        /** 按优先级匹配第一个命中的规则 */
        _matchRule(cmd) {
            for (const r of ALL_RULES) {
                if (r.pat.test(cmd)) return r;
            }
            return null;
        },

        /** critical：阻止执行，发送 Ctrl+C 取消当前行 */
        _blockCritical(sessionId, cmd, rule) {
            const App = window.App;
            if (App) {
                App.toast('⛔ 极度危险命令已阻止: ' + rule.desc,
                    'error', 8000);
            }
            DCM.sendCtrlC(sessionId);
        },

        /** high：自定义安全确认弹窗（命令高亮 + 影响分析 + 倒计时后再确认） */
        _showConfirm(sessionId, cmd, rule) {
            const App = window.App;
            const lv = rule.level || 'high';

            // ── 降级：无 App 或 Modal ──
            if (!App || !document.getElementById('securityConfirmModal')) {
                if (confirm('⚠️ 高危命令:\n\n' + cmd + '\n\n风险: ' + rule.desc + '\n\n是否确认执行？')) {
                    if (App) App.toast('✅ 命令已确认并发送', 'success');
                    return false;
                }
                if (App) App.toast('❌ 命令已取消', 'info');
                return true;
            }

            // ── 1. 设置风险徽章 ──
            const badge = document.getElementById('secRiskBadge');
            const label = document.getElementById('secRiskLabel');
            if (badge && label) {
                const icons = { critical:'fa-biohazard', high:'fa-shield-virus', medium:'fa-exclamation-triangle' };
                const names = { critical:'严重威胁',  high:'高危操作',       medium:'中危提醒' };
                badge.className = 'sec-badge ' + lv;
                badge.querySelector('i').className = 'fas ' + (icons[lv] || icons.high);
                label.textContent = (names[lv] || names.high);
            }

            // 类别副标题
            const catEl = document.getElementById('secCategory');
            if (catEl) catEl.textContent = DCM._guessCategory(rule.desc);

            // ── 2. 命令高亮 ──
            const cmdText = document.getElementById('secCmdText');
            if (cmdText) cmdText.innerHTML = DCM._highlightCmd(cmd, rule);

            // ── 3. 描述 & 建议 ──
            const descEl = document.getElementById('secDescription');
            if (descEl) descEl.textContent = rule.desc;
            const suggEl = document.getElementById('secSuggestion');
            if (suggEl) suggEl.textContent = (rule.sugg || '请仔细核对命令后再执行');

            // ── 4. 影响分析 ──
            const dmgGrid = document.getElementById('secDmgGrid');
            if (dmgGrid) {
                const impacts = DCM._analyzeImpact(cmd);
                dmgGrid.innerHTML = DCM._IMPACT_DIMENSIONS.map(dim => {
                    const hit = impacts.indexOf(dim.id) >= 0;
                    return '<div class="sec-dmg-item ' + (hit ? 'active' : 'inactive') + '">' +
                        '<i class="fas ' + dim.icon + ' sec-dmg-icon"></i>' +
                        '<span>' + dim.label + '</span></div>';
                }).join('');
            }

            // ── 5. 动态副标题 ──
            const hdSub = document.getElementById('secHdSub');
            if (hdSub) hdSub.textContent = (lv === 'critical')
                ? '⚠ 此操作可能造成不可逆的严重损害，请谨慎决策'
                : '系统已拦截该命令，需二次确认后方可执行';

            // ── 6. 倒计时配置（秒）──
            const CD_SEC = lv === 'critical' ? 5 : 3;
            const cdBar  = document.getElementById('secCdFill');
            const cdNum  = document.getElementById('secCdNum');
            const cdText = document.getElementById('secCdText');
            const confirmBtn = document.getElementById('secConfirmBtn');
            const confirmLabel = document.getElementById('secConfirmLabel');
            let cdTimer = null, cdLeft = CD_SEC, cdDone = false;

            const updateCdUI = (left) => {
                const pct = (left / CD_SEC) * 100;
                if (cdBar)  cdBar.style.width = pct + '%';
                if (cdNum)  cdNum.textContent = String(left);
                if (cdText) cdText.innerHTML = '请等待 <strong id="secCdNum">' + left + '</strong> 秒后再确认';
            };
            updateCdUI(CD_SEC);

            if (confirmBtn && confirmLabel) {
                confirmBtn.disabled = true;
                confirmLabel.textContent = '我了解风险，执行命令';
            }

            const startCd = () => {
                cdTimer = setInterval(() => {
                    cdLeft--;
                    updateCdUI(Math.max(cdLeft, 0));
                    if (cdLeft <= 0) {
                        clearInterval(cdTimer);
                        cdDone = true;
                        if (cdBar)  cdBar.style.width = '0%';
                        if (cdText) cdText.innerHTML = '<i class="fas fa-check-circle" style="color:#4caf50;"></i> 请再次确认后点击执行';
                        if (confirmBtn) {
                            confirmBtn.disabled = false;
                            confirmBtn.focus();
                        }
                    }
                }, 1000);
            };

            // ── 7. 事件绑定 & cleanup ──
            const cancelBtn = document.getElementById('secCancelBtn');
            const backdrop  = document.getElementById('securityConfirmBackdrop');

            const cleanup = () => {
                if (cdTimer) clearInterval(cdTimer);
                DCM._clearTimer();
                if (confirmBtn) confirmBtn.replaceWith(confirmBtn.cloneNode(true));
                if (cancelBtn) cancelBtn.replaceWith(cancelBtn.cloneNode(true));
                if (backdrop) backdrop.replaceWith(backdrop.cloneNode(true));
                App.closeSecurityConfirm();
            };

            console.log('[SecModal] DCM path _showConfirm triggering', { command: cmd, level: lv });

            document.getElementById('secConfirmBtn').addEventListener('click', () => {
                if (!cdDone) return; // 倒计时未完成，忽略点击
                cleanup();
                App.socket.emit('terminal_input', {
                    session_id: sessionId,
                    data: cmd + '\r'
                });
                App.toast('✅ 命令已确认并发送', 'success');
            });

            document.getElementById('secCancelBtn').addEventListener('click', () => {
                cleanup();
                App.toast('❌ 命令已取消', 'info');
            });

            // 点击遮罩关闭
            if (backdrop) {
                backdrop.addEventListener('click', () => {
                    cleanup();
                    App.toast('❌ 命令已取消', 'info');
                });
            }

            // 60 秒超时（从打开弹窗起算）
            _confirmTimer = setTimeout(() => {
                cleanup();
                App.toast('⏰ 确认超时，请重新执行命令', 'warning');
            }, 60000);

            // ── 打开弹窗（CSS transform 居中，无需 JS 定位）──
            console.log('[SecModal] Calling App.openSecurityConfirm() [DCM path]');
            if (App && typeof App.openSecurityConfirm === 'function') {
                App.openSecurityConfirm();
            }

            // 延迟校准（极端小屏适配）
            setTimeout(() => {
                if (App && typeof App.repositionSecurityConfirm === 'function') {
                    App.repositionSecurityConfirm();
                }
            }, 100);

            // 打开后启动倒计时
            setTimeout(startCd, 200);

            // 始终返回 true（拦截），由 Modal 的 confirm 按钮负责发送
            return true;
        },

        /** medium：Toast 警告后放行 */
        _warnAndPass(sessionId, cmd, rule) {
            const App = window.App;
            if (App) {
                App.toast(
                    '⚠️ 中危操作: ' + rule.desc +
                    ' — ' + (rule.sugg || '请确认是否安全'),
                    'warning', 5000
                );
            }
            // 不在此发送 \r，由调用方统一发送
        },

        _clearTimer() {
            if (_confirmTimer) {
                clearTimeout(_confirmTimer);
                _confirmTimer = null;
            }
        },

        // ═══════════ 影响维度的静态定义 ═══════════
        _IMPACT_DIMENSIONS: [
            { id: 'data_loss',    icon: 'fa-database',     label: '数据丢失' },
            { id: 'permission',   icon: 'fa-key',          label: '权限变更' },
            { id: 'sys_crash',    icon: 'fa-power-off',    label: '系统崩溃/中断' },
            { id: 'svc_stop',     icon: 'fa-server',       label: '服务停止' },
            { id: 'disk_destroy', icon: 'fa-hdd',          label: '磁盘/分区损坏' },
            { id: 'sec_breach',   icon: 'fa-user-secret',  label: '安全漏洞' },
        ],

        /** 根据风险描述猜测操作类别 */
        _guessCategory(desc) {
            const keys = {
                '删除':   '文件与目录操作',
                '格式化': '磁盘/文件系统操作',
                '清空':   '数据销毁',
                '修改':   '权限与所有者变更',
                '关机':   '电源与系统控制',
                '重启':   '电源与系统控制',
                '停机':   '电源与系统控制',
                '分区':   '磁盘管理',
                '防火墙': '网络安全',
                '杀死':   '进程管理',
                '粉碎':   '数据销毁',
                '写入':   '磁盘写入',
                '关停':   '电源与系统控制',
                '覆盖':   '数据销毁',
                '删除所有': '定时任务管理',
                '清除':   '历史记录清理',
            };
            for (const k in keys) {
                if (desc.indexOf(k) >= 0) return keys[k];
            }
            return '系统命令';
        },

        /** 分析命令涉及的潜在影响维度 */
        _analyzeImpact(cmd) {
            const hits = [];
            // 数据丢失
            if (/\brm\b|shred|unlink|truncate|wipefs/.test(cmd))              hits.push('data_loss');
            // 磁盘/分区损坏
            if (/\bmkfs\b|mke2fs|fdisk|parted|dd\s+if=.*\/dev\//.test(cmd)  ||
                />\s*\/dev\/sd/.test(cmd))                                     hits.push('disk_destroy');
            // 权限变更
            if (/\bchmod\s+-R\s+777|chmod\s+777\b|chown\s+-R/.test(cmd))     hits.push('permission');
            // 系统崩溃/关机/重启
            if (/\bshutdown\b|reboot|halt|poweroff|init\s+[06]|kill\s+-9\b/.test(cmd)) hits.push('sys_crash');
            // 服务停止
            if (/\bsystemctl\s+(stop|disable)\b/.test(cmd))                    hits.push('svc_stop');
            // 安全漏洞（防火墙清空等）
            if (/\biptables\s+-F|iptables\s+-X/.test(cmd))                     hits.push('sec_breach');

            // 兜底：无匹配则至少显示数据丢失风险
            return hits.length ? hits : ['data_loss'];
        },

        /** 命令高亮：将规则 pattern 匹配到的片段包裹 <span class="cmd-hl"> */
        _highlightCmd(cmd, rule) {
            if (!rule.pat) { return DCM._escapeHtml(cmd); }
            const escaped = DCM._escapeHtml(cmd);
            try {
                // 用规则的 pat 去匹配原始 cmd，拿到匹配区间
                const m = cmd.match(rule.pat);
                if (!m || typeof m.index !== 'number') return escaped;

                const start = m.index;
                const end   = start + m[0].length;
                // 需要计算 HTML 转义后的偏移映射（简单方案：纯 ASCII 命令通常 1:1）
                let htmlStart = start;
                let htmlEnd   = end;
                // 计算转义引入的偏移（仅 '&' '<' '>' 会导致偏移）
                for (let i = 0; i < start; i++) {
                    if (cmd[i] === '&') htmlStart += 4; // &amp;
                    else if (cmd[i] === '<') htmlStart += 3; // &lt;
                    else if (cmd[i] === '>') htmlStart += 3; // &gt;
                }
                htmlEnd = htmlStart;
                for (let i = start; i < end; i++) {
                    const ch = cmd[i];
                    htmlEnd += (ch === '&') ? 5 : (ch === '<' || ch === '>') ? 4 : 1;
                }

                return escaped.substring(0, htmlStart) +
                    '<span class="cmd-hl">' + escaped.substring(htmlStart, htmlEnd) + '</span>' +
                    escaped.substring(htmlEnd);
            } catch(e) {
                return escaped;
            }
        },

        /** HTML 转义 */
        _escapeHtml(str) {
            const div = document.createElement('div');
            div.appendChild(document.createTextNode(str));
            return div.innerHTML;
        },
    };

    // ═══════════════════════════════════════════════════════
    //  挂载到全局
    // ═══════════════════════════════════════════════════════
    window.DangerousCommandManager = DCM;

})();
