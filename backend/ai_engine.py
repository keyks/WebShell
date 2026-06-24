# backend/ai_engine.py
"""
AI 运维引擎 - 统一处理所有 AI 功能
模块一：智能运维助手（对话、命令分析、命令解释）
模块二：主动巡检与预测（容量预测、安全扫描）
模块三：变更管理（命令风险分析）
模块四：知识库（CRUD、AI 生成）
模块五：集群管理（健康总览、拓扑）
"""
import os
import json
import time
import sqlite3
import threading
import re
import subprocess
import sys
import tempfile
from datetime import datetime
from typing import Dict, List, Optional, Any
from pathlib import Path
from dataclasses import dataclass, field, asdict

from logger import log
from config import config

# ══════════════════════════════════════════
#  数据结构
# ══════════════════════════════════════════

@dataclass
class ChatMessage:
    role:      str
    content:   str
    timestamp: str = field(
        default_factory=lambda: datetime.now().isoformat()
    )


@dataclass
class ConversationSession:
    session_id:   str
    conn_session: str
    messages:     List[ChatMessage] = field(default_factory=list)
    context:      Dict              = field(default_factory=dict)
    created_at:   str               = field(
        default_factory=lambda: datetime.now().isoformat()
    )


@dataclass
class KnowledgeEntry:
    id:         str
    title:      str
    content:    str
    tags:       List[str]
    category:   str
    created_at: str = field(
        default_factory=lambda: datetime.now().isoformat()
    )
    updated_at: str = field(
        default_factory=lambda: datetime.now().isoformat()
    )


@dataclass
class RiskLevel:
    level:       str   # safe | low | medium | high | critical
    score:       int   # 0-100
    description: str
    suggestion:  str


# ══════════════════════════════════════════
#  高危命令规则库
# ══════════════════════════════════════════

