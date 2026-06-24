/**
 * SFTP 文件管理器 v2.3
 * ✅ Map 存储每会话独立状态
 * ✅ 危险操作闭包锁定 sessionId + file
 * ✅ XHR 上传/下载 + 原生进度回调
 * ✅ 传输悬浮球（自动显隐 + 手动折叠）
 */
const FileManager = {

    // ══════════════════════════════════════════
    //  多会话状态
    // ══════════════════════════════════════════

    _states: new Map(),

    _getState(sessionId) {
        if (!sessionId) return null;
        if (!this._states.has(sessionId)) {
            this._states.set(sessionId, {
                currentPath:   '/',
                currentFiles:  [],
                selectedFile:  null,
                editingFile:   null,
                history:       ['/'],
                historyIndex:  0,
                _selectedIndex: -1,
                _vs:           null,
            });
        }
        return this._states.get(sessionId);
    },

    clearState(sessionId) {
        this._states.delete(sessionId);
    },

    currentSessionId: null,

    // ══════════════════════════════════════════
    //  路径工具
    // ══════════════════════════════════════════

    normalizePath(path) {
        if (!path || path === '') return '/';
        path = path.replace(/\\/g, '/').replace(/\/+/g, '/');
        if (!path.startsWith('/')) path = '/' + path;
        if (path !== '/' && path.endsWith('/')) path = path.slice(0, -1);
        return path;
    },

    joinPath(base, name) {
        base = this.normalizePath(base);
        return base === '/' ? '/' + name : base + '/' + name;
    },

    parentPath(path) {
        path = this.normalizePath(path);
        if (path === '/') return '/';
        const parts = path.split('/').filter(Boolean);
        parts.pop();
        return '/' + parts.join('/');
    },

    // ══════════════════════════════════════════
    //  初始化
    // ══════════════════════════════════════════

    init(sessionId) {
        this.currentSessionId = sessionId;
        const state = this._getState(sessionId);
        this.loadDirectory(state.currentPath || '/');
    },

    // ══════════════════════════════════════════
    //  目录加载
    // ══════════════════════════════════════════

    async loadDirectory(path) {
        if (!this.currentSessionId) return;
        const sessionId = this.currentSessionId;
        const state     = this._getState(sessionId);
        path = this.normalizePath(path);

        try {
            const res  = await fetch(
                `/api/sftp/${sessionId}/list?path=${encodeURIComponent(path)}`,
                { headers: App.authHeaders() }
            );
            const data = await res.json();
            if (this.currentSessionId !== sessionId) return;

            if (data.status === 'ok') {
                state.currentPath  = this.normalizePath(data.path || path);
                state.currentFiles = data.data || [];
                this._renderFiles(sessionId, state);
                this._updatePathInput(sessionId, state.currentPath);

                if (state.history[state.historyIndex] !== state.currentPath) {
                    state.history = state.history.slice(0, state.historyIndex + 1);
                    state.history.push(state.currentPath);
                    state.historyIndex = state.history.length - 1;
                }
            } else {
                // 权限错误时保持旧路径不变，只显示错误提示（不覆盖当前文件列表）
                const isPermError = res.status === 403 || (data.message && data.message.includes('权限不足'));
                if (isPermError) {
                    state.currentFiles = []; // 清空文件列表以显示空状态
                    this._renderFiles(sessionId, state);
                    this._updatePathInput(sessionId, path); // 恢复旧路径显示
                }
                App.toast(data.message || '加载目录失败', 'error');
            }
        } catch (e) {
            if (this.currentSessionId === sessionId) {
                App.toast('加载目录失败: ' + e.message, 'error');
            }
        }
    },

    _updatePathInput(sessionId, path) {
        const el = document.querySelector(`#panel-${sessionId} .fm-path-input`);
        if (el) el.value = path;
    },

    // ══════════════════════════════════════════
    //  渲染文件列表
    // ══════════════════════════════════════════

    _renderFiles(sessionId, state) {
        const container = document.querySelector(`#panel-${sessionId} .fm-content`);
        if (!container) return;

        // 清除旧的虚拟滚动状态（防止从大目录切到小目录时误判）
        state._vs = null;
        if (container.onscroll) container.onscroll = null;

        // 小于 50 个文件：完整渲染（简单、无额外开销）
        if (state.currentFiles.length <= 50) {
            this._renderFilesFull(sessionId, state, container);
            return;
        }

        // 大目录：虚拟滚动（只渲染可视区域内的行）
        this._renderFilesVirtual(sessionId, state, container);
    },

    _renderFilesFull(sessionId, state, container) {
        let html = `
            <table class="fm-table">
                <thead>
                    <tr>
                        <th style="width:55%;min-width:200px">名称</th>
                        <th style="width:12%;text-align:right;min-width:80px">大小</th>
                        <th style="width:13%;min-width:80px;font-family:monospace">权限</th>
                        <th style="width:20%;min-width:120px;font-size:12px">修改时间</th>
                    </tr>
                </thead>
                <tbody>`;

        if (state.currentPath !== '/') {
            html += this._renderParentRow();
        }

        if (state.currentFiles.length === 0) {
            html += `<tr><td colspan="4">
                <div class="fm-empty">
                    <i class="fas fa-folder-open"
                       style="font-size:36px;display:block;margin-bottom:12px;
                              color:var(--text-secondary)"></i>
                    目录为空
                </div>
            </td></tr>`;
        } else {
            state.currentFiles.forEach((file, index) => {
                html += this._renderFileRow(file, index, state);
            });
        }

        html += '</tbody></table>';
        container.innerHTML = html;
    },

    _renderParentRow() {
        return `<tr ondblclick="FileManager.goUp()" style="cursor:pointer" title="返回上级目录">
            <td><div class="fm-file-name">
                <i class="fas fa-level-up-alt" style="color:var(--accent-color)"></i>
                <span>..</span>
            </div></td>
            <td></td><td></td><td></td>
        </tr>`;
    },

    _renderFileRow(file, index, state) {
        const icon = this.getFileIcon(file);
        const size = file.is_dir ? '-' : this.formatSize(file.size);
        const name = this.escapeHtml(file.name);
        const selected = state._selectedIndex === index ? ' class="selected"' : '';

        return `
            <tr data-index="${index}"${selected}
                ondblclick="FileManager._onDoubleClick(${index})"
                onclick="FileManager._onSelectFile(${index})"
                oncontextmenu="FileManager.showContextMenu(event,${index});return false;">
                <td><div class="fm-file-name">
                    <i class="${icon}"></i>
                    <span title="${name}">${name}</span>
                </div></td>
                <td class="fm-file-size">${size}</td>
                <td class="fm-file-perm">${file.permissions || ''}</td>
                <td class="fm-file-time">${file.mtime || ''}</td>
            </tr>`;
    },

    // ══════════════════════════════════════════
    //  虚拟滚动（>50 文件时启用）
    // ══════════════════════════════════════════

    _renderFilesVirtual(sessionId, state, container) {
        const ROW_H = 32;
        const showParent = state.currentPath !== '/';
        const fileCount = state.currentFiles.length;
        const totalItems = fileCount + (showParent ? 1 : 0);
        const totalHeight = totalItems * ROW_H;

        if (state.currentFiles.length === 0) {
            container.innerHTML = `<table class="fm-table"><thead>
                <tr>
                    <th style="width:55%;min-width:200px">名称</th>
                    <th style="width:12%;text-align:right;min-width:80px">大小</th>
                    <th style="width:13%;min-width:80px;font-family:monospace">权限</th>
                    <th style="width:20%;min-width:120px;font-size:12px">修改时间</th>
                </tr></thead><tbody><tr><td colspan="4"><div class="fm-empty">
                <i class="fas fa-folder-open" style="font-size:36px;display:block;margin-bottom:12px;color:var(--text-secondary)"></i>
                目录为空</div></td></tr></tbody></table>`;
            return;
        }

        // 初始 shell：只有一个占位 tbody
        container.innerHTML = `
            <table class="fm-table">
                <thead>
                    <tr>
                        <th style="width:55%;min-width:200px">名称</th>
                        <th style="width:12%;text-align:right;min-width:80px">大小</th>
                        <th style="width:13%;min-width:80px;font-family:monospace">权限</th>
                        <th style="width:20%;min-width:120px;font-size:12px">修改时间</th>
                    </tr>
                </thead>
                <tbody id="fmVScroll-${sessionId}"></tbody>
            </table>`;

        // 存入虚拟滚动参数
        state._vs = { ROW_H, showParent, fileCount, totalItems, totalHeight };

        // 首次渲染可见行
        this._renderVisibleRows(sessionId, state, container);

        // 滚动监听（rAF 节流）
        let raf = null;
        container.onscroll = () => {
            if (raf) return;
            raf = requestAnimationFrame(() => {
                this._renderVisibleRows(sessionId, state, container);
                raf = null;
            });
        };

        // 选中索引变更时重新计算（不清空 _vs）
    },

    // 计算可视范围并渲染行
    _renderVisibleRows(sessionId, state, container) {
        const vs = state._vs;
        if (!vs) return;

        const { ROW_H, showParent, fileCount, totalItems, totalHeight } = vs;
        const scrollTop = container.scrollTop;
        const viewH = container.clientHeight;
        const BUFFER = 8; // 上下各多渲染 8 行

        const startRow = Math.max(0, Math.floor(scrollTop / ROW_H) - BUFFER);
        const endRow = Math.min(totalItems, startRow + Math.ceil(viewH / ROW_H) + BUFFER * 2);

        const topPad = startRow * ROW_H;
        const bottomPad = totalHeight - endRow * ROW_H;

        let rowsHTML = '';
        // 顶部占位
        if (topPad > 0) {
            rowsHTML += `<tr style="height:${topPad}px;padding:0;border:none;pointer-events:none;"><td colspan="4"></td></tr>`;
        }

        // 渲染文件行
        let fileStart = startRow;
        let parentRendered = false;

        // 如果包含 ".." 行且在可视区内
        if (showParent && startRow <= 0 && endRow > 0) {
            rowsHTML += this._renderParentRow();
            fileStart = 1;
            parentRendered = true;
        }

        // 调整文件索引（.. 行占 1 个位置）
        const fIdxOffset = parentRendered ? 1 : 0;
        const fStart = Math.max(0, startRow - fIdxOffset);
        const fEnd = Math.min(fileCount, endRow - fIdxOffset);

        for (let i = fStart; i < fEnd; i++) {
            rowsHTML += this._renderFileRow(state.currentFiles[i], i, state);
        }

        // 底部占位
        if (bottomPad > 0) {
            rowsHTML += `<tr style="height:${bottomPad}px;padding:0;border:none;pointer-events:none;"><td colspan="4"></td></tr>`;
        }

        const tbody = document.getElementById(`fmVScroll-${sessionId}`);
        if (tbody) {
            tbody.innerHTML = rowsHTML;
        }
    },

    // ══════════════════════════════════════════
    //  内部事件
    // ══════════════════════════════════════════

    _onDoubleClick(index) {
        const state = this._getState(this.currentSessionId);
        if (!state) return;
        const file = state.currentFiles[index];
        if (!file) return;
        if (file.is_dir || file.is_link) {
            this.loadDirectory(file.path);
        } else {
            this.openFile(file);
        }
    },

    _onSelectFile(index) {
        const sessionId = this.currentSessionId;
        const state     = this._getState(sessionId);
        if (!state) return;
        state.selectedFile = state.currentFiles[index];
        state._selectedIndex = index;

        // 虚拟滚动模式：重绘可见行以更新高亮
        if (state._vs) {
            const container = document.querySelector(`#panel-${sessionId} .fm-content`);
            if (container) this._renderVisibleRows(sessionId, state, container);
        } else {
            // 完整渲染模式：直接操作 DOM
            const panel = document.getElementById(`panel-${sessionId}`);
            if (!panel) return;
            const rows = panel.querySelectorAll('.fm-table tbody tr');
            rows.forEach(r => r.classList.remove('selected'));
            const offset = state.currentPath !== '/' ? 1 : 0;
            rows[index + offset]?.classList.add('selected');
        }
    },

    // ══════════════════════════════════════════
    //  文件操作（锁定 sessionId + file）
    // ══════════════════════════════════════════

    async openFile(file) {
        const sessionId  = this.currentSessionId;
        const targetFile = { ...file };

        App.toast(`正在加载 ${targetFile.name}...`, 'info');
        try {
            const res  = await fetch(
                `/api/sftp/${sessionId}/read?path=${encodeURIComponent(targetFile.path)}`,
                { headers: App.authHeaders() }
            );
            const data = await res.json();
            if (data.status === 'ok') {
                const state = this._getState(sessionId);
                if (state) state.editingFile = { ...targetFile, sessionId };
                // ✅ 改为抽屉
                App.openFileDrawer(targetFile.name, data.data);
            } else {
                App.toast(data.message || '无法打开文件', 'error');
            }
        } catch (e) {
            App.toast('打开文件失败: ' + e.message, 'error');
        }
    },

    async saveFile() {
        const state = this._getState(this.currentSessionId);
        const ef    = state?.editingFile;
        if (!ef) return;
        const { path, sessionId } = ef;
        const content = document.getElementById('fileEditorContent').value;

        try {
            const res = await fetch(`/api/sftp/${sessionId}/write`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', ...App.authHeaders() },
                body:    JSON.stringify({ path, content })
            });
            const data = await res.json();
            if (data.status === 'ok') {
                App.toast('文件保存成功', 'success');
                // ✅ 关闭抽屉
                App.closeFileDrawer();
                // ✅ 保存成功后刷新当前目录的文件列表
                this.refresh();
            } else {
                App.toast(data.message || '保存失败', 'error');
            }
        } catch (e) {
            App.toast('保存文件失败: ' + e.message, 'error');
        }
    },

    deleteFile(file) {
        if (!file) return;
        const sessionId  = this.currentSessionId;
        const targetFile = { ...file };

        App.confirm(
            `确定要删除 "${targetFile.name}" 吗？此操作不可恢复！`,
            async () => {
                try {
                    const res = await fetch(`/api/sftp/${sessionId}/delete`, {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json',
                                   ...App.authHeaders() },
                        body: JSON.stringify({
                            path: targetFile.path, is_dir: targetFile.is_dir
                        })
                    });
                    const data = await res.json();
                    if (data.status === 'ok') {
                        App.toast('删除成功', 'success');
                        if (this.currentSessionId === sessionId) this.refresh();
                    } else {
                        App.toast(data.message || '删除失败', 'error');
                    }
                } catch (e) {
                    App.toast('删除失败: ' + e.message, 'error');
                }
            }
        );
    },

    async renameFile(file) {
        if (!file) return;
        const sessionId  = this.currentSessionId;
        const targetFile = { ...file };

        const newName = prompt('请输入新名称:', targetFile.name);
        if (!newName || newName.trim() === targetFile.name) return;

        const newPath = this.joinPath(this.parentPath(targetFile.path), newName.trim());
        try {
            const res = await fetch(`/api/sftp/${sessionId}/rename`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', ...App.authHeaders() },
                body: JSON.stringify({ old_path: targetFile.path, new_path: newPath })
            });
            const data = await res.json();
            if (data.status === 'ok') {
                App.toast('重命名成功', 'success');
                if (this.currentSessionId === sessionId) this.refresh();
            } else {
                App.toast(data.message || '重命名失败', 'error');
            }
        } catch (e) {
            App.toast('重命名失败: ' + e.message, 'error');
        }
    },

    async chmodFile(file) {
        if (!file) return;
        const sessionId  = this.currentSessionId;
        const targetFile = { ...file };

        const currentMode = (targetFile.perm_octal || '755').replace('0o', '');
        const mode = prompt('请输入权限（如 755, 644）:', currentMode);
        if (!mode || !mode.trim()) return;
        if (!/^[0-7]{3,4}$/.test(mode.trim())) {
            App.toast('权限格式错误', 'error');
            return;
        }

        try {
            const res = await fetch(`/api/sftp/${sessionId}/chmod`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', ...App.authHeaders() },
                body: JSON.stringify({ path: targetFile.path, mode: mode.trim() })
            });
            const data = await res.json();
            if (data.status === 'ok') {
                App.toast('权限修改成功', 'success');
                if (this.currentSessionId === sessionId) this.refresh();
            } else {
                App.toast(data.message || '修改失败', 'error');
            }
        } catch (e) {
            App.toast('修改权限失败: ' + e.message, 'error');
        }
    },

    // ══════════════════════════════════════════
    //  传输悬浮球系统
    // ══════════════════════════════════════════

    _transfers: new Map(),  // id → { type, name, total, loaded, status, startTime, xhr }
    _ballVisible: false,
    _panelOpen:   false,

    /**
     * 确保悬浮球 DOM 存在
     */
    _ensureBall() {
        if (document.getElementById('transferBall')) return;

        const ball = document.createElement('div');
        ball.id    = 'transferBall';
        ball.className = 'transfer-ball';
        ball.innerHTML = `
            <div class="tb-badge" id="tbBadge"
                 onclick="FileManager._togglePanel()" title="传输列表">
                <i class="fas fa-exchange-alt"></i>
                <span class="tb-count" id="tbCount">0</span>
            </div>
            <div class="tb-panel" id="tbPanel">
                <div class="tb-panel-header">
                    <span class="tb-panel-title">
                        <i class="fas fa-exchange-alt"></i> 传输列表
                    </span>
                    <div class="tb-panel-actions">
                        <button class="btn btn-icon btn-sm"
                                onclick="FileManager._clearCompleted()"
                                title="清除已完成">
                            <i class="fas fa-broom"></i>
                        </button>
                        <button class="btn btn-icon btn-sm"
                                onclick="FileManager._togglePanel()"
                                title="收起">
                            <i class="fas fa-chevron-down"></i>
                        </button>
                    </div>
                </div>
                <div class="tb-panel-body" id="tbPanelBody">
                    <div class="tb-empty">暂无传输任务</div>
                </div>
            </div>`;
        document.body.appendChild(ball);
    },

    _showBall() {
        this._ensureBall();
        const ball = document.getElementById('transferBall');
        if (ball) ball.classList.add('visible');
        this._ballVisible = true;
    },

    _hideBall() {
        const ball = document.getElementById('transferBall');
        if (ball) ball.classList.remove('visible');
        this._ballVisible = false;
        this._panelOpen   = false;
    },

    _togglePanel() {
        this._panelOpen = !this._panelOpen;
        const panel = document.getElementById('tbPanel');
        if (panel) panel.classList.toggle('open', this._panelOpen);
    },

    /**
     * 添加传输任务
     */
    _addTransfer(id, type, name, total) {
        this._transfers.set(id, {
            type,        // 'upload' | 'download'
            name,
            total,
            loaded:    0,
            status:    'active',   // 'active' | 'done' | 'error'
            startTime: Date.now(),
            lastBytes: 0,
            lastTime:  Date.now(),
            speed:     0,
            message:   '',
        });
        this._showBall();
        this._renderTransfers();
    },

    /**
     * 更新传输进度
     */
    _updateTransfer(id, loaded, total) {
        const t = this._transfers.get(id);
        if (!t) return;

        t.loaded = loaded;
        if (total > 0) t.total = total;

        // 计算速度（每 500ms 更新一次）
        const now     = Date.now();
        const elapsed = (now - t.lastTime) / 1000;
        if (elapsed >= 0.5) {
            t.speed     = (loaded - t.lastBytes) / elapsed;
            t.lastBytes = loaded;
            t.lastTime  = now;
        }

        this._renderTransfers();
    },

    /**
     * 标记传输完成
     */
    _completeTransfer(id, success, message) {
        const t = this._transfers.get(id);
        if (!t) return;

        t.status  = success ? 'done' : 'error';
        t.message = message || '';
        t.loaded  = success ? t.total : t.loaded;
        this._renderTransfers();

        // ✅ 成功后 5 秒自动移除
        if (success) {
            setTimeout(() => {
                this._transfers.delete(id);
                this._renderTransfers();
                this._autoHideBall();
            }, 5000);
        }
    },

    /**
     * 清除已完成的任务
     */
    _clearCompleted() {
        for (const [id, t] of this._transfers) {
            if (t.status === 'done' || t.status === 'error') {
                this._transfers.delete(id);
            }
        }
        this._renderTransfers();
        this._autoHideBall();
    },

    /**
     * 无活跃任务时自动隐藏悬浮球
     */
    _autoHideBall() {
        const hasActive = [...this._transfers.values()].some(t => t.status === 'active');
        const hasAny    = this._transfers.size > 0;
        if (!hasActive && !hasAny) {
            setTimeout(() => {
                if (this._transfers.size === 0) this._hideBall();
            }, 1000);
        }
    },

    /**
     * 渲染传输列表
     */
    _renderTransfers() {
        this._updateBadgeCount();

        const body = document.getElementById('tbPanelBody');
        if (!body) return;

        if (this._transfers.size === 0) {
            body.innerHTML = '<div class="tb-empty">暂无传输任务</div>';
            return;
        }

        let html = '';
        for (const [id, t] of this._transfers) {
            const pct       = t.total > 0 ? Math.min(100, Math.round(t.loaded / t.total * 100)) : 0;
            const isUpload  = t.type === 'upload';
            const icon      = isUpload ? 'fa-arrow-up' : 'fa-arrow-down';
            const iconColor = isUpload ? 'var(--accent-color)' : 'var(--success-color)';
            const shortName = t.name.length > 25 ? t.name.slice(0, 22) + '...' : t.name;

            let statusHtml = '';
            if (t.status === 'active') {
                const speedText  = t.speed > 0 ? this.formatSize(t.speed) + '/s' : '计算中...';
                const remainText = (t.speed > 0 && t.total > t.loaded)
                    ? this._fmtTime((t.total - t.loaded) / t.speed)
                    : '';
                statusHtml = `
                    <div class="tb-item-progress">
                        <div class="tb-bar-wrap">
                            <div class="tb-bar" style="width:${pct}%;background:${iconColor}"></div>
                        </div>
                        <div class="tb-item-stats">
                            <span>${pct}%</span>
                            <span>${speedText}</span>
                            <span>${remainText}</span>
                        </div>
                    </div>`;
            } else if (t.status === 'done') {
                statusHtml = `
                    <div class="tb-item-done">
                        <i class="fas fa-check-circle" style="color:var(--success-color)"></i>
                        已完成 · ${this.formatSize(t.total)}
                    </div>`;
            } else {
                statusHtml = `
                    <div class="tb-item-error">
                        <i class="fas fa-exclamation-circle" style="color:var(--danger-color)"></i>
                        失败${t.message ? ': ' + this.escapeHtml(t.message) : ''}
                    </div>`;
            }

            html += `
                <div class="tb-item ${t.status}" data-id="${id}">
                    <div class="tb-item-header">
                        <i class="fas ${icon}" style="color:${iconColor}"></i>
                        <span class="tb-item-name" title="${this.escapeHtml(t.name)}">
                            ${this.escapeHtml(shortName)}
                        </span>
                        <span class="tb-item-size">${this.formatSize(t.total)}</span>
                    </div>
                    ${statusHtml}
                </div>`;
        }
        body.innerHTML = html;
    },

    _updateBadgeCount() {
        const el    = document.getElementById('tbCount');
        const count = [...this._transfers.values()].filter(t => t.status === 'active').length;
        if (el) {
            el.textContent = count;
            el.style.display = count > 0 ? 'flex' : 'none';
        }
    },

    // ══════════════════════════════════════════
    //  上传（XHR + FormData + 悬浮球进度）
    // ══════════════════════════════════════════

    uploadFile() {
        const input    = document.createElement('input');
        input.type     = 'file';
        input.multiple = true;
        input.onchange = e => this.uploadFileList(Array.from(e.target.files));
        input.click();
    },

    async uploadFileList(files) {
        const sessionId  = this.currentSessionId;
        const state      = this._getState(sessionId);
        const uploadPath = state ? state.currentPath : '/';

        let successCount = 0;
        for (const file of files) {
            const ok = await this._uploadOne(file, sessionId, uploadPath);
            if (ok) successCount++;
        }
        if (successCount > 0 && this.currentSessionId === sessionId) {
            this.refresh();
        }
    },

    _uploadOne(file, sessionId, uploadPath) {
        return new Promise((resolve) => {
            const MAX = 100 * 1024 * 1024 * 1024;
            if (file.size > MAX) {
                App.toast(`❌ ${file.name} 超过 100GB 限制`, 'error');
                resolve(false);
                return;
            }

            const tid = `up-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            this._addTransfer(tid, 'upload', file.name, file.size);

            const formData = new FormData();
            formData.append('file', file);
            formData.append('path', uploadPath);

            const xhr = new XMLHttpRequest();
            xhr.open('POST', `/api/sftp/${sessionId}/upload`, true);
            xhr.timeout = 0;

            const token = App._token;
            if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

            // ✅ 上传进度 → 更新悬浮球
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    this._updateTransfer(tid, e.loaded, e.total);
                }
            };

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        const data = JSON.parse(xhr.responseText);
                        if (data.status === 'ok') {
                            this._completeTransfer(tid, true);
                            resolve(true);
                        } else {
                            this._completeTransfer(tid, false, data.message);
                            resolve(false);
                        }
                    } catch (_) {
                        this._completeTransfer(tid, false, '响应解析失败');
                        resolve(false);
                    }
                } else {
                    let msg = `HTTP ${xhr.status}`;
                    try { msg = JSON.parse(xhr.responseText).message || msg; } catch (_) {}
                    this._completeTransfer(tid, false, msg);
                    resolve(false);
                }
            };

            xhr.onerror   = () => { this._completeTransfer(tid, false, '网络错误'); resolve(false); };
            xhr.ontimeout = () => { this._completeTransfer(tid, false, '上传超时'); resolve(false); };
            xhr.onabort   = () => { this._completeTransfer(tid, false, '已取消');   resolve(false); };

            xhr.send(formData);
        });
    },

    // ══════════════════════════════════════════
    //  下载（XHR + 悬浮球进度）
    // ══════════════════════════════════════════

    downloadFile(file) {
        if (!file) return;
        if (file.is_dir) { App.toast('暂不支持下载文件夹', 'warning'); return; }

        const sessionId = this.currentSessionId;
        const url = `/api/sftp/${sessionId}/download?path=${encodeURIComponent(file.path)}`;

        // 统一使用 XHR + blob 下载（小文件也会携带 JWT 认证头）
        this._downloadWithXHR(url, file.name, file.size);
    },

    _downloadWithXHR(url, filename, fileSize) {
        const tid = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        this._addTransfer(tid, 'download', filename, fileSize);

        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'blob';
        xhr.timeout      = 0;

        const token = App._token;
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

        // ✅ 下载进度 → 更新悬浮球
        xhr.onprogress = (e) => {
            const total = e.lengthComputable ? e.total : (fileSize || 0);
            if (total > 0) this._updateTransfer(tid, e.loaded, total);
        };

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                const blob   = xhr.response;
                const objUrl = URL.createObjectURL(blob);
                const a      = document.createElement('a');
                a.href = objUrl; a.download = filename; a.click();
                setTimeout(() => URL.revokeObjectURL(objUrl), 30000);
                this._completeTransfer(tid, true);
            } else {
                this._completeTransfer(tid, false, `HTTP ${xhr.status}`);
            }
        };

        xhr.onerror   = () => { this._completeTransfer(tid, false, '网络错误'); };
        xhr.ontimeout = () => { this._completeTransfer(tid, false, '下载超时'); };

        xhr.send();
    },

    // ══════════════════════════════════════════
    //  新建文件夹 / 文件
    // ══════════════════════════════════════════

    async createFolder() {
        const sessionId = this.currentSessionId;
        const state     = this._getState(sessionId);
        if (!state) return;
        const name = prompt('请输入文件夹名称:');
        if (!name?.trim()) return;
        const path = this.joinPath(state.currentPath, name.trim());
        try {
            const res = await fetch(`/api/sftp/${sessionId}/mkdir`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...App.authHeaders() },
                body: JSON.stringify({ path })
            });
            const data = await res.json();
            if (data.status === 'ok') {
                App.toast('文件夹创建成功', 'success');
                if (this.currentSessionId === sessionId) this.refresh();
            } else {
                App.toast(data.message || '创建失败', 'error');
            }
        } catch (e) {
            App.toast('创建失败: ' + e.message, 'error');
        }
    },

    async createFile() {
        const sessionId = this.currentSessionId;
        const state     = this._getState(sessionId);
        if (!state) return;
        const name = prompt('请输入文件名:');
        if (!name?.trim()) return;
        const path = this.joinPath(state.currentPath, name.trim());
        try {
            const res = await fetch(`/api/sftp/${sessionId}/write`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...App.authHeaders() },
                body: JSON.stringify({ path, content: '' })
            });
            const data = await res.json();
            if (data.status === 'ok') {
                App.toast('文件创建成功', 'success');
                if (this.currentSessionId === sessionId) this.refresh();
            } else {
                App.toast(data.message || '创建失败', 'error');
            }
        } catch (e) {
            App.toast('创建失败: ' + e.message, 'error');
        }
    },

    // ══════════════════════════════════════════
    //  导航
    // ══════════════════════════════════════════

    goUp() {
        const state = this._getState(this.currentSessionId);
        if (state) this.loadDirectory(this.parentPath(state.currentPath));
    },
    goBack() {
        const state = this._getState(this.currentSessionId);
        if (!state || state.historyIndex <= 0) return;
        state.historyIndex--;
        this._loadNoHistory(this.currentSessionId, state.history[state.historyIndex]);
    },
    goForward() {
        const state = this._getState(this.currentSessionId);
        if (!state || state.historyIndex >= state.history.length - 1) return;
        state.historyIndex++;
        this._loadNoHistory(this.currentSessionId, state.history[state.historyIndex]);
    },
    refresh() {
        const state = this._getState(this.currentSessionId);
        if (state) this._loadNoHistory(this.currentSessionId, state.currentPath);
    },
    goToPath(inputEl) {
        const path = inputEl.value.trim();
        if (path) this.loadDirectory(path);
    },

    async _loadNoHistory(sessionId, path) {
        if (!sessionId) return;
        const state = this._getState(sessionId);
        if (!state) return;
        path = this.normalizePath(path);
        try {
            const res  = await fetch(
                `/api/sftp/${sessionId}/list?path=${encodeURIComponent(path)}`,
                { headers: App.authHeaders() }
            );
            const data = await res.json();
            if (this.currentSessionId !== sessionId) return;
            if (data.status === 'ok') {
                state.currentPath  = this.normalizePath(data.path || path);
                state.currentFiles = data.data || [];
                this._renderFiles(sessionId, state);
                this._updatePathInput(sessionId, state.currentPath);
            } else {
                const isPermError = res.status === 403 || (data.message && data.message.includes('权限不足'));
                if (isPermError) {
                    state.currentFiles = [];
                    this._renderFiles(sessionId, state);
                    this._updatePathInput(sessionId, path);
                }
                App.toast(data.message || '加载失败', 'error');
            }
        } catch (e) {
            if (this.currentSessionId === sessionId)
                App.toast('加载失败: ' + e.message, 'error');
        }
    },

    // ══════════════════════════════════════════
    //  右键菜单
    // ══════════════════════════════════════════

    showContextMenu(event, index) {
        event.preventDefault();
        event.stopPropagation();
        this._onSelectFile(index);

        const state = this._getState(this.currentSessionId);
        if (!state) return;
        const file = state.currentFiles[index];
        if (!file) return;

        this.hideContextMenu();
        const menu = document.createElement('div');
        menu.className = 'fm-context-menu';
        menu.id = 'fmContextMenu';
        menu.style.cssText = `display:block;left:${event.clientX}px;top:${event.clientY}px`;

        let items = '';
        if (file.is_dir) {
            items += `<div class="fm-context-item" onclick="FileManager._onDoubleClick(${index});FileManager.hideContextMenu()">
                <i class="fas fa-folder-open"></i>打开</div>`;
            items += `<div class="fm-context-item highlight" onclick="FileManager.openTerminalHere(${index});FileManager.hideContextMenu()">
                <i class="fas fa-terminal"></i>在终端中打开</div>`;
        } else {
            items += `<div class="fm-context-item" onclick="FileManager._getAndOpen(${index});FileManager.hideContextMenu()">
                <i class="fas fa-edit"></i>编辑</div>`;
            items += `<div class="fm-context-item" onclick="FileManager._getAndDownload(${index});FileManager.hideContextMenu()">
                <i class="fas fa-download"></i>下载</div>`;
        }
        items += `<div class="fm-context-separator"></div>`;
        items += `<div class="fm-context-item" onclick="FileManager._getAndRename(${index});FileManager.hideContextMenu()">
            <i class="fas fa-pen"></i>重命名</div>`;
        items += `<div class="fm-context-item" onclick="FileManager._getAndChmod(${index});FileManager.hideContextMenu()">
            <i class="fas fa-shield-alt"></i>修改权限</div>`;
        items += `<div class="fm-context-separator"></div>`;
        items += `<div class="fm-context-item danger" onclick="FileManager._getAndDelete(${index});FileManager.hideContextMenu()">
            <i class="fas fa-trash"></i>删除</div>`;

        menu.innerHTML = items;
        document.body.appendChild(menu);

        requestAnimationFrame(() => {
            const rect = menu.getBoundingClientRect();
            if (rect.right > window.innerWidth) menu.style.left = (event.clientX - rect.width) + 'px';
            if (rect.bottom > window.innerHeight) menu.style.top = (event.clientY - rect.height) + 'px';
        });

        setTimeout(() => {
            document.addEventListener('click', FileManager.hideContextMenu, { once: true });
            document.addEventListener('contextmenu', FileManager.hideContextMenu, { once: true });
        }, 0);
    },
    openTerminalHere(index) {
        const state = this._getState(this.currentSessionId);
        if (!state) return;
        const file = state.currentFiles[index];
        if (!file || !file.is_dir) return;
        const sessionId = this.currentSessionId;
        App.openTerminalAtPath(sessionId, file.path);
    },
    hideContextMenu() {
        document.getElementById('fmContextMenu')?.remove();
    },

    _getFile(i) {
        const s = this._getState(this.currentSessionId);
        return s ? s.currentFiles[i] : null;
    },
    _getAndOpen(i)     { const f = this._getFile(i); if (f) this.openFile(f); },
    _getAndDownload(i) { const f = this._getFile(i); if (f) this.downloadFile(f); },
    _getAndRename(i)   { const f = this._getFile(i); if (f) this.renameFile(f); },
    _getAndChmod(i)    { const f = this._getFile(i); if (f) this.chmodFile(f); },
    _getAndDelete(i)   { const f = this._getFile(i); if (f) this.deleteFile(f); },

    // ══════════════════════════════════════════
    //  工具
    // ══════════════════════════════════════════

    _fmtTime(seconds) {
        if (seconds < 1)    return '即将完成';
        if (seconds < 60)   return `${Math.ceil(seconds)}秒`;
        if (seconds < 3600) return `${Math.ceil(seconds / 60)}分钟`;
        return `${(seconds / 3600).toFixed(1)}小时`;
    },

    getFileIcon(file) {
        if (file.is_dir)  return 'fas fa-folder';
        if (file.is_link) return 'fas fa-link';
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        const m = {
            // 代码文件
            js:'fab fa-js-square', ts:'fab fa-js-square', jsx:'fab fa-react',
            tsx:'fab fa-react', py:'fab fa-python', java:'fab fa-java',
            go:'fab fa-golang', rs:'fas fa-cog', rb:'fas fa-gem',
            php:'fab fa-php', 
            // 前端
            html:'fab fa-html5', htm:'fab fa-html5',
            css:'fab fa-css3-alt', scss:'fab fa-css3-alt', less:'fab fa-css3-alt',
            vue:'fab fa-vuejs', svelte:'fas fa-bolt',
            // 配置文件
            json:'fas fa-file-code', xml:'fas fa-file-code',
            yaml:'fas fa-file-code', yml:'fas fa-file-code',
            conf:'fas fa-cog', ini:'fas fa-cog', toml:'fas fa-cog',
            env:'fas fa-cog', 
            // 脚本
            sh:'fas fa-terminal', bash:'fas fa-terminal', zsh:'fas fa-terminal',
            // 文档
            md:'fas fa-file-alt', txt:'fas fa-file-alt', log:'fas fa-file-alt',
            // 压缩包
            zip:'fas fa-file-archive', tar:'fas fa-file-archive',
            gz:'fas fa-file-archive', rar:'fas fa-file-archive', '7z':'fas fa-file-archive',
            // 图片
            jpg:'fas fa-file-image', jpeg:'fas fa-file-image',
            png:'fas fa-file-image', gif:'fas fa-file-image',
            svg:'fas fa-file-image', webp:'fas fa-file-image',
            // 办公文档
            pdf:'fas fa-file-pdf',
            doc:'fas fa-file-word', docx:'fas fa-file-word',
            xls:'fas fa-file-excel', xlsx:'fas fa-file-excel',
            ppt:'fas fa-file-powerpoint', pptx:'fas fa-file-powerpoint',
            // 数据库
            sql:'fas fa-database', db:'fas fa-database', sqlite:'fas fa-database',
            // 证书
            key:'fas fa-key', pem:'fas fa-key',
            crt:'fas fa-certificate', cer:'fas fa-certificate',
            // 音频视频
            mp3:'fas fa-music', mp4:'fas fa-video', avi:'fas fa-video',
            mov:'fas fa-video', mkv:'fas fa-video', flac:'fas fa-music'
        };
        return m[ext] || 'fas fa-file';
    },

    formatSize(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        const u = ['B','KB','MB','GB','TB'];
        const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), u.length - 1);
        return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + ' ' + u[i];
    },

    escapeHtml(text) {
        if (text == null) return '';
        const d = document.createElement('div');
        d.textContent = String(text);
        return d.innerHTML;
    },
};

window.FileManager = FileManager;