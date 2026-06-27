"""
全局配置管理
"""
import os
import sys
import secrets
from pathlib import Path
from cryptography.fernet import Fernet
from dotenv import load_dotenv

# ══════════════════════════════════════════
# 🔧 修复 Windows 控制台中文乱码
#   必须在任何 print() 之前执行
# ══════════════════════════════════════════
if sys.platform == 'win32':
    # 方法1: reconfigure（Python 3.7+，最可靠）
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        # 方法2: 替换流
        import io
        sys.stdout = io.TextIOWrapper(
            sys.stdout.buffer, encoding='utf-8', errors='replace', line_buffering=True
        )
        sys.stderr = io.TextIOWrapper(
            sys.stderr.buffer, encoding='utf-8', errors='replace', line_buffering=True
        )

# ══════════════════════════════════════════
# 🔧 健壮的 .env 多路径加载策略
#   Windows 服务环境中 CWD 不可靠，需要逐级搜索确保找到配置
# ══════════════════════════════════════════

def _find_and_load_env():
    """在多个可能的位置查找并加载 .env 文件，返回实际加载的路径"""
    search_paths = []

    # 1. 环境变量 DOTENV_PATH 显式指定（最高优先级，用于部署脚本）
    dotenv_env = os.environ.get('DOTENV_PATH', '') or os.environ.get('ENV_FILE', '')
    if dotenv_env and Path(dotenv_env).exists():
        load_dotenv(dotenv_env, override=False)
        print(f'[OK] .env 已加载（DOTENV_PATH）: {dotenv_env}')
        return dotenv_env
    if dotenv_env:
        search_paths.append(('DOTENV_PATH', dotenv_env))

    # 2. backend/ 目录（与 config.py 同级）
    backend_env = Path(__file__).resolve().parent / '.env'
    search_paths.append(('backend/', str(backend_env)))
    if backend_env.exists():
        load_dotenv(backend_env, override=False)
        print(f'[OK] .env 已加载: {backend_env}')
        return str(backend_env)

    # 3. 项目根目录（backend 父级，如 d:/WebShell/.env）
    project_env = Path(__file__).resolve().parent.parent / '.env'
    search_paths.append(('project_root/', str(project_env)))
    if project_env.exists():
        load_dotenv(project_env, override=False)
        print(f'[OK] .env 已加载（项目根目录）: {project_env}')
        return str(project_env)

    # 4. 当前工作目录
    cwd_env = Path.cwd() / '.env'
    search_paths.append(('CWD/', str(cwd_env)))
    if cwd_env.exists():
        load_dotenv(cwd_env, override=False)
        print(f'[OK] .env 已加载（CWD）: {cwd_env}')
        return str(cwd_env)

    # 5. 最终回退：默认行为（遍历 sys.path）
    load_dotenv(override=False)

    # 诊断：打印所有搜索路径和结果
    groq_key = os.environ.get('GROQ_API_KEY', '')
    print(f'[WARNING] .env 文件未在任何标准位置找到')
    print(f'  搜索路径:')
    for label, path in search_paths:
        exists = '✓' if Path(path).exists() else '✗'
        print(f'    [{exists}] {label}: {path}')
    print(f'  GROQ_API_KEY 环境变量: {"已设置(" + groq_key[:8] + "...)" if groq_key else "未设置"}')
    return None

_env_loaded_from = _find_and_load_env()

DATA_DIR = Path(os.environ.get('DATA_DIR', Path.home() / '.webterminal'))
DATA_DIR.mkdir(parents=True, exist_ok=True)


def _write_key_file(path: Path, data: bytes):
    try:
        path.write_bytes(data)
        try:
            path.chmod(0o600)
        except Exception:
            pass
    except Exception as e:
        print(f"[WARNING] 无法写入密钥文件 {path}: {e}")


def _backup_file(path: Path):
    try:
        backup = path.with_suffix(path.suffix + '.bak')
        path.rename(backup)
        print(f"[WARNING] 已备份损坏文件到 {backup}")
    except Exception:
        pass