RISK_RULES: List[tuple] = [
    # === critical: 直接拦截，不可绕过 ===
    (r'rm\s+-rf\s+/',          'critical', '递归删除根目录，极度危险',          '请使用 rm -rf /path/to/specific/dir'),
    (r'rm\s+-rf\s+/\*',        'critical', '删除根目录所有内容',               '请指定明确的子目录'),
    (r'rm\s+-[rR][fF]\s+~?/[\s;$|&]', 'critical', '删除根目录或家目录，极度危险', '请指定明确的子目录'),
    (r'dd\s+if=/dev/zero',     'critical', '向设备写零字节，可能覆盖磁盘',       '请确认目标设备正确'),
    (r'dd\s+if=/dev/random',   'critical', '向设备写随机数据',                  '请确认目标设备正确'),
    (r'dd\s+if=/dev/urandom',  'critical', '向设备写随机数据',                  '请确认目标设备正确'),
    (r'mkfs\b',                'critical', '格式化文件系统，将清空所有数据',      '请先备份数据'),
    (r'mke2fs\b',              'critical', '格式化文件系统，将清空所有数据',      '请先备份数据'),
    (r'>\s*/dev/sd[a-z]\d?',   'critical', '直接写入磁盘设备文件',               '极度危险，请勿执行'),
    (r'cat\s+/dev/null\s*>\s*/dev/sd', 'critical', '清空磁盘设备',              '极度危险，请勿执行'),
    (r':\(\)\{.*\}.*:',        'critical', 'Fork 炸弹，可能导致系统崩溃',        '这是恶意代码'),
    (r'kill\s+-9\s+1\b',       'critical', '杀死 init 进程，导致系统崩溃',       '请勿执行此操作'),
    (r'kill\s+-9\s+-1\b',      'critical', '杀死所有进程，导致系统崩溃',         '请勿执行此操作'),

    # === high: 需要后端强制二次确认 ===
    (r'rm\s+-rf\s+',           'high',     '递归强制删除，可能造成数据丢失',      '请确认目标目录'),
    (r'rm\s+-[rR][fF]\s+',     'high',     '递归删除目录，可能造成数据丢失',      '请确认目标目录'),
    (r'rm\s+-[rR]\s+',         'high',     '递归删除目录，可能造成数据丢失',      '请确认目标目录'),
    (r'rm\s+-[fF]\s+',         'high',     '强制删除，跳过确认提示',              '请确认要删除的文件'),
    (r'shred\b',               'high',     '安全粉碎文件（多次覆写后删除）',      '请先备份重要文件'),
    (r'chmod\s+-R\s+777',      'high',     '递归赋予所有权限，存在安全风险',      '请使用最小必要权限'),
    (r'chmod\s+777\s+/',       'high',     '给根目录赋予全部权限',               '这会导致严重安全漏洞'),
    (r'chown\s+-R\s+\S+\s+/',  'high',     '递归修改根目录所有者',               '请指定具体子目录'),
    (r'chown\s+-R\s+root:root\s+/', 'high', '递归修改根目录所有者',             '请指定具体子目录'),
    (r'mv\s+\S+\s+/dev/null',  'high',     '将文件移入黑洞，数据不可恢复',        '请使用 rm 并先备份'),
    (r'fdisk\b',               'high',     '磁盘分区操作，可能导致数据丢失',      '请先备份重要数据'),
    (r'parted\b',              'high',     '磁盘分区操作，可能导致数据丢失',      '请先备份重要数据'),
    (r'shutdown\b',            'high',     '关机/重启操作，将中断所有服务',       '请确认非生产环境'),
    (r'reboot\b',              'high',     '重启操作，将中断所有服务',            '请确认非生产环境'),
    (r'halt\b',                'high',     '关机操作，将中断所有服务',            '请确认非生产环境'),
    (r'poweroff\b',            'high',     '关机操作，将中断所有服务',            '请确认非生产环境'),
    (r'init\s+[06]\b',         'high',     '切换运行级别，可能关机/重启',         '请确认非生产环境'),
    (r'iptables\s+-F',         'high',     '清空防火墙规则，暴露所有端口',        '请确认有其他安全措施'),
    (r'iptables\s+-X',         'high',     '删除自定义防火墙链',                 '请确认有其他安全措施'),

    # === medium: 审计记录，前端确认 ===
    (r'rm\s+',                 'medium',   '删除文件，不可恢复',                 '请确认要删除的文件'),
    (r'rmdir\b',               'medium',   '删除空目录',                         '请确认目录为空且不再需要'),
    (r'unlink\b',              'medium',   '删除文件链接',                       '请确认不再需要此文件'),
    (r'truncate\s+-s\s+0',     'medium',   '清空文件内容',                      '请先备份文件'),
    (r'systemctl\s+disable',   'medium',   '禁用系统服务',                      '请确认服务不是关键依赖'),
    (r'systemctl\s+stop\s+',   'medium',   '停止系统服务',                      '请确认服务可以安全停止'),
    (r'passwd\b',              'medium',   '修改用户密码',                       '请记录新密码并妥善保管'),
    (r'userdel\s+-r',          'medium',   '删除用户及主目录',                   '请先备份用户数据'),
    (r'crontab\s+-r',          'medium',   '删除所有定时任务',                   '请先备份 crontab'),
    (r'history\s+-c\b',        'medium',   '清除命令历史记录',                   '此操作不可恢复'),
    (r'wipefs\b',              'medium',   '清除文件系统签名',                   '可能导致数据丢失'),
    (r'mkswap\b',              'medium',   '创建交换分区',                       '请确认目标设备正确'),
]

# 🔧 修复：将 cat、curl、wget 等可能有风险但通常是安全的命令移到 READ_ONLY_PREFIXES
# 真正只读的命令放在 SAFE_PREFIXES，其余放在 CONDITIONAL_SAFE_PREFIXES（仍需经过规则检查）
SAFE_PREFIXES = (
    'ls', 'pwd', 'whoami', 'date', 'echo',
    'tail', 'head', 'top', 'df', 'du', 'ps', 'netstat', 'ss',
    'ping', 'uname', 'uptime', 'free', 'who',
    'w', 'id', 'env', 'printenv', 'history', 'man',
)

# 🔧 新增：这些命令虽然通常是安全的，但组合使用时可能危险，需要经过规则检查
CONDITIONAL_SAFE_PREFIXES = (
    'cat', 'grep', 'curl', 'wget',
)


