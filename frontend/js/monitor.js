/**
 * 系统监控管理器 - 修复版
 * ✅ 修复每次刷新都重建 Chart 导致内存泄漏
 * ✅ 修复 monitor API 缺少 JWT header
 * ✅ 图表实例复用，只更新数据
 */
class Monitor {
    static timers      = {};
    static charts      = {};   // key: `${sessionId}_cpu` 等
    static historyData = {};

    static start(sessionId) {
        // 如果已有历史数据（之前被 pause 或后台运行），立即更新 + 恢复轮询
        if (this.historyData[sessionId]) {
            this.fetchData(sessionId); // 立即刷新（让切回监控 tab 的图表秒显）
            if (!this.timers[sessionId]) {
                this.timers[sessionId] = setInterval(() => this.fetchData(sessionId), 3000);
            }
            return;
        }

        // 首次启动：初始化空数据
        this.historyData[sessionId] = {
            cpu:           [],
            memory:        [],
            timestamps:    [],
            networkRx:     [],
            networkTx:     [],
            lastNetworkRx: 0,
            lastNetworkTx: 0,
        };

        this.fetchData(sessionId);
        this.timers[sessionId] = setInterval(() => {
            this.fetchData(sessionId);
        }, 3000);
    }

    // 暂停轮询（保留 charts / historyData / canvas DOM，切回时秒恢复）
    static stop(sessionId) {
        if (this.timers[sessionId]) {
            clearInterval(this.timers[sessionId]);
            delete this.timers[sessionId];
        }
    }

    // 彻底销毁（关闭会话 / 断开全部连接时使用）
    static destroy(sessionId) {
        this.stop(sessionId);
        for (const key of Object.keys(this.charts)) {
            if (key.startsWith(sessionId + '_')) {
                try {
                    const chart = this.charts[key];
                    if (chart) {
                        chart.stop();
                        if (chart.canvas) chart.canvas.remove();
                        chart.destroy();
                    }
                } catch (_) {}
                delete this.charts[key];
            }
        }
        delete this.historyData[sessionId];
    }

    static async fetchData(sessionId) {
        try {
            // ✅ 携带 JWT header
            const res  = await fetch(`/api/monitor/${sessionId}`, {
                headers: App.authHeaders()
            });
            // 🔧 会话已不存在（404），停止轮询避免无限请求
            if (res.status === 404) {
                console.warn(`[Monitor] 会话 ${sessionId} 已不存在，停止监控轮询`);
                this.stop(sessionId);
                delete this.historyData[sessionId];
                return;
            }
            const data = await res.json();
            if (data.status === 'ok') {
                this.updateUI(sessionId, data.data);
            }
        } catch (e) {
            // 🔧 fetch 失败（网络错误/服务器不可达），单次静默跳过但不清除数据
            // 服务器恢复后轮询会自动恢复
            if (e.name === 'TypeError' && e.message === 'Failed to fetch') {
                // 网络不可达，不打印日志（避免刷屏）
                return;
            }
            console.error('[Monitor] 获取数据失败:', e);
        }
    }

    static updateUI(sessionId, info) {
        const history = this.historyData[sessionId];
        if (!history) return;

        // ✅ 数据始终收集（即使 tab 隐藏，切换回来也有完整历史曲线）
        const now = new Date().toLocaleTimeString();
        history.timestamps.push(now);
        history.cpu.push(info.cpu_percent || 0);
        history.memory.push(info.memory?.percent || 0);

        let rxRate = 0, txRate = 0;
        if (history.lastNetworkRx > 0 && info.network) {
            rxRate = Math.max(0, (info.network.rx_bytes - history.lastNetworkRx) / 3);
            txRate = Math.max(0, (info.network.tx_bytes - history.lastNetworkTx) / 3);
        }
        if (info.network) {
            history.lastNetworkRx = info.network.rx_bytes;
            history.lastNetworkTx = info.network.tx_bytes;
        }
        history.networkRx.push(rxRate);
        history.networkTx.push(txRate);

        // 最多保留 1200 个点（3s * 1200 = 3600s = 1小时），自动滚动清理
        const MAX = 1200;
        if (history.timestamps.length > MAX) {
            history.timestamps.shift();
            history.cpu.shift();
            history.memory.shift();
            history.networkRx.shift();
            history.networkTx.shift();
        }

        // tab 隐藏时跳过 DOM 更新（offsetParent 为 null 表示 display:none）
        const container = document.querySelector(`#panel-${sessionId} .system-monitor`);
        if (!container || container.offsetParent === null) return;

        const cpuLevel  = info.cpu_percent > 80 ? 'high'   : info.cpu_percent > 50  ? 'medium' : 'low';
        const memLevel  = (info.memory?.percent||0) > 80 ? 'high' : (info.memory?.percent||0) > 50 ? 'medium' : 'low';
        const diskLevel = (info.disk?.percent||0)   > 80 ? 'high' : (info.disk?.percent||0)   > 50 ? 'medium' : 'low';

        // ✅ 只在首次渲染时写 innerHTML，后续只更新数值
        const firstRender = !document.getElementById(`cpuChart-${sessionId}`);

        if (firstRender) {
            container.innerHTML = this._buildHTML(sessionId, info, cpuLevel, memLevel, diskLevel, rxRate, txRate);
            this._initCharts(sessionId, history);
        } else {
            this._updateValues(sessionId, info, cpuLevel, memLevel, diskLevel, rxRate, txRate);
            this._updateCharts(sessionId, history);
        }
    }