def _load_or_create_encryption_key() -> bytes:
    key_file = DATA_DIR / '.encryption_key'
    env_key = os.environ.get('ENCRYPTION_KEY', '').strip()
    if env_key:
        try:
            key_bytes = env_key.encode() if isinstance(env_key, str) else env_key
            Fernet(key_bytes)
            _write_key_file(key_file, key_bytes)
            return key_bytes
        except Exception:
            pass
    if key_file.exists():
        try:
            key = key_file.read_bytes().strip()
            Fernet(key)
            return key
        except Exception:
            _backup_file(key_file)
    key = Fernet.generate_key()
    _write_key_file(key_file, key)
    return key


def _load_or_create_secret_key() -> str:
    key_file = DATA_DIR / '.secret_key'
    env_key = os.environ.get('SECRET_KEY', '').strip()
    if env_key and len(env_key) >= 32:
        _write_key_file(key_file, env_key.encode())
        return env_key
    if key_file.exists():
        try:
            val = key_file.read_text(encoding='utf-8').strip()
            if len(val) >= 32:
                return val
        except Exception:
            _backup_file(key_file)
    key = secrets.token_hex(32)
    _write_key_file(key_file, key.encode())
    return key


def _load_or_create_jwt_key() -> str:
    key_file = DATA_DIR / '.jwt_key'
    env_key = os.environ.get('JWT_SECRET_KEY', '').strip()
    if env_key and len(env_key) >= 32:
        _write_key_file(key_file, env_key.encode())
        return env_key
    if key_file.exists():
        try:
            val = key_file.read_text(encoding='utf-8').strip()
            if len(val) >= 32:
                return val
        except Exception:
            _backup_file(key_file)
    key = secrets.token_hex(32)
    _write_key_file(key_file, key.encode())
    return key