def analyze_command_risk(command: str) -> RiskLevel:
    """分析命令风险等级"""
    cmd = command.strip()

    # 🔧 修复：高危规则匹配必须优先于安全命令判断
    # 确保如 cat /dev/null > /dev/sda 这类危险命令先被 critical 规则捕获
    for pattern, level, desc, suggestion in RISK_RULES:
        if re.search(pattern, cmd, re.IGNORECASE):
            score_map = {'critical': 100, 'high': 75, 'medium': 50, 'low': 25}
            return RiskLevel(level, score_map[level], desc, suggestion)

    # 安全命令快速判断（只读命令，无任何组合风险）
    first_word = cmd.split()[0] if cmd.split() else ''
    if first_word in SAFE_PREFIXES:
        return RiskLevel('safe', 0, '只读查询命令，无风险', '')

    # 🔧 条件安全命令：通常安全，但已经过规则检查（如果有危险组合已被上面拦截）
    if first_word in CONDITIONAL_SAFE_PREFIXES:
        return RiskLevel('low', 10, '通常安全的命令，已通过危险规则检查', '')

    return RiskLevel('low', 15, '未知命令，建议确认后执行', '请确认命令的影响范围')


# ══════════════════════════════════════════
#  知识库（SQLite）
# ══════════════════════════════════════════

class KnowledgeBase:
    """本地知识库，基于 SQLite"""

    def __init__(self):
        self.db_path = config.DATA_DIR / 'ai_knowledge.db'
        self._init_db()

    def _init_db(self):
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute('''
                CREATE TABLE IF NOT EXISTS knowledge (
                    id         TEXT PRIMARY KEY,
                    title      TEXT NOT NULL,
                    content    TEXT NOT NULL,
                    tags       TEXT DEFAULT "[]",
                    category   TEXT DEFAULT "qa",
                    created_at TEXT,
                    updated_at TEXT
                )
            ''')
            conn.execute(
                'CREATE INDEX IF NOT EXISTS idx_kb_category '
                'ON knowledge(category)'
            )
            conn.execute(
                'CREATE INDEX IF NOT EXISTS idx_kb_updated '
                'ON knowledge(updated_at)'
            )
        log.info(f'[KnowledgeBase] 已就绪: {self.db_path}')

    def save(self, entry: KnowledgeEntry):
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute('''
                INSERT OR REPLACE INTO knowledge
                    (id, title, content, tags, category, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ''', (
                entry.id,
                entry.title,
                entry.content,
                json.dumps(entry.tags, ensure_ascii=False),
                entry.category,
                entry.created_at,
                entry.updated_at,
            ))

    def search(self, query: str, category: str = None,
               limit: int = 20) -> List[KnowledgeEntry]:
        sql    = '''
            SELECT * FROM knowledge
            WHERE (title LIKE ? OR content LIKE ? OR tags LIKE ?)
        '''
        params = [f'%{query}%', f'%{query}%', f'%{query}%']
        if category:
            sql += ' AND category = ?'
            params.append(category)
        sql += ' ORDER BY updated_at DESC LIMIT ?'
        params.append(limit)
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.row_factory = sqlite3.Row
            return [self._to_entry(r)
                    for r in conn.execute(sql, params).fetchall()]

    def get_all(self, category: str = None,
                limit: int = 50) -> List[KnowledgeEntry]:
        sql, params = 'SELECT * FROM knowledge', []
        if category:
            sql += ' WHERE category = ?'
            params.append(category)
        sql += ' ORDER BY updated_at DESC LIMIT ?'
        params.append(limit)
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.row_factory = sqlite3.Row
            return [self._to_entry(r)
                    for r in conn.execute(sql, params).fetchall()]

    def delete(self, entry_id: str):
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute('DELETE FROM knowledge WHERE id = ?', (entry_id,))

    def _to_entry(self, row) -> KnowledgeEntry:
        d = dict(row)
        try:
            tags = json.loads(d.get('tags', '[]'))
        except Exception:
            tags = []
        return KnowledgeEntry(
            id=d['id'], title=d['title'], content=d['content'],
            tags=tags, category=d['category'],
            created_at=d.get('created_at', ''),
            updated_at=d.get('updated_at', ''),
        )


# ══════════════════════════════════════════
#  对话会话管理
# ══════════════════════════════════════════