    static _buildHTML(sessionId, info, cpuLevel, memLevel, diskLevel, rxRate, txRate) {
        return `
            <div class="monitor-header">
                <h3><i class="fas fa-chart-line"></i> 系统监控</h3>
                <div class="monitor-info" id="monitorUptime-${sessionId}">
                    每3秒更新 | ${info.uptime || ''}
                </div>
            </div>
            <div class="monitor-grid">
                <!-- CPU -->
                <div class="monitor-card">
                    <div class="monitor-card-header">
                        <h4><i class="fas fa-microchip"></i> CPU</h4>
                        <div class="monitor-value" id="cpuValue-${sessionId}">${info.cpu_percent||0}%</div>
                    </div>
                    <div class="monitor-chart-container">
                        <canvas id="cpuChart-${sessionId}"></canvas>
                    </div>
                    <div class="monitor-progress">
                        <div class="monitor-progress-bar ${cpuLevel}" id="cpuBar-${sessionId}"
                             style="width:${info.cpu_percent||0}%"></div>
                    </div>
                    <div class="monitor-details">
                        <div class="monitor-detail-item">
                            <span class="monitor-detail-label">核心数</span>
                            <span class="monitor-detail-value">${info.cpu_cores||'-'}</span>
                        </div>
                        <div class="monitor-detail-item">
                            <span class="monitor-detail-label">进程数</span>
                            <span class="monitor-detail-value" id="procCount-${sessionId}">${info.process_count||'-'}</span>
                        </div>
                        <div class="monitor-detail-item">
                            <span class="monitor-detail-label">负载(1m)</span>
                            <span class="monitor-detail-value" id="load1-${sessionId}">${info.load?.load1||'-'}</span>
                        </div>
                        <div class="monitor-detail-item">
                            <span class="monitor-detail-label">负载(5m)</span>
                            <span class="monitor-detail-value" id="load5-${sessionId}">${info.load?.load5||'-'}</span>
                        </div>
                    </div>
                </div>
                <!-- 内存 -->
                <div class="monitor-card">
                    <div class="monitor-card-header">
                        <h4><i class="fas fa-memory"></i> 内存</h4>
                        <div class="monitor-value" id="memValue-${sessionId}">${info.memory?.percent||0}%</div>
                    </div>
                    <div class="monitor-chart-container">
                        <canvas id="memChart-${sessionId}"></canvas>
                    </div>
                    <div class="monitor-progress">
                        <div class="monitor-progress-bar ${memLevel}" id="memBar-${sessionId}"
                             style="width:${info.memory?.percent||0}%"></div>
                    </div>
                    <div class="monitor-details">
                        <div class="monitor-detail-item">
                            <span class="monitor-detail-label">总计</span>
                            <span class="monitor-detail-value">${this.formatBytes(info.memory?.total)}</span>
                        </div>
                        <div class="monitor-detail-item">
                            <span class="monitor-detail-label">已用</span>
                            <span class="monitor-detail-value" id="memUsed-${sessionId}">${this.formatBytes(info.memory?.used)}</span>
                        </div>
                    </div>
                </div>
                <!-- 磁盘 -->
                <div class="monitor-card">
                    <div class="monitor-card-header">
                        <h4><i class="fas fa-hdd"></i> 磁盘 (/)</h4>
                        <div class="monitor-value" id="diskValue-${sessionId}">${info.disk?.percent||0}%</div>
                    </div>
                    <div class="monitor-progress" style="margin-top:40px">
                        <div class="monitor-progress-bar ${diskLevel}" id="diskBar-${sessionId}"
                             style="width:${info.disk?.percent||0}%"></div>
                    </div>
                    <div class="monitor-details">
                        <div class="monitor-detail-item">
                            <span class="monitor-detail-label">总计</span>
                            <span class="monitor-detail-value">${this.formatBytes(info.disk?.total)}</span>
                        </div>
                        <div class="monitor-detail-item">
                            <span class="monitor-detail-label">已用</span>
                            <span class="monitor-detail-value" id="diskUsed-${sessionId}">${this.formatBytes(info.disk?.used)}</span>
                        </div>
                    </div>
                </div>
                <!-- 网络 -->
                <div class="monitor-card">
                    <div class="monitor-card-header">
                        <h4><i class="fas fa-network-wired"></i> 网络</h4>
                    </div>
                    <div class="monitor-chart-container">
                        <canvas id="netChart-${sessionId}"></canvas>
                    </div>
                    <div class="monitor-details">
                        <div class="monitor-detail-item">
                            <span class="monitor-detail-label">↓ 接收</span>
                            <span class="monitor-detail-value" id="rxRate-${sessionId}">${this.formatBytes(rxRate)}/s</span>
                        </div>
                        <div class="monitor-detail-item">
                            <span class="monitor-detail-label">↑ 发送</span>
                            <span class="monitor-detail-value" id="txRate-${sessionId}">${this.formatBytes(txRate)}/s</span>
                        </div>
                    </div>
                </div>
            </div>
            <div class="monitor-sys-info">
                <h4><i class="fas fa-info-circle"></i> 系统信息</h4>
                <div class="sys-info-grid">
                    <div class="sys-info-item">
                        <i class="fas fa-server"></i>
                        <span class="label">系统</span>
                        <span class="value">${info.system||'-'}</span>
                    </div>
                    <div class="sys-info-item">
                        <i class="fas fa-clock"></i>
                        <span class="label">运行时间</span>
                        <span class="value" id="sysUptime-${sessionId}">${info.uptime||'-'}</span>
                    </div>
                    <div class="sys-info-item">
                        <i class="fas fa-tachometer-alt"></i>
                        <span class="label">负载</span>
                        <span class="value" id="sysLoad-${sessionId}">
                            ${info.load?.load1||0} / ${info.load?.load5||0} / ${info.load?.load15||0}
                        </span>
                    </div>
                </div>
            </div>
        `;
    }

