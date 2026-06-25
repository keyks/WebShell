# WebTerminal · Web SSH 运维管理平台

基于 Web 的远程 SSH 终端与服务器运维管理平台，提供浏览器端终端访问、文件管理、集群运维、AI 智能诊断等一站式能力。

---

## 目录

- [功能特性](#功能特性)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [配置参考](#配置参考)
- [项目结构](#项目结构)
- [API 参考](#api-参考)
- [WebSocket 事件](#websocket-事件)
- [部署建议](#部署建议)
- [安全说明](#安全说明)
- [许可证](#许可证)

---

## 功能特性

### SSH 终端

| 能力 | 说明 |
|------|------|
| 终端模拟 | 基于 xterm.js + WebSocket，支持 256 色、光标控制、全键盘交互 |
| 多标签分屏 | 多个 SSH 会话以标签页管理，支持终端面板横向/纵向分屏 |
| 双认证模式 | 密码认证 + 私钥认证（RSA/Ed25519/ECDSA），SSH 代理跳转 |
| 窗口自适应 | 终端尺寸随浏览器窗口自动调整，xterm-addon-fit 实时同步 |
| 会话恢复 | SSH 断开后自动重建连接，恢复终端状态快照 |
| 录制回放 | 终端操作全程录制，支持按时间线回放追溯 |

### 连接管理

| 能力 | 说明 |
|------|------|
| 连接 CRUD | SSH 连接配置的新增、编辑、删除，支持分组归类 |
| 加密存储 | 密码使用 Fernet 对称加密后存入 SQLite |
| 连接测试 | TCP 端口连通性检测，即时反馈可达性 |
| 快速连接 | 基于历史记录的快速重连，支持搜索过滤 |
| 导入/导出 | 连接配置支持 JSON 批量导入导出 |

### 文件管理（SFTP）

| 能力 | 说明 |
|------|------|
| 可视化浏览 | 树形目录浏览、文件类型图标、排序与筛选 |
| 上传下载 | 流式传输，支持 100GB 大文件，MD5 完整性校验 |
| 在线编辑 | 文本文件直接编辑并回写远端，编码自动检测 |
| 文件操作 | 新建/删除/重命名/权限修改，迭代删除防栈溢出 |
| 拖拽上传 | 拖拽文件到终端窗口即可上传到当前目录 |
| 路径安全 | 路径遍历攻击防护，禁止访问 `/etc/shadow` 等敏感文件 |

### 系统监控

| 能力 | 说明 |
|------|------|
| 实时图表 | CPU / 内存 / 磁盘 / 网络四维实时曲线（Chart.js） |
| 进程监控 | Top 进程列表，CPU/内存占用排序 |
| 系统信息 | 内核版本、运行时间、发行版信息采集 |
| 告警引擎 | 自定义阈值告警（CPU >90%、磁盘 >85% 等），冷却时间可配 |
| 进程守护 | 指定进程存活监控，异常退出自动告警 |

### 集群运维

| 能力 | 说明 |
|------|------|
| 节点管理 | 按分组/连接筛选节点列表，健康状态一目了然 |
| 批量命令 | 向多台服务器并发下发命令，支持延时执行、分批策略、失败重试 |
| 任务调度 | 任务并发数可配，实时进度跟踪，支持中途取消 |
| 文件分发 | 一次上传同步分发至多节点，覆盖/跳过/备份三种策略 |
| 分发校验 | MD5 完整性校验，确保分发数据一致 |

### 系统巡检

| 能力 | 说明 |
|------|------|
| 自动巡检 | 一键检查集群节点健康状态（CPU/内存/磁盘/服务/网络） |
| 报告生成 | 巡检结果生成结构化报告，支持导出为 Excel 文件 |
| 批量执行 | 支持同时对多个节点执行巡检，并发数可控 |
| 超时保护 | 单节点最长 300 秒，避免巡检阻塞系统 |

### 告警管理

| 能力 | 说明 |
|------|------|
| 多渠道通知 | 页面 Toast + 通知中心 + 浏览器桌面通知 |
| 告警确认 | 逐条确认/全部清除，区分已处理/未处理 |
| 冷却机制 | 同一告警在冷却时间内不重复推送（默认 300 秒） |
| 节点标记 | 告警直接在连接树节点上显示红色标记 |

### AI 智能运维

| 能力 | 说明 |
|------|------|
| 智能对话 | 多轮交互式 AI 助手，上下文持久化，支持按日期/关键词搜索历史 |
| 命令分析 | 实时分析 Linux 命令风险等级（safe/low/medium/high/critical） |
| 命令解释 | AI 解释命令功能、参数含义、风险提示和使用建议 |
| 系统诊断 | 自动采集服务器运行信息，AI 生成综合诊断报告 |
| 容量预测 | 基于资源历史趋势，预测容量瓶颈并给出扩容建议 |
| 安全扫描 | AI 分析已安装软件包、开放端口、系统配置等安全隐患 |
| 知识库 | 运维知识条目的 CRUD，支持 AI 自动生成知识内容 |
| 服务拓扑 | AI 分析服务依赖关系，生成 Mermaid 可视化拓扑图 |
| 集群摘要 | AI 汇总集群节点健康状态与异常摘要 |
| 悬浮助手 | 全局智能助手悬浮窗，所有页面均可唤出 |

### 安全机制

| 机制 | 说明 |
|------|------|
| JWT 认证 | Token 登录 + 黑名单机制，Cookie HttpOnly |
| 登录限流 | 密码错误次数限制（默认 5 次），锁定时间可配 |
| 命令风险分析 | 五级风险评级，critical 直接拦截，high 需二次确认 |
| 审计日志 | 全链路操作审计记录，支持按时间/操作类型查询 |
| 加密存储 | Fernet 对称加密保护 SSH 密码和 AI API Key |
| DoS 防护 | 终端累计输出上限（50MB）、单条命令长度限制（100KB） |

### 用户体验

| 功能 | 说明 |
|------|------|
| 运维控制台 | Dashboard 仪表盘，总览连接数、活跃会话、告警、最近操作 |
| 屏保介绍页 | 空闲 5 分钟自动展示产品功能轮播（3 组 X 3 卡片） |
| 命令面板 | Ctrl+Shift+P 快速搜索执行任意功能 |
| 快捷命令 | 常用命令预设 CRUD，终端内一键发送执行 |
| 多主题 | 明亮/暗黑双主题，字号自由调节 |
| 响应式布局 | 工具栏文字在窄窗口渐进隐藏，hover 显示完整标题 |

---

## 技术栈

### 后端

| 组件 | 技术 | 版本 |
|------|------|------|
| Web 框架 | Flask | 3.0 |
| 实时通信 | Flask-SocketIO + Eventlet | 5.3 / 0.35 |
| SSH 协议 | Paramiko | 3.4 |
| 身份认证 | Flask-JWT-Extended | 4.6 |
| 加密引擎 | cryptography (Fernet) | 41.0 |
| 数据库 | SQLite | — |
| AI 接口 | OpenAI 兼容 (Groq / DeepSeek) | ≥1.0 |
| Excel 导出 | openpyxl | 3.1 |
| 系统监控 | psutil | 5.9 |
| 环境管理 | python-dotenv | 1.0 |
| 反向代理 | Nginx（app.py 自动管理） | 1.24+ |

### 前端

| 组件 | 技术 |
|------|------|
| 终端模拟 | xterm.js + addon-fit + addon-web-links |
| 实时通信 | Socket.IO Client |
| 数据可视化 | Chart.js |
| 图标 | Font Awesome 6 |
| 架构 | 原生 JavaScript SPA（零框架依赖） |

---

## 快速开始

### 环境要求

- Python 3.9+
- pip
- （可选）Nginx 1.24+，用于反向代理

### 安装

```bash
# 克隆项目
git clone <your-repo-url>
cd WebTerminal

# 安装 Python 依赖
pip install -r backend/requirements.txt
```

### 最小配置

在 `backend/.env` 中至少配置：

```bash
# 数据存储目录（Windows 建议显式指定）
DATA_DIR=C:\Users\YOUR_USER\.webterminal

# 管理员账号
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your_secure_password

# 服务器监听
HOST=127.0.0.1
PORT=8082
```

> 首次运行未设置管理员密码时，系统会在控制台打印自动生成的随机密码，请务必保存。

### 运行

```bash
cd backend
python app.py
```

- **不启用 Nginx**：访问 `http://localhost:8082`
- **启用 Nginx**：访问 `http://localhost:8088`（Nginx 由 app.py 自动管理启停）

---

## 配置参考

详见 `backend/.env`，完整配置项：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `DATA_DIR` | `~/.webterminal` | 数据存储目录 |
| `ADMIN_USERNAME` | `admin` | 管理员用户名 |
| `ADMIN_PASSWORD` | 自动生成 | 管理员密码 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `5000` | 监听端口 |
| `DEBUG` | `false` | 调试模式 |
| `SSH_CONNECT_TIMEOUT` | `30` | SSH 连接超时（秒） |
| `SSH_BANNER_TIMEOUT` | `20` | SSH Banner 超时（秒） |
| `SSH_AUTH_TIMEOUT` | `30` | SSH 认证超时（秒） |
| `MAX_SESSIONS` | `50` | 最大并发会话数 |
| `SESSION_IDLE_TIMEOUT` | `0` | 会话空闲超时（0=不超时） |
| `MAX_EDIT_FILE_SIZE` | `2MB` | 在线编辑文件大小上限 |
| `MAX_UPLOAD_SIZE` | `500MB` | 上传文件大小上限 |
| `MAX_CONCURRENT_DOWNLOADS` | `10` | 并发下载数上限 |
| `MAX_TERMINAL_OUTPUT_BYTES` | `50MB` | 单终端累计输出上限 |
| `MAX_COMMAND_LENGTH` | `100KB` | 单条命令最大长度 |
| `JWT_ACCESS_TOKEN_EXPIRES_HOURS` | `8` | JWT 有效期（小时） |
| `LOGIN_MAX_ATTEMPTS` | `5` | 登录最大尝试次数 |
| `LOGIN_LOCKOUT_SECS` | `300` | 登录锁定时间（秒） |
| `ALERT_CHECK_INTERVAL` | `30` | 告警检测间隔（秒） |
| `ALERT_COOLDOWN` | `300` | 告警冷却时间（秒） |
| `INSPECTION_TIMEOUT` | `300` | 巡检超时（秒） |
| `DISTRIBUTE_MAX_CONCURRENT` | `10` | 分发最大并发数 |
| `ENABLE_RECORDING` | `false` | 启用会话录制 |
| `QUICK_CONNECT_HISTORY_MAX` | `20` | 快速连接历史上限 |
| `AI_ENABLED` | `true` | 启用 AI 功能 |
| `GROQ_API_KEY` | — | Groq API Key |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | AI 模型 |
| `NGINX_ENABLED` | `false` | 启用 Nginx 反向代理 |
| `NGINX_PATH` | — | Nginx 安装路径 |
| `NGINX_PORT` | `8088` | Nginx 监听端口 |
| `SECRET_KEY` | 自动生成 | Flask 密钥 |
| `JWT_SECRET_KEY` | 自动生成 | JWT 签名密钥 |
| `ENCRYPTION_KEY` | 自动生成 | 数据加密密钥 |

---

## 项目结构

```
WebTerminal/
├── backend/
│   ├── app.py                    # 主入口：Flask 路由 + SocketIO 事件 + Nginx 管理
│   ├── config.py                 # 全局配置（环境变量/密钥/路径）
│   ├── core.py                   # 核心依赖实例化
│   ├── database.py               # SQLite 数据库 CRUD + 加密层
│   ├── ssh_manager.py            # SSH 连接池与多会话管理
│   ├── sftp_manager.py           # SFTP 文件操作管理器
│   ├── ai_engine.py              # AI 运维引擎（对话/分析/知识库）
│   ├── ai_config.py              # AI 配置持久化（API Key 加密）
│   ├── diagnose.py               # AI 系统诊断引擎（异步）
│   ├── alert_engine.py           # 监控告警引擎
│   ├── inspection.py             # 集群巡检 + Excel 报告生成
│   ├── cluster_scheduler.py      # 集群批量任务并发调度
│   ├── file_distributor.py       # 批量文件分发引擎
│   ├── session_recorder.py       # 终端会话录制与回放
│   ├── session_recovery.py       # 会话快照与自动恢复
│   ├── logger.py                 # 日志模块（含审计日志）
│   ├── _groq_worker.py           # Groq API 独立子进程 Worker
│   ├── .env                      # 环境变量配置
│   ├── requirements.txt          # Python 依赖
│   └── logs/                     # 运行日志目录
│
├── frontend/
│   ├── index.html                # SPA 主页面
│   ├── favicon.svg               # 网站图标
│   ├── css/
│   │   └── style.css             # 全局样式（CSS 变量主题体系）
│   ├── js/
│   │   ├── app.js                # 核心应用逻辑 + 仪表盘 + 介绍页控制器
│   │   ├── terminal.js           # xterm.js 终端封装
│   │   ├── filemanager.js        # SFTP 文件管理器
│   │   ├── ai_assistant.js       # AI 助手面板
│   │   ├── monitor.js            # 系统监控面板
│   │   ├── cluster.js            # 集群运维管理
│   │   ├── commands.js           # 快捷命令管理
│   │   ├── alerts.js             # 告警面板
│   │   └── recovery.js           # 会话恢复 + AI 诊断结果展示
│   └── libs/
│       ├── xterm/                # xterm.js 终端核心
│       ├── xterm-addon-fit/      # 终端自适应插件
│       ├── xterm-addon-web-links/ # 链接识别插件
│       ├── socket.io/            # WebSocket 客户端
│       ├── chart.js/             # 数据可视化
│       └── fontawesome/          # 图标库
│
├── tests/
│   ├── conftest.py               # Pytest fixtures
│   ├── test_stability.py         # 压力稳定性测试
│   ├── locustfile.py             # Locust 性能压测
│   ├── cleanup_test_data.py      # 测试数据清理
│   ├── 测试方案.md                # 测试方案文档
│   ├── pytest.ini                # Pytest 配置
│   ├── test_unit/                # 单元测试（数据库/配置/加密）
│   └── test_integration/         # 集成测试（API 端点/WebSocket 事件）
│
└── README.md
```

---

## API 参考

### 认证

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/login` | 用户登录，返回 JWT Token |
| POST | `/api/logout` | 登出，Token 加入黑名单 |
| GET | `/api/me` | 获取当前用户信息 |

### 连接管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/connections` | 连接列表（不含敏感字段） |
| POST | `/api/connections` | 新增连接（密码加密存储） |
| GET | `/api/connections/<id>` | 连接详情（含解密密码/私钥指纹） |
| PUT | `/api/connections/<id>` | 更新连接 |
| DELETE | `/api/connections/<id>` | 删除连接 |
| POST | `/api/test-connection` | TCP 端口连通性测试 |

### 分组管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/groups` | 分组列表 |
| POST | `/api/groups` | 创建分组 |
| DELETE | `/api/groups/<id>` | 删除分组 |

### 快捷命令

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/shortcuts` | 快捷命令列表 |
| POST | `/api/shortcuts` | 新增快捷命令 |
| PUT | `/api/shortcuts/<sid>` | 更新快捷命令 |
| DELETE | `/api/shortcuts/<sid>` | 删除快捷命令 |

### SFTP 文件管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sftp/<sid>/list` | 目录列表（含路径遍历防护） |
| GET | `/api/sftp/<sid>/read` | 读取文件内容（二进制检测，多编码尝试） |
| POST | `/api/sftp/<sid>/write` | 写入文件 |
| POST | `/api/sftp/<sid>/mkdir` | 创建目录 |
| POST | `/api/sftp/<sid>/delete` | 删除文件/目录 |
| POST | `/api/sftp/<sid>/rename` | 重命名 |
| POST | `/api/sftp/<sid>/chmod` | 修改权限（八进制验证） |
| GET | `/api/sftp/<sid>/download` | 流式下载 |
| POST | `/api/sftp/<sid>/upload` | 流式上传（先临时文件后 rename） |

### 系统监控

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/monitor/<sid>` | 实时系统监控数据 |
| GET | `/api/status` | 服务器运行状态 |

### 告警

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/alerts` | 告警列表 |
| POST | `/api/alerts/<id>/ack` | 确认告警 |
| POST | `/api/alerts/clear` | 清除已确认告警 |

### 集群运维

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/cluster/nodes` | 节点列表（支持分组/连接筛选） |
| POST | `/api/cluster/batch-command` | 批量执行命令（含安全风险检查） |
| GET | `/api/cluster/task/<tid>/status` | 任务状态查询 |
| POST | `/api/cluster/task/<tid>/cancel` | 取消任务 |

### 文件分发

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/distribute` | 发起文件分发任务（含 MD5 校验） |
| GET | `/api/distribute/<tid>/status` | 分发状态查询 |

### 巡检

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/inspection/run` | 执行巡检 |
| POST | `/api/inspection/export` | 导出 Excel 报告 |

### AI 功能

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/ai/chat` | AI 对话（多轮，含上下文记忆） |
| GET | `/api/ai/chat/history` | 对话历史列表 |
| GET | `/api/ai/chat/sessions` | 会话列表 |
| POST | `/api/ai/chat/clear` | 清空历史 |
| POST | `/api/ai/chat/delete` | 删除指定会话 |
| GET | `/api/ai/chat/search` | 搜索历史消息 |
| GET | `/api/ai/chat/by-date` | 按日期查询 |
| GET | `/api/ai/chat/stats` | 对话统计 |
| POST | `/api/ai/analyze-command` | 命令风险分析 |
| POST | `/api/ai/explain-command` | 命令解释 |
| POST | `/api/ai/diagnose` | 系统诊断报告 |
| POST | `/api/ai/predict` | 容量预测 |
| POST | `/api/ai/security-scan` | 安全漏洞扫描 |
| GET | `/api/ai/knowledge` | 知识库列表 |
| POST | `/api/ai/knowledge` | 新增知识条目 |
| DELETE | `/api/ai/knowledge/<id>` | 删除知识条目 |
| POST | `/api/ai/knowledge/generate` | AI 生成知识内容 |
| POST | `/api/ai/cluster-summary` | 集群健康摘要 |
| POST | `/api/ai/topology` | 服务拓扑发现 |
| GET | `/api/ai/status` | AI 引擎状态 |
| GET | `/api/ai/config` | AI 配置 |
| POST | `/api/ai/config` | 保存 AI 配置 |
| POST | `/api/ai/config/test` | 测试 AI 连接 |

### 其他

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/recordings` | 录制列表 |
| GET | `/api/recordings/<filename>` | 获取录制数据 |
| GET | `/api/audit-logs` | 审计日志查询 |
| GET | `/api/quick-history` | 快速连接历史 |
| GET | `/api/session/recover/<sid>` | 会话恢复数据 |
| GET | `/health` | 健康检查 |

---

## WebSocket 事件

| 事件 | 方向 | 说明 |
|------|------|------|
| `connect` | C→S | WebSocket 连接（含 JWT 认证） |
| `open_terminal` | C→S | 打开 SSH 终端会话 |
| `quick_connect` | C→S | 快速连接 |
| `terminal_input` | C→S | 终端输入（经风险分析引擎） |
| `terminal_resize` | C→S | 调整终端尺寸 |
| `close_terminal` | C→S | 关闭会话 |
| `terminal_output` | S→C | 终端数据回显 |
| `terminal_connected` | S→C | 会话建立成功通知 |
| `terminal_error` | S→C | 终端错误通知 |
| `terminal_closed` | S→C | 终端断开通知 |
| `command_medium_risk` | S→C | 中风险命令确认请求 |
| `terminal_state_sync` | S→C | 状态同步 |
| `alert` | S→C | 监控告警推送 |
| `disconnect` | C↔S | 断开连接 |

---

## 部署建议

### Windows 服务

可将 `backend/app.py` 注册为 Windows 服务（通过 NSSM 等工具），注意在 `.env` 中显式设置 `DATA_DIR`：

```bash
DATA_DIR=C:\Users\YOUR_USER\.webterminal
```

### 生产环境

- 设置强密码：`ADMIN_PASSWORD=<32+ 字符随机串>`
- 限制 JWT 有效期：`JWT_ACCESS_TOKEN_EXPIRES_HOURS=8`
- 生产环境建议配置 HTTPS（通过 Nginx SSL 终端）
- 定期备份 `DATA_DIR` 下的数据库和密钥文件
- 建议配合 fail2ban 等工具监控登录异常

### 文件权限

```bash
# Linux 下确保密钥文件仅当前用户可读
chmod 600 ~/.webterminal/.encryption_key
chmod 600 ~/.webterminal/.secret_key
chmod 600 ~/.webterminal/.jwt_key
```

---

## 安全说明

- **密钥管理**：`SECRET_KEY` / `JWT_SECRET_KEY` / `ENCRYPTION_KEY` 支持环境变量注入，未设置时自动生成并持久化到 `DATA_DIR`，文件权限 `0600`
- **密码存储**：SSH 密码使用 Fernet 对称加密后存入 SQLite
- **AI API Key**：支持通过前端页面配置或环境变量，加密存储于本地 `ai_config.json`
- **命令安全**：终端输入经五级风险分析引擎，critical 级直接拦截，high 级需二次确认
- **路径安全**：SFTP 操作含路径遍历攻击防护，禁止访问 `/etc/shadow` 等敏感路径
- **审计追溯**：所有关键操作（登录/连接/命令/文件）记录审计日志，支持按时间/类型查询
- **Token 黑名单**：登出后 Token 即时加入黑名单，有效期内不可复用
- **登录限流**：密码错误次数超限自动锁定（默认 5 次 / 5 分钟）
- **DoS 防护**：终端累计输出上限 50MB，单条命令长度上限 100KB，并发连接数可配

---

## 联系方式

- **QQ**: 727418053@qq.com

---

## 许可证

MIT License