class ConversationManager:
    """管理多轮对话上下文 + 持久化到 SQLite"""

    def __init__(self):
        self._sessions: Dict[str, ConversationSession] = {}
        self._lock     = threading.Lock()
        self._db       = ChatHistoryDB()

    def get_or_create(self, chat_id: str,
                      conn_session: str = '') -> ConversationSession:
        with self._lock:
            if chat_id not in self._sessions:
                self._sessions[chat_id] = ConversationSession(
                    session_id=chat_id,
                    conn_session=conn_session,
                )
                # 从数据库恢复最近消息到内存
                history = self._db.get_recent_for_llm(chat_id, 20)
                for m in history:
                    self._sessions[chat_id].messages.append(
                        ChatMessage(role=m['role'], content=m['content'])
                    )
            return self._sessions[chat_id]

    def add_message(self, chat_id: str, role: str, content: str):
        # 写入数据库
        self._db.save_message(chat_id, role, content)
        # 写入内存
        with self._lock:
            s = self._sessions.get(chat_id)
            if s:
                s.messages.append(ChatMessage(role=role, content=content))
                if len(s.messages) > 20:
                    s.messages = s.messages[-20:]

    def get_history(self, chat_id: str,
                    limit: int = 50) -> List[Dict]:
        """从数据库获取完整历史（含时间戳）"""
        return self._db.get_history(chat_id, limit)

    def get_history_for_llm(self, chat_id: str) -> List[Dict]:
        """获取用于 LLM 的上下文（内存优先）"""
        with self._lock:
            s = self._sessions.get(chat_id)
            if s:
                return [{'role': m.role, 'content': m.content}
                        for m in s.messages]
        return self._db.get_recent_for_llm(chat_id, 20)

    def clear(self, chat_id: str):
        self._db.clear(chat_id)
        with self._lock:
            self._sessions.pop(chat_id, None)

    def get_all_sessions(self) -> List[Dict]:
        return self._db.get_all_chat_ids()

    def update_context(self, chat_id: str, key: str, value: Any):
        with self._lock:
            s = self._sessions.get(chat_id)
            if s:
                s.context[key] = value

    def get_context(self, chat_id: str) -> Dict:
        with self._lock:
            s = self._sessions.get(chat_id)
            return s.context if s else {}
    
    def search(self, keyword: str, chat_id: str = None,
               limit: int = 50) -> List[Dict]:
        return self._db.search_messages(keyword, chat_id, limit)

    def get_messages_by_date(self, date_str: str) -> List[Dict]:
        return self._db.get_messages_by_date(date_str)

    def get_stats(self) -> Dict:
        return self._db.get_stats()

# ══════════════════════════════════════════
#  Groq 同步调用（subprocess 方式，绕开 eventlet）
# ══════════════════════════════════════════