    static _updateValues(sessionId, info, cpuLevel, memLevel, diskLevel, rxRate, txRate) {
        const set = (id, val) => {
            const el = document.getElementById(`${id}-${sessionId}`);
            if (el) el.textContent = val;
        };
        const setStyle = (id, style, val) => {
            const el = document.getElementById(`${id}-${sessionId}`);
            if (el) el.style[style] = val;
        };
        const setClass = (id, cls) => {
            const el = document.getElementById(`${id}-${sessionId}`);
            if (el) {
                el.className = el.className.replace(/\b(low|medium|high)\b/, '');
                el.classList.add(cls);
            }
        };

        set('cpuValue',  `${info.cpu_percent||0}%`);
        set('memValue',  `${info.memory?.percent||0}%`);
        set('diskValue', `${info.disk?.percent||0}%`);
        set('procCount', info.process_count||'-');
        set('load1',     info.load?.load1||'-');
        set('load5',     info.load?.load5||'-');
        set('memUsed',   this.formatBytes(info.memory?.used));
        set('diskUsed',  this.formatBytes(info.disk?.used));
        set('rxRate',    `${this.formatBytes(rxRate)}/s`);
        set('txRate',    `${this.formatBytes(txRate)}/s`);
        set('sysUptime', info.uptime||'-');
        set('sysLoad',   `${info.load?.load1||0} / ${info.load?.load5||0} / ${info.load?.load15||0}`);

        setStyle('cpuBar',  'width', `${info.cpu_percent||0}%`);
        setStyle('memBar',  'width', `${info.memory?.percent||0}%`);
        setStyle('diskBar', 'width', `${info.disk?.percent||0}%`);
        setClass('cpuBar',  cpuLevel);
        setClass('memBar',  memLevel);
        setClass('diskBar', diskLevel);
    }

