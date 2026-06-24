// frontend/js/ai_assistant.js
/**
 * AI 运维助手前端控制器
 * 模块一：智能对话
 * 模块二：容量预测 + 安全扫描
 * 模块三：命令风险分析
 * 模块四：知识库
 * 模块五：集群健康总览 + 拓扑
 */

// ==================== XSS 安全防护：HTML 转义工具 ====================
const _htmlEsc = (text) => {
    if (text == null) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
};

const AIAssistant = {

    // 当前会话
    currentSessionId: null,
    currentChatId:    null,
    _initialized:     new Set(),
    _activeTab:       {},
    _chatHistory:     [],
    _cmdRegistry: {},
    _cmdCounter:  0,
    _MAX_CMD_REGISTRY_SIZE: 500,  // 命令注册表最大容量
    _floatingMode: {},   // sessionId → boolean，每会话独立悬浮状态
    _floatPrevTab: {},   // sessionId → tabName，退出悬浮时恢复之前的 Tab
    _floatBusy: false,   // 🔧 防止快速关闭/打开导致的动画竞态

    // ══════════════════════════════════════════
    //  初始化（在 switchPanelTab 'ai-diagnose' 时调用）
    // ══════════════════════════════════════════

    init(sessionId) {
        this.currentSessionId = sessionId;
        this.currentChatId    = `chat_${sessionId}`;

        if (!this._initialized.has(sessionId)) {
            this._initialized.add(sessionId);
            this._renderPanel(sessionId);
            // 🔧 使用 requestAnimationFrame 确保 DOM 渲染完成后再绑定事件
            requestAnimationFrame(() => {
                this._bindEvents(sessionId);
            });
        } else {
            // ✅ 切回时恢复上次激活的子 Tab 可见性（默认 diagnose，智能助手已移至全局）
            const lastTab = this._activeTab[sessionId] || 'diagnose';
            this.switchTab(sessionId, lastTab);
            // 🔧 重新绑定事件（DOM 可能被重建）
            requestAnimationFrame(() => {
                this._bindEvents(sessionId);
            });
        }
    },

    /**
     * 🔧 事件委托：统一处理 AI 面板中的快捷发送、命令执行、复制等操作
     * 解决内联 onclick 中的引号冲突和 this 指向问题
     * 使用 WeakMap 存储每个容器的事件处理器，避免内存泄漏
     */
    _bindEvents(sessionId) {
        const container = document.getElementById(`ai-diagnose-${sessionId}`);
        if (!container) return;

        // 使用 WeakMap 存储每个容器的事件处理器，避免内存泄漏
        if (!this._eventHandlers) {
            this._eventHandlers = new WeakMap();
        }

        // 如果已有处理器，先移除
        const oldHandler = this._eventHandlers.get(container);
        if (oldHandler) {
            container.removeEventListener('click', oldHandler);
        }

        const handler = (e) => {
            const target = e.target.closest('[data-ai-action]');
            if (!target) return;

            const action = target.dataset.aiAction;
            const id = target.dataset.aiId;
            const sid = target.dataset.aiSessionId || this.currentSessionId;
            const risk = target.dataset.aiRisk || 'low';

            switch (action) {
                case 'quick-send':
                    this._executeQuickSend(id, sid);
                    break;
                case 'exec-command':
                    this._executeCommandById(id, sid, risk);
                    break;
                case 'copy-command':
                    this._executeCopyById(id);
                    break;
            }
        };

        container.addEventListener('click', handler);
        this._eventHandlers.set(container, handler);
    },

    /**
     * 🔧 通过 data-ai-id 执行快捷发送（事件委托回调）
     */
    _executeQuickSend(id, sessionId) {
        const item = this._cmdRegistry[id];
        if (!item) {
            // 回退：尝试从 DOM 元素文本获取
            const el = document.querySelector(`[data-ai-id="${id}"]`);
            if (el && el.textContent) {
                const text = el.textContent.trim();
                if (text) {
                    this.sendQuick(sessionId || this.currentSessionId, text);
                    return;
                }
            }
            App.toast('快捷指令已过期，请刷新页面', 'warning');
            return;
        }
        this.sendQuick(item.sessionId || sessionId, item.text);
    },

    /**
     * 🔧 通过 data-ai-id 执行命令（事件委托回调）
     */
    _executeCommandById(id, sessionId, riskLevel) {
        const cmd = this._cmdRegistry[id];
        if (!cmd) {
            // 回退：尝试从 DOM 元素中提取命令文本
            const el = document.querySelector(`[data-ai-id="${id}"]`);
            if (el) {
                const codeEl = el.closest('div')?.querySelector('code');
                if (codeEl && codeEl.textContent) {
                    const cmdText = codeEl.textContent.trim();
                    if (cmdText && cmdText.length < 1000) {
                        this.executeCommand(sessionId || this.currentSessionId, cmdText, riskLevel || 'low');
                        return;
                    }
                }
            }
            App.toast('命令已过期，请重新查询', 'warning');
            return;
        }
        this.executeCommand(sessionId || this.currentSessionId, cmd, riskLevel || 'low');
    },

    /**
     * 🔧 通过 data-ai-id 复制命令（事件委托回调）
     */
    _executeCopyById(id) {
        const cmd = this._cmdRegistry[id];
        if (cmd) {
            navigator.clipboard.writeText(cmd);
            App.toast('已复制', 'success');
        }
    },

    // ✅ 新增方法
    _activeTab: {},   // 记录每个 session 上次激活的子 Tab

    _restoreActiveTab(sessionId) {
        const lastTab = this._activeTab[sessionId] || 'diagnose';
        this.switchTab(sessionId, lastTab);
    },
    // ══════════════════════════════════════════
    //  渲染主面板
    // ══════════════════════════════════════════

    _renderPanel(sessionId) {
        const container = document.getElementById(`ai-diagnose-${sessionId}`);
        if (!container) return;

        container.innerHTML = `
            <div style="display:flex;flex-direction:column;height:100%;background:var(--bg-primary);">

                <!-- 顶部 Tab 导航（AI 诊断面板：不含「智能助手」，智能助手是全局悬浮功能） -->
                <div style="display:flex;gap:0;border-bottom:1px solid var(--border-color);
                            background:var(--bg-secondary);flex-shrink:0;padding:0 4px;">
                    ${[
                        ['diagnose',  'fa-stethoscope',  'AI 诊断'],
                        ['predict',   'fa-chart-line',   '容量预测'],
                        ['security',  'fa-shield-alt',   '安全扫描'],
                    ].map(([tab, icon, label]) => `
                        <div class="ai-sub-tab" data-tab="${tab}"
                             onclick="AIAssistant.switchTab('${sessionId}','${tab}')">
                            <i class="fas ${icon}"></i> ${label}
                        </div>
                    `).join('')}
                </div>

                <!-- 内容区 -->
                <div style="flex:1;overflow:hidden;position:relative;">

                    <!-- AI 诊断 -->
                    <div class="ai-tab-content" id="ai-tab-diagnose-${sessionId}"
                         style="display:none;height:100%;overflow-y:auto;padding:24px;">
                        ${this._renderDiagnosePanel(sessionId)}
                    </div>

                    <!-- 容量预测 -->
                    <div class="ai-tab-content" id="ai-tab-predict-${sessionId}"
                         style="display:none;height:100%;overflow-y:auto;padding:24px;">
                        ${this._renderPredictPanel(sessionId)}
                    </div>

                    <!-- 安全扫描 -->
                    <div class="ai-tab-content" id="ai-tab-security-${sessionId}"
                         style="display:none;height:100%;overflow-y:auto;padding:24px;">
                        ${this._renderSecurityPanel(sessionId)}
                    </div>

                </div>
            </div>
        `;

        // 默认激活 AI 诊断 Tab（第一个 Tab，智能助手已移至全局悬浮窗）
        this.switchTab(sessionId, 'diagnose');
    },
    // ══════════════════════════════════════════
    //  悬浮窗模式
    // ══════════════════════════════════════════

    /**
     * 🆕 全局智能助手悬浮窗入口（从 toolbar 按钮调用）
     *    创建独立的悬浮 DOM 元素，不依赖 AI 诊断面板
     *    v2.2: 关闭时隐藏而非销毁，重新打开保留对话记录
     */
    toggleGlobalFloat() {
        // 🔧 防止快速关闭/打开导致的动画竞态（350ms 内禁止二次操作）
        if (this._floatBusy) return;
        this._floatBusy = true;
        setTimeout(() => { this._floatBusy = false; }, 350);

        // 获取当前活跃会话
        let sessionId = (typeof App !== 'undefined') ? App.activeSession : null;
        if (!sessionId) {
            this._floatBusy = false;
            App.toast('请先打开一个终端会话', 'warning');
            return;
        }

        const existingFloat = document.getElementById('globalAIFloat');
        if (existingFloat) {
            // 已存在 → 隐藏/显示切换（保留对话记录）
            // 🔧 用 visibility 判断（非 display），保持布局树不销毁
            if (existingFloat.style.visibility === 'hidden') {
                // 🔧 重新显示：更新会话 ID（用户可能切换了会话）
                this._showGlobalFloat(sessionId);
            } else {
                this._hideGlobalFloat();
            }
            return;
        }

        // 确保 AI 助手已初始化（加载聊天面板数据）
        if (!this._initialized.has(sessionId)) {
            this.init(sessionId);
        }

        // 标记全局悬浮状态
        this._floatingMode['global'] = true;
        this._createGlobalFloat(sessionId);
    },

    /**
     * 🔧 隐藏全局悬浮窗（保留 DOM 和对话内容）
     */
    _hideGlobalFloat() {
        const wrapper = document.getElementById('globalAIFloat');
        if (!wrapper) return;
        // 🔧 用 visibility 代替 display:none，保持布局树中的占地，
        //     防止 GPU 合成层被销毁导致恢复后 flex 布局错误上移
        wrapper.style.visibility = 'hidden';
        wrapper.style.pointerEvents = 'none';
        wrapper.style.opacity = '0';

        // 恢复全局按钮状态
        const globalBtn = document.getElementById('globalFloatBtn');
        if (globalBtn) {
            globalBtn.style.background = '';
            globalBtn.style.color = '';
            globalBtn.style.borderColor = '';
            const span = globalBtn.querySelector('span');
            if (span) span.textContent = '智能助手';
        }
    },

    /**
     * 🔧 重新显示全局悬浮窗（处理会话切换）
     */
    _showGlobalFloat(sessionId) {
        const wrapper = document.getElementById('globalAIFloat');
        if (!wrapper) return;
        wrapper.style.visibility = '';
        wrapper.style.pointerEvents = '';
        wrapper.style.opacity = '';

        // 🔧 如果会话切换了，更新 currentSessionId/currentChatId
        if (this.currentSessionId !== sessionId) {
            this.currentSessionId = sessionId;
            this.currentChatId = `chat_${sessionId}`;
            // 重新绑定事件（使用新的 sessionId）
            const content = document.getElementById('globalAIFloatContent');
            if (content) {
                this._rebindAllChatEvents(sessionId, content);
            }
        }

        // 更新全局按钮状态
        const globalBtn = document.getElementById('globalFloatBtn');
        if (globalBtn) {
            globalBtn.style.background = 'var(--accent-color)';
            globalBtn.style.color = '#fff';
            globalBtn.style.borderColor = 'var(--accent-color)';
            const span = globalBtn.querySelector('span');
            if (span) span.textContent = '关闭助手';
        }
    },

    /**
     * 🔧 切换会话时重新绑定所有事件（发送按钮、输入框、快捷提问委托）
     */
    _rebindAllChatEvents(sessionId, container) {
        // 清理旧事件
        if (this._chatEventCleanups) {
            Object.keys(this._chatEventCleanups).forEach(k => {
                if (this._chatEventCleanups[k]) this._chatEventCleanups[k]();
                delete this._chatEventCleanups[k];
            });
        }
        if (this._chatKeyCleanups) {
            Object.keys(this._chatKeyCleanups).forEach(k => {
                if (this._chatKeyCleanups[k]) this._chatKeyCleanups[k]();
                delete this._chatKeyCleanups[k];
            });
        }
        if (this._floatClickHandlers) {
            Object.keys(this._floatClickHandlers).forEach(k => {
                if (container && this._floatClickHandlers[k]) {
                    container.removeEventListener('click', this._floatClickHandlers[k]);
                }
                delete this._floatClickHandlers[k];
            });
        }
        // 重新绑定
        this._bindChatEvents(sessionId, container);
    },

    /**
     * 创建全局悬浮窗 DOM（独立于 AI 诊断面板）
     */
    _createGlobalFloat(sessionId) {
        // 🔧 防御式清理：确保没有残留的旧 float（防止快速切换时 DOM 残留）
        const staleFloat = document.getElementById('globalAIFloat');
        if (staleFloat) {
            try { staleFloat.remove(); } catch (e) {}
        }

        this.currentSessionId = sessionId;
        this.currentChatId = `chat_${sessionId}`;

        // 🔧 响应式尺寸
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let floatW = 520, floatH = 600;
        if (vw < 640) {
            floatW = vw - 24; floatH = vh - 140;
        } else if (vw < 1024) {
            floatW = Math.min(480, vw - 40); floatH = Math.min(560, vh - 120);
        }

        const wrapper = document.createElement('div');
        wrapper.id = 'globalAIFloat';
        wrapper.className = 'ai-float-window';
        wrapper.style.cssText = `
            position: fixed !important;
            top: 80px;
            right: 20px;
            width: ${floatW}px;
            height: ${floatH}px;
            max-width: calc(100vw - 40px);
            max-height: calc(100vh - 100px);
            min-width: 320px;
            min-height: 360px;
            z-index: 901;
            border-radius: 12px;
            border: 1px solid var(--border-color);
            box-shadow: 0 12px 40px rgba(0,0,0,0.4);
            overflow: hidden;
            display: flex;
            flex-direction: column;
            background: var(--bg-primary);
        `;

        // 标题栏
        const titleBar = document.createElement('div');
        titleBar.style.cssText = `
            display: flex; align-items: center; justify-content: space-between;
            height: 36px; padding: 0 8px 0 14px;
            background: var(--bg-secondary); border-bottom: 1px solid var(--border-color);
            border-radius: 12px 12px 0 0; cursor: move; flex-shrink: 0; user-select: none;
        `;
        titleBar.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-secondary);pointer-events:none;">
                <i class="fas fa-robot" style="color:var(--accent-color);"></i>
                <span>智能助手</span>
            </div>
            <div style="display:flex;gap:4px;pointer-events:auto;">
                <button class="btn-icon" title="关闭" onclick="AIAssistant._closeGlobalFloat()"
                        style="width:28px;height:28px;border-radius:6px;font-size:12px;color:var(--danger-color);">
                    <i class="fas fa-times"></i>
                </button>
            </div>
        `;

        // 内容区：聊天面板
        const content = document.createElement('div');
        content.id = 'globalAIFloatContent';
        content.style.cssText = 'flex:1;overflow:hidden;display:flex;flex-direction:column;position:relative;min-height:0;';
        content.innerHTML = this._renderChatPanel(sessionId);

        wrapper.appendChild(titleBar);
        wrapper.appendChild(content);

        // 🔧 右下角 resize 手柄
        const resizeHandle = document.createElement('div');
        resizeHandle.style.cssText = `
            position: absolute;
            bottom: 0;
            right: 0;
            width: 16px;
            height: 16px;
            cursor: nwse-resize;
            z-index: 10;
        `;
        resizeHandle.innerHTML = `
            <svg width="12" height="12" viewBox="0 0 12 12" style="position:absolute;bottom:2px;right:2px;opacity:0.4;">
                <path d="M0 12 L12 0 L12 4 L4 12 Z" fill="var(--text-secondary)"/>
                <path d="M4 12 L12 4 L12 8 L8 12 Z" fill="var(--text-secondary)"/>
                <path d="M8 12 L12 8 L12 12 Z" fill="var(--text-secondary)"/>
            </svg>`;
        wrapper.appendChild(resizeHandle);

        document.body.appendChild(wrapper);

        // 🔧 动画结束后清理 animation 属性，防止快速切换导致的样式污染
        const onAnimEnd = () => {
            wrapper.style.animation = 'none';
            wrapper.removeEventListener('animationend', onAnimEnd);
        };
        wrapper.addEventListener('animationend', onAnimEnd);
        // 兜底：350ms 后强制清理（防止 animationend 未触发）
        setTimeout(() => {
            if (wrapper.style.animation !== 'none') {
                wrapper.style.animation = 'none';
            }
        }, 400);

        // 拖拽支持
        this._initFloatDrag(titleBar, wrapper, 'global');

        // resize 支持
        this._initFloatResize(resizeHandle, wrapper, 'global');

        // 窗口 resize 响应式处理
        this._registerFloatResizeHandler('global', wrapper);

        // 🔧 绑定事件（聊天输入等）
        this._bindChatEvents(sessionId, content);

        // 🔧 更新全局按钮状态
        const globalBtn = document.getElementById('globalFloatBtn');
        if (globalBtn) {
            globalBtn.style.background = 'var(--accent-color)';
            globalBtn.style.color = '#fff';
            globalBtn.style.borderColor = 'var(--accent-color)';
            globalBtn.querySelector('span').textContent = '关闭助手';
        }

        // 🔧 加载聊天历史（仅首次打开时）
        setTimeout(() => {
            if (typeof this.loadAllChatHistory === 'function') {
                this.loadAllChatHistory(sessionId);
            }
        }, 200);

        App.toast('智能助手已打开，可拖拽移动、右下角调整大小', 'info');
    },

    /**
     * 关闭全局悬浮窗
     */
    _closeGlobalFloat() {
        // 🔧 防止快速关闭/打开导致的动画竞态
        if (this._floatBusy) return;
        this._floatBusy = true;

        const wrapper = document.getElementById('globalAIFloat');
        if (!wrapper) {
            this._floatBusy = false;
            return;
        }

        // 清理 resize 处理器
        this._unregisterFloatResizeHandler('global');
        // 清理 resize 手柄处理器
        if (this._floatResizeCleanups && this._floatResizeCleanups['global']) {
            try { this._floatResizeCleanups['global'](); } catch (e) {}
            delete this._floatResizeCleanups['global'];
        }
        // 清理拖拽处理器
        if (this._floatCleanups && this._floatCleanups['global']) {
            try { this._floatCleanups['global'](); } catch (e) {}
            delete this._floatCleanups['global'];
        }

        // 清理聊天事件
        if (this._chatEventCleanups) {
            Object.keys(this._chatEventCleanups).forEach(k => {
                try { if (this._chatEventCleanups[k]) this._chatEventCleanups[k](); } catch (e) {}
            });
        }
        if (this._chatKeyCleanups) {
            Object.keys(this._chatKeyCleanups).forEach(k => {
                try { if (this._chatKeyCleanups[k]) this._chatKeyCleanups[k](); } catch (e) {}
            });
        }
        // 清理快捷发送事件委托
        if (this._floatClickHandlers) {
            const content = document.getElementById('globalAIFloatContent');
            Object.keys(this._floatClickHandlers).forEach(k => {
                try {
                    if (content && this._floatClickHandlers[k]) {
                        content.removeEventListener('click', this._floatClickHandlers[k]);
                    }
                } catch (e) {}
                delete this._floatClickHandlers[k];
            });
        }

        // 🔧 确保 wrapper 一定被移除（放在 try/catch 之后的安全移除）
        try { wrapper.remove(); } catch (e) {
            // 降级：手动从父节点移除
            if (wrapper.parentNode) { wrapper.parentNode.removeChild(wrapper); }
        }
        this._floatingMode['global'] = false;

        // 恢复全局按钮状态
        const globalBtn = document.getElementById('globalFloatBtn');
        if (globalBtn) {
            globalBtn.style.background = '';
            globalBtn.style.color = '';
            globalBtn.style.borderColor = '';
            const span = globalBtn.querySelector('span');
            if (span) span.textContent = '智能助手';
        }

        // 🔧 延迟解除锁，确保动画完成
        setTimeout(() => { this._floatBusy = false; }, 350);
    },

    /**
     * 🔧 为全局悬浮窗绑定聊天事件（独立于 AI 诊断面板的 _bindEvents）
     */
    _bindChatEvents(sessionId, container) {
        if (!container) return;

        // 发送按钮事件
        const sendBtn = container.querySelector('.ai-send-btn');
        if (sendBtn) {
            const handler = () => this.sendMessage(sessionId);
            sendBtn.addEventListener('click', handler);
            if (!this._chatEventCleanups) this._chatEventCleanups = {};
            this._chatEventCleanups[sessionId] = () => sendBtn.removeEventListener('click', handler);
        }

        // 输入框回车发送 & 自动增高
        const input = container.querySelector(`#chatInput-${sessionId}`);
        if (input) {
            // 🔧 修复：keydown 事件不再依赖内联 onkeydown 属性
            const keyHandler = (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendMessage(sessionId);
                }
            };
            input.addEventListener('keydown', keyHandler);
            // 🔧 修复：自动增高事件不再依赖内联 oninput 属性
            // 只在高度真正变化时才设置，避免不必要的回流
            const inputHandler = () => {
                const prevHeight = input.style.height;
                input.style.height = 'auto';
                const newH = Math.min(120, Math.max(42, input.scrollHeight));
                const newHeight = newH + 'px';
                if (prevHeight !== newHeight) {
                    input.style.height = newHeight;
                }
            };
            input.addEventListener('input', inputHandler);
            if (!this._chatKeyCleanups) this._chatKeyCleanups = {};
            if (!this._chatInputCleanups) this._chatInputCleanups = {};
            this._chatKeyCleanups[sessionId] = () => {
                input.removeEventListener('keydown', keyHandler);
                input.removeEventListener('input', inputHandler);
            };
        }

        // 🔧 快捷提问 / 命令执行 / 复制 的事件委托（与 _bindEvents 一致）
        if (!this._floatClickHandlers) this._floatClickHandlers = {};
        const oldFloatHandler = this._floatClickHandlers[sessionId];
        if (oldFloatHandler) {
            container.removeEventListener('click', oldFloatHandler);
        }
        const floatClickHandler = (e) => {
            const target = e.target.closest('[data-ai-action]');
            if (!target) return;

            const action = target.dataset.aiAction;
            const id = target.dataset.aiId;
            const sid = target.dataset.aiSessionId || sessionId;
            const risk = target.dataset.aiRisk || 'low';

            switch (action) {
                case 'quick-send':
                    this._executeQuickSend(id, sid);
                    break;
                case 'exec-command':
                    this._executeCommandById(id, sid, risk);
                    break;
                case 'copy-command':
                    this._executeCopyById(id);
                    break;
            }
        };
        container.addEventListener('click', floatClickHandler);
        this._floatClickHandlers[sessionId] = floatClickHandler;
    },

    toggleFloat(sessionId) {
        const aiPanel = document.getElementById(`ai-diagnose-${sessionId}`);
        if (!aiPanel) return;

        this._floatingMode[sessionId] = !this._floatingMode[sessionId];
        const isFloating = this._floatingMode[sessionId];
        const btn = document.getElementById(`floatToggle-${sessionId}`);

        if (isFloating) {
            this._enterFloat(sessionId, aiPanel, btn);
        } else {
            this._exitFloat(sessionId, aiPanel, btn);
        }
    },

    _enterFloat(sessionId, aiPanel, btn) {
        // 🔧 保存进入悬浮前的活动 Tab，用于退出时恢复
        const panel = document.getElementById(`panel-${sessionId}`);
        const prevActiveTab = panel
            ? (panel.querySelector('.panel-tab.active')?.dataset?.tab || 'terminal')
            : 'terminal';
        this._floatPrevTab[sessionId] = prevActiveTab;

        // 🔧 响应式：根据窗口宽度自适应悬浮窗尺寸
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let floatW = 520, floatH = 600;
        if (vw < 640) {
            floatW = vw - 24; floatH = vh - 140;
        } else if (vw < 1024) {
            floatW = Math.min(480, vw - 40); floatH = Math.min(560, vh - 120);
        }

        aiPanel.style.cssText = `
            position: fixed !important;
            top: 80px;
            right: 20px;
            width: ${floatW}px;
            height: ${floatH}px;
            max-width: calc(100vw - 40px);
            max-height: calc(100vh - 100px);
            min-width: 320px;
            min-height: 360px;
            z-index: 900;
            border-radius: 12px;
            border: 1px solid var(--border-color);
            box-shadow: 0 12px 40px rgba(0,0,0,0.4);
            overflow: hidden;
            display: flex;
            flex-direction: column;
            background: var(--bg-primary);
        `;

        // 🔧 添加悬浮窗标题栏（拖拽 + 关闭按钮）
        if (!document.getElementById(`floatTitleBar-${sessionId}`)) {
            const bar = document.createElement('div');
            bar.id = `floatTitleBar-${sessionId}`;
            bar.style.cssText = `
                display: flex;
                align-items: center;
                justify-content: space-between;
                height: 36px;
                padding: 0 8px 0 14px;
                background: var(--bg-secondary);
                border-bottom: 1px solid var(--border-color);
                border-radius: 12px 12px 0 0;
                cursor: move;
                flex-shrink: 0;
                user-select: none;
            `;
            bar.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-secondary);pointer-events:none;">
                    <i class="fas fa-robot" style="color:var(--accent-color);"></i>
                    <span>AI 运维助手</span>
                </div>
                <div style="display:flex;gap:4px;pointer-events:auto;">
                    <button class="btn-icon" title="最小化" onclick="AIAssistant.toggleFloatMinimize('${sessionId}')"
                            style="width:28px;height:28px;border-radius:6px;font-size:12px;color:var(--text-secondary);">
                        <i class="fas fa-window-minimize"></i>
                    </button>
                    <button class="btn-icon" title="关闭悬浮窗" onclick="AIAssistant.toggleFloat('${sessionId}')"
                            style="width:28px;height:28px;border-radius:6px;font-size:12px;color:var(--danger-color);">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            `;
            aiPanel.prepend(bar);
            this._initFloatDrag(bar, aiPanel, sessionId);
        }

        // 🔧 添加右下角调整大小手柄
        if (!document.getElementById(`floatResize-${sessionId}`)) {
            const resize = document.createElement('div');
            resize.id = `floatResize-${sessionId}`;
            resize.style.cssText = `
                position: absolute;
                bottom: 0;
                right: 0;
                width: 16px;
                height: 16px;
                cursor: nwse-resize;
                z-index: 10;
            `;
            resize.innerHTML = `
                <svg width="12" height="12" viewBox="0 0 12 12" style="position:absolute;bottom:2px;right:2px;opacity:0.4;">
                    <path d="M0 12 L12 0 L12 4 L4 12 Z" fill="var(--text-secondary)"/>
                    <path d="M4 12 L12 4 L12 8 L8 12 Z" fill="var(--text-secondary)"/>
                    <path d="M8 12 L12 8 L12 12 Z" fill="var(--text-secondary)"/>
                </svg>`;
            aiPanel.appendChild(resize);
            this._initFloatResize(resize, aiPanel, sessionId);
        }

        // 🔧 注册窗口 resize 响应式处理器：窗口变化时悬浮窗自动适配
        this._registerFloatResizeHandler(sessionId, aiPanel);

        if (btn) {
            btn.innerHTML = '<i class="fas fa-compress-alt"></i> <span>还原</span>';
            btn.style.background = 'var(--accent-color)';
            btn.style.color = '#fff';
            btn.style.borderColor = 'var(--accent-color)';
        }

        // 🔧 悬浮模式下：切换到终端 Tab 让用户同时看到终端 + 悬浮 AI 窗
        //    但两个 Tab 高亮会导致视觉混乱，这里仅高亮终端，AI Tab 不高亮
        if (panel) {
            const termTab = panel.querySelector('.panel-tab[data-tab="terminal"]');
            if (termTab) {
                // 显示终端内容区
                panel.querySelector('.terminal-wrapper')?.classList.add('active');
                panel.querySelector('.file-manager')?.classList.remove('active');
                panel.querySelector('.system-monitor')?.classList.remove('active');
                panel.querySelector('.cmd-panel')?.classList.remove('active');
                // 🔧 仅终端 Tab 高亮，AI Tab 不高亮（悬浮窗本身就是 AI 面板）
                panel.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
                termTab.classList.add('active');
                setTimeout(() => {
                    if (typeof terminalManager !== 'undefined') {
                        const size = terminalManager.fit(sessionId);
                        if (size && App.socket) App.socket.emit('terminal_resize', { session_id: sessionId, ...size });
                        terminalManager.focus(sessionId);
                    }
                }, 100);
            }
        }

        App.toast('已进入悬浮窗模式，拖拽标题栏移动，右下角调整大小', 'info');
    },

    _exitFloat(sessionId, aiPanel, btn) {
        // 🔧 恢复面板原始布局（非悬浮态的正常样式）
        //    原始 inline style: display:flex; flex:1; overflow-y:auto; padding:20px; background: var(--bg-primary);
        aiPanel.style.cssText = `
            display: flex;
            flex: 1;
            overflow-y: auto;
            padding: 20px;
            background: var(--bg-primary);
        `;
        // 清除悬浮模式附加的 fixed 定位残留属性
        aiPanel.style.position = '';
        aiPanel.style.top = '';
        aiPanel.style.right = '';
        aiPanel.style.left = '';
        aiPanel.style.width = '';
        aiPanel.style.height = '';
        aiPanel.style.maxWidth = '';
        aiPanel.style.maxHeight = '';
        aiPanel.style.minWidth = '';
        aiPanel.style.minHeight = '';
        aiPanel.style.zIndex = '';
        aiPanel.style.borderRadius = '';
        aiPanel.style.border = '';
        aiPanel.style.boxShadow = '';
        aiPanel.style.resize = '';
        aiPanel.style.flexDirection = '';

        // 清理悬浮窗 DOM 元素
        document.getElementById(`floatTitleBar-${sessionId}`)?.remove();
        document.getElementById(`floatResize-${sessionId}`)?.remove();

        // 🔧 清理窗口 resize 响应式处理器
        this._unregisterFloatResizeHandler(sessionId);

        if (btn) {
            btn.innerHTML = '<i class="fas fa-external-link-alt"></i> <span>悬浮</span>';
            btn.style.background = '';
            btn.style.color = '';
            btn.style.borderColor = '';
        }

        // 🔧 退出悬浮窗后，恢复进入悬浮前的 Tab 状态
        const prevTab = this._floatPrevTab[sessionId] || 'ai-diagnose';
        if (typeof App !== 'undefined' && App.switchPanelTab) {
            App.switchPanelTab(sessionId, prevTab);
        }
        delete this._floatPrevTab[sessionId];

        App.toast('已退出悬浮窗模式', 'info');
    },

    /**
     * 🔧 悬浮窗最小化/恢复
     */
    toggleFloatMinimize(sessionId) {
        const aiPanel = document.getElementById(`ai-diagnose-${sessionId}`);
        if (!aiPanel) return;
        const innerContent = aiPanel.querySelector(':scope > div:nth-child(2)'); // 跳过标题栏后的内容区
        if (!innerContent) return;
        const isMinimized = innerContent.style.display === 'none';
        if (isMinimized) {
            innerContent.style.display = 'flex';
            aiPanel.style.height = '';
            aiPanel.style.minHeight = '360px';
        } else {
            innerContent.style.display = 'none';
            aiPanel.style.height = 'auto';
            aiPanel.style.minHeight = '36px';
        }
    },

    _initFloatDrag(handle, panel, sessionId) {
        let isDragging = false;
        let startX, startY, startLeft, startTop;

        // 🔧 使用命名函数避免重复绑定的内存泄漏
        const onMouseDown = (e) => {
            // 忽略按钮点击
            if (e.target.closest('button')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = panel.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'move';
            e.preventDefault();
        };

        const onMouseMove = (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const panelW = panel.offsetWidth;
            const panelH = panel.offsetHeight;
            const margin = 16;

            let newLeft = startLeft + dx;
            let newTop = startTop + dy;

            if (newLeft < margin - panelW) newLeft = margin - panelW;
            if (newLeft > window.innerWidth - margin) newLeft = window.innerWidth - margin;
            if (newTop < 0) newTop = 0;
            if (newTop > window.innerHeight - margin) newTop = window.innerHeight - margin;

            panel.style.left = newLeft + 'px';
            panel.style.top = newTop + 'px';
            panel.style.right = 'auto';
        };

        const onMouseUp = () => {
            isDragging = false;
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
        };

        handle.addEventListener('mousedown', onMouseDown);
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);

        // 🔧 存储清理函数，供 destroy 时使用
        if (!this._floatCleanups) this._floatCleanups = {};
        this._floatCleanups[sessionId] = () => {
            handle.removeEventListener('mousedown', onMouseDown);
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };
    },

    _initFloatResize(handle, panel, sessionId) {
        let isResizing = false;
        let startX, startY, startW, startH;

        const onMouseDown = (e) => {
            isResizing = true;
            startX = e.clientX;
            startY = e.clientY;
            startW = panel.offsetWidth;
            startH = panel.offsetHeight;
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'nwse-resize';
            e.preventDefault();
            e.stopPropagation();
        };

        const onMouseMove = (e) => {
            if (!isResizing) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const newW = Math.max(320, Math.min(window.innerWidth - 40, startW + dx));
            const newH = Math.max(360, Math.min(window.innerHeight - 40, startH + dy));
            panel.style.width = newW + 'px';
            panel.style.height = newH + 'px';
        };

        const onMouseUp = () => {
            isResizing = false;
            document.body.style.userSelect = '';
            document.body.style.cursor = '';
        };

        handle.addEventListener('mousedown', onMouseDown);
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);

        if (!this._floatResizeCleanups) this._floatResizeCleanups = {};
        this._floatResizeCleanups[sessionId] = () => {
            handle.removeEventListener('mousedown', onMouseDown);
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };
    },

    /**
     * 🔧 注册窗口 resize 处理器，确保悬浮窗在窗口变化时自适应
     *    防止出现错位、重叠、超出屏幕等问题
     */
    _registerFloatResizeHandler(sessionId, aiPanel) {
        // 先移除旧的处理器
        this._unregisterFloatResizeHandler(sessionId);

        let debounceTimer = null;
        let rafId = null;

        const onResize = () => {
            if (rafId) cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => {
                const vw = window.innerWidth;
                const vh = window.innerHeight;

                // 响应式调整宽度
                if (vw < 640) {
                    aiPanel.style.width = (vw - 24) + 'px';
                    aiPanel.style.height = (vh - 140) + 'px';
                } else if (vw < 1024) {
                    aiPanel.style.width = Math.min(480, vw - 40) + 'px';
                    aiPanel.style.height = Math.min(560, vh - 120) + 'px';
                }

                // 确保悬浮窗不超出视口边界
                const rect = aiPanel.getBoundingClientRect();
                const margin = 8;

                if (rect.left < margin) {
                    aiPanel.style.left = margin + 'px';
                    aiPanel.style.right = 'auto';
                }
                if (rect.top < margin) {
                    aiPanel.style.top = margin + 'px';
                }
                if (rect.bottom > vh - margin) {
                    aiPanel.style.top = (vh - rect.height - margin) + 'px';
                }
                if (rect.right > vw - margin) {
                    aiPanel.style.right = margin + 'px';
                    aiPanel.style.left = 'auto';
                }
            });
        };

        // 使用 debounce 避免频繁触发
        const debouncedResize = () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(onResize, 150);
        };

        window.addEventListener('resize', debouncedResize);

        // 存储清理函数
        if (!this._floatWindowResizeCleanups) this._floatWindowResizeCleanups = {};
        this._floatWindowResizeCleanups[sessionId] = () => {
            window.removeEventListener('resize', debouncedResize);
            clearTimeout(debounceTimer);
            if (rafId) cancelAnimationFrame(rafId);
        };
    },

    _unregisterFloatResizeHandler(sessionId) {
        if (this._floatWindowResizeCleanups && this._floatWindowResizeCleanups[sessionId]) {
            this._floatWindowResizeCleanups[sessionId]();
            delete this._floatWindowResizeCleanups[sessionId];
        }
    },
    /**
     * 注册一条命令并返回唯一 ID（避免 onclick 引号冲突）
     * 自动清理旧命令，防止内存无限增长
     */
    _regCmd(cmd) {
        // 🔧 清理过期命令（仅清理 aicmd_ 前缀，保护 quick_ 快捷消息条目）
        const allKeys = Object.keys(this._cmdRegistry);
        const cmdKeys = allKeys.filter(k => k.startsWith('aicmd_'));
        if (cmdKeys.length > this._MAX_CMD_REGISTRY_SIZE) {
            const sorted = cmdKeys.sort((a, b) => {
                const idA = parseInt(a.split('_')[1] || 0);
                const idB = parseInt(b.split('_')[1] || 0);
                return idA - idB;
            });
            const toRemove = sorted.slice(0, Math.floor(cmdKeys.length * 0.2));
            toRemove.forEach(k => delete this._cmdRegistry[k]);
        }
        const id = `aicmd_${++this._cmdCounter}`;
        this._cmdRegistry[id] = cmd;
        return id;
    },

    /**
     * 通过 ID 执行命令
     */
    execById(cmdId, sessionId, riskLevel) {
        const cmd = this._cmdRegistry[cmdId];
        if (!cmd) {
            // 🔧 回退策略：尝试从 DOM 元素中提取命令文本
            const el = document.querySelector(`[onclick*="execById('${cmdId}')"]`);
            if (el) {
                // 尝试从父级 code 元素获取命令
                const codeEl = el.closest('div')?.querySelector('code');
                if (codeEl && codeEl.textContent) {
                    const cmdText = codeEl.textContent.trim();
                    if (cmdText && cmdText.length < 1000) {
                        this.executeCommand(sessionId || this.currentSessionId, cmdText, riskLevel || 'low');
                        return;
                    }
                }
            }
            App.toast('命令已过期，请重新查询', 'warning');
            return;
        }
        if (!sessionId || sessionId === 'undefined' || sessionId === 'null') {
            sessionId = this.currentSessionId;
        }
        this.executeCommand(sessionId || this.currentSessionId, cmd, riskLevel || 'low');
    },

    /**
     * 通过 ID 复制命令
     */
    copyById(cmdId) {
        const cmd = this._cmdRegistry[cmdId];
        if (cmd) {
            navigator.clipboard.writeText(cmd);
            App.toast('已复制', 'success');
        }
    },

    /**
     * 注册快捷提示文本并返回唯一 ID（避免 onclick 引号冲突）
     */
    _regQuick(sessionId, text) {
        const id = `quick_${++this._cmdCounter}`;
        this._cmdRegistry[id] = { sessionId, text };
        return id;
    },

    /**
     * 通过 ID 发送快捷提示
     * ✅ 修复：如果注册表项丢失，尝试直接从 DOM 文本中提取并发送
     */
    execQuick(id) {
        const item = this._cmdRegistry[id];
        if (!item) {
            // 🔧 回退策略：查找调用该函数的元素，从其文本内容获取提示文本
            const el = document.querySelector(`[onclick*="execQuick('${id}')"]`);
            if (el && el.textContent) {
                const text = el.textContent.trim();
                if (text) {
                    this.sendQuick(this.currentSessionId, text);
                    return;
                }
            }
            App.toast('已过期，请重试', 'warning');
            return;
        }
        this.sendQuick(item.sessionId, item.text);
    },

    switchTab(sessionId, tab) {
        const container = document.getElementById(`ai-diagnose-${sessionId}`);
        if (!container) return;

        this._activeTab[sessionId] = tab;

        // 更新 Tab 样式（使用 CSS class 替代 inline style）
        container.querySelectorAll('.ai-sub-tab').forEach(el => {
            const active = el.dataset.tab === tab;
            el.classList.toggle('active', active);
        });

        // 切换内容区
        container.querySelectorAll('.ai-tab-content').forEach(el => {
            el.style.display = 'none';
        });

        const target = document.getElementById(`ai-tab-${tab}-${sessionId}`);
        if (!target) return;

        // ✅ chat 面板需要 flex 布局，其他用 block
        target.style.display = (tab === 'chat') ? 'flex' : 'block';

        // 🔧 滚动到当前选中的 Tab 标签（子Tab过多时的体验优化）
        const activeTab = container.querySelector('.ai-sub-tab.active');
        if (activeTab) {
            activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        }

        // 按需加载数据（知识库和拓扑图已提升为顶级 Tab，不再需要在此处理）
    },

    /**
     * 🔧 同步悬浮窗按钮的 UI 状态与实际 _floatingMode 一致
     */
    _syncFloatButtonState(sessionId) {
        const btn = document.getElementById(`floatToggle-${sessionId}`);
        if (!btn) return;
        const isFloating = this._floatingMode[sessionId];
        if (isFloating) {
            btn.innerHTML = '<i class="fas fa-compress-alt"></i> <span>还原</span>';
            btn.style.background = 'var(--accent-color)';
            btn.style.color = '#fff';
            btn.style.borderColor = 'var(--accent-color)';
        } else {
            btn.innerHTML = '<i class="fas fa-external-link-alt"></i> <span>悬浮</span>';
            btn.style.background = '';
            btn.style.color = '';
            btn.style.borderColor = '';
        }
    },

    // ============================================================
    // 5. 修复历史记录 - 添加刷新和搜索功能
    // ============================================================

    // 修改 _loadHistoryList 方法，增加刷新按钮功能
    _loadHistoryList: async function(sessionId) {
        const div = document.getElementById(`historyList-${sessionId}`);
        if (!div) return;

        div.innerHTML = `<div style="text-align:center;color:var(--text-secondary);padding:40px;">
            <i class="fas fa-spinner fa-spin"></i> 加载中...
        </div>`;

        try {
            const res = await fetch('/api/ai/chat/sessions', { headers: App.authHeaders() });
            const data = await res.json();

            if (!data.data?.length) {
                div.innerHTML = `
                    <div style="text-align:center;color:var(--text-secondary);padding:60px;background:var(--bg-secondary);border-radius:12px;border:1px dashed var(--border-color);">
                        <i class="fas fa-comment-slash" style="font-size:36px;display:block;margin-bottom:12px;opacity:0.3;"></i>
                        暂无历史对话记录
                    </div>`;
                return;
            }

            // 按时间分组
            const grouped = {};
            data.data.forEach(session => {
                const date = (session.last_active || '').slice(0, 10);
                if (!grouped[date]) grouped[date] = [];
                grouped[date].push(session);
            });

            let html = '';
            // 按日期排序（最新的在前）
            const dates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));
            
            for (const date of dates) {
                html += `
                    <div style="margin-bottom:16px;">
                        <div style="font-size:11px;font-weight:600;color:var(--text-secondary);
                                    padding:4px 8px;margin-bottom:8px;
                                    background:var(--bg-tertiary);border-radius:4px;
                                    display:inline-block;">
                            <i class="far fa-calendar-alt" style="margin-right:4px;"></i>
                            ${date}
                        </div>
                        <div style="display:flex;flex-direction:column;gap:6px;">`;
                
                for (const session of grouped[date]) {
                    const isCurrentChat = session.chat_id === `chat_${sessionId}`;
                    html += `
                        <div style="background:var(--bg-secondary);border:1px solid ${isCurrentChat ? 'var(--accent-color)' : 'var(--border-color)'};
                                    border-radius:8px;padding:12px 16px;
                                    cursor:pointer;transition:all 0.2s;
                                    ${isCurrentChat ? 'box-shadow: var(--glow-accent);' : ''}"
                            onclick="AIAssistant._loadSessionDetail('${sessionId}', '${session.chat_id}')"
                            onmouseenter="this.style.borderColor='var(--accent-color)';this.style.transform='translateX(2px)'"
                            onmouseleave="this.style.borderColor='${isCurrentChat ? 'var(--accent-color)' : 'var(--border-color)'}';this.style.transform='translateX(0)'">
                            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
                                <div style="flex:1;min-width:0;">
                                    <div style="font-size:13px;font-weight:500;color:var(--text-bright);display:flex;align-items:center;gap:6px;">
                                        <i class="fas fa-comments" style="color:var(--accent-color);font-size:12px;"></i>
                                        ${App.escapeHtml(session.chat_id)}
                                        ${isCurrentChat ? `<span style="font-size:9px;background:var(--accent-color);color:#fff;padding:1px 8px;border-radius:10px;">当前</span>` : ''}
                                    </div>
                                    <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">
                                        ${session.message_count} 条消息
                                    </div>
                                </div>
                                <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
                                    <div style="font-size:11px;color:var(--text-secondary);">
                                        ${(session.last_active || '').slice(11, 16)}
                                    </div>
                                    <button class="btn btn-icon btn-sm"
                                            onclick="event.stopPropagation();AIAssistant._deleteHistorySession('${sessionId}','${session.chat_id}')"
                                            title="删除此对话"
                                            style="color:var(--danger-color);opacity:0.5;transition:opacity 0.2s;flex-shrink:0;"
                                            onmouseenter="this.style.opacity='1'"
                                            onmouseleave="this.style.opacity='0.5'">
                                        <i class="fas fa-trash-alt" style="font-size:11px;"></i>
                                    </button>
                                </div>
                            </div>
                        </div>`;
                }
                
                html += `</div></div>`;
            }

            div.innerHTML = html;

        } catch (e) {
            div.innerHTML = `<div style="color:var(--danger-color);padding:20px;">加载失败: ${App.escapeHtml(e.message)}</div>`;
        }
    },

    // 修改 _loadSessionDetail 方法 - 美化详情显示
    _loadSessionDetail: async function(sessionId, chatId) {
        const div = document.getElementById(`historyList-${sessionId}`);
        if (!div) return;

        div.innerHTML = `<div style="text-align:center;color:var(--text-secondary);padding:20px;">
            <i class="fas fa-spinner fa-spin"></i> 加载消息...
        </div>`;

        try {
            const res = await fetch(
                `/api/ai/chat/history?chat_id=${encodeURIComponent(chatId)}&limit=200`,
                { headers: App.authHeaders() }
            );
            const data = await res.json();
            const msgs = data.data || [];

            let html = `
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap;">
                    <button class="btn btn-sm" onclick="AIAssistant._loadHistoryList('${sessionId}')">
                        <i class="fas fa-arrow-left"></i> 返回列表
                    </button>
                    <span style="font-size:13px;color:var(--text-secondary);flex:1;">
                        <i class="fas fa-comments" style="color:var(--accent-color);"></i>
                        ${App.escapeHtml(chatId)} · ${msgs.length} 条消息
                    </span>
                    <span style="font-size:11px;color:var(--text-secondary);">
                        ${(msgs[0]?.created_at || '').slice(0, 10)}
                    </span>
                    <button class="btn btn-sm"
                            onclick="AIAssistant._deleteHistorySession('${sessionId}','${chatId}')"
                            title="删除此对话"
                            style="font-size:10px;color:var(--danger-color);border-color:var(--danger-color);">
                        <i class="fas fa-trash-alt"></i> 删除
                    </button>
                </div>
                <div style="display:flex;flex-direction:column;gap:10px;">
                    ${msgs.filter(m => m.role !== 'system').map(m =>
                        AIAssistant._renderHistoryMessage(sessionId, m)
                    ).join('')}
                </div>
            `;

            div.innerHTML = html;
            div.scrollTop = 0;

        } catch (e) {
            div.innerHTML = `<div style="color:var(--danger-color);padding:20px;">加载失败: ${App.escapeHtml(e.message)}</div>`;
        }
    },

    // ══════════════════════════════════════════
    //  模块一：智能对话面板
    // ══════════════════════════════════════════

    _renderChatPanel(sessionId) {
        return `
            <div id="chatMessages-${sessionId}"
                style="flex:1;overflow-y:auto;padding:16px 16px;
                        display:flex;flex-direction:column;gap:16px;min-height:0;">
                <div style="display:flex;align-items:flex-start;gap:10px;
                            padding:12px 0;margin-top:4px;">
                    <div style="width:36px;height:36px;border-radius:50%;
                                background:var(--bg-tertiary);display:flex;
                                align-items:center;justify-content:center;
                                flex-shrink:0;color:var(--accent-color);font-size:16px;">
                        <i class="fas fa-robot"></i>
                    </div>
                    <div style="flex:1;">
                        <div style="font-size:14px;font-weight:600;
                                    color:var(--text-bright);margin-bottom:4px;">
                            AI 运维助手
                        </div>
                        <div style="font-size:13px;line-height:1.7;
                                    color:var(--text-secondary);">
                            你好！用自然语言向我描述问题即可，试试这些：
                        </div>
                        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;">
                            ${(() => {
                                const examples = [
                                    '检查 Nginx 运行状态',
                                    '内存占用为什么这么高？',
                                    '查看磁盘空间使用情况',
                                ];
                                return examples.map(e => {
                                    const eid = this._regQuick(sessionId, e);
                                    return `<span data-ai-action="quick-send" data-ai-id="${eid}"
                                        class="ai-example-chip">${App.escapeHtml(e)}</span>`;
                                }).join('');
                            })()}
                        </div>
                    </div>
                </div>
            </div>

            <!-- 快捷提问区 -->
            <div style="padding:8px 16px;display:flex;gap:8px;flex-wrap:wrap;
                        border-top:1px solid var(--border-color);flex-shrink:0;
                        background:var(--bg-secondary);">
                ${(() => {
                    const quickPrompts = [
                        '检查系统健康状态',
                        '内存占用最高的进程',
                        '检查磁盘空间',
                        '查看最近的系统错误',
                    ];
                    return quickPrompts.map(q => {
                        const qid = this._regQuick(sessionId, q);
                        return `
                    <span data-ai-action="quick-send" data-ai-id="${qid}"
                        class="ai-quick-chip">
                        <i class="fas fa-bolt" style="font-size:10px;opacity:0.5;"></i>
                        ${App.escapeHtml(q)}
                    </span>`;
                    }).join('');
                })()}
            </div>

            <!-- 输入区 -->
            <div style="padding:12px 16px;border-top:1px solid var(--border-color);
                        background:var(--bg-secondary);flex-shrink:0;">
                <div style="display:flex;gap:10px;align-items:stretch;">
                    <textarea id="chatInput-${sessionId}"
                            placeholder="输入问题，Enter 发送，Shift+Enter 换行"
                            rows="1"
                                   style="flex:1;padding:10px 12px;
                                    border:1px solid var(--border-color);
                                    border-radius:10px;background:var(--bg-primary);
                                    color:var(--text-primary);font-size:14px;
                                    resize:none;outline:none;font-family:inherit;
                                    line-height:1.6;overflow-y:auto;
                                    transition:border-color 0.2s,box-shadow 0.2s,height 0.12s ease-out;
                                    min-height:42px;max-height:120px;"
                            onfocus="this.style.borderColor='var(--accent-color)';this.style.boxShadow='0 0 0 3px rgba(79,195,247,0.12)'"
                            onblur="this.style.borderColor='var(--border-color)';this.style.boxShadow='none'"></textarea>
                    <button id="chatSendBtn-${sessionId}"
                            class="ai-send-btn"
                            title="发送 (Enter)">
                        <i class="fas fa-paper-plane"></i>
                    </button>
                    <button onclick="AIAssistant.showChatHistory('${sessionId}')"
                            class="ai-minor-btn" title="对话历史">
                        <i class="fas fa-history"></i>
                    </button>
                    <button onclick="AIAssistant.clearChat('${sessionId}')"
                            class="ai-minor-btn" title="清空对话">
                        <i class="fas fa-trash-alt"></i>
                    </button>
                </div>
            </div>

            <!-- 历史记录抽屉 -->
            <div id="chatHistoryDrawer-${sessionId}"
                style="display:none;position:absolute;top:0;right:0;bottom:0;
                        width:380px;max-width:100%;background:var(--bg-secondary);
                        border-left:1px solid var(--border-color);
                        box-shadow:-4px 0 20px rgba(0,0,0,0.3);z-index:50;
                        flex-direction:column;">

                <!-- 抽屉头部 -->
                <div style="display:flex;align-items:center;justify-content:space-between;
                            padding:14px 16px;border-bottom:1px solid var(--border-color);
                            flex-shrink:0;">
                    <div style="display:flex;align-items:center;gap:8px;">
                        <i class="fas fa-history" style="color:var(--accent-color);"></i>
                        <span style="font-size:14px;font-weight:600;
                                    color:var(--text-bright);">
                            对话历史
                        </span>
                        <span id="chatHistoryStats-${sessionId}"
                            style="font-size:11px;color:var(--text-secondary);"></span>
                    </div>
                    <button class="btn btn-icon btn-sm"
                            onclick="AIAssistant.hideChatHistory('${sessionId}')"
                            title="关闭">
                        <i class="fas fa-times"></i>
                    </button>
                </div>

                <!-- 搜索栏 -->
                <div style="padding:10px 16px;border-bottom:1px solid var(--border-color);
                            flex-shrink:0;display:flex;gap:6px;">
                    <input type="text"
                        id="chatHistorySearch-${sessionId}"
                        placeholder="搜索对话内容..."
                        onkeypress="if(event.key==='Enter')
                            AIAssistant.searchChatHistory('${sessionId}')"
                        style="flex:1;padding:7px 10px;
                                border:1px solid var(--border-color);
                                background:var(--bg-tertiary);
                                color:var(--text-primary);
                                border-radius:6px;font-size:12px;outline:none;">
                    <button class="btn btn-sm"
                            onclick="AIAssistant.searchChatHistory('${sessionId}')">
                        <i class="fas fa-search"></i>
                    </button>
                </div>

                <!-- 日期筛选 -->
                <div style="padding:8px 16px;border-bottom:1px solid var(--border-color);
                            flex-shrink:0;display:flex;gap:6px;align-items:center;">
                    <input type="date"
                        id="chatHistoryDate-${sessionId}"
                        onchange="AIAssistant.filterByDate('${sessionId}')"
                        style="padding:5px 8px;border:1px solid var(--border-color);
                                background:var(--bg-tertiary);color:var(--text-primary);
                                border-radius:6px;font-size:12px;outline:none;">
                    <button class="btn btn-sm"
                            onclick="AIAssistant.loadAllChatHistory('${sessionId}')"
                            style="font-size:11px;">
                        全部
                    </button>
                    <button class="btn btn-sm"
                            onclick="AIAssistant.loadTodayChatHistory('${sessionId}')"
                            style="font-size:11px;">
                        今天
                    </button>
                </div>

                <!-- 会话列表 / 消息列表 -->
                <div id="chatHistoryContent-${sessionId}"
                    style="flex:1;overflow-y:auto;padding:8px;">
                    <div style="text-align:center;color:var(--text-secondary);
                                padding:30px;font-size:13px;">
                        <i class="fas fa-spinner fa-spin"></i> 加载中...
                    </div>
                </div>
            </div>
        `;
    },

    /**
     * 🔧 渲染历史记录子Tab - 包含完整的会话列表、搜索、删除功能
     */
    _renderHistoryTab(sessionId) {
        return `
            <div style="max-width:900px;margin:0 auto;width:100%;">
                <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
                    <i class="fas fa-history" style="font-size:24px;color:var(--accent-color);"></i>
                    <div>
                        <h3 style="color:var(--text-bright);margin:0;">对话历史记录</h3>
                        <p style="color:var(--text-secondary);font-size:12px;margin:2px 0 0;">
                            查看、搜索和管理历史对话
                        </p>
                    </div>
                </div>

                <!-- 搜索和操作栏 -->
                <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
                    <input type="text" id="historyTabSearch-${sessionId}"
                           placeholder="搜索历史对话..."
                           onkeypress="if(event.key==='Enter')AIAssistant._searchHistoryTab('${sessionId}')"
                           style="flex:1;min-width:150px;padding:8px 12px;
                                  border:1px solid var(--border-color);
                                  border-radius:6px;background:var(--bg-tertiary);
                                  color:var(--text-primary);font-size:13px;outline:none;">
                    <button class="btn btn-sm" onclick="AIAssistant._searchHistoryTab('${sessionId}')">
                        <i class="fas fa-search"></i> 搜索
                    </button>
                    <button class="btn btn-sm" onclick="AIAssistant._refreshHistoryTab('${sessionId}')">
                        <i class="fas fa-sync-alt"></i> 刷新
                    </button>
                </div>

                <!-- 会话列表容器 -->
                <div id="historyList-${sessionId}" style="display:flex;flex-direction:column;gap:6px;">
                    <div style="text-align:center;color:var(--text-secondary);padding:40px;">
                        <i class="fas fa-spinner fa-spin"></i> 加载中...
                    </div>
                </div>
            </div>
        `;
    },

    /** 🔧 刷新历史记录子Tab */
    _refreshHistoryTab(sessionId) {
        this._loadHistoryList(sessionId);
    },

    /** 🔧 搜索历史记录子Tab */
    _searchHistoryTab(sessionId) {
        const keyword = document.getElementById(`historyTabSearch-${sessionId}`)?.value?.trim();
        if (!keyword) {
            this._loadHistoryList(sessionId);
            return;
        }
        const div = document.getElementById(`historyList-${sessionId}`);
        if (!div) return;

        div.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-secondary);">
            <i class="fas fa-spinner fa-spin"></i> 搜索中...
        </div>`;

        fetch(`/api/ai/chat/search?q=${encodeURIComponent(keyword)}&limit=50`, {
            headers: App.authHeaders()
        }).then(r => r.json()).then(data => {
            const msgs = data.data || [];
            if (!msgs.length) {
                div.innerHTML = `<div style="text-align:center;color:var(--text-secondary);padding:40px;">
                    未找到包含「${App.escapeHtml(keyword)}」的对话
                </div>`;
                return;
            }
            // 按 chat_id 分组
            const grouped = {};
            msgs.forEach(m => {
                if (!grouped[m.chat_id]) grouped[m.chat_id] = [];
                grouped[m.chat_id].push(m);
            });
            let html = `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:12px;">
                找到 ${msgs.length} 条结果，来自 ${Object.keys(grouped).length} 个会话
            </div>`;
            for (const [chatId, messages] of Object.entries(grouped)) {
                const timeText = (messages[0]?.created_at || '').replace('T', ' ').slice(0, 16);
                html += `
                    <div style="background:var(--bg-secondary);border:1px solid var(--border-color);
                                border-radius:8px;padding:12px 16px;cursor:pointer;margin-bottom:6px;"
                         onclick="AIAssistant._loadSessionDetail('${sessionId}','${chatId}')">
                        <div style="display:flex;justify-content:space-between;align-items:center;">
                            <div>
                                <strong style="color:var(--text-bright);font-size:13px;">
                                    <i class="fas fa-comments" style="color:var(--accent-color);margin-right:6px;"></i>
                                    ${App.escapeHtml(chatId)}
                                </strong>
                                <div style="font-size:11px;color:var(--text-secondary);margin-top:4px;">
                                    ${messages.length} 条匹配消息 · ${timeText}
                                </div>
                            </div>
                            <button class="btn btn-icon btn-sm"
                                    onclick="event.stopPropagation();AIAssistant._deleteHistorySession('${sessionId}','${chatId}')"
                                    title="删除" style="color:var(--danger-color);opacity:0.5;"
                                    onmouseenter="this.style.opacity='1'"
                                    onmouseleave="this.style.opacity='0.5'">
                                <i class="fas fa-trash-alt"></i>
                            </button>
                        </div>
                    </div>`;
            }
            div.innerHTML = html;
        }).catch(e => {
            div.innerHTML = `<div style="color:var(--danger-color);padding:20px;">搜索失败: ${App.escapeHtml(e.message)}</div>`;
        });
    },

    destroy(sessionId) {
        this._initialized.delete(sessionId);
        delete this._activeTab[sessionId];
        // 🔧 清理事件监听器
        const container = document.getElementById(`ai-diagnose-${sessionId}`);
        if (container && this._handleContainerClick) {
            container.removeEventListener('click', this._handleContainerClick);
        }
        // 🔧 清理悬浮窗拖拽和调整大小的监听器（防止内存泄漏）
        if (this._floatCleanups && this._floatCleanups[sessionId]) {
            this._floatCleanups[sessionId]();
            delete this._floatCleanups[sessionId];
        }
        if (this._floatResizeCleanups && this._floatResizeCleanups[sessionId]) {
            this._floatResizeCleanups[sessionId]();
            delete this._floatResizeCleanups[sessionId];
        }
        // 🔧 清理窗口 resize 响应式处理器
        this._unregisterFloatResizeHandler(sessionId);
        // 退出悬浮模式（只针对当前 sessionId）
        if (this._floatingMode[sessionId]) {
            const aiPanel = document.getElementById(`ai-diagnose-${sessionId}`);
            if (aiPanel) aiPanel.style.cssText = '';
            document.getElementById(`floatTitleBar-${sessionId}`)?.remove();
            document.getElementById(`floatResize-${sessionId}`)?.remove();
            this._floatingMode[sessionId] = false;
        }
        delete this._floatPrevTab[sessionId];
    },
    async sendMessage(sessionId) {
        if (!sessionId) {
            sessionId = this.currentSessionId;
        }
        
        if (!sessionId) {
            App.toast('没有活跃的会话', 'warning');
            return;
        }
        const input  = document.getElementById(`chatInput-${sessionId}`);
        const btnEl  = document.getElementById(`chatSendBtn-${sessionId}`);
        const msgs   = document.getElementById(`chatMessages-${sessionId}`);
        
        if (!input || !msgs) {
            App.toast('聊天界面未就绪，请先切换到 AI 助手标签页', 'warning');
            return;
        }
        
        const message = (input.value || '').trim();
        if (!message) {
            App.toast('请输入消息内容', 'warning');
            return;
        }

        input.value = '';
        // 🔧 重置 textarea 高度
        input.style.height = 'auto';

        // 显示用户消息
        this._appendMessage(msgs, 'user', message);

        // 显示加载
        const loadingId = `loading-${Date.now()}`;
        msgs.insertAdjacentHTML('beforeend', `
            <div id="${loadingId}" class="ai-message-row">
                <div class="ai-avatar ai-avatar-bot">
                    <i class="fas fa-robot"></i>
                </div>
                <div class="ai-bubble ai-bubble-bot">
                    <span class="ai-typing-dots">
                        <span></span><span></span><span></span>
                    </span>
                </div>
            </div>
        `);
        msgs.scrollTop = msgs.scrollHeight;

        if (btnEl) { btnEl.disabled = true; btnEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }

        try {
            const res = await fetch('/api/ai/chat', {
                method: 'POST',
                headers: App.authHeaders(),
                body: JSON.stringify({
                    session_id: sessionId,
                    chat_id:    this.currentChatId,
                    message,
                }),
            });

            // 🔧 防御：检测非 JSON 响应（Flask 崩溃返回 HTML 调试页）
            const contentType = res.headers.get('content-type') || '';
            if (!contentType.includes('application/json')) {
                console.error('[AI Chat] 非 JSON 响应:', res.status, contentType);
                throw new Error(`服务器异常 (HTTP ${res.status})，请稍后重试`);
            }

            const data = await res.json();

            document.getElementById(loadingId)?.remove();

            if (data.status === 'ok') {
                this._appendMessage(msgs, 'assistant', data.reply, data.commands);
            } else {
                this._appendMessage(msgs, 'error', data.message || '请求失败');
            }

        } catch (e) {
            document.getElementById(loadingId)?.remove();
            // 🔧 过滤掉技术性 JSON 解析错误，显示友好消息
            const msg = e.message || '';
            if (msg.includes('Unexpected token') || msg.includes('not valid JSON')) {
                this._appendMessage(msgs, 'error', 'AI 服务暂时不可用，请稍后重试');
            } else {
                this._appendMessage(msgs, 'error', '网络错误: ' + msg);
            }
        } finally {
            if (btnEl) {
                btnEl.disabled = false;
                btnEl.innerHTML = '<i class="fas fa-paper-plane"></i>';
            }
            msgs.scrollTop = msgs.scrollHeight;
        }
    },

    _appendMessage(container, role, content, commands = [], timestamp = null) {
        const isUser  = role === 'user';
        const isError = role === 'error';
        const sid     = this.currentSessionId || '';

        // 渲染内容
        const renderedHtml = this._renderRichContent(sid, content, isUser);

        // 🔧 命令按钮：优先使用 API 返回的 commands，否则从文本中提取
        // 🔧 如果内容已含 ```commands 块（由 _renderRichContent 内联渲染），则跳过避免重复
        const hasCommandsBlock = /```commands?/i.test(content);
        let commandsHtml = '';
        if (!hasCommandsBlock) {
            if (commands?.length) {
                const cmdList = commands.map(c => typeof c === 'string' ? c : c.command);
                commandsHtml = this._renderCommandButtons(sid, cmdList);
            } else if (!isUser && !isError && content) {
                const extractedCmds = this._extractCommandsFromText(content);
                if (extractedCmds.length) {
                    commandsHtml = this._renderCommandButtons(sid, extractedCmds);
                }
            }
        }

        const timeHtml = timestamp
            ? `<div class="ai-msg-time" style="text-align:${isUser ? 'right' : 'left'}">${timestamp.replace('T',' ').slice(0,19)}</div>`
            : '';

        const rowClass = isUser ? 'ai-message-row ai-message-row-user' : 'ai-message-row';
        const avatarClass = isUser ? 'ai-avatar ai-avatar-user' : isError ? 'ai-avatar ai-avatar-error' : 'ai-avatar ai-avatar-bot';
        const avatarIcon = isUser ? 'fa-user' : isError ? 'fa-exclamation-circle' : 'fa-robot';
        const bubbleClass = isUser ? 'ai-bubble ai-bubble-user' : isError ? 'ai-bubble ai-bubble-error' : 'ai-bubble ai-bubble-bot';

        container.insertAdjacentHTML('beforeend', `
            <div class="${rowClass}">
                <div class="${avatarClass}">
                    <i class="fas ${avatarIcon}"></i>
                </div>
                <div class="ai-bubble-wrap">
                    <div class="${bubbleClass}">
                        ${renderedHtml}
                        ${commandsHtml}
                    </div>
                    ${timeHtml}
                </div>
            </div>
        `);
    },

    async executeCommand(sessionId, command, riskLevel) {
        // ✅ 规范化 sessionId
        if (!sessionId || sessionId === 'undefined' || sessionId === 'null') {
            sessionId = this.currentSessionId;
        }
        
        if (!sessionId || sessionId === 'undefined' || sessionId === 'null') {
            App.toast('没有活跃的终端会话，请先打开终端', 'warning');
            return;
        }

        // ✅ 验证命令
        if (!command || typeof command !== 'string') {
            App.toast('无效的命令', 'warning');
            return;
        }

        // ✅ 风险检查
        if (riskLevel === 'critical') {
            App.toast('此命令被标记为极度危险，已阻止执行', 'error');
            return;
        }

        // high/medium 命令：先弹确认弹窗，确认后再调用后端 API 二次校验
        if (riskLevel === 'high' || riskLevel === 'medium') {
            const riskLabel = riskLevel === 'high' ? '⚠️ 高危' : '⚠️ 中危';
            const confirmed = await new Promise(resolve => {
                App.confirm(
                    `<div style="text-align:left;line-height:1.7">
                        <div style="font-size:14px;font-weight:600;color:var(--warning-color);margin-bottom:10px">
                            <i class="fas fa-exclamation-triangle"></i> ${riskLabel}命令确认
                        </div>
                        <div style="margin-bottom:8px;color:var(--text-secondary);font-size:12px">
                            您即将执行以下命令，请仔细确认：
                        </div>
                        <div style="background:var(--bg-primary);padding:10px 14px;border-radius:6px;border:1px solid var(--border-color);font-family:Consolas,monospace;font-size:13px;color:var(--text-bright);word-break:break-all;margin-bottom:8px;">
                            ${App.escapeHtml(command)}
                        </div>
                        <div style="font-size:11px;color:var(--danger-color)">
                            此命令被标记为高风险操作，执行后可能对系统造成影响。
                        </div>
                    </div>`,
                    () => resolve(true),
                    () => resolve(false)
                );
            });
            if (!confirmed) return;

            // 用户确认后，再调用后端 API 做二次安全校验
            try {
                const res = await fetch('/api/ai/analyze-command', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...App.authHeaders() },
                    body: JSON.stringify({ command })
                });
                const data = await res.json();
                if (data.status === 'ok') {
                    const backendRisk = data.data.risk;
                    if (backendRisk.level === 'critical') {
                        const reason = backendRisk.reason || backendRisk.description || '';
                        App.toast(`⛔ 后端安全策略拦截\n原因：${reason}`, 'error');
                        return;
                    }
                    if (data.data.ai_explanation) {
                        App.toast(`🔍 AI 分析：${data.data.ai_explanation}`, 'info', 5000);
                    }
                }
            } catch (e) {
                console.warn('[AI] 后端风险检查失败，将交由终端安全检查:', e);
            }
        }

        // ✅ 确保 Socket 已连接
        if (!App.socket || !App.socket.connected) {
            App.toast('Socket 未连接，请刷新页面后重试', 'error');
            return;
        }

        // ✅ 确保终端会话存在
        const panel = document.getElementById(`panel-${sessionId}`);
        if (!panel) {
            App.toast('终端面板未找到，请先打开该会话', 'warning');
            return;
        }

        // ✅ 发送命令到终端（🔧 使用 \r 保持与键盘输入 onData 格式一致）
        App.socket.emit('terminal_input', {
            session_id: sessionId,
            data: command + '\r',
        });

        // ✅ 切换到终端标签页（悬浮模式下不切换，保持悬浮窗口可见）
        if (!this._floatingMode[sessionId]) {
            const termTab = panel.querySelector('.panel-tab[data-tab="terminal"]');
            if (termTab) {
                App.switchPanelTab(sessionId, 'terminal', termTab);
            }
        }

        // 🔧 命令发送后自动聚焦终端，提升操作流畅性
        setTimeout(() => {
            if (typeof terminalManager !== 'undefined') {
                terminalManager.focus(sessionId);
            }
        }, 100);

        App.toast('命令已发送到终端', 'success');
    },

    sendQuick(sessionId, text) {
        if (!sessionId || sessionId === 'undefined' || sessionId === 'null') {
            sessionId = this.currentSessionId;
        }
        
        if (!sessionId || sessionId === 'undefined' || sessionId === 'null') {
            App.toast('请先打开终端会话', 'warning');
            return;
        }

        // 🔧 确保智能助手已初始化（AI 面板初始化时渲染聊天内容）
        if (!this._initialized.has(sessionId)) {
            this.init(sessionId);
        }

        // 🔧 如果全局悬浮窗未打开/已隐藏，则自动打开
        const globalFloat = document.getElementById('globalAIFloat');
        const isHidden = globalFloat && globalFloat.style.display === 'none';
        const sessionChanged = globalFloat && this.currentSessionId !== sessionId;
        const needOpenFloat = !globalFloat || isHidden || sessionChanged;
        if (needOpenFloat) {
            if (sessionChanged) {
                // 会话变了 → 销毁旧窗口重建
                this._closeGlobalFloat();
            }
            this.toggleGlobalFloat();
        }

        // ✅ 等待 DOM 渲染完成后发送（悬浮窗创建后需要时间渲染）
        const trySend = () => {
            const input = document.getElementById(`chatInput-${sessionId}`);
            if (input) {
                input.value = text;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                this.sendMessage(sessionId);
            } else {
                // 再等一帧
                requestAnimationFrame(() => {
                    const retryInput = document.getElementById(`chatInput-${sessionId}`);
                    if (retryInput) {
                        retryInput.value = text;
                        retryInput.dispatchEvent(new Event('input', { bubbles: true }));
                        this.sendMessage(sessionId);
                    } else {
                        App.toast('聊天输入框未就绪，请打开智能助手后重试', 'warning');
                    }
                });
            }
        };

        // 如果需要打开悬浮窗，给更多时间渲染；否则立即尝试
        if (needOpenFloat) {
            setTimeout(() => requestAnimationFrame(trySend), 100);
        } else if (document.getElementById(`chatInput-${sessionId}`)) {
            trySend();
        } else {
            requestAnimationFrame(trySend);
        }
    },

    onChatKeydown(event, sessionId) {
        // Enter 发送（不带 Shift），Shift+Enter 换行
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            this.sendMessage(sessionId);
        }
        // Shift+Enter 允许浏览器默认换行行为，不做任何处理
        // （注意：事件监听在 onkeydown 而非 onkeypress，确保兼容性）
    },

    async clearChat(sessionId) {
        if (!confirm('确认清空对话历史？')) return;
        await fetch('/api/ai/chat/clear', {
            method:  'POST',
            headers: App.authHeaders(),
            body:    JSON.stringify({ chat_id: this.currentChatId }),
        });
        const msgs = document.getElementById(`chatMessages-${sessionId}`);
        if (msgs) msgs.innerHTML = `
            <div style="display:flex;align-items:flex-start;gap:12px;padding:16px;">
                <div class="ai-avatar ai-avatar-bot">
                    <i class="fas fa-robot"></i>
                </div>
                <div class="ai-bubble ai-bubble-bot" style="max-width:78%;">
                    对话已清空，有什么可以帮你的？
                </div>
            </div>`;
    },

    // ══════════════════════════════════════════
    //  历史记录抽屉
    // ══════════════════════════════════════════

    showChatHistory(sessionId) {
        const drawer = document.getElementById(`chatHistoryDrawer-${sessionId}`);
        if (!drawer) return;
        drawer.style.display = 'flex';
        this.loadAllChatHistory(sessionId);
        this._loadChatStats(sessionId);
    },

    hideChatHistory(sessionId) {
        const drawer = document.getElementById(`chatHistoryDrawer-${sessionId}`);
        if (drawer) drawer.style.display = 'none';
    },

    async _loadChatStats(sessionId) {
        try {
            const res  = await fetch('/api/ai/chat/stats', { headers: App.authHeaders() });
            const data = await res.json();
            const el   = document.getElementById(`chatHistoryStats-${sessionId}`);
            if (el && data.data) {
                el.textContent = `${data.data.total_messages} 条 · ${data.data.total_sessions} 个会话`;
            }
        } catch {}
    },

    // ── 加载全部会话列表 ──

    async loadAllChatHistory(sessionId) {
        const div = document.getElementById(`chatHistoryContent-${sessionId}`);
        if (!div) return;

        div.innerHTML = `<div style="text-align:center;padding:20px;
            color:var(--text-secondary);">
            <i class="fas fa-spinner fa-spin"></i> 加载中...
        </div>`;

        try {
            const res  = await fetch('/api/ai/chat/sessions', { headers: App.authHeaders() });
            const data = await res.json();

            if (!data.data?.length) {
                div.innerHTML = `
                    <div style="text-align:center;color:var(--text-secondary);
                                padding:40px;font-size:13px;">
                        <i class="fas fa-comment-slash"
                        style="font-size:28px;display:block;
                                margin-bottom:10px;opacity:0.3;"></i>
                        暂无历史对话
                    </div>`;
                return;
            }

            div.innerHTML = data.data.map(session => {
                const timeText = (session.last_active || '').replace('T', ' ').slice(0, 16);
                const startText = (session.started_at || '').replace('T', ' ').slice(0, 16);
                const isCurrentChat = session.chat_id === `chat_${sessionId}`;

                return `
                    <div style="padding:10px 12px;margin-bottom:4px;border-radius:8px;
                                cursor:pointer;transition:all 0.2s;
                                background:${isCurrentChat ? 'var(--bg-active)' : 'transparent'};
                                border:1px solid ${isCurrentChat ? 'var(--accent-color)' : 'transparent'};"
                        onmouseenter="if(!${isCurrentChat})this.style.background='var(--bg-hover)'"
                        onmouseleave="if(!${isCurrentChat})this.style.background='${isCurrentChat ? 'var(--bg-active)' : 'transparent'}'">
                        <div style="display:flex;align-items:center;gap:8px;">
                            <i class="fas fa-comments"
                            style="color:${isCurrentChat ? 'var(--accent-color)' : 'var(--text-secondary)'};
                                    font-size:13px;flex-shrink:0;"></i>
                            <div style="flex:1;min-width:0;"
                                onclick="AIAssistant._openHistorySession('${sessionId}','${session.chat_id}')">
                                <div style="font-size:12px;font-weight:500;
                                            color:var(--text-bright);
                                            white-space:nowrap;overflow:hidden;
                                            text-overflow:ellipsis;">
                                    ${App.escapeHtml(session.chat_id.replace('chat_', ''))}
                                    ${isCurrentChat
                                        ? '<span style="font-size:10px;color:var(--accent-color);margin-left:4px;">当前</span>'
                                        : ''}
                                </div>
                                <div style="font-size:11px;color:var(--text-secondary);
                                            margin-top:2px;">
                                    ${session.message_count} 条消息 · ${timeText}
                                </div>
                            </div>
                            <i class="fas fa-chevron-right"
                            style="font-size:10px;color:var(--text-secondary);
                                    flex-shrink:0;"
                            onclick="AIAssistant._openHistorySession('${sessionId}','${session.chat_id}')"></i>
                            <button class="btn btn-icon btn-sm"
                                    onclick="event.stopPropagation();AIAssistant._deleteHistorySession('${sessionId}','${session.chat_id}')"
                                    title="删除此对话"
                                    style="flex-shrink:0;opacity:0.5;transition:opacity 0.2s;color:var(--danger-color);"
                                    onmouseenter="this.style.opacity='1'"
                                    onmouseleave="this.style.opacity='0.5'">
                                <i class="fas fa-trash-alt" style="font-size:10px;"></i>
                            </button>
                        </div>
                    </div>`;
            }).join('');

        } catch (e) {
            div.innerHTML = `<div style="color:var(--danger-color);
                padding:20px;font-size:13px;">
                加载失败: ${App.escapeHtml(e.message)}
            </div>`;
        }
    },

    // ── 删除某个历史会话 ──
    async _deleteHistorySession(sessionId, chatId) {
        if (!confirm(`确认删除此对话及其所有消息？\n\n${chatId}\n\n此操作不可撤销！`)) return;

        try {
            const res = await fetch('/api/ai/chat/delete', {
                method: 'POST',
                headers: App.authHeaders(),
                body: JSON.stringify({ chat_id: chatId }),
            });
            const data = await res.json();

            if (data.status === 'ok') {
                App.toast('对话已删除', 'success');
                // 如果删除的是当前对话，清空聊天面板
                if (chatId === this.currentChatId) {
                    const msgs = document.getElementById(`chatMessages-${sessionId}`);
                    if (msgs) {
                        msgs.innerHTML = `<div style="text-align:center;color:var(--text-secondary);padding:40px 20px;">
                            <i class="fas fa-robot" style="font-size:40px;display:block;margin-bottom:12px;color:var(--accent-color);opacity:0.6;"></i>
                            <div style="font-size:0.95rem;font-weight:500;color:var(--text-bright);margin-bottom:8px;">AI 运维助手</div>
                            <div style="font-size:0.82rem;color:var(--text-secondary);">对话已删除，开始新的对话吧</div>
                        </div>`;
                    }
                }
                // 刷新所有相关区域
                this.loadAllChatHistory(sessionId);
                // 如果 history 列表区域存在，也刷新它
                const historyListDiv = document.getElementById(`historyList-${sessionId}`);
                if (historyListDiv) {
                    this._loadHistoryList(sessionId);
                }
            } else {
                App.toast('删除失败: ' + (data.message || '未知错误'), 'error');
            }
        } catch (e) {
            App.toast('删除失败: ' + e.message, 'error');
        }
    },

    // ── 打开某个历史会话的消息列表 ──

    async _openHistorySession(sessionId, chatId) {
        const div = document.getElementById(`chatHistoryContent-${sessionId}`);
        if (!div) return;

        div.innerHTML = `<div style="text-align:center;padding:20px;
            color:var(--text-secondary);">
            <i class="fas fa-spinner fa-spin"></i> 加载消息...
        </div>`;

        try {
            const res  = await fetch(
                `/api/ai/chat/history?chat_id=${encodeURIComponent(chatId)}&limit=200`,
                { headers: App.authHeaders() }
            );
            const data = await res.json();
            const msgs = (data.data || []).filter(m => m.role !== 'system');

            let html = `
                <div style="display:flex;align-items:center;gap:8px;
                            margin-bottom:12px;padding-bottom:8px;
                            border-bottom:1px solid var(--border-color);">
                    <button class="btn btn-sm"
                            onclick="AIAssistant.loadAllChatHistory('${sessionId}')">
                        <i class="fas fa-arrow-left"></i> 返回
                    </button>
                    <span style="font-size:12px;color:var(--text-secondary);
                                flex:1;overflow:hidden;text-overflow:ellipsis;
                                white-space:nowrap;">
                        ${App.escapeHtml(chatId)} · ${msgs.length} 条
                    </span>
                    <button class="btn btn-sm"
                            onclick="AIAssistant._deleteHistorySession('${sessionId}','${chatId}')"
                            title="删除此对话"
                            style="font-size:10px;color:var(--danger-color);border-color:var(--danger-color);">
                        <i class="fas fa-trash-alt"></i> 删除
                    </button>
                    ${chatId === `chat_${sessionId}` ? `
                    <button class="btn btn-sm btn-primary"
                            onclick="AIAssistant._restoreToChat('${sessionId}','${chatId}')"
                            style="font-size:11px;">
                        <i class="fas fa-undo"></i> 切回对话
                    </button>` : ''}
                </div>
            `;

            if (!msgs.length) {
                html += `<div style="text-align:center;color:var(--text-secondary);
                    padding:30px;font-size:13px;">该会话暂无消息</div>`;
            } else {
                html += msgs.map(m =>
                    this._renderHistoryMessage(sessionId, m)
                ).join('');
            }

            div.innerHTML = html;

        } catch (e) {
            div.innerHTML = `<div style="color:var(--danger-color);
                padding:20px;font-size:13px;">
                加载失败: ${App.escapeHtml(e.message)}
            </div>`;
        }
    },

    /**
     * 渲染历史记录中的单条消息
     * ✅ 代码块高亮 + 命令可执行 + 风险标识 + 用户消息美化
     */
    _renderHistoryMessage(sessionId, msg) {
        const isUser = msg.role === 'user';
        const time = (msg.created_at || '').replace('T', ' ').slice(0, 19);
        const icon = isUser ? 'fa-user' : 'fa-robot';
        const color = isUser ? 'var(--success-color)' : 'var(--accent-color)';
        const bg = isUser ? 'rgba(79,195,247,0.06)' : 'var(--bg-tertiary)';
        const label = isUser ? '你' : 'AI';
        const content = msg.content || '';

        // 提取命令（仅 AI 消息）
        const commands = isUser ? [] : this._extractCommandsFromText(content);
        
        // 渲染内容：用户消息使用美化的富文本渲染，AI 消息使用增强的富文本渲染（含快捷执行按钮）
        const renderedContent = isUser
            ? this._renderUserMessageContent(content)
            : this._renderRichContent(sessionId, content, false);

        // 命令按钮区（带执行功能）- 仅 AI 消息
        // 🔧 如果内容已含 ```commands 块（由 _renderRichContent 内联渲染），跳过避免重复
        const hasCommandsBlock = /```commands?/i.test(content);
        const commandsHtml = (!hasCommandsBlock && commands.length > 0)
            ? this._renderHistoryCommandButtons(sessionId, commands)
            : '';

        // 复制纯文本内容（去除 Markdown 标记，避免复制出 ```commands 等原文）
        const plainText = content
            .replace(/```[\w]*\r?\n?/g, '')
            .replace(/```/g, '')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/\*\*(.*?)\*\*/g, '$1')
            .replace(/^[#]+\s+/gm, '')
            .replace(/^[-•]\s+/gm, '• ')
            .trim();
        const copyCid = this._regCmd(plainText);

        return `
            <div style="margin-bottom:12px;padding:12px 16px;border-radius:12px;
                        background:${bg};border:1px solid var(--border-color);
                        transition:box-shadow 0.2s, border-color 0.2s;
                        position:relative;"
                onmouseenter="this.style.borderColor='${color}';this.style.boxShadow='0 2px 12px rgba(0,0,0,0.15)'"
                onmouseleave="this.style.borderColor='var(--border-color)';this.style.boxShadow='none'">

                <!-- 消息头部 -->
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
                    <div style="width:28px;height:28px;border-radius:50%;
                                background:${color}20;display:flex;
                                align-items:center;justify-content:center;flex-shrink:0;">
                        <i class="fas ${icon}" style="font-size:12px;color:${color};"></i>
                    </div>
                    <span style="font-size:12px;font-weight:600;color:var(--text-bright);">
                        ${label}
                    </span>
                    <span style="font-size:10px;color:var(--text-secondary);flex:1;text-align:right;">
                        <i class="far fa-clock"></i> ${time}
                    </span>
                    ${!isUser ? `
                    <button class="btn btn-icon btn-sm"
                            data-ai-action="copy-command" data-ai-id="${copyCid}"
                            title="复制全部内容"
                            style="opacity:0.4;flex-shrink:0;"
                            onmouseenter="this.style.opacity='1'"
                            onmouseleave="this.style.opacity='0.4'">
                        <i class="fas fa-copy" style="font-size:10px;"></i>
                    </button>` : ''}
                </div>

                <!-- 消息正文 -->
                <div style="font-size:13px;line-height:1.8;color:var(--text-primary);
                            word-break:break-word;max-height:600px;
                            overflow-y:auto;padding-right:4px;">
                    ${renderedContent}
                </div>

                <!-- 命令按钮区 -->
                ${commandsHtml}
            </div>
        `;
    },

    // 历史记录命令按钮渲染（统一用 _regCmd + execById 避免引号冲突）
    _renderHistoryCommandButtons(sessionId, commands) {
        if (!commands?.length) return '';
        
        const self = this;
        const sid = sessionId || this.currentSessionId || '';
        
        return `
            <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border-color);">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
                    <i class="fas fa-terminal" style="font-size:10px;color:var(--success-color);"></i>
                    <span style="font-size:10px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px;">
                        可执行命令 (${commands.length})
                    </span>
                </div>
                <div style="display:flex;flex-direction:column;gap:4px;">
                    ${commands.map((cmd, i) => {
                        const risk = self._quickRiskCheck(cmd);
                        const cid = self._regCmd(cmd);
                        return `
                            <div style="display:flex;align-items:center;gap:8px;
                                        background:var(--bg-secondary);padding:8px 12px;
                                        border-radius:6px;border-left:3px solid ${risk.color || 'var(--success-color)'};
                                        transition:background .15s;"
                                onmouseenter="this.style.background='var(--bg-hover)'"
                                onmouseleave="this.style.background='var(--bg-secondary)'">
                                <span style="color:var(--text-secondary);font-size:10px;min-width:20px;font-weight:600;flex-shrink:0;">#${i+1}</span>
                                <code style="flex:1;font-family:Consolas,monospace;font-size:11px;
                                            color:var(--text-bright);word-break:break-all;
                                            max-height:40px;overflow-y:auto;">
                                    ${App.escapeHtml(cmd)}
                                </code>
                                ${risk.label ? `<span style="font-size:8px;padding:1px 6px;border-radius:8px;background:${risk.bg};color:${risk.color};flex-shrink:0;">${risk.label}</span>` : ''}
                                ${risk.level !== 'critical' ? `
                                    <button class="btn btn-sm btn-primary"
                                            data-ai-action="exec-command" data-ai-id="${cid}" data-ai-session-id="${sid}" data-ai-risk="${risk.level}"
                                            style="font-size:9px;padding:2px 8px;flex-shrink:0;border-radius:4px;">
                                        <i class="fas fa-play" style="font-size:7px;"></i> 执行
                                    </button>
                                ` : `
                                    <span style="font-size:10px;color:var(--danger-color);flex-shrink:0;">
                                        <i class="fas fa-ban"></i> 禁止
                                    </span>
                                `}
                                <button class="btn btn-icon btn-sm"
                                        data-ai-action="copy-command" data-ai-id="${cid}"
                                        title="复制"
                                        style="flex-shrink:0;opacity:0.4;"
                                        onmouseenter="this.style.opacity='1'"
                                        onmouseleave="this.style.opacity='0.4'">
                                    <i class="fas fa-copy" style="font-size:8px;"></i>
                                </button>
                            </div>`;
                    }).join('')}
                </div>
            </div>
        `;
    },

    /**
     * 用户消息内容美化渲染
     * 支持：代码块、行内代码、多行文本格式化
     */
    _renderUserMessageContent(text) {
        if (!text) return '';
        let out = App.escapeHtml(text);
        
        // 代码块高亮
        out = out.replace(/```([\w]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
            const langLabel = lang ? `<span style="font-size:9px;color:var(--text-secondary);padding:1px 6px;border-radius:4px;background:var(--bg-active)">${App.escapeHtml(lang)}</span>` : '';
            return `
                <div style="margin:6px 0;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:6px;overflow:hidden;">
                    <div style="padding:4px 10px;background:var(--bg-active);border-bottom:1px solid var(--border-color);display:flex;justify-content:space-between;align-items:center;">
                        <span style="font-size:10px;color:var(--text-secondary);"><i class="fas fa-code"></i> 代码</span>
                        ${langLabel}
                    </div>
                    <pre style="padding:10px 14px;font-family:Consolas,monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--text-primary);margin:0;max-height:200px;overflow-y:auto;">${App.escapeHtml(code.trim())}</pre>
                </div>
            `;
        });

        // 行内代码高亮
        out = out.replace(/`([^`\n]{2,80})`/g, (_, code) => {
            return `<code style="background:var(--bg-secondary);padding:1px 6px;border-radius:3px;font-family:Consolas,monospace;font-size:11px;color:var(--success-color);border:1px solid var(--border-color);">${App.escapeHtml(code)}</code>`;
        });

        // 换行
        out = out.replace(/\n/g, '<br>');
        
        return out;
    },

    // 新增：历史记录专用内容渲染（已废弃，保留兼容）
    _renderRichContentForHistory(sessionId, text, isUser) {
        if (!text) return '';
        if (isUser) return this._renderUserMessageContent(text);

        let out = App.escapeHtml(text);
        
        // 代码块高亮
        out = out.replace(/```([\w]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
            const langLabel = lang ? `<span style="font-size:9px;color:var(--text-secondary);padding:1px 6px;border-radius:4px;background:var(--bg-active)">${lang}</span>` : '';
            return `
                <div style="margin:8px 0;background:var(--bg-tertiary);border:1px solid var(--border-color);border-radius:6px;overflow:hidden;">
                    <div style="padding:4px 10px;background:var(--bg-active);border-bottom:1px solid var(--border-color);display:flex;justify-content:space-between;align-items:center;">
                        <span style="font-size:10px;color:var(--text-secondary);">代码</span>
                        ${langLabel}
                    </div>
                    <pre style="padding:10px 14px;font-family:Consolas,monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--text-primary);margin:0;max-height:200px;overflow-y:auto;">${code.trim()}</pre>
                </div>
            `;
        });

        // 行内代码
        out = out.replace(/`([^`\n]{2,80})`/g, (_, code) => {
            return `<code style="background:var(--bg-tertiary);padding:1px 6px;border-radius:3px;font-family:Consolas,monospace;font-size:11px;color:var(--accent-color);border:1px solid var(--border-color);">${code}</code>`;
        });

        // Markdown 标题
        out = out.replace(/^###\s+(.+)$/gm, '<div style="font-size:14px;font-weight:600;color:var(--text-bright);margin:10px 0 4px;">$1</div>');
        out = out.replace(/^##\s+(.+)$/gm, '<div style="font-size:15px;font-weight:600;color:var(--text-bright);margin:12px 0 4px;padding-bottom:4px;border-bottom:1px solid var(--border-color);">$1</div>');
        
        // 粗体
        out = out.replace(/\*\*(.*?)\*\*/g, '<strong style="color:var(--text-bright)">$1</strong>');
        
        // 列表
        out = out.replace(/^[-•]\s+(.+)$/gm, '<div style="display:flex;gap:8px;margin:2px 0;padding-left:4px;"><span style="color:var(--accent-color);flex-shrink:0;">•</span><span>$1</span></div>');
        out = out.replace(/^(\d+)\.\s+(.+)$/gm, '<div style="display:flex;gap:8px;margin:2px 0;padding-left:4px;"><span style="color:var(--accent-color);font-weight:600;min-width:18px;flex-shrink:0;">$1.</span><span>$2</span></div>');

        // 换行
        out = out.replace(/\n/g, '<br>');
        
        return out;
    },


    /**
     * 将消息内容渲染为富文本
     * 支持：代码块、行内代码、粗体、列表、链接
     */
    _renderRichContent(sessionId, text, isUser) {
        if (!text) return '';
        if (isUser) return App.escapeHtml(text).replace(/\n/g, '<br>');

        const self = this;
        const PH   = [];

        let out = text;

        // ── 1. ```commands``` 块 ──
        // 🔧 使用 \r?\n 兼容 Windows/Linux 换行
        out = out.replace(/```commands?\r?\n([\s\S]*?)```/gi, (_, block) => {
            const lines = block.trim().split('\n');
            const rows  = lines.map(line => {
                const t = line.trim();
                if (!t || t.startsWith('#')) {
                    return `<div style="padding:3px 12px;font-size:11px;color:var(--text-secondary);font-family:Consolas,monospace;font-style:italic;">${App.escapeHtml(line)}</div>`;
                }
                const cmd  = t.replace(/^⚠️\s*/, '');
                const warn = t.startsWith('⚠️');
                const risk = self._quickRiskCheck(cmd);
                const cid  = self._regCmd(cmd);

                // ⚠️ 警告注释行（非命令）：仅显示警告文本，不显示执行/复制按钮
                if (warn && !self._looksLikeCommand(cmd)) {
                    return `<div style="display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid rgba(255,167,38,0.2);background:rgba(255,167,38,0.06);">
                        <i class="fas fa-exclamation-triangle" style="color:var(--warning-color);font-size:11px;flex-shrink:0"></i>
                        <code style="flex:1;font-family:Consolas,monospace;font-size:12px;color:var(--warning-color);word-break:break-all">${App.escapeHtml(cmd)}</code>
                    </div>`;
                }

                const warnIcon = warn
                    ? '<i class="fas fa-exclamation-triangle" style="color:var(--warning-color);font-size:10px;flex-shrink:0"></i>'
                    : '<i class="fas fa-chevron-right" style="color:var(--success-color);font-size:8px;flex-shrink:0;opacity:.6"></i>';
                const riskBadge = risk.label
                    ? `<span style="font-size:9px;padding:1px 5px;border-radius:8px;background:${risk.bg};color:${risk.color};flex-shrink:0">${risk.label}</span>`
                    : '';
                const execBtn = risk.level !== 'critical'
                    ? `<button class="btn btn-sm btn-primary" data-ai-action="exec-command" data-ai-id="${cid}" data-ai-session-id="${sessionId}" data-ai-risk="${risk.level}" style="font-size:10px;padding:2px 8px;flex-shrink:0;border-radius:4px"><i class="fas fa-play" style="font-size:8px"></i> 执行</button>`
                    : `<span style="font-size:10px;color:var(--danger-color);flex-shrink:0"><i class="fas fa-ban"></i> 禁止</span>`;
                const copyBtn = `<button class="btn btn-icon btn-sm" data-ai-action="copy-command" data-ai-id="${cid}" title="复制" style="flex-shrink:0;opacity:.4" onmouseenter="this.style.opacity='1'" onmouseleave="this.style.opacity='.4'"><i class="fas fa-copy" style="font-size:9px"></i></button>`;
                // ✅ 单行：避免模板字符串内的 \n 被后续 \n→&lt;br&gt; 替换破坏 HTML
                return `<div style="display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid rgba(51,56,66,0.3);transition:background .15s;" onmouseenter="this.style.background='var(--bg-hover)'" onmouseleave="this.style.background='transparent'">${warnIcon}<code style="flex:1;font-family:Consolas,monospace;font-size:12px;color:var(--text-bright);word-break:break-all">${App.escapeHtml(cmd)}</code>${riskBadge}${execBtn}${copyBtn}</div>`;
            }).join('');

            // ✅ 单行容器
            const html = `<div style="margin:10px 0;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:8px;overflow:hidden"><div style="padding:6px 12px;background:var(--bg-active);border-bottom:1px solid var(--border-color);display:flex;align-items:center;gap:6px"><i class="fas fa-terminal" style="font-size:10px;color:var(--success-color)"></i><span style="font-size:10px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px">可执行命令</span></div>${rows}</div>`;
            const k = `\x00BLK${PH.length}\x00`;
            PH.push(html);
            return k;
        });

        // ── 2. 普通代码块 ```lang ... ``` ──
        // 增强：检测代码块内容是否为命令，是则添加执行按钮
        // 🔧 使用 \r?\n 兼容 Windows/Linux 换行
        out = out.replace(/```(\w*)\r?\n?([\s\S]*?)```/g, (_, lang, code) => {
            const codeText = code.trim();
            const cid = self._regCmd(codeText);
            // 检测是否为 shell/bash 代码块或内容像命令
            const isShellLang = /^(bash|sh|shell|zsh|cmd)$/i.test(lang);
            const looksLikeCommands = self._looksLikeCommandBlock(codeText);
            const showExec = isShellLang || looksLikeCommands;

            let toolbarButtons = '';
            if (showExec) {
                // 逐行处理，对每行命令添加执行按钮
                const lines = codeText.split('\n');
                const execBlockHtml = lines.map(line => {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) {
                        return `<span style="color:var(--text-secondary);font-family:Consolas,monospace;font-size:12px;display:block;padding:2px 0;">${App.escapeHtml(line)}</span>`;
                    }
                    const risk = self._quickRiskCheck(trimmed);
                    const lcid = self._regCmd(trimmed);
                    const execBtn2 = risk.level !== 'critical'
                        ? `<button class="btn btn-sm btn-primary" data-ai-action="exec-command" data-ai-id="${lcid}" data-ai-session-id="${sessionId}" data-ai-risk="${risk.level}" style="font-size:8px;padding:1px 6px;flex-shrink:0;border-radius:3px;opacity:0.5;transition:opacity .15s;"><i class="fas fa-play" style="font-size:6px;"></i> 执行</button>`
                        : `<span style="font-size:9px;color:var(--danger-color);flex-shrink:0;opacity:0.5;transition:opacity .15s;"><i class="fas fa-ban"></i></span>`;
                    // ✅ 单行：避免 \n 被破坏
                    return `<div style="display:flex;align-items:center;gap:6px;padding:2px 0;transition:background .15s;" onmouseenter="this.style.background='var(--bg-hover)'" onmouseleave="this.style.background='transparent'"><span style="font-family:Consolas,monospace;font-size:12px;color:var(--text-bright);flex:1;word-break:break-all;">${App.escapeHtml(trimmed)}</span>${execBtn2}</div>`;
                }).join('');
                // ✅ 单行
                toolbarButtons = `<div style="position:absolute;top:6px;right:8px;display:flex;gap:4px;align-items:center">${lang ? `<span style="font-size:9px;color:var(--text-secondary);padding:1px 6px;border-radius:4px;background:var(--bg-active)">${App.escapeHtml(lang)}</span>` : ''}<button class="btn btn-icon btn-sm" data-ai-action="copy-command" data-ai-id="${cid}" title="复制全部" style="opacity:.4" onmouseenter="this.style.opacity='1'" onmouseleave="this.style.opacity='.4'"><i class="fas fa-copy" style="font-size:9px"></i></button></div>`;
                // ✅ 单行容器
                const html = `<div style="margin:10px 0;position:relative;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:8px;overflow:hidden;">${toolbarButtons}<pre style="padding:12px 14px;padding-right:100px;font-family:Consolas,monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--text-primary);margin:0;max-height:300px;overflow-y:auto;">${execBlockHtml}</pre></div>`;
                const k = `\x00BLK${PH.length}\x00`;
                PH.push(html);
                return k;
            }

            // 普通代码块（非命令）- 只显示复制按钮
            // ✅ 单行容器
            const html = `<div style="margin:10px 0;position:relative"><div style="position:absolute;top:6px;right:8px;display:flex;gap:4px;align-items:center">${lang ? `<span style="font-size:9px;color:var(--text-secondary);padding:1px 6px;border-radius:4px;background:var(--bg-active)">${App.escapeHtml(lang)}</span>` : ''}<button class="btn btn-icon btn-sm" data-ai-action="copy-command" data-ai-id="${cid}" title="复制" style="opacity:.4" onmouseenter="this.style.opacity='1'" onmouseleave="this.style.opacity='.4'"><i class="fas fa-copy" style="font-size:9px"></i></button></div><pre style="background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:8px;padding:12px 14px;padding-right:80px;font-family:Consolas,monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--text-primary);margin:0">${App.escapeHtml(codeText)}</pre></div>`;
            const k = `\x00BLK${PH.length}\x00`;
            PH.push(html);
            return k;
        });

        // ── 3. 行内代码 `...` ──
        out = out.replace(/`([^`\n]{2,80})`/g, (_, code) => {
            const t     = code.trim();
            const isCmd = self._looksLikeCommand(t);
            let html;
            if (isCmd) {
                const cid = self._regCmd(t);
                html = `<code style="background:rgba(102,187,106,.1);padding:2px 8px;border-radius:4px;font-family:Consolas,monospace;font-size:11px;color:var(--success-color);cursor:pointer;border:1px solid rgba(102,187,106,.3);display:inline-flex;align-items:center;gap:4px;transition:all .15s;margin:1px 2px" data-ai-action="exec-command" data-ai-id="${cid}" data-ai-session-id="${sessionId}" data-ai-risk="low" onmouseenter="this.style.borderColor='var(--success-color)'" onmouseleave="this.style.borderColor='rgba(102,187,106,.3)'" title="点击执行"><i class="fas fa-play" style="font-size:7px;opacity:.7"></i>${App.escapeHtml(t)}</code>`;
            } else {
                html = `<code style="background:var(--bg-secondary);padding:2px 6px;border-radius:4px;font-family:Consolas,monospace;font-size:11px;color:var(--accent-color);border:1px solid var(--border-color);margin:1px 2px">${App.escapeHtml(t)}</code>`;
            }
            const k = `\x00INL${PH.length}\x00`;
            PH.push(html);
            return k;
        });

        // ── 4. 转义纯文本（\x00 占位符不受 escapeHtml 影响） ──
        out = App.escapeHtml(out);

        // ── 5. 还原占位符（\x00 安全还原，不会被 escapeHtml 破坏） ──
        PH.forEach((h, i) => {
            out = out.replace(`\x00BLK${i}\x00`, h);
            out = out.replace(`\x00INL${i}\x00`, h);
        });

        // ── 5.5. 保护已还原 HTML 区域：去掉标签内的换行，防止被步骤6的 \n→<br> 破坏 ──
        out = out.replace(/<[^>]+>/g, tag => tag.replace(/\n/g, ' '));

        // ── 6. Markdown 行内格式 ──
        out = out.replace(/\*\*(.*?)\*\*/g, '<strong style="color:var(--text-bright)">$1</strong>');
        out = out.replace(/^[-•]\s+(.+)$/gm, '<div style="display:flex;gap:8px;margin:3px 0;padding-left:4px"><span style="color:var(--accent-color);flex-shrink:0">•</span><span>$1</span></div>');
        out = out.replace(/^(\d+)\.\s+(.+)$/gm, '<div style="display:flex;gap:8px;margin:3px 0;padding-left:4px"><span style="color:var(--accent-color);font-weight:600;min-width:18px;flex-shrink:0">$1.</span><span>$2</span></div>');
        out = out.replace(/^###\s+(.+)$/gm, '<div style="font-size:14px;font-weight:600;color:var(--text-bright);margin:12px 0 6px;padding-bottom:4px;border-bottom:1px solid var(--border-color)">$1</div>');
        out = out.replace(/^##\s+(.+)$/gm, '<div style="font-size:15px;font-weight:600;color:var(--text-bright);margin:14px 0 6px;padding-bottom:4px;border-bottom:1px solid var(--border-color)">$1</div>');

        // 换行
        out = out.replace(/\n/g, '<br>');
        out = out.replace(/<br>\s*(<div)/g, '$1');
        out = out.replace(/(<\/div>)\s*<br>/g, '$1');

        return out;
    },

    /**
     * 快速判断一段文本是否像命令
     */
    _looksLikeCommand(text) {
        const cmdPrefixes = [
            'ls', 'cd', 'pwd', 'cat', 'grep', 'tail', 'head', 'find', 'ps',
            'top', 'df', 'du', 'free', 'ss', 'netstat', 'ping', 'curl', 'wget',
            'systemctl', 'service', 'journalctl', 'dmesg', 'uname', 'uptime',
            'chmod', 'chown', 'chgrp', 'mkdir', 'rm', 'cp', 'mv', 'touch',
            'kill', 'pkill', 'nginx', 'mysql', 'docker', 'kubectl', 'git',
            'apt', 'yum', 'dnf', 'pip', 'npm', 'node', 'python',
            'tar', 'gzip', 'unzip', 'scp', 'rsync', 'ssh', 'iptables',
            'crontab', 'mount', 'umount', 'fdisk', 'lsof', 'strace',
            'awk', 'sed', 'sort', 'uniq', 'wc', 'xargs', 'tee',
            'echo', 'export', 'source', 'sudo', 'su', 'htop', 'iotop',
            'vmstat', 'iostat', 'mpstat', 'sar', 'swapon', 'swapoff',
            'tcpdump', 'nc', 'telnet', 'nslookup', 'dig', 'host',
            'who', 'whoami', 'id', 'groups', 'last', 'history',
            'ifconfig', 'ip', 'route', 'arp', 'nmap', 'mtr',
            'firewall-cmd', 'ufw', 'setenforce', 'getenforce',
            'supervisorctl', 'pm2', 'forever',
            'composer', 'mvn', 'gradle', 'go', 'cargo', 'rustc',
            'make', 'cmake', 'gcc', 'g++', 'javac',
        ];
        const firstWord = text.split(/[\s;|&]/)[0].replace(/^sudo\s+/, '');
        return cmdPrefixes.includes(firstWord);
    },

    /**
     * 判断一个代码块的内容是否像命令集合
     */
    _looksLikeCommandBlock(codeText) {
        if (!codeText) return false;
        const lines = codeText.split('\n').filter(l => {
            const t = l.trim();
            return t && !t.startsWith('#') && !t.startsWith('//');
        });
        if (lines.length === 0) return false;
        // 如果超过 60% 的行看起来像命令，就认为是命令块
        const cmdCount = lines.filter(l => this._looksLikeCommand(l.trim())).length;
        return cmdCount > 0 && cmdCount / lines.length >= 0.5;
    },

    /**
     * 快速风险检查（不调用后端，纯前端规则）
     */
    _quickRiskCheck(cmd) {
        const critical = [
            /rm\s+-rf\s+\//, /dd\s+if=\/dev\/zero/, /mkfs\b/,
            /kill\s+-9\s+1\b/, />\s*\/dev\/sd/,
        ];
        const high = [
            /rm\s+-rf/, /chmod\s+-R\s+777/, /fdisk\b/,
            /chown\s+-R\s+\S+\s+\//,
        ];
        const medium = [
            /iptables\s+-F/, /systemctl\s+(stop|disable)/,
            /crontab\s+-r/, /truncate\s+-s\s+0/,
        ];

        for (const re of critical) {
            if (re.test(cmd)) return {
                level: 'critical', label: '极危',
                color: '#ff0000', bg: 'rgba(255,0,0,0.15)'
            };
        }
        for (const re of high) {
            if (re.test(cmd)) return {
                level: 'high', label: '高危',
                color: 'var(--danger-color)', bg: 'rgba(239,83,80,0.12)'
            };
        }
        for (const re of medium) {
            if (re.test(cmd)) return {
                level: 'medium', label: '中危',
                color: 'var(--warning-color)', bg: 'rgba(255,167,38,0.12)'
            };
        }
        return { level: 'low', label: '', color: '', bg: '' };
    },

    /**
     * 渲染命令按钮区（用于消息底部的命令汇总）
     */
    _renderCommandButtons(sessionId, commands) {
        if (!commands?.length) return '';
        const self = this;
        const sid = sessionId || this.currentSessionId || '';
        return `
            <div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border-color)">
                <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
                    <i class="fas fa-terminal" style="font-size:10px;color:var(--success-color)"></i>
                    <span style="font-size:10px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px">提取的命令 (${commands.length})</span>
                </div>
                ${commands.map((cmd, i) => {
                    const risk = self._quickRiskCheck(cmd);
                    const cid = self._regCmd(cmd);
                    return `
                        <div style="display:flex;align-items:center;gap:6px;background:var(--bg-secondary);padding:6px 10px;border-radius:6px;margin-bottom:3px;border-left:3px solid ${risk.color || 'var(--success-color)'};transition:background .15s"
                            onmouseenter="this.style.background='var(--bg-hover)'"
                            onmouseleave="this.style.background='var(--bg-secondary)'">
                            <span style="color:var(--text-secondary);font-size:10px;min-width:16px;font-weight:600;flex-shrink:0">#${i+1}</span>
                            <code style="flex:1;font-family:Consolas,monospace;font-size:11px;color:var(--text-bright);word-break:break-all;cursor:pointer" data-ai-action="copy-command" data-ai-id="${cid}" title="点击复制">${App.escapeHtml(cmd)}</code>
                            ${risk.label ? `<span style="font-size:9px;padding:1px 5px;border-radius:8px;background:${risk.bg};color:${risk.color};flex-shrink:0">${risk.label}</span>` : ''}
                            ${risk.level !== 'critical'
                                ? `<button class="btn btn-sm btn-primary" data-ai-action="exec-command" data-ai-id="${cid}" data-ai-session-id="${sid}" data-ai-risk="${risk.level}" style="font-size:10px;padding:2px 10px;flex-shrink:0;border-radius:4px"><i class="fas fa-play" style="font-size:8px"></i> 执行</button>`
                                : `<span style="font-size:10px;color:var(--danger-color);flex-shrink:0"><i class="fas fa-ban"></i> 禁止</span>`}
                            <button class="btn btn-icon btn-sm" data-ai-action="copy-command" data-ai-id="${cid}" title="复制" style="flex-shrink:0;opacity:.4" onmouseenter="this.style.opacity='1'" onmouseleave="this.style.opacity='.4'"><i class="fas fa-copy" style="font-size:9px"></i></button>
                        </div>`;
                }).join('')}
            </div>`;
    },

    // ── 从文本中提取命令 ──
    _extractCommandsFromText(text) {
        const cmds = [];
        // ```commands``` 块
        // 🔧 使用 \r?\n 兼容 Windows/Linux 换行
        const blockRe = /```commands?\r?\n([\s\S]*?)```/gi;
        let match;
        while ((match = blockRe.exec(text)) !== null) {
            match[1].split('\n').forEach(line => {
                line = line.trim().replace(/^⚠️\s*/, '');
                if (line && !line.startsWith('#')) cmds.push(line);
            });
        }
        // 也提取 bash/shell/cmd/powershell/zsh 代码块中的命令
        // 🔧 使用 \r?\n 兼容 Windows/Linux 换行
        const shellBlockRe = /```(?:bash|sh|shell|cmd|powershell|zsh)\r?\n([\s\S]*?)```/gi;
        while ((match = shellBlockRe.exec(text)) !== null) {
            match[1].split('\n').forEach(line => {
                line = line.trim();
                if (line && !line.startsWith('#') && !line.startsWith('//')) {
                    cmds.push(line);
                }
            });
        }
        // 🔧 也提取无语言标记的代码块（可能包含命令）
        // 🔧 使用 \r?\n 兼容 Windows/Linux 换行
        const plainBlockRe = /```\r?\n([\s\S]*?)```/g;
        while ((match = plainBlockRe.exec(text)) !== null) {
            const blockText = match[1];
            // 判断该块是否像命令集合
            if (this._looksLikeCommandBlock(blockText)) {
                blockText.split('\n').forEach(line => {
                    line = line.trim();
                    if (line && !line.startsWith('#') && !line.startsWith('//')) {
                        cmds.push(line);
                    }
                });
            }
        }
        // 行内反引号 - 使用 this._looksLikeCommand 判断
        const inlineRe = /`([^`\n]{2,80})`/g;
        while ((match = inlineRe.exec(text)) !== null) {
            const cmd = match[1].trim();
            if (this._looksLikeCommand(cmd)) {
                cmds.push(cmd);
            }
        }
        return [...new Set(cmds)];
    },

    // ── 切回指定对话 ──

    _restoreToChat(sessionId, chatId) {
        this.hideChatHistory(sessionId);

        // 🔧 智能助手已移至全局悬浮窗，确保悬浮窗打开
        const globalFloat = document.getElementById('globalAIFloat');
        if (!globalFloat) {
            this.toggleGlobalFloat();
        }

        // 滚动聊天消息到底部
        setTimeout(() => {
            const msgs = document.getElementById(`chatMessages-${sessionId}`);
            if (msgs) {
                msgs.scrollTop = msgs.scrollHeight;
            }

            // 聚焦输入框
            const input = document.getElementById(`chatInput-${sessionId}`);
            if (input) input.focus();
        }, 150);

        App.toast('已切回当前对话', 'info');
    },

    // ── 搜索对话历史 ──

    async searchChatHistory(sessionId) {
        const keyword = document.getElementById(
            `chatHistorySearch-${sessionId}`
        )?.value?.trim();
        if (!keyword) {
            this.loadAllChatHistory(sessionId);
            return;
        }

        const div = document.getElementById(`chatHistoryContent-${sessionId}`);
        if (!div) return;

        div.innerHTML = `<div style="text-align:center;padding:20px;
            color:var(--text-secondary);">
            <i class="fas fa-spinner fa-spin"></i> 搜索中...
        </div>`;

        try {
            const res  = await fetch(
                `/api/ai/chat/search?q=${encodeURIComponent(keyword)}&limit=50`,
                { headers: App.authHeaders() }
            );
            const data = await res.json();
            const msgs = data.data || [];

            if (!msgs.length) {
                div.innerHTML = `
                    <div style="text-align:center;color:var(--text-secondary);
                                padding:30px;font-size:13px;">
                        <i class="fas fa-search"
                        style="font-size:24px;display:block;
                                margin-bottom:8px;opacity:0.3;"></i>
                        未找到包含「${App.escapeHtml(keyword)}」的对话
                    </div>`;
                return;
            }

            // 按 chat_id 分组
            const grouped = {};
            msgs.forEach(m => {
                if (!grouped[m.chat_id]) grouped[m.chat_id] = [];
                grouped[m.chat_id].push(m);
            });

            let html = `
                <div style="display:flex;align-items:center;gap:8px;
                            margin-bottom:10px;padding-bottom:8px;
                            border-bottom:1px solid var(--border-color);">
                    <button class="btn btn-sm"
                            onclick="AIAssistant.loadAllChatHistory('${sessionId}')">
                        <i class="fas fa-arrow-left"></i> 返回
                    </button>
                    <span style="font-size:12px;color:var(--text-secondary);">
                        找到 ${msgs.length} 条结果，来自 ${Object.keys(grouped).length} 个会话
                    </span>
                </div>
            `;

            for (const [chatId, messages] of Object.entries(grouped)) {
                html += `
                    <div style="margin-bottom:12px;">
                        <div style="font-size:11px;font-weight:600;
                                    color:var(--text-secondary);
                                    padding:4px 8px;margin-bottom:4px;
                                    text-transform:uppercase;letter-spacing:0.5px;">
                            <i class="fas fa-comments"
                            style="color:var(--accent-color);margin-right:4px;"></i>
                            ${App.escapeHtml(chatId)}
                        </div>
                        ${messages.map(m => {
                            const isUser = m.role === 'user';
                            const time   = (m.created_at || '').replace('T', ' ').slice(0, 19);
                            // 高亮关键词
                            const highlighted = App.escapeHtml(
                                m.content.length > 300
                                    ? m.content.slice(0, 300) + '...'
                                    : m.content
                            ).replace(
                                new RegExp(App.escapeHtml(keyword), 'gi'),
                                match => `<mark style="background:rgba(79,195,247,0.3);
                                                color:var(--text-bright);
                                                padding:0 2px;border-radius:2px;">
                                            ${match}
                                        </mark>`
                            );

                            return `
                                <div style="padding:6px 10px;margin-bottom:3px;
                                            border-radius:6px;
                                            background:var(--bg-tertiary);
                                            border-left:3px solid ${isUser
                                                ? 'var(--success-color)'
                                                : 'var(--accent-color)'};
                                            cursor:pointer;transition:background 0.2s;"
                                    onclick="AIAssistant._openHistorySession(
                                        '${sessionId}','${chatId}')"
                                    onmouseenter="this.style.background='var(--bg-hover)'"
                                    onmouseleave="this.style.background='var(--bg-tertiary)'">
                                    <div style="display:flex;align-items:center;gap:4px;
                                                margin-bottom:3px;">
                                        <span style="font-size:10px;font-weight:500;
                                                    color:${isUser
                                                        ? 'var(--success-color)'
                                                        : 'var(--accent-color)'};">
                                            ${isUser ? '你' : 'AI'}
                                        </span>
                                        <span style="font-size:10px;
                                                    color:var(--text-secondary);
                                                    margin-left:auto;">${time}</span>
                                    </div>
                                    <div style="font-size:12px;line-height:1.5;
                                                color:var(--text-primary);
                                                word-break:break-word;">
                                        ${highlighted}
                                    </div>
                                </div>`;
                        }).join('')}
                    </div>`;
            }

            div.innerHTML = html;

        } catch (e) {
            div.innerHTML = `<div style="color:var(--danger-color);
                padding:20px;font-size:13px;">
                搜索失败: ${App.escapeHtml(e.message)}
            </div>`;
        }
    },

    // ── 按日期筛选 ──

    async filterByDate(sessionId) {
        const dateInput = document.getElementById(`chatHistoryDate-${sessionId}`);
        const dateStr   = dateInput?.value;
        if (!dateStr) return;

        const div = document.getElementById(`chatHistoryContent-${sessionId}`);
        if (!div) return;

        div.innerHTML = `<div style="text-align:center;padding:20px;
            color:var(--text-secondary);">
            <i class="fas fa-spinner fa-spin"></i> 加载中...
        </div>`;

        try {
            const res  = await fetch(
                `/api/ai/chat/by-date?date=${dateStr}`,
                { headers: App.authHeaders() }
            );
            const data = await res.json();
            const msgs = (data.data || []).filter(m => m.role !== 'system');

            if (!msgs.length) {
                div.innerHTML = `
                    <div style="text-align:center;color:var(--text-secondary);
                                padding:30px;font-size:13px;">
                        ${dateStr} 没有对话记录
                    </div>`;
                return;
            }

            div.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;
                            margin-bottom:10px;padding-bottom:8px;
                            border-bottom:1px solid var(--border-color);">
                    <button class="btn btn-sm"
                            onclick="AIAssistant.loadAllChatHistory('${sessionId}')">
                        <i class="fas fa-arrow-left"></i> 返回
                    </button>
                    <span style="font-size:12px;color:var(--text-secondary);">
                        ${dateStr} 的对话 · ${msgs.length} 条
                    </span>
                </div>
                ${msgs.map(m => {
                    const isUser = m.role === 'user';
                    const time   = (m.created_at || '').replace('T', ' ').slice(11, 19);
                    return `
                        <div style="padding:6px 10px;margin-bottom:3px;
                                    border-radius:6px;background:var(--bg-tertiary);
                                    border-left:3px solid ${isUser
                                        ? 'var(--success-color)'
                                        : 'var(--accent-color)'};">
                            <div style="display:flex;align-items:center;gap:4px;
                                        margin-bottom:3px;">
                                <i class="fas ${isUser ? 'fa-user' : 'fa-robot'}"
                                style="font-size:10px;color:${isUser
                                    ? 'var(--success-color)'
                                    : 'var(--accent-color)'};"></i>
                                <span style="font-size:10px;font-weight:500;
                                            color:var(--text-bright);">
                                    ${isUser ? '你' : 'AI'}
                                </span>
                                <span style="font-size:10px;color:var(--text-secondary);
                                            margin-left:auto;">${time}</span>
                            </div>
                            <div style="font-size:12px;line-height:1.5;
                                        color:var(--text-primary);
                                        white-space:pre-wrap;word-break:break-word;">
                                ${App.escapeHtml(
                                    m.content.length > 300
                                        ? m.content.slice(0, 300) + '...'
                                        : m.content
                                )}
                            </div>
                        </div>`;
                }).join('')}
            `;

        } catch (e) {
            div.innerHTML = `<div style="color:var(--danger-color);
                padding:20px;font-size:13px;">
                加载失败: ${App.escapeHtml(e.message)}
            </div>`;
        }
    },

    // ── 快捷：加载今天的记录 ──

    loadTodayChatHistory(sessionId) {
        const today = new Date().toISOString().slice(0, 10);
        const dateInput = document.getElementById(`chatHistoryDate-${sessionId}`);
        if (dateInput) dateInput.value = today;
        this.filterByDate(sessionId);
    },

    // ══════════════════════════════════════════
    //  模块一：AI 诊断面板
    // ══════════════════════════════════════════

    _renderDiagnosePanel(sessionId) {
        return `
            <div style="max-width:900px;margin:0 auto;width:100%;">
                <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
                    <i class="fas fa-stethoscope"
                       style="font-size:24px;color:var(--accent-color);"></i>
                    <div>
                        <h3 style="color:var(--text-bright);margin:0;">AI 系统诊断</h3>
                        <p style="color:var(--text-secondary);font-size:12px;margin:2px 0 0;">
                            全面采集系统状态，AI 分析并给出修复建议
                        </p>
                    </div>
                </div>
                <div style="display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap;">
                    <button class="btn btn-primary"
                            onclick="AIAssistant.runDiagnose('${sessionId}')"
                            id="diagnoseBtn-${sessionId}">
                        <i class="fas fa-play"></i> 开始诊断
                    </button>
                    <button class="btn"
                            onclick="AIAssistant.exportDiagnose('${sessionId}')"
                            id="diagnoseExportBtn-${sessionId}" disabled>
                        <i class="fas fa-file-export"></i> 导出报告
                    </button>
                    <button class="btn"
                            onclick="AIAssistant.saveDiagnoseToKB('${sessionId}')"
                            id="diagnoseSaveBtn-${sessionId}" style="display:none;">
                        <i class="fas fa-book"></i> 存入知识库
                    </button>
                </div>
                <div id="diagnoseResult-${sessionId}">
                    <div style="text-align:center;color:var(--text-secondary);
                                padding:60px;background:var(--bg-secondary);
                                border-radius:12px;border:1px dashed var(--border-color);">
                        <i class="fas fa-stethoscope"
                           style="font-size:40px;display:block;margin-bottom:12px;opacity:0.3;"></i>
                        点击「开始诊断」让 AI 分析系统状态
                    </div>
                </div>
            </div>
        `;
    },

    async runDiagnose(sessionId) {
        const btn       = document.getElementById(`diagnoseBtn-${sessionId}`);
        const resultDiv = document.getElementById(`diagnoseResult-${sessionId}`);
        if (!resultDiv) return;

        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 诊断中...'; }

        resultDiv.innerHTML = `
            <div style="text-align:center;padding:60px;background:var(--bg-secondary);
                        border-radius:12px;border:1px dashed var(--border-color);">
                <i class="fas fa-spinner fa-spin"
                   style="font-size:36px;display:block;margin-bottom:16px;
                          color:var(--accent-color);"></i>
                <p>AI 正在采集系统信息并分析...</p>
                <p style="font-size:12px;color:var(--text-secondary);margin-top:4px;">
                    预计 15~30 秒
                </p>
            </div>`;

        try {
            const res  = await fetch('/api/ai/diagnose', {
                method:  'POST',
                headers: App.authHeaders(),
                body:    JSON.stringify({ session_id: sessionId }),
            });

            const ct = res.headers.get('content-type') || '';
            if (!ct.includes('application/json')) {
                throw new Error(`HTTP ${res.status} 非 JSON 响应`);
            }

            const data = await res.json();
            if (data.status !== 'ok') throw new Error(data.message);

            const report = data.data;
            this._lastDiagnoseReport = report;
            this._lastDiagnoseSession = sessionId;

            this._renderDiagnoseReport(sessionId, report, resultDiv);

            const exportBtn = document.getElementById(`diagnoseExportBtn-${sessionId}`);
            const saveBtn   = document.getElementById(`diagnoseSaveBtn-${sessionId}`);
            if (exportBtn) exportBtn.disabled = false;
            if (saveBtn)   saveBtn.style.display = '';

            App.toast('AI 诊断完成', 'success');

        } catch (e) {
            resultDiv.innerHTML = `
                <div style="background:var(--alert-critical-bg);border-radius:12px;
                            padding:24px;border:1px solid var(--danger-color);">
                    <i class="fas fa-exclamation-circle"
                       style="color:var(--danger-color);font-size:20px;margin-right:10px;"></i>
                    <strong style="color:var(--danger-color);">诊断失败</strong>
                    <p style="color:var(--text-secondary);margin-top:8px;font-size:13px;">
                        ${App.escapeHtml(e.message)}
                    </p>
                    <button class="btn btn-sm" onclick="AIAssistant.runDiagnose('${sessionId}')"
                            style="margin-top:12px;">
                        <i class="fas fa-redo"></i> 重试
                    </button>
                </div>`;
            App.toast('诊断失败: ' + e.message, 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-stethoscope"></i> 开始诊断'; }
        }
    },

    _renderDiagnoseReport(sessionId, report, container) {
        const cmdsHtml = (report.commands || []).map((cmd, i) => `
            <div style="display:flex;align-items:center;gap:10px;background:var(--bg-tertiary);
                        padding:10px 14px;border-radius:8px;margin-bottom:6px;
                        border-left:3px solid var(--success-color);">
                <span style="color:var(--text-secondary);font-size:11px;min-width:20px;">
                    #${i+1}
                </span>
                <code style="flex:1;color:var(--text-bright);font-family:Consolas,monospace;
                             font-size:12px;word-break:break-all;">
                    ${App.escapeHtml(cmd)}
                </code>
                <button class="btn btn-sm btn-primary"
                        onclick="AIAssistant.executeCommand('${sessionId}','${App.escapeHtml(cmd).replace(/'/g, "\\'")}','low')"
                        style="flex-shrink:0;">
                    <i class="fas fa-play"></i>
                </button>
            </div>
        `).join('');

        const recsHtml = (report.recommendations || []).map(r => `
            <li style="margin-bottom:4px;">${App.escapeHtml(r)}</li>
        `).join('');

        container.innerHTML = `
            <div style="background:var(--bg-secondary);border-radius:12px;
                        padding:24px;border:1px solid var(--border-color);">
                <!-- 摘要 -->
                <div style="display:flex;align-items:center;gap:12px;
                            margin-bottom:20px;padding-bottom:16px;
                            border-bottom:1px solid var(--border-color);">
                    <div style="width:44px;height:44px;border-radius:12px;flex-shrink:0;
                                background:rgba(79,195,247,0.15);display:flex;
                                align-items:center;justify-content:center;">
                        <i class="fas fa-robot" style="color:var(--accent-color);font-size:20px;"></i>
                    </div>
                    <div style="flex:1;">
                        <div style="font-size:1rem;font-weight:600;color:var(--text-bright);">
                            ${App.escapeHtml(report.summary || '诊断完成')}
                        </div>
                        <div style="font-size:11px;color:var(--text-secondary);margin-top:3px;">
                            ${new Date().toLocaleString()}
                        </div>
                    </div>
                </div>

                <!-- 详细诊断 -->
                <div style="margin-bottom:16px;">
                    <h4 style="color:var(--text-bright);margin-bottom:8px;font-size:14px;">
                        <i class="fas fa-search" style="color:var(--info-color);"></i> 诊断详情
                    </h4>
                    <div style="background:var(--bg-tertiary);padding:14px;border-radius:8px;
                                font-size:13px;line-height:1.8;white-space:pre-line;
                                color:var(--text-primary);">
                        ${App.escapeHtml(App._formatDiagnosisText(report.diagnosis) || '无详细信息')}
                    </div>
                </div>

                <!-- 修复建议 -->
                ${recsHtml ? `
                <div style="margin-bottom:16px;">
                    <h4 style="color:var(--text-bright);margin-bottom:8px;font-size:14px;">
                        <i class="fas fa-lightbulb" style="color:var(--warning-color);"></i> 修复建议
                    </h4>
                    <ul style="padding-left:20px;color:var(--text-primary);font-size:13px;
                               line-height:1.8;">
                        ${recsHtml}
                    </ul>
                </div>` : ''}

                <!-- 建议命令 -->
                ${cmdsHtml ? `
                <div>
                    <h4 style="color:var(--text-bright);margin-bottom:8px;font-size:14px;">
                        <i class="fas fa-terminal" style="color:var(--success-color);"></i> 建议执行
                    </h4>
                    ${cmdsHtml}
                    <div style="font-size:11px;color:var(--text-secondary);margin-top:6px;">
                        <i class="fas fa-shield-alt"></i> 执行前请确认命令安全性
                    </div>
                </div>` : ''}
            </div>
        `;
    },

    exportDiagnose(sessionId) {
        const report = this._lastDiagnoseReport;
        if (!report) { App.toast('请先执行诊断', 'warning'); return; }

        const session = App.sessions[sessionId] || {};
        const ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        let md = `# AI 诊断报告\n\n`;
        md += `**主机**: ${session.connName || sessionId}\n`;
        md += `**时间**: ${new Date().toLocaleString()}\n\n---\n\n`;
        md += `## 诊断摘要\n\n${report.summary}\n\n`;
        md += `## 详细分析\n\n${report.diagnosis}\n\n`;
        if (report.recommendations?.length) {
            md += `## 修复建议\n\n`;
            report.recommendations.forEach((r, i) => { md += `${i+1}. ${r}\n`; });
            md += '\n';
        }
        if (report.commands?.length) {
            md += `## 建议命令\n\n`;
            report.commands.forEach((c, i) => { md += `${i+1}. \`${c}\`\n`; });
        }

        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = `诊断报告_${ts}.md`; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        App.toast('报告已导出', 'success');
    },

    async saveDiagnoseToKB(sessionId) {
        const report  = this._lastDiagnoseReport;
        const session = App.sessions[sessionId] || {};
        if (!report) return;

        const content = [
            `## 诊断摘要\n${report.summary}`,
            `## 详细分析\n${report.diagnosis}`,
            report.recommendations?.length ? `## 修复建议\n${report.recommendations.join('\n')}` : '',
            report.commands?.length ? `## 修复命令\n${report.commands.map(c => '`'+c+'`').join('\n')}` : '',
        ].filter(Boolean).join('\n\n');

        try {
            const res  = await fetch('/api/ai/knowledge', {
                method:  'POST',
                headers: App.authHeaders(),
                body:    JSON.stringify({
                    title:    `诊断报告 - ${session.connName || sessionId} - ${new Date().toLocaleDateString()}`,
                    content,
                    tags:     ['诊断', session.connName || sessionId],
                    category: 'fault',
                }),
            });
            const data = await res.json();
            if (data.status === 'ok') {
                App.toast('已保存到知识库', 'success');
            }
        } catch (e) {
            App.toast('保存失败: ' + e.message, 'error');
        }
    },

    // ══════════════════════════════════════════
    //  模块二：容量预测面板
    // ══════════════════════════════════════════

    _renderPredictPanel(sessionId) {
        return `
            <div style="max-width:900px;margin:0 auto;width:100%;">
                <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
                    <i class="fas fa-chart-line" style="font-size:24px;color:var(--accent-color);"></i>
                    <div>
                        <h3 style="color:var(--text-bright);margin:0;">容量预测与优化建议</h3>
                        <p style="color:var(--text-secondary);font-size:12px;margin:2px 0 0;">
                            AI 分析当前资源使用趋势，预测未来风险
                        </p>
                    </div>
                </div>
                <button class="btn btn-primary" onclick="AIAssistant.runPredict('${sessionId}')"
                        id="predictBtn-${sessionId}">
                    <i class="fas fa-chart-line"></i> 开始预测
                </button>
                <div id="predictResult-${sessionId}" style="margin-top:20px;">
                    <div style="text-align:center;color:var(--text-secondary);
                                padding:60px;background:var(--bg-secondary);
                                border-radius:12px;border:1px dashed var(--border-color);">
                        <i class="fas fa-chart-line"
                           style="font-size:40px;display:block;margin-bottom:12px;opacity:0.3;"></i>
                        点击「开始预测」分析资源趋势
                    </div>
                </div>
            </div>
        `;
    },

    async runPredict(sessionId) {
        const btn = document.getElementById(`predictBtn-${sessionId}`);
        const div = document.getElementById(`predictResult-${sessionId}`);
        if (!div) return;

        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 分析中...'; }
        div.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-secondary);">
            <i class="fas fa-spinner fa-spin" style="font-size:30px;display:block;
               margin-bottom:12px;color:var(--accent-color);"></i>AI 正在分析资源趋势...
        </div>`;

        try {
            const res  = await fetch('/api/ai/predict', {
                method:  'POST',
                headers: App.authHeaders(),
                body:    JSON.stringify({ session_id: sessionId }),
            });
            const data = await res.json();
            if (data.status !== 'ok') throw new Error(data.message);

            const result = data.data;
            const scoreColor = result.overall_health >= 80 ? 'var(--success-color)' :
                               result.overall_health >= 50 ? 'var(--warning-color)' : 'var(--danger-color)';

            div.innerHTML = `
                <div style="background:var(--bg-secondary);border-radius:12px;
                            padding:24px;border:1px solid var(--border-color);">
                    <!-- 健康评分 -->
                    <div style="display:flex;align-items:center;gap:16px;margin-bottom:24px;
                                padding-bottom:16px;border-bottom:1px solid var(--border-color);">
                        <div style="width:64px;height:64px;border-radius:50%;flex-shrink:0;
                                    background:var(--bg-tertiary);display:flex;
                                    flex-direction:column;align-items:center;justify-content:center;
                                    border:3px solid ${scoreColor};">
                            <span style="font-size:20px;font-weight:700;color:${scoreColor};">
                                ${result.overall_health || 0}
                            </span>
                            <span style="font-size:10px;color:var(--text-secondary);">健康分</span>
                        </div>
                        <div>
                            <h4 style="color:var(--text-bright);margin:0 0 4px;">资源健康评估</h4>
                            ${(result.priority_actions || []).map(a =>
                                `<div style="font-size:12px;color:var(--warning-color);">⚡ ${App.escapeHtml(a)}</div>`
                            ).join('')}
                        </div>
                    </div>

                    <!-- 各资源预测 -->
                    ${(result.predictions || []).map(p => {
                        const riskColor = p.risk_level === 'critical' ? 'var(--danger-color)' :
                                          p.risk_level === 'high'     ? 'var(--warning-color)' :
                                          p.risk_level === 'medium'   ? 'var(--info-color)'    : 'var(--success-color)';
                        const daysText  = p.estimated_full_days > 0
                            ? `预计 <strong style="color:${riskColor}">${p.estimated_full_days} 天</strong>后耗尽`
                            : '暂无耗尽风险';
                        return `
                            <div style="margin-bottom:16px;padding:16px;background:var(--bg-tertiary);
                                        border-radius:8px;border-left:4px solid ${riskColor};">
                                <div style="display:flex;justify-content:space-between;
                                            align-items:center;margin-bottom:8px;">
                                    <strong style="color:var(--text-bright);">${App.escapeHtml(p.resource)}</strong>
                                    <span style="font-size:12px;color:${riskColor};">${p.risk_level?.toUpperCase()}</span>
                                </div>
                                <div style="font-size:13px;color:var(--text-secondary);margin-bottom:4px;">
                                    当前使用率: ${p.current_usage} | ${daysText}
                                </div>
                                <div style="font-size:12px;color:var(--text-secondary);">
                                    趋势: ${App.escapeHtml(p.trend || '-')}
                                </div>
                                ${p.suggestions?.length ? `
                                <ul style="margin:8px 0 0;padding-left:18px;font-size:12px;
                                           color:var(--text-primary);">
                                    ${p.suggestions.map(s => `<li>${App.escapeHtml(s)}</li>`).join('')}
                                </ul>` : ''}
                            </div>
                        `;
                    }).join('')}
                </div>
            `;

            App.toast('容量预测完成', 'success');

        } catch (e) {
            div.innerHTML = `<div style="background:var(--alert-critical-bg);padding:20px;
                border-radius:12px;border:1px solid var(--danger-color);">
                <strong style="color:var(--danger-color);">预测失败</strong>
                <p style="color:var(--text-secondary);font-size:13px;margin-top:6px;">
                    ${App.escapeHtml(e.message)}
                </p>
            </div>`;
            App.toast('预测失败', 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-chart-line"></i> 开始预测'; }
        }
    },

    // ══════════════════════════════════════════
    //  模块二：安全扫描面板
    // ══════════════════════════════════════════

    _renderSecurityPanel(sessionId) {
        return `
            <div style="max-width:900px;margin:0 auto;width:100%;">
                <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
                    <i class="fas fa-shield-alt" style="font-size:24px;color:var(--accent-color);"></i>
                    <div>
                        <h3 style="color:var(--text-bright);margin:0;">安全漏洞扫描</h3>
                        <p style="color:var(--text-secondary);font-size:12px;margin:2px 0 0;">
                            分析已安装软件包，发现已知安全漏洞
                        </p>
                    </div>
                </div>
                <button class="btn btn-primary" onclick="AIAssistant.runSecurityScan('${sessionId}')"
                        id="securityBtn-${sessionId}">
                    <i class="fas fa-search"></i> 开始扫描
                </button>
                <div id="securityResult-${sessionId}" style="margin-top:20px;">
                    <div style="text-align:center;color:var(--text-secondary);
                                padding:60px;background:var(--bg-secondary);
                                border-radius:12px;border:1px dashed var(--border-color);">
                        <i class="fas fa-shield-alt"
                           style="font-size:40px;display:block;margin-bottom:12px;opacity:0.3;"></i>
                        点击「开始扫描」检测安全漏洞
                    </div>
                </div>
            </div>
        `;
    },

    async runSecurityScan(sessionId) {
        const btn = document.getElementById(`securityBtn-${sessionId}`);
        const div = document.getElementById(`securityResult-${sessionId}`);
        if (!div) return;

        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 扫描中...'; }
        div.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-secondary);">
            <i class="fas fa-spinner fa-spin" style="font-size:30px;display:block;
               margin-bottom:12px;color:var(--accent-color);"></i>
            AI 正在分析软件包安全性...
        </div>`;

        try {
            const res  = await fetch('/api/ai/security-scan', {
                method:  'POST',
                headers: App.authHeaders(),
                body:    JSON.stringify({ session_id: sessionId }),
            });
            const data = await res.json();
            if (data.status !== 'ok') throw new Error(data.message);

            const result    = data.data;
            const score     = result.security_score || 0;
            const scoreColor = score >= 80 ? 'var(--success-color)' :
                               score >= 50 ? 'var(--warning-color)' : 'var(--danger-color)';

            div.innerHTML = `
                <div style="background:var(--bg-secondary);border-radius:12px;
                            padding:24px;border:1px solid var(--border-color);">

                    <!-- 安全评分 -->
                    <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;
                                padding-bottom:16px;border-bottom:1px solid var(--border-color);">
                        <div style="width:64px;height:64px;border-radius:50%;
                                    background:var(--bg-tertiary);display:flex;
                                    flex-direction:column;align-items:center;justify-content:center;
                                    border:3px solid ${scoreColor};flex-shrink:0;">
                            <span style="font-size:20px;font-weight:700;color:${scoreColor};">${score}</span>
                            <span style="font-size:10px;color:var(--text-secondary);">安全分</span>
                        </div>
                        <div>
                            <h4 style="color:var(--text-bright);margin:0 0 6px;">安全评估结果</h4>
                            <span style="font-size:12px;">
                                发现 <strong style="color:var(--danger-color);">
                                    ${result.vulnerabilities?.length || 0}
                                </strong> 个潜在漏洞，
                                <strong style="color:var(--warning-color);">
                                    ${result.open_ports_risk?.length || 0}
                                </strong> 个端口风险
                            </span>
                        </div>
                    </div>

                    <!-- 漏洞列表 -->
                    ${(result.vulnerabilities || []).length ? `
                    <h4 style="color:var(--text-bright);margin-bottom:10px;font-size:14px;">
                        <i class="fas fa-bug" style="color:var(--danger-color);"></i> 发现漏洞
                    </h4>
                    ${result.vulnerabilities.map(v => {
                        const c = v.severity === 'critical' ? 'var(--danger-color)' :
                                  v.severity === 'high'     ? 'var(--warning-color)' : 'var(--info-color)';
                        return `
                        <div style="padding:12px 14px;border-radius:8px;margin-bottom:8px;
                                    background:var(--bg-tertiary);border-left:4px solid ${c};">
                            <div style="display:flex;justify-content:space-between;align-items:center;">
                                <strong style="color:var(--text-bright);">${App.escapeHtml(v.package)}</strong>
                                <span style="font-size:11px;color:${c};">${v.severity?.toUpperCase()}</span>
                            </div>
                            <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">
                                版本: ${App.escapeHtml(v.version)} | ${App.escapeHtml(v.description)}
                            </div>
                            <div style="font-size:12px;color:var(--success-color);margin-top:4px;">
                                修复: ${App.escapeHtml(v.fix)}
                            </div>
                        </div>`;
                    }).join('')}` : `
                    <div style="color:var(--success-color);padding:10px;">
                        <i class="fas fa-check-circle"></i> 未发现明显软件包漏洞
                    </div>`}

                    <!-- 端口风险 -->
                    ${(result.open_ports_risk || []).length ? `
                    <h4 style="color:var(--text-bright);margin:16px 0 10px;font-size:14px;">
                        <i class="fas fa-door-open" style="color:var(--warning-color);"></i> 端口风险
                    </h4>
                    ${result.open_ports_risk.map(p => `
                        <div style="padding:10px 14px;border-radius:8px;margin-bottom:6px;
                                    background:var(--bg-tertiary);">
                            <strong style="color:var(--warning-color);">:${p.port}</strong>
                            <span style="color:var(--text-secondary);font-size:12px;margin-left:8px;">
                                ${App.escapeHtml(p.service)} - ${App.escapeHtml(p.risk)}
                            </span>
                        </div>
                    `).join('')}` : ''}

                    <!-- 加固建议 -->
                    ${(result.recommendations || []).length ? `
                    <h4 style="color:var(--text-bright);margin:16px 0 10px;font-size:14px;">
                        <i class="fas fa-shield-alt" style="color:var(--success-color);"></i> 加固建议
                    </h4>
                    <ul style="padding-left:20px;font-size:13px;color:var(--text-primary);">
                        ${result.recommendations.map(r => `<li style="margin-bottom:4px;">${App.escapeHtml(r)}</li>`).join('')}
                    </ul>` : ''}
                </div>
            `;

            App.toast(`扫描完成，发现 ${result.vulnerabilities?.length || 0} 个潜在漏洞`, 'success');

        } catch (e) {
            div.innerHTML = `<div style="background:var(--alert-critical-bg);padding:20px;
                border-radius:12px;border:1px solid var(--danger-color);">
                <strong style="color:var(--danger-color);">扫描失败</strong>
                <p style="color:var(--text-secondary);font-size:13px;margin-top:6px;">
                    ${App.escapeHtml(e.message)}
                </p>
            </div>`;
            App.toast('扫描失败', 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-search"></i> 开始扫描'; }
        }
    },

    // ══════════════════════════════════════════
    //  模块四：知识库面板
    // ══════════════════════════════════════════

    _renderKnowledgePanel(sessionId) {
        return `
            <div style="max-width:900px;margin:0 auto;width:100%;">
                <div style="display:flex;align-items:center;justify-content:space-between;
                            margin-bottom:20px;flex-wrap:wrap;gap:10px;">
                    <div style="display:flex;align-items:center;gap:12px;">
                        <i class="fas fa-book" style="font-size:24px;color:var(--accent-color);"></i>
                        <div>
                            <h3 style="color:var(--text-bright);margin:0;">运维知识库</h3>
                            <p style="color:var(--text-secondary);font-size:12px;margin:2px 0 0;">
                                故障案例、操作手册、经验沉淀
                            </p>
                        </div>
                    </div>
                    <div style="display:flex;gap:8px;">
                        <input type="text" id="kbSearch-${sessionId}"
                               placeholder="搜索知识库..."
                               onkeypress="if(event.key==='Enter')AIAssistant.searchKB('${sessionId}')"
                               style="padding:7px 12px;border:1px solid var(--border-color);
                                      background:var(--bg-tertiary);color:var(--text-primary);
                                      border-radius:6px;font-size:13px;width:200px;outline:none;">
                        <button class="btn btn-sm" onclick="AIAssistant.searchKB('${sessionId}')">
                            <i class="fas fa-search"></i>
                        </button>
                        <button class="btn btn-sm btn-primary"
                                onclick="AIAssistant.showAddKB('${sessionId}')">
                            <i class="fas fa-plus"></i> 新增
                        </button>
                    </div>
                </div>

                <!-- 分类 Tab -->
                <div style="display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap;">
                    ${[
                        ['', '全部'],
                        ['fault', '故障案例'],
                        ['command', '命令手册'],
                        ['qa', '问答'],
                        ['topology', '拓扑'],
                    ].map(([cat, label]) => `
                        <button class="btn btn-sm kb-cat-btn"
                                data-category="${cat}"
                                onclick="AIAssistant.loadKB('${sessionId}','${cat}')"
                                style="font-size:12px;">
                            ${label}
                        </button>
                    `).join('')}
                </div>

                <div id="kbList-${sessionId}">
                    <div style="text-align:center;color:var(--text-secondary);padding:40px;">
                        <i class="fas fa-spinner fa-spin"></i> 加载中...
                    </div>
                </div>

                <!-- 新增弹窗 -->
                <div id="kbAddModal-${sessionId}" style="display:none;position:fixed;
                     top:0;left:0;right:0;bottom:0;z-index:2000;background:rgba(0,0,0,0.6);
                     display:none;align-items:center;justify-content:center;">
                    <div style="background:var(--bg-secondary);border-radius:12px;
                                padding:24px;width:560px;max-width:90vw;max-height:80vh;
                                overflow-y:auto;border:1px solid var(--border-color);">
                        <h3 style="color:var(--text-bright);margin-bottom:16px;">新增知识</h3>
                        <div class="form-group">
                            <label>标题</label>
                            <input type="text" id="kbTitle-${sessionId}" placeholder="简洁的标题">
                        </div>
                        <div class="form-group">
                            <label>分类</label>
                            <select id="kbCategory-${sessionId}">
                                <option value="qa">问答</option>
                                <option value="fault">故障案例</option>
                                <option value="command">命令手册</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label>内容 (支持 Markdown)</label>
                            <textarea id="kbContent-${sessionId}" rows="8"
                                      style="font-family:Consolas,monospace;font-size:13px;"
                                      placeholder="## 故障现象&#10;...&#10;## 解决方案&#10;..."></textarea>
                        </div>
                        <div class="form-group">
                            <label>标签 (逗号分隔)</label>
                            <input type="text" id="kbTags-${sessionId}" placeholder="nginx, 内存, 性能">
                        </div>
                        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px;">
                            <button class="btn" onclick="AIAssistant.hideAddKB('${sessionId}')">取消</button>
                            <button class="btn btn-primary" onclick="AIAssistant.submitKB('${sessionId}')">
                                保存
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    },

    async loadKB(sessionId, category = '') {
        const div = document.getElementById(`kbList-${sessionId}`);
        if (!div) return;

        try {
            const url = `/api/ai/knowledge${category ? '?category=' + category : ''}`;
            const res  = await fetch(url, { headers: App.authHeaders() });
            const data = await res.json();

            if (!data.data?.length) {
                div.innerHTML = `<div style="text-align:center;color:var(--text-secondary);
                    padding:40px;background:var(--bg-secondary);border-radius:12px;
                    border:1px dashed var(--border-color);">
                    <i class="fas fa-book-open" style="font-size:36px;display:block;
                       margin-bottom:12px;opacity:0.3;"></i>
                    暂无知识条目，点击「新增」添加
                </div>`;
                return;
            }

            div.innerHTML = data.data.map(entry => `
                <div style="background:var(--bg-secondary);border:1px solid var(--border-color);
                            border-radius:8px;padding:14px 16px;margin-bottom:8px;
                            transition:border-color 0.2s;"
                     onmouseenter="this.style.borderColor='var(--accent-color)'"
                     onmouseleave="this.style.borderColor='var(--border-color)'">
                    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
                        <div style="flex:1;min-width:0;">
                            <div style="font-size:14px;font-weight:600;color:var(--text-bright);
                                        margin-bottom:4px;">
                                ${App.escapeHtml(entry.title)}
                            </div>
                            <div style="font-size:12px;color:var(--text-secondary);
                                        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                                ${App.escapeHtml(entry.content.slice(0, 120))}...
                            </div>
                            <div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap;">
                                <span style="font-size:10px;padding:1px 6px;border-radius:8px;
                                             background:var(--bg-tertiary);color:var(--text-secondary);">
                                    ${entry.category}
                                </span>
                                ${(entry.tags || []).map(t => `
                                    <span style="font-size:10px;padding:1px 6px;border-radius:8px;
                                                 background:rgba(79,195,247,0.1);
                                                 color:var(--accent-color);">
                                        ${App.escapeHtml(t)}
                                    </span>
                                `).join('')}
                            </div>
                        </div>
                        <div style="display:flex;gap:4px;flex-shrink:0;">
                            <button class="btn btn-icon btn-sm"
                                    onclick="AIAssistant.viewKBEntry('${entry.id}','${App.escapeHtml(entry.title)}')"
                                    title="查看">
                                <i class="fas fa-eye" style="font-size:11px;"></i>
                            </button>
                            <button class="btn btn-icon btn-sm"
                                    onclick="AIAssistant.deleteKB('${entry.id}','${sessionId}')"
                                    title="删除">
                                <i class="fas fa-trash" style="font-size:11px;color:var(--danger-color);"></i>
                            </button>
                        </div>
                    </div>
                </div>
            `).join('');

        } catch (e) {
            div.innerHTML = `<div style="color:var(--danger-color);padding:20px;">加载失败: ${App.escapeHtml(e.message)}</div>`;
        }
    },

    async searchKB(sessionId) {
        const q   = document.getElementById(`kbSearch-${sessionId}`)?.value?.trim();
        const div = document.getElementById(`kbList-${sessionId}`);
        if (!div) return;

        const url = q ? `/api/ai/knowledge?q=${encodeURIComponent(q)}` : '/api/ai/knowledge';
        const res = await fetch(url, { headers: App.authHeaders() });
        const data = await res.json();

        if (!data.data?.length) {
            div.innerHTML = `<div style="text-align:center;color:var(--text-secondary);padding:40px;">
                未找到匹配结果
            </div>`;
            return;
        }

        // 复用 loadKB 渲染逻辑
        div.innerHTML = data.data.map(entry => `
            <div style="background:var(--bg-secondary);border:1px solid var(--border-color);
                        border-radius:8px;padding:14px 16px;margin-bottom:8px;">
                <div style="font-size:14px;font-weight:600;color:var(--text-bright);">
                    ${App.escapeHtml(entry.title)}
                </div>
                <div style="font-size:12px;color:var(--text-secondary);margin-top:4px;">
                    ${App.escapeHtml(entry.content.slice(0, 120))}...
                </div>
            </div>
        `).join('');
    },

    showAddKB(sessionId) {
        const modal = document.getElementById(`kbAddModal-${sessionId}`);
        if (modal) modal.style.display = 'flex';
    },

    hideAddKB(sessionId) {
        const modal = document.getElementById(`kbAddModal-${sessionId}`);
        if (modal) modal.style.display = 'none';
    },

    async submitKB(sessionId) {
        const title    = document.getElementById(`kbTitle-${sessionId}`)?.value?.trim();
        const category = document.getElementById(`kbCategory-${sessionId}`)?.value;
        const content  = document.getElementById(`kbContent-${sessionId}`)?.value?.trim();
        const tagsRaw  = document.getElementById(`kbTags-${sessionId}`)?.value?.trim();
        const tags     = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

        if (!title || !content) {
            App.toast('标题和内容不能为空', 'warning');
            return;
        }

        try {
            const res = await fetch('/api/ai/knowledge', {
                method: 'POST',
                headers: App.authHeaders(),
                body: JSON.stringify({ title, content, tags, category }),
            });
            const data = await res.json();
            if (data.status === 'ok') {
                App.toast('已保存', 'success');
                this.hideAddKB(sessionId);
                this.loadKB(sessionId);
            } else {
                App.toast(data.message, 'error');
            }
        } catch (e) {
            App.toast('保存失败: ' + e.message, 'error');
        }
    },

    async deleteKB(entryId, sessionId) {
        if (!confirm('确认删除此条知识？')) return;
        await fetch(`/api/ai/knowledge/${entryId}`, {
            method: 'DELETE', headers: App.authHeaders(),
        });
        App.toast('已删除', 'success');
        this.loadKB(sessionId);
    },

    viewKBEntry(entryId, title) {
        App.toast(`查看: ${title}`, 'info');
        // 可扩展为弹窗展示完整内容
    },

    // ══════════════════════════════════════════
    //  模块五：拓扑图面板
    // ══════════════════════════════════════════

    _renderTopologyPanel(sessionId) {
        // 预加载 Mermaid 库
        if (!document.getElementById('mermaid-js')) {
            const script = document.createElement('script');
            script.id = 'mermaid-js';
            script.src = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';
            script.onload = () => { if (window.mermaid) mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose' }); };
            document.head.appendChild(script);
        }
        return `
            <div style="max-width:1100px;margin:0 auto;width:100%;">
                <!-- Header -->
                <div style="display:flex;align-items:center;justify-content:space-between;
                            margin-bottom:24px;padding-bottom:18px;
                            border-bottom:1px solid var(--border-color);flex-wrap:wrap;gap:12px;">
                    <div style="display:flex;align-items:center;gap:14px;">
                        <div style="width:44px;height:44px;border-radius:12px;
                                    background:linear-gradient(135deg, #4fc3f7, #0ea5e9);
                                    display:flex;align-items:center;justify-content:center;
                                    box-shadow: 0 4px 14px rgba(79,195,247,0.35);">
                            <i class="fas fa-project-diagram" style="font-size:19px;color:#fff;"></i>
                        </div>
                        <div>
                            <h3 style="color:var(--text-bright);margin:0;font-size:17px;">服务拓扑图</h3>
                            <p style="color:var(--text-secondary);font-size:12px;margin:3px 0 0;">
                                AI 分析进程 · 端口 · 网络连接 → 生成服务依赖关系图
                            </p>
                        </div>
                    </div>
                    <button onclick="AIAssistant.runTopology('${sessionId}')"
                            id="topoBtn-${sessionId}"
                            style="padding:10px 22px;font-size:14px;font-weight:600;
                                   display:flex;align-items:center;gap:8px;
                                   background:linear-gradient(135deg, #4fc3f7, #0284c7);
                                   border:none;border-radius:8px;color:#fff;cursor:pointer;
                                   box-shadow: 0 4px 12px rgba(79,195,247,0.3);
                                   transition: all 0.2s ease;"
                            onmouseenter="this.style.transform='translateY(-1px)';this.style.boxShadow='0 6px 18px rgba(79,195,247,0.4)'"
                            onmouseleave="this.style.transform='translateY(0)';this.style.boxShadow='0 4px 12px rgba(79,195,247,0.3)'">
                        <i class="fas fa-play" style="font-size:12px;"></i> 生成拓扑图
                    </button>
                </div>

                <!-- 结果区 -->
                <div id="topoResult-${sessionId}">
                    <div style="text-align:center;color:var(--text-secondary);
                                padding:70px 24px;background:var(--bg-secondary);
                                border-radius:12px;border:1px solid var(--border-color);">
                        <div style="width:72px;height:72px;border-radius:50%;
                                    background:linear-gradient(135deg, rgba(79,195,247,0.12), rgba(14,165,233,0.08));
                                    display:flex;align-items:center;justify-content:center;
                                    margin:0 auto 20px;">
                            <i class="fas fa-project-diagram"
                               style="font-size:30px;color:#4fc3f7;opacity:0.5;"></i>
                        </div>
                        <p style="font-size:15px;margin:0 0 6px;color:var(--text-primary);">
                            <strong style="color:var(--text-bright);">点击上方「生成拓扑图」按钮</strong>
                        </p>
                        <p style="font-size:13px;margin:0;color:var(--text-secondary);">
                            AI 将分析服务器进程、监听端口和网络连接，生成详细的服务依赖关系图
                        </p>
                    </div>
                </div>
            </div>
        `;
    },

    async runTopology(sessionId) {
        const btn = document.getElementById(`topoBtn-${sessionId}`);
        const div = document.getElementById(`topoResult-${sessionId}`);
        if (!div) return;

        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 正在分析...'; }
        div.innerHTML = `<div style="text-align:center;padding:50px 24px;color:var(--text-secondary);
            background:var(--bg-secondary);border-radius:12px;border:1px solid var(--border-color);">
            <div style="width:60px;height:60px;border-radius:50%;
                        background:linear-gradient(135deg, rgba(79,195,247,0.15), rgba(14,165,233,0.1));
                        display:flex;align-items:center;justify-content:center;
                        margin:0 auto 20px;">
                <i class="fas fa-spinner fa-spin" style="font-size:26px;color:#4fc3f7;"></i>
            </div>
            <p style="font-size:14px;margin:0;color:var(--text-primary);">
                正在分析进程、端口和网络连接...
            </p>
            <p style="font-size:12px;margin:8px 0 0;color:var(--text-secondary);opacity:0.6;">
                预计需要 5–15 秒
            </p>
        </div>`;

        try {
            const res  = await fetch('/api/ai/topology', {
                method:  'POST',
                headers: App.authHeaders(),
                body:    JSON.stringify({ session_id: sessionId }),
            });
            const data = await res.json();
            if (data.status !== 'ok') throw new Error(data.message);

            const result = data.data;
            const svcs = result.services || [];
            const deps = result.dependencies || [];
            const summary = result.summary || '拓扑分析完成';
            const mermaidCode = result.mermaid || 'graph LR\n    Server[服务器]';

            // ── 构建完整 HTML（双栏主布局）──
            let html = '<div style="display:flex;flex-direction:column;gap:18px;">';

            // ── 1. 分析摘要（全宽）──
            html += `<div style="background:var(--bg-secondary);border-radius:12px;
                             padding:18px 22px;border:1px solid var(--border-color);">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
                    <i class="fas fa-file-alt" style="color:#4fc3f7;font-size:14px;"></i>
                    <h4 style="color:var(--text-bright);margin:0;font-size:14px;">分析摘要</h4>
                </div>
                <p style="color:var(--text-primary);font-size:13px;line-height:1.8;margin:0;
                          padding:14px 16px;background:var(--bg-tertiary);border-radius:8px;
                          border-left:3px solid #4fc3f7;white-space:pre-line;">
                    ${App.escapeHtml(App._formatDiagnosisText(summary))}
                </p>
            </div>`;

            // ── 2. Mermaid 拓扑图（全宽）──
            html += `<div style="background:var(--bg-secondary);border-radius:12px;
                             padding:18px 22px;border:1px solid var(--border-color);">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
                    <i class="fas fa-project-diagram" style="color:#4fc3f7;font-size:14px;"></i>
                    <h4 style="color:var(--text-bright);margin:0;font-size:14px;">拓扑图</h4>
                </div>
                <div id="mermaidChart-${sessionId}" style="background:#12141c;border-radius:10px;
                         padding:28px 24px;overflow-x:auto;min-height:100px;text-align:center;
                         border:1px solid rgba(79,195,247,0.12);">
                    <pre class="mermaid" style="display:flex;justify-content:center;">${App.escapeHtml(mermaidCode)}</pre>
                </div>
                <details style="margin-top:10px;">
                    <summary style="cursor:pointer;font-size:12px;color:var(--text-secondary);
                                    padding:6px 0;user-select:none;">
                        <i class="fas fa-code"></i> 查看 Mermaid 源码
                    </summary>
                    <pre style="font-family:Consolas,monospace;font-size:11px;color:var(--text-primary);
                                background:var(--bg-tertiary);padding:12px;border-radius:6px;
                                margin-top:6px;white-space:pre-wrap;overflow-x:auto;
                                max-height:300px;overflow-y:auto;">${App.escapeHtml(mermaidCode)}</pre>
                </details>
            </div>`;

            // ── 3 + 4: 服务清单 + 调用关系（双栏布局）──
            if (svcs.length || deps.length) {
                html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">';

                // ── 左栏：服务清单 ──
                if (svcs.length) {
                    html += `<div style="background:var(--bg-secondary);border-radius:12px;
                                     overflow:hidden;border:1px solid var(--border-color);">
                        <div style="display:flex;align-items:center;gap:8px;
                                    padding:14px 18px;border-bottom:1px solid var(--border-color);">
                            <i class="fas fa-cubes" style="color:#06b6d4;font-size:13px;"></i>
                            <h4 style="color:var(--text-bright);margin:0;font-size:13px;font-weight:600;">服务清单</h4>
                            <span style="font-size:10px;padding:1px 8px;border-radius:8px;
                                         background:rgba(6,182,212,0.12);color:#06b6d4;font-weight:600;">
                                ${svcs.length}
                            </span>
                        </div>
                        <div style="display:flex;flex-direction:column;gap:1px;padding:6px 8px 10px;
                                    background:var(--bg-secondary);">
                            ${svcs.map((s, i) => {
                                const typeColors = {
                                    web:     '#4fc3f7', db:      '#66bb6a', app: '#ffa726',
                                    cache:   '#ef5350', proxy:   '#ab47bc', mq: '#26c6da',
                                    monitor: '#7e57c2', storage: '#42a5f5',
                                };
                                const typeColor = typeColors[s.type] || '#90a4ae';
                                const statusColor = s.status === '运行中' ? '#66bb6a' : s.status === '已停止' ? '#ef5350' : '#ffa726';
                                const statusDot = s.status === '运行中' ? '●' : s.status === '已停止' ? '●' : '●';
                                return `
                                <div style="padding:10px 12px 10px 10px;background:var(--bg-tertiary);
                                            border-radius:6px;border-left:3px solid ${typeColor};
                                            transition: background 0.15s;"
                                     onmouseenter="this.style.background='var(--bg-hover)'"
                                     onmouseleave="this.style.background='var(--bg-tertiary)'">
                                    <div style="display:flex;align-items:flex-start;gap:10px;">
                                        <div style="width:26px;height:26px;border-radius:6px;
                                                    background:${typeColor}18;display:flex;
                                                    align-items:center;justify-content:center;flex-shrink:0;
                                                    margin-top:1px;">
                                            <span style="color:${typeColor};font-weight:700;font-size:11px;">${i + 1}</span>
                                        </div>
                                        <div style="flex:1;min-width:0;">
                                            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:5px;">
                                                <strong style="color:var(--text-bright);font-size:13px;line-height:1.2;">
                                                    ${App.escapeHtml(s.name)}
                                                </strong>
                                                <span style="font-size:10px;padding:1px 6px;border-radius:3px;
                                                             background:${typeColor}14;color:${typeColor};font-weight:600;white-space:nowrap;">
                                                    ${App.escapeHtml(s.type || '?')}
                                                </span>
                                                ${s.version ? `<span style="font-size:10px;color:var(--text-secondary);white-space:nowrap;">v${App.escapeHtml(s.version)}</span>` : ''}
                                            </div>
                                            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:${s.description?'5px':'2px'};">
                                                ${s.port ? `<span style="font-size:11px;color:var(--text-secondary);display:inline-flex;align-items:center;gap:3px;">
                                                    <span style="width:4px;height:4px;border-radius:50%;background:${statusColor};flex-shrink:0;"></span>
                                                    :${s.port}</span>` : ''}
                                                ${s.pid ? `<span style="font-size:10px;color:var(--text-muted);white-space:nowrap;">PID ${s.pid}</span>` : ''}
                                                ${s.cpu_percent != null ? `<span style="font-size:10px;color:var(--text-muted);white-space:nowrap;">CPU ${s.cpu_percent}%</span>` : ''}
                                                ${s.mem_percent != null ? `<span style="font-size:10px;color:var(--text-muted);white-space:nowrap;">MEM ${s.mem_percent}%</span>` : ''}
                                                <span style="font-size:10px;color:${statusColor};white-space:nowrap;">${statusDot} ${App.escapeHtml(s.status || '?')}</span>
                                            </div>
                                            ${s.description ? `<div style="font-size:10px;color:var(--text-muted);line-height:1.4;opacity:0.75;">${App.escapeHtml(s.description)}</div>` : ''}
                                        </div>
                                    </div>
                                </div>`;
                            }).join('')}
                        </div>
                    </div>`;
                } else {
                    html += `<div style="background:var(--bg-secondary);border-radius:12px;
                                     padding:32px 20px;border:1px solid var(--border-color);
                                     text-align:center;">
                        <i class="fas fa-server" style="font-size:28px;opacity:0.12;display:block;margin-bottom:10px;"></i>
                        <span style="color:var(--text-secondary);font-size:12px;">未检测到明确服务</span>
                    </div>`;
                }

                // ── 右栏：调用关系 ──
                if (deps.length) {
                    html += `<div style="background:var(--bg-secondary);border-radius:12px;
                                     overflow:hidden;border:1px solid var(--border-color);">
                        <div style="display:flex;align-items:center;gap:8px;
                                    padding:14px 18px;border-bottom:1px solid var(--border-color);">
                            <i class="fas fa-project-diagram" style="color:#f59e0b;font-size:13px;"></i>
                            <h4 style="color:var(--text-bright);margin:0;font-size:13px;font-weight:600;">调用关系</h4>
                            <span style="font-size:10px;padding:1px 8px;border-radius:8px;
                                         background:rgba(245,158,11,0.12);color:#f59e0b;font-weight:600;">
                                ${deps.length}
                            </span>
                        </div>
                        <div style="display:flex;flex-direction:column;gap:1px;padding:6px 8px 10px;
                                    background:var(--bg-secondary);">
                            ${deps.map(d => {
                                const strengthColor = d.strength === '强依赖' ? '#ef5350' :
                                                      d.strength === '弱依赖' ? '#66bb6a' : '#ffa726';
                                const strengthLabel = d.strength || '';
                                return `
                                <div style="padding:10px 12px;background:var(--bg-tertiary);
                                            border-radius:6px;transition: background 0.15s;"
                                     onmouseenter="this.style.background='var(--bg-hover)'"
                                     onmouseleave="this.style.background='var(--bg-tertiary)'">
                                    <div style="display:flex;align-items:center;gap:10px;min-width:0;">
                                        <!-- FROM -->
                                        <span style="color:#4fc3f7;font-weight:600;font-size:12px;
                                                     white-space:nowrap;flex-shrink:0;">
                                            ${App.escapeHtml(d.from)}
                                        </span>

                                        <!-- 箭头线 + 协议/强度 中置 -->
                                        <div style="display:flex;align-items:center;gap:4px;
                                                    flex:1;min-width:0;position:relative;">
                                            <div style="height:1.5px;flex:1;min-width:10px;
                                                        background: linear-gradient(90deg, #4fc3f750, ${strengthColor}80);
                                                        border-radius:2px;"></div>
                                            <i class="fas fa-arrow-right" style="color:${strengthColor};font-size:11px;flex-shrink:0;"></i>
                                            ${d.protocol || strengthLabel ? `
                                            <div style="display:flex;flex-direction:column;align-items:center;gap:1px;flex-shrink:0;">
                                                ${d.protocol ? `<span style="font-size:9px;padding:1px 5px;border-radius:3px;
                                                    background:rgba(255,255,255,0.04);color:var(--text-muted);line-height:1.3;">
                                                    ${App.escapeHtml(d.protocol)}</span>` : ''}
                                                ${strengthLabel ? `<span style="font-size:8px;color:${strengthColor};
                                                    font-weight:700;line-height:1;opacity:0.9;">${App.escapeHtml(strengthLabel)}</span>` : ''}
                                            </div>` : ''}
                                            <div style="height:1.5px;flex:1;min-width:10px;
                                                        background: linear-gradient(90deg, ${strengthColor}80, #66bb6a50);
                                                        border-radius:2px;"></div>
                                        </div>

                                        <!-- TO -->
                                        <span style="color:#66bb6a;font-weight:600;font-size:12px;
                                                     white-space:nowrap;flex-shrink:0;">
                                            ${App.escapeHtml(d.to)}
                                        </span>
                                    </div>
                                    ${d.description ? `<div style="font-size:10px;color:var(--text-muted);
                                        margin-top:6px;line-height:1.4;opacity:0.7;padding-left:2px;">
                                        ${App.escapeHtml(d.description)}</div>` : ''}
                                </div>`;
                            }).join('')}
                        </div>
                    </div>`;
                } else {
                    html += `<div style="background:var(--bg-secondary);border-radius:12px;
                                     padding:32px 20px;border:1px solid var(--border-color);
                                     text-align:center;">
                        <i class="fas fa-project-diagram" style="font-size:28px;opacity:0.12;display:block;margin-bottom:10px;"></i>
                        <span style="color:var(--text-secondary);font-size:12px;">未检测到调用关系</span>
                    </div>`;
                }

                html += '</div>'; // close grid
            }

            // ── 5. 图例（全宽）──
            if (svcs.length || deps.length) {
                html += `<div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap;
                                 padding:12px 18px;background:var(--bg-secondary);border-radius:8px;
                                 border:1px solid var(--border-color);font-size:11px;color:var(--text-secondary);">
                    <span style="font-weight:600;color:var(--text-bright);font-size:12px;">
                        <i class="fas fa-tags" style="margin-right:4px;color:#4fc3f7;"></i>图例
                    </span>
                    <span style="color:#4fc3f7;">● Web</span>
                    <span style="color:#66bb6a;">● 数据库</span>
                    <span style="color:#ffa726;">● 应用</span>
                    <span style="color:#ef5350;">● 缓存</span>
                    <span style="color:#ab47bc;">● 代理</span>
                    <span style="opacity:0.5;color:var(--border-color);">|</span>
                    <span style="color:#ef5350;"><i class="fas fa-link" style="font-size:9px;"></i> 强依赖</span>
                    <span style="color:#ffa726;"><i class="fas fa-minus" style="font-size:9px;"></i> 中等</span>
                    <span style="color:#66bb6a;"><i class="fas fa-ellipsis-h" style="font-size:9px;"></i> 弱依赖</span>
                </div>`;
            }

            html += '</div>';
            div.innerHTML = html;

            // ── 渲染 Mermaid ──
            setTimeout(async () => {
                try {
                    if (typeof mermaid !== 'undefined') {
                        // 重新初始化（支持动态渲染）
                        const chartEl = document.getElementById(`mermaidChart-${sessionId}`);
                        if (chartEl) {
                            const preEl = chartEl.querySelector('pre.mermaid');
                            if (preEl) {
                                // 还原原始 mermaid 代码（去 escapeHtml）
                                const tempDiv = document.createElement('div');
                                tempDiv.innerHTML = preEl.textContent || '';
                                const code = tempDiv.textContent;
                                const id = `mermaid-svg-${sessionId}-${Date.now()}`;
                                const { svg } = await mermaid.render(id, code);
                                preEl.innerHTML = svg;
                                preEl.style.display = 'block';
                            }
                        }
                    }
                } catch (e) {
                    console.warn('Mermaid 渲染失败（将保留源码）:', e);
                }
            }, 200);

            App.toast('拓扑图生成完成', 'success');

        } catch (e) {
            div.innerHTML = `<div style="background:var(--bg-secondary);padding:32px 24px;
                border-radius:12px;border:1px solid var(--border-color);text-align:center;">
                <div style="width:56px;height:56px;border-radius:50%;
                            background:rgba(244,71,71,0.12);display:flex;
                            align-items:center;justify-content:center;margin:0 auto 14px;">
                    <i class="fas fa-exclamation-triangle" style="font-size:24px;color:var(--danger-color);"></i>
                </div>
                <strong style="color:var(--text-bright);font-size:14px;">拓扑生成失败</strong>
                <p style="color:var(--text-secondary);font-size:13px;margin:8px 0 14px;">
                    ${App.escapeHtml(e.message)}
                </p>
                <button onclick="AIAssistant.runTopology('${sessionId}')"
                        style="padding:7px 18px;font-size:13px;border-radius:6px;
                               background:transparent;border:1px solid var(--border-color);
                               color:var(--text-primary);cursor:pointer;
                               transition: all 0.2s;"
                        onmouseenter="this.style.borderColor='#4fc3f7';this.style.color='#4fc3f7'"
                        onmouseleave="this.style.borderColor='var(--border-color)';this.style.color='var(--text-primary)'">
                    <i class="fas fa-redo" style="margin-right:5px;"></i> 重试
                </button>
            </div>`;
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-play"></i> 生成拓扑图'; }
        }
    },
};

window.AIAssistant = AIAssistant;