def call_groq_sync(
    messages:   List[Dict],
    model:      str  = None,
    max_tokens: int  = 1500,
    json_mode:  bool = False,
    timeout:    int  = 90,
    api_key:    str  = '',
    base_url:   str  = '',
) -> str:
    """
    同步调用 Groq API（支持自定义 base_url），通过独立子进程避免 eventlet 冲突。
    返回纯文本响应内容。
    """
    import os as _os

    # ✅ 优先使用传入的 api_key，其次从环境变量/config 读取
    if not api_key:
        from ai_config import get_effective_ai_config
        try:
            _eff = get_effective_ai_config()
            api_key = _eff.get('api_key', '').strip()
            if api_key:
                log.debug(f'[Groq] 使用 ai_config 中配置的 Key（len={len(api_key)}）')
        except Exception:
            pass

    # 最终 fallback：直接读环境变量 / config
    if not api_key:
        api_key = (
            _os.environ.get('GROQ_API_KEY', '').strip()
            or getattr(config, 'GROQ_API_KEY', '').strip()
        )
        if api_key:
            log.debug('[Groq] 使用 .env GROQ_API_KEY')

    if not api_key:
        _has_env = bool(_os.environ.get('GROQ_API_KEY', ''))
        _has_cfg = bool(getattr(config, 'GROQ_API_KEY', ''))
        raise RuntimeError(
            f'GROQ_API_KEY 未设置。'
            f' 环境变量: {"已设置" if _has_env else "未设置"}, '
            f' config: {"已设置" if _has_cfg else "未设置"}, '
            f' ai_config.json: 未知'
        )

    model = model or getattr(config, 'GROQ_MODEL', 'openai/gpt-oss-120b')

    input_data = {
        'api_key':    api_key,
        'model':      model,
        'messages':   messages,
        'max_tokens': max_tokens,
        'json_mode':  json_mode,
        'base_url':   base_url or 'https://api.groq.com/openai/v1',
    }

    # 🔧 安全修复 v2：用安全临时目录避免权限竞态
    tmpdir = tempfile.mkdtemp(prefix='webshell_ai_')
    os.chmod(tmpdir, 0o700)
    in_path = os.path.join(tmpdir, 'ai_in.json')
    out_path = os.path.join(tmpdir, 'ai_out.json')
    for p in (in_path, out_path):
        fd = os.open(p, os.O_CREAT | os.O_WRONLY, 0o600)
        os.close(fd)

    try:
        with open(in_path, 'w', encoding='utf-8') as f:
            json.dump(input_data, f, ensure_ascii=False)

        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_groq_worker.py')

        if not os.path.exists(script):
            raise RuntimeError(f'_groq_worker.py 不存在: {script}')

        # 🔧 安全修复 v3：用 stderr 文件重定向代替 capture_output=True
        #    capture_output=True 会创建 OS 管道，httpx.post() 的大量 stderr 输出
        #    可能堵塞管道缓冲区导致子进程死锁（Windows 服务 Session 0 尤其容易触发）
        stderr_file = tmpdir + '/stderr.log'
        proc = subprocess.run(
            [sys.executable, script, in_path, out_path],
            timeout=timeout,
            stdout=subprocess.DEVNULL,
            stderr=open(stderr_file, 'w', encoding='utf-8'),
        )

        # 从文件读取 stderr
        try:
            with open(stderr_file, 'r', encoding='utf-8', errors='replace') as _sf:
                stderr_text = _sf.read().strip()
        except Exception:
            stderr_text = ''
        if stderr_text:
            log.info(f'[_groq_worker] returncode={proc.returncode}')
            for line in stderr_text.splitlines():
                log.info(f'[_groq_worker] {line}')

        if not os.path.exists(out_path):
            raise RuntimeError(
                f'子进程未生成输出文件 (exit={proc.returncode})，stderr: {stderr_text[:300]}'
            )

        with open(out_path, 'r', encoding='utf-8') as f:
            result = json.load(f)

        # 🔧 防御：result 不应是 None（json.load 只有读到 null 才返回 None）
        if not isinstance(result, dict):
            log.warning(f'[_groq_worker] 输出文件格式异常: type={type(result).__name__}')
            result = {'error': f'输出格式异常: {type(result).__name__}'}

        if 'error' in result:
            err_msg = result['error']
            log.error(f'[_groq_worker] AI 调用失败: {err_msg[:300]}')

            # 🔧 403 自动清理失效 Key，避免后续调用继续失败
            if '403' in err_msg or 'Forbidden' in err_msg:
                try:
                    from ai_config import invalidate_stored_key
                    cleanup = invalidate_stored_key()
                    log.warning(
                        f'[Groq] 403 Forbidden — 已自动清理本地 Key（{cleanup}），'
                        f'请前往 https://console.groq.com/keys 生成新 Key'
                    )
                    err_msg += (
                        '\n\n[已自动清除本地失效 Key]'
                        '\n请前往 https://console.groq.com/keys 创建新 API Key，'
                        '然后在「系统设置 → AI 配置」中填写并保存。'
                    )
                except Exception:
                    pass

            raise RuntimeError(err_msg)

        # 🔧 兼容 json_mode=False + 客户端 JSON 提取：
        #   子进程提取到 JSON 时返回 data(dict)，否则返回 text(str)，错误时返回 str
        _ret = result.get('data', result.get('text', '') or result.get('error', ''))
        return _ret if _ret is not None else ''

    finally:
        try:
            import shutil as _shutil
            _shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            pass

# ══════════════════════════════════════════
#  系统信息采集（供 app.py 调用）
# ══════════════════════════════════════════