    // ✅ 初始化图表（只调用一次）
    static _initCharts(sessionId, history) {
        const cpuColor    = this._getCssVar('--chart-cpu');
        const cpuBg       = this._getCssVar('--chart-cpu-bg');
        const memColor    = this._getCssVar('--chart-mem');
        const memBg       = this._getCssVar('--chart-mem-bg');
        const netRxColor  = this._getCssVar('--chart-net-rx');
        const netRxBg     = this._getCssVar('--chart-net-rx-bg');
        const netTxColor  = this._getCssVar('--chart-net-tx');
        const netTxBg     = this._getCssVar('--chart-net-tx-bg');
        const gridColor   = 'rgba(107,114,128,0.1)';
        const tickColor   = '#6b7280';

        const baseOpts = {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 200 },
            plugins: { legend: { display: false } },
            elements: {
                point: { radius: 0 },
                line:  { tension: 0.4, borderWidth: 2 }
            },
            scales: {
                x: { display: false },
                y: {
                    min: 0, max: 100,
                    ticks: { color: tickColor, font: { size: 10 }, callback: v => v + '%' },
                    grid:  { color: gridColor }
                }
            }
        };

        const cpuCanvas = document.getElementById(`cpuChart-${sessionId}`);
        if (cpuCanvas) {
            this.charts[`${sessionId}_cpu`] = new Chart(cpuCanvas.getContext('2d'), {
                type: 'line',
                data: {
                    labels:   history.timestamps,
                    datasets: [{ data: history.cpu, borderColor: cpuColor,
                                backgroundColor: cpuBg, fill: true }]
                },
                options: baseOpts
            });
        }

        const memCanvas = document.getElementById(`memChart-${sessionId}`);
        if (memCanvas) {
            this.charts[`${sessionId}_mem`] = new Chart(memCanvas.getContext('2d'), {
                type: 'line',
                data: {
                    labels:   history.timestamps,
                    datasets: [{ data: history.memory, borderColor: memColor,
                                backgroundColor: memBg, fill: true }]
                },
                options: baseOpts
            });
        }

        const netCanvas = document.getElementById(`netChart-${sessionId}`);
        if (netCanvas) {
            const netOpts = JSON.parse(JSON.stringify(baseOpts));
            netOpts.plugins.legend.display = true;
            netOpts.plugins.legend.labels  = { color: tickColor, font: { size: 10 }, boxWidth: 12 };
            netOpts.scales.y.max           = undefined;
            netOpts.scales.y.ticks         = {
                color: tickColor, font: { size: 10 },
                callback: v => Monitor.formatBytes(v) + '/s'
            };
            this.charts[`${sessionId}_net`] = new Chart(netCanvas.getContext('2d'), {
                type: 'line',
                data: {
                    labels:   history.timestamps,
                    datasets: [
                        { label: '接收', data: history.networkRx,
                        borderColor: netRxColor, backgroundColor: netRxBg, fill: true },
                        { label: '发送', data: history.networkTx,
                        borderColor: netTxColor, backgroundColor: netTxBg, fill: true }
                    ]
                },
                options: netOpts
            });
        }
    }

    // 容器从隐藏变为可见后矫正 chart 尺寸
    static resize(sessionId) {
        for (const key of Object.keys(this.charts)) {
            if (key.startsWith(sessionId + '_')) {
                try { this.charts[key].resize(); } catch (_) {}
            }
        }
    }

    // ✅ 更新图表数据（不重建）
    static _updateCharts(sessionId, history) {
        const keys = ['cpu', 'mem', 'net'];
        const dataMap = {
            cpu: [history.cpu],
            mem: [history.memory],
            net: [history.networkRx, history.networkTx]
        };

        for (const key of keys) {
            const chart = this.charts[`${sessionId}_${key}`];
            if (!chart) continue;
            chart.data.labels = history.timestamps;
            dataMap[key].forEach((arr, i) => {
                if (chart.data.datasets[i]) {
                    chart.data.datasets[i].data = arr;
                }
            });
            chart.update('none');  // 'none' = 不执行动画，性能更好
        }
    }

    static formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        const k     = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i     = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }
    static _getCssVar(name) {
        return getComputedStyle(document.documentElement)
            .getPropertyValue(name).trim();
    }

}

window.Monitor = Monitor;