class Config:
    # ============================================================
    # 路径配置
    # ============================================================
    DATA_DIR: Path = DATA_DIR
    DB_PATH: Path = DATA_DIR / 'webterminal.db'
    RECORDINGS_DIR: Path = DATA_DIR / 'recordings'
    LOG_DIR: Path = DATA_DIR / 'logs'

    # ============================================================
    # 安全密钥
    # ============================================================
    SECRET_KEY: str = _load_or_create_secret_key()
    ENCRYPTION_KEY: bytes = _load_or_create_encryption_key()
    JWT_SECRET_KEY: str = _load_or_create_jwt_key()
    # 🔧 安全策略：默认 8 小时过期（原 24h 对管理平台过长）
    JWT_ACCESS_TOKEN_EXPIRES_HOURS: int = int(
        os.environ.get('JWT_ACCESS_TOKEN_EXPIRES_HOURS', '8')
    )

    # ============================================================
    # 管理账号
    # 🔧 安全修复：不再允许默认弱密码。未设置 ADMIN_PASSWORD 时自动生成随机密码。
    # 首次启动时会打印在控制台，请务必保存。
    # 🔧 使用 property 延迟读取密码，避免类定义时泄露到日志/堆栈
    # ============================================================
    ADMIN_USERNAME: str = os.environ.get('ADMIN_USERNAME', 'admin')

    # ============================================================
    # 服务器配置
    # ============================================================
    HOST: str = os.environ.get('HOST', '0.0.0.0')
    PORT: int = int(os.environ.get('PORT', '5000'))
    DEBUG: bool = os.environ.get('DEBUG', 'false').lower() == 'true'

    # ============================================================
    # CORS 跨域配置
    # ============================================================
    # 🔧 修复：过滤空字符串，防止末尾逗号产生无效元素
    ALLOWED_ORIGINS: list = [
        o.strip() for o in os.environ.get(
            'ALLOWED_ORIGINS',
            'http://localhost:5000,http://127.0.0.1:5000'
        ).split(',')
        if o.strip()
    ]

    # ============================================================
    # SSH 配置
    # ============================================================
    SSH_CONNECT_TIMEOUT: int = int(os.environ.get('SSH_CONNECT_TIMEOUT', '30'))
    SSH_BANNER_TIMEOUT: int = int(os.environ.get('SSH_BANNER_TIMEOUT', '20'))
    SSH_AUTH_TIMEOUT: int = int(os.environ.get('SSH_AUTH_TIMEOUT',    '30'))
    SSH_KEEPALIVE_INTERVAL: int = int(os.environ.get('SSH_KEEPALIVE_INTERVAL', '30'))  # TCP keepalive 间隔（秒）
    PORT_TEST_TIMEOUT: int = int(os.environ.get('PORT_TEST_TIMEOUT', '5'))
    MAX_SESSIONS: int = int(os.environ.get('MAX_SESSIONS', '50'))

    # ============================================================
    # 会话超时（秒，0=不超时）
    # ============================================================
    SESSION_IDLE_TIMEOUT: int = int(os.environ.get('SESSION_IDLE_TIMEOUT', '0'))

    # ============================================================
    # 文件传输配置
    # ============================================================
    MAX_EDIT_FILE_SIZE: int = int(
        os.environ.get('MAX_EDIT_FILE_SIZE', str(2 * 1024 * 1024))
    )
    MAX_UPLOAD_SIZE: int = int(
        os.environ.get('MAX_UPLOAD_SIZE', str(500 * 1024 * 1024))
    )
    MAX_CONCURRENT_DOWNLOADS: int = int(
        os.environ.get('MAX_CONCURRENT_DOWNLOADS', '10')
    )
    # 🔧 DoS 防护：限制单个 SSH 终端的累计输出字节数（50MB）
    MAX_TERMINAL_OUTPUT_BYTES: int = int(
        os.environ.get('MAX_TERMINAL_OUTPUT_BYTES', str(50 * 1024 * 1024))
    )
    # 🔧 DoS 防护：单条命令最大长度（100KB）
    MAX_COMMAND_LENGTH: int = int(
        os.environ.get('MAX_COMMAND_LENGTH', str(102400))
    )

    # ============================================================
    # Redis 配置（用于会话缓存、任务队列）
    # ============================================================
    REDIS_HOST: str = os.environ.get('REDIS_HOST', 'localhost')
    REDIS_PORT: int = int(os.environ.get('REDIS_PORT', '6379'))
    REDIS_PASSWORD: str = os.environ.get('REDIS_PASSWORD', '')

    # ============================================================
    # 告警配置
    # ============================================================
    ALERT_CHECK_INTERVAL: int = int(os.environ.get('ALERT_CHECK_INTERVAL', '30'))
    ALERT_COOLDOWN: int = int(os.environ.get('ALERT_COOLDOWN', '300'))

    # ============================================================
    # 巡检配置
    # ============================================================
    INSPECTION_TIMEOUT: int = int(os.environ.get('INSPECTION_TIMEOUT', '300'))
    INSPECTION_MAX_NODES: int = int(os.environ.get('INSPECTION_MAX_NODES', '100'))

    # ============================================================
    # 文件分发配置
    # ============================================================
    # 🔧 修复：Windows 上使用 tempfile 获取正确的临时目录
    _default_temp_dir = '/tmp/wt_distribute'
    if os.name == 'nt':
        import tempfile as _tempfile
        _default_temp_dir = os.path.join(_tempfile.gettempdir(), 'wt_distribute')
    DISTRIBUTE_TEMP_DIR: str = os.environ.get('DISTRIBUTE_TEMP_DIR', _default_temp_dir)
    DISTRIBUTE_MAX_CONCURRENT: int = int(os.environ.get('DISTRIBUTE_MAX_CONCURRENT', '10'))

    # ============================================================
    # Nginx 反向代理（由 app.py 自动管理）
    # ============================================================
    NGINX_ENABLED: bool = (
        os.environ.get('NGINX_ENABLED', 'false').lower() == 'true'
    )
    NGINX_PATH: str = os.environ.get('NGINX_PATH', '')
    NGINX_PORT: int = int(os.environ.get('NGINX_PORT', '8088'))

    # ============================================================
    # 功能开关
    # ============================================================
    ENABLE_RECORDING: bool = (
        os.environ.get('ENABLE_RECORDING', 'false').lower() == 'true'
    )

    # ============================================================
    # 日志配置
    # ============================================================
    LOG_MAX_BYTES: int = 10 * 1024 * 1024
    LOG_BACKUP_COUNT: int = 5

    # ============================================================
    # 历史记录
    # ============================================================
    QUICK_CONNECT_HISTORY_MAX: int = int(
        os.environ.get('QUICK_CONNECT_HISTORY_MAX', '20')
    )

    # ============================================================
    # 登录限流
    # ============================================================
    LOGIN_MAX_ATTEMPTS: int = int(os.environ.get('LOGIN_MAX_ATTEMPTS', '5'))
    LOGIN_LOCKOUT_SECS: int = int(os.environ.get('LOGIN_LOCKOUT_SECS', '300'))

    # ============================================================
    # AI 配置
    # ============================================================
    GROQ_API_KEY: str = os.environ.get('GROQ_API_KEY', '')
    GROQ_MODEL: str = os.environ.get('GROQ_MODEL', 'openai/gpt-oss-120b')
    AI_ENABLED: bool = os.environ.get('AI_ENABLED', 'true').lower() == 'true'

    # ============================================================
    # 属性
    # ============================================================

    @property
    def ADMIN_PASSWORD(self) -> str:
        """延迟读取密码，避免类定义时泄露到日志/堆栈"""
        env_pw = os.environ.get('ADMIN_PASSWORD', '').strip()
        if env_pw:
            return env_pw
        # 自动生成密码只读取一次并缓存
        if not hasattr(self, '_auto_password'):
            self._auto_password = secrets.token_urlsafe(16)
        return self._auto_password

    @property
    def IS_DEFAULT_PASSWORD(self) -> bool:
        """密码来自自动生成（未通过环境变量设置），视为非安全密码"""
        return not bool(os.environ.get('ADMIN_PASSWORD', '').strip())