def collect_system_context(session) -> str:
    """
    同步采集系统信息（在 eventlet 线程中直接调用）
    根据 OS 类型选择对应的采集命令
    """
    parts  = []
    budget = 30.0
    start  = time.time()

    # 结构化指标
    os_type = 'unknown'
    try:
        info = session.get_system_info()
        parts.append(
            '=== 结构化系统指标 ===\n' +
            json.dumps(info, ensure_ascii=False, indent=2, default=str)
        )
        os_type = info.get('os_type', 'unknown')
    except Exception as e:
        parts.append(f'=== 结构化系统指标 ===\n获取失败: {e}')

    # 补充命令（根据 OS 类型）
    if os_type == 'windows':
        commands = [
            ('进程列表', 'powershell \"Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 | Format-Table Name,CPU,PM,Id -AutoSize\"', 8),
            ('磁盘使用', 'powershell \"Get-CimInstance Win32_LogicalDisk -Filter DriveType=3 | Format-Table DeviceID,@{N=SizeGB;E={[math]::Round($_.Size/1GB)}},@{N=FreeGB;E={[math]::Round($_.FreeSpace/1GB)}} -AutoSize\"', 5),
            ('网络监听', 'netstat -an | findstr LISTENING', 5),
            ('系统错误日志', 'powershell \"Get-EventLog -LogName System -EntryType Error -Newest 20 | Format-Table TimeGenerated,Message -Wrap\" 2>nul || echo 事件日志不可用', 8),
            ('服务状态', 'powershell \"Get-Service | Where-Object {$_.Status -eq Stopped} | Select-Object -First 20 | Format-Table Name,DisplayName -AutoSize\"', 6),
        ]
    else:
        commands = [
            ('TOP摘要',    'top -b -n 1 | head -20',          6),
            ('CPU TOP进程', 'ps aux --sort=-%cpu | head -10',  5),
            ('磁盘使用',    'df -h',                           5),
            ('网络监听',
             'ss -tuln 2>/dev/null || netstat -tuln 2>/dev/null || echo N/A', 5),
            ('系统错误日志',
             'journalctl -p 3 -n 15 --no-pager 2>/dev/null '
             '|| tail -15 /var/log/syslog 2>/dev/null '
             '|| echo 日志不可用', 6),
        ]

    for name, cmd, timeout in commands:
        if time.time() - start > budget:
            parts.append(f'=== {name} ===\n已跳过（超出采集预算）')
            continue
        try:
            stdout, stderr = session.execute_command(cmd, timeout=timeout)
            output = (stdout or '').strip() or (stderr or '').strip() or '(无输出)'
            if len(output) > 1500:
                output = output[:1500] + '\n...[已截断]'
            parts.append(f'=== {name} ===\n{output}')
        except Exception as e:
            parts.append(f'=== {name} ===\n失败: {e}')

    return '\n\n'.join(parts)

# ══════════════════════════════════════════
#  对话历史持久化（SQLite）
# ══════════════════════════════════════════

class ChatHistoryDB:
    """对话历史持久化，基于 SQLite"""

    def __init__(self):
        self.db_path = config.DATA_DIR / 'ai_chat_history.db'
        self._init_db()

    def _init_db(self):
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute('''
                CREATE TABLE IF NOT EXISTS chat_history (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    chat_id    TEXT NOT NULL,
                    role       TEXT NOT NULL,
                    content    TEXT NOT NULL,
                    created_at TEXT DEFAULT (datetime('now','localtime'))
                )
            ''')
            conn.execute(
                'CREATE INDEX IF NOT EXISTS idx_chat_id '
                'ON chat_history(chat_id)'
            )
            conn.execute(
                'CREATE INDEX IF NOT EXISTS idx_chat_created '
                'ON chat_history(created_at)'
            )
        log.info(f'[ChatHistoryDB] 已就绪: {self.db_path}')

    def save_message(self, chat_id: str, role: str, content: str):
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute(
                'INSERT INTO chat_history(chat_id, role, content) '
                'VALUES (?, ?, ?)',
                (chat_id, role, content)
            )

    def get_history(self, chat_id: str,
                    limit: int = 50) -> List[Dict]:
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                'SELECT role, content, created_at FROM chat_history '
                'WHERE chat_id = ? '
                'ORDER BY id DESC LIMIT ?',
                (chat_id, limit)
            ).fetchall()
        # 返回正序（旧 → 新）
        result = [dict(r) for r in reversed(rows)]
        return result

    def get_recent_for_llm(self, chat_id: str,
                           limit: int = 20) -> List[Dict]:
        """获取最近 N 条用于 LLM 上下文（只含 role/content）"""
        rows = self.get_history(chat_id, limit)
        return [{'role': r['role'], 'content': r['content']} for r in rows]

    def clear(self, chat_id: str):
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute(
                'DELETE FROM chat_history WHERE chat_id = ?',
                (chat_id,)
            )

    def get_all_chat_ids(self) -> List[Dict]:
        """获取所有对话列表（用于历史记录面板）"""
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute('''
                SELECT
                    chat_id,
                    COUNT(*) as message_count,
                    MIN(created_at) as started_at,
                    MAX(created_at) as last_active
                FROM chat_history
                GROUP BY chat_id
                ORDER BY last_active DESC
                LIMIT 50
            ''').fetchall()
        return [dict(r) for r in rows]

    def search_messages(self, keyword: str, chat_id: str = None,
                        limit: int = 50) -> List[Dict]:
        """按关键词搜索所有对话消息"""
        sql    = 'SELECT * FROM chat_history WHERE content LIKE ?'
        params = [f'%{keyword}%']
        if chat_id:
            sql += ' AND chat_id = ?'
            params.append(chat_id)
        sql += ' ORDER BY id DESC LIMIT ?'
        params.append(limit)
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.row_factory = sqlite3.Row
            return [dict(r) for r in conn.execute(sql, params).fetchall()]

    def get_messages_by_date(self, date_str: str,
                             limit: int = 200) -> List[Dict]:
        """按日期查询消息（格式 2026-06-21）"""
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                'SELECT * FROM chat_history '
                'WHERE created_at LIKE ? '
                'ORDER BY id ASC LIMIT ?',
                (f'{date_str}%', limit)
            ).fetchall()
        return [dict(r) for r in rows]

    def get_stats(self) -> Dict:
        """获取对话统计信息"""
        with sqlite3.connect(str(self.db_path)) as conn:
            total = conn.execute(
                'SELECT COUNT(*) FROM chat_history'
            ).fetchone()[0]
            sessions = conn.execute(
                'SELECT COUNT(DISTINCT chat_id) FROM chat_history'
            ).fetchone()[0]
            latest = conn.execute(
                'SELECT MAX(created_at) FROM chat_history'
            ).fetchone()[0]
        return {
            'total_messages': total,
            'total_sessions': sessions,
            'latest_at':      latest or '',
        }

def fmt_bytes(b: int) -> str:
    # 🔧 修复：负数直接返回，避免进入无限循环
    if b is None or b <= 0:
        return '0B'
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if b < 1024:
            return f'{b:.1f}{unit}'
        b /= 1024
    return f'{b:.1f}PB'

def call_groq_sync_with_retry(
    messages: List[Dict],
    model: str = None,
    max_tokens: int = 1500,
    json_mode: bool = False,
    timeout: int = 90,
    max_retries: int = 2,
    api_key: str = '',
    base_url: str = '',
) -> str:
    """带重试的 Groq API 调用，使用指数退避 + 随机抖动"""
    import random
    last_error = None
    for attempt in range(max_retries + 1):
        try:
            return call_groq_sync(
                messages=messages,
                model=model,
                max_tokens=max_tokens,
                json_mode=json_mode,
                timeout=timeout,
                api_key=api_key,
                base_url=base_url,
            )
        except Exception as e:
            last_error = e
            err_str = str(e)
            # 🔧 修复：401/403 认证错误不应重试，立即抛出
            if any(kw in err_str for kw in ('403', '401', 'Forbidden', 'Unauthorized', '权限', '无效')):
                log.error(f'[Groq] 认证失败，不重试: {e}')
                raise RuntimeError(str(e))

            if attempt < max_retries:
                # 指数退避: 2, 4, 8... 秒，最大 30 秒
                wait = min(2 ** (attempt + 1), 30)
                # 添加随机抖动，避免惊群效应
                wait += random.uniform(0, 1)
                log.warning(f'[Groq] 调用失败，{wait:.1f}s 后重试 (attempt {attempt+1}/{max_retries}): {e}')
                time.sleep(wait)
            else:
                log.error(f'[Groq] 所有重试失败: {e}')
                raise RuntimeError(f'AI 调用失败: {last_error}')

# ══════════════════════════════════════════
#  全局单例
# ══════════════════════════════════════════

knowledge_base       = KnowledgeBase()
conversation_manager = ConversationManager()