# 创建全局配置实例
config = Config()

# 确保必要的目录存在
config.RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
config.LOG_DIR.mkdir(parents=True, exist_ok=True)
Path(config.DISTRIBUTE_TEMP_DIR).mkdir(parents=True, exist_ok=True)

# ══════════════════════════════════════════
# 启动时 AI 配置诊断
# ══════════════════════════════════════════
_groq_key = config.GROQ_API_KEY
_ai_cfg_file = config.DATA_DIR / 'ai_config.json'

print(f'[启动诊断] AI 配置状态:')
print(f'  AI_ENABLED        = {config.AI_ENABLED}')
print(f'  GROQ_API_KEY      = {"已设置(" + _groq_key[:8] + "...)" if _groq_key else "未设置"}')
print(f'  GROQ_MODEL        = {config.GROQ_MODEL}')
print(f'  .env 加载来源     = {_env_loaded_from or "未找到"}')
print(f'  DATA_DIR          = {config.DATA_DIR}')
print(f'  ai_config.json    = {"存在" if _ai_cfg_file.exists() else "不存在"}')
if _ai_cfg_file.exists():
    try:
        _raw_cfg = __import__('json').loads(_ai_cfg_file.read_text(encoding='utf-8'))
        _has_enc = bool(_raw_cfg.get('api_key_enc'))
        _has_plain = bool(_raw_cfg.get('api_key'))
        print(f'  ai_config.json    = has_encrypted={_has_enc}, has_plaintext={_has_plain}')
    except Exception:
        print(f'  ai_config.json    = 读取失败（可能损坏）')

if config.AI_ENABLED and not _groq_key:
    _has_user_cfg = _ai_cfg_file.exists()
    if _has_user_cfg:
        print('[INFO] AI_ENABLED=true, GROQ_API_KEY 环境变量未设置，但 ai_config.json 存在，将通过用户配置提供 Key')
    else:
        print('[WARNING] AI_ENABLED=true 但 GROQ_API_KEY 未设置且 ai_config.json 不存在，AI 功能将不可用')
        print('[提示] 请在 .env 中设置 GROQ_API_KEY 或通过前端设置页面配置')
elif not config.AI_ENABLED:
    print('[INFO] AI_ENABLED=false，AI 功能已全局禁用')
elif _groq_key:
    print('[OK] AI 配置完整，功能可用')