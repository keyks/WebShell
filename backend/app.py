# -*- coding: utf-8 -*-
# backend/app.py
"""
WebTerminal Server v3.0
"""
import eventlet
eventlet.monkey_patch()

import os
import json
import time
import posixpath
import threading
import asyncio
from datetime import datetime, timedelta
from functools import wraps
from collections import defaultdict, OrderedDict
from dataclasses import asdict

from flask import (
    Flask, request, jsonify, send_from_directory, send_file,
    g, Response, stream_with_context, after_this_request
)
from flask_socketio import SocketIO, emit
from flask_cors import CORS
from flask_jwt_extended import (
    JWTManager, create_access_token,
    get_jwt_identity, get_jwt, verify_jwt_in_request, decode_token
)

from config import config
from nginx_manager import start_nginx
from logger import log, audit_log


from core import db, ssh_manager

from sftp_manager import SFTPManager
from session_recorder import list_recordings, load_recording
from session_recovery import SessionRecoveryManager, SessionSnapshot

from diagnose import get_diagnostic_engine


# ══════════════════════════════════════════
#  工具函数
# ══════════════════════════════════════════

def _validate_port(value, default: int = 22) -> int:
    """校验端口号范围 1-65535，非法值返回默认值"""
    try:
        port = int(value)
        if 1 <= port <= 65535:
            return port
    except (TypeError, ValueError):
        pass
    return default


def _cleanup_temp_files(*paths):
    """🔧 安全清理临时文件/目录，防止包含敏感信息（API Key）的临时文件残留"""
    import shutil as _shutil
    for p in paths:
        try:
            if os.path.isdir(p):
                _shutil.rmtree(p, ignore_errors=True)
            else:
                os.unlink(p)
        except Exception:
            pass


# ══════════════════════════════════════════
#  应用初始化
# ══════════════════════════════════════════

app = Flask(__name__, static_folder='../frontend', static_url_path='')
# 🔧 安全修复：根据环境变量决定是否启用 HTTPS 安全配置
_secure_cookies = os.environ.get('SECURE_COOKIES', 'false').lower() == 'true'
app.config.update(
    SECRET_KEY=config.SECRET_KEY,
    JWT_SECRET_KEY=config.JWT_SECRET_KEY,
    JWT_ACCESS_TOKEN_EXPIRES=timedelta(hours=config.JWT_ACCESS_TOKEN_EXPIRES_HOURS),
    JWT_TOKEN_LOCATION=['headers', 'cookies'],
    JWT_COOKIE_SECURE=_secure_cookies,
    JWT_COOKIE_CSRF_PROTECT=_secure_cookies,
    MAX_CONTENT_LENGTH=config.MAX_UPLOAD_SIZE if config.MAX_UPLOAD_SIZE > 0 else None,
    MAX_FORM_MEMORY_SIZE=1 * 1024 * 1024,
)

CORS(app, origins=config.ALLOWED_ORIGINS, supports_credentials=True)
socketio = SocketIO(
    app,
    cors_allowed_origins=config.ALLOWED_ORIGINS,
    async_mode='eventlet',
    max_http_buffer_size=10 * 1024 * 1024,
    per_message_deflate=True,  # 启用 WebSocket 压缩，减少终端输出带宽
)
jwt_manager = JWTManager(app)
_start_time = time.time()


# ══════════════════════════════════════════
#  安全辅助函数
# ══════════════════════════════════════════

def _get_real_ip():
    """获取真实客户端 IP（支持反向代理 X-Forwarded-For）"""
    forwarded = request.headers.get('X-Forwarded-For', '')
    if forwarded:
        # 取链中第一个 IP（真实客户端），去除空白
        real = forwarded.split(',')[0].strip()
        if real:
            return real
    return request.remote_addr or '0.0.0.0'


# ══════════════════════════════════════════
#  统一安全响应头 (after_request 钩子)
# ══════════════════════════════════════════

@app.after_request
def _add_security_headers(response):
    """为所有 HTTP 响应添加安全头部"""
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('X-Frame-Options', 'DENY')
    response.headers.setdefault('X-XSS-Protection', '1; mode=block')
    response.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
    response.headers.setdefault('Permissions-Policy',
                                 'camera=(), microphone=(), geolocation=()')
    response.headers.setdefault('Cache-Control',
                                 'no-store, max-age=0')
    return response


# ══════════════════════════════════════════
#  启动告警引擎
# ══════════════════════════════════════════

from alert_engine import alert_engine
alert_engine.start()

# ══════════════════════════════════════════
#  登录限流
# ══════════════════════════════════════════

_login_attempts: dict = defaultdict(list)
_login_lock = threading.Lock()


def _check_login_rate_limit(ip: str) -> tuple:
    now = time.time()
    with _login_lock:
        cutoff = now - config.LOGIN_LOCKOUT_SECS
        _login_attempts[ip] = [t for t in _login_attempts[ip] if t > cutoff]
        attempts = _login_attempts[ip]
        if len(attempts) >= config.LOGIN_MAX_ATTEMPTS:
            oldest = min(attempts)
            remain = int(config.LOGIN_LOCKOUT_SECS - (now - oldest))
            return False, max(0, remain)
        return True, 0


def _record_login_failure(ip: str):
    with _login_lock:
        _login_attempts[ip].append(time.time())


def _clear_login_attempts(ip: str):
    with _login_lock:
        _login_attempts.pop(ip, None)


# ══════════════════════════════════════════
#  下载并发限制
# ══════════════════════════════════════════

_download_semaphore = threading.Semaphore(config.MAX_CONCURRENT_DOWNLOADS)


# ══════════════════════════════════════════
#  启动安全检查
# ══════════════════════════════════════════

def _startup_security_check():
    if config.IS_DEFAULT_PASSWORD:
        # 🔧 安全硬化工：生产环境未设置 ADMIN_PASSWORD 时拒绝启动
        # 仅在 DEBUG 模式或显式设置 ALLOW_AUTO_PASSWORD=true 时允许自动生成
        if not config.DEBUG and not os.environ.get('ALLOW_AUTO_PASSWORD', '').lower() == 'true':
            log.critical('=' * 60)
            log.critical('  致命错误：ADMIN_PASSWORD 环境变量未设置！')
            log.critical('  生产环境严禁使用自动生成的随机密码。')
            log.critical('  请设置环境变量: ADMIN_PASSWORD=<your-strong-password>')
            log.critical('  或开发环境使用: DEBUG=true ALLOW_AUTO_PASSWORD=true')
            log.critical('=' * 60)
            import sys
            sys.exit(1)

        # DEBUG / ALLOW_AUTO_PASSWORD 模式
        # 🔧 安全修复 v3：不将密码写入文件，不在 stderr 打印密码
        # 生产环境必须拒绝启动；开发环境输出简短提示但不泄露密码原文
        log.warning('=' * 60)
        log.warning('  ⚠️  ADMIN_PASSWORD 未通过环境变量设置！')
        log.warning('  [开发模式] 已自动生成初始密码（用户名: admin）')
        log.warning('  密码仅限本次运行使用，重启后将重新生成')
        log.warning('  启动后请立即通过前端或 API 修改密码')
        log.warning('  export ADMIN_PASSWORD=your_strong_password')
        log.warning('=' * 60)


_startup_security_check()


# ══════════════════════════════════════════
#  空闲会话清理
# ══════════════════════════════════════════

def _idle_session_cleaner():
    while True:
        try:
            socketio.sleep(60)
            cleaned = ssh_manager.cleanup_idle_sessions()
            for sid in cleaned:
                socketio.emit('terminal_error', {
                    'message': '会话因长时间无操作已自动断开',
                    'session_id': sid
                })
        except Exception as e:
            log.error(f'[Cleaner] 清理异常: {e}')


if config.SESSION_IDLE_TIMEOUT > 0:
    socketio.start_background_task(_idle_session_cleaner)


# ══════════════════════════════════════════
#  认证工具
# ══════════════════════════════════════════

def require_jwt(fn):
    """JWT 认证装饰器 - 所有 API 请求必须携带有效 JWT Token"""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            verify_jwt_in_request()
            g.current_user = get_jwt_identity()

            # 🔧 修复：直接使用 get_jwt() 获取 jti，避免二次 decode_token 开销
            jti = get_jwt().get('jti', '')
            if jti:
                with _token_blacklist_lock:
                    if jti in _token_blacklist:
                        return jsonify({'status': 'error', 'message': 'Token 已失效，请重新登录'}), 401

        except Exception:
            return jsonify({'status': 'error', 'message': '请先登录'}), 401
        return fn(*args, **kwargs)
    return wrapper


def _verify_ws_token(token: str):
    """WebSocket Token 验证 - 所有 WebSocket 连接必须携带有效 JWT Token"""
    if not token:
        return None
    try:
        # 🔧 修复：验证 Token 是否过期
        data = decode_token(token)
        if not data:
            return None
        # 检查过期时间
        exp = data.get('exp')
        if exp and exp < time.time():
            log.warning(f'[WS] Token 已过期')
            return None
        return data.get('sub')
    except Exception:
        return None


def _fmt_size(size: int) -> str:
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size < 1024:
            return f'{size:.1f} {unit}'
        size /= 1024
    return f'{size:.1f} PB'


# ══════════════════════════════════════════
#  静态文件
# ══════════════════════════════════════════

@app.route('/')
def index():
    return send_from_directory('../frontend', 'index.html')


@app.route('/<path:path>')
def static_files(path):
    if path.startswith('api/'):
        from flask import abort
        abort(404)
    from flask import send_from_directory
    return send_from_directory('../frontend/libs', path)

# ══════════════════════════════════════════
#  认证 API
# ══════════════════════════════════════════

@app.route('/api/login', methods=['POST'])
def login():
    ip = _get_real_ip()
    data = request.json or {}
    username = data.get('username', '').strip()
    password = data.get('password', '')

    allowed, remain = _check_login_rate_limit(ip)
    if not allowed:
        return jsonify({
            'status': 'error',
            'message': f'登录尝试过多，请 {remain} 秒后再试'
        }), 429

    if username == config.ADMIN_USERNAME and password == config.ADMIN_PASSWORD:
        _clear_login_attempts(ip)
        token = create_access_token(identity=username)
        db.add_audit('LOGIN', user=username, ip=ip)
        return jsonify({
            'status': 'ok',
            'token': token,
            'username': username,
            'is_default_password': config.IS_DEFAULT_PASSWORD
        })

    _record_login_failure(ip)
    db.add_audit('LOGIN_FAIL', user=username, ip=ip)

    # 🔧 修复：复用已锁定的计数，避免重复获取 time.time()
    with _login_lock:
        remaining = config.LOGIN_MAX_ATTEMPTS - len(_login_attempts[ip])

    msg = '用户名或密码错误'
    if remaining <= 2:
        msg += f'（还剩 {max(0, remaining)} 次机会）'

    return jsonify({'status': 'error', 'message': msg}), 401


# 🔧 Token 黑名单（带 TTL 自动过期，防止内存无限增长）
class _TokenBlacklist:
    """带 TTL 的 Token 黑名单，自动过期清理"""

    def __init__(self, max_size=10000, default_ttl=86400):
        self._store = OrderedDict()  # jti -> expires_at
        self._lock = threading.Lock()
        self._max_size = max_size
        self._default_ttl = default_ttl
        self._last_cleanup = 0

    def add(self, jti: str, expires_at: float = None):
        now = time.time()
        if expires_at is None or expires_at <= 0:
            expires_at = now + self._default_ttl
        with self._lock:
            self._store[jti] = expires_at
            self._store.move_to_end(jti)
            # 触发清理
            if len(self._store) > self._max_size or now - self._last_cleanup > 300:
                self._cleanup(now)

    def __contains__(self, jti: str) -> bool:
        now = time.time()
        with self._lock:
            exp = self._store.get(jti)
            if exp is None:
                return False
            if exp < now:
                del self._store[jti]
                return False
            return True

    def _cleanup(self, now: float):
        """清理过期 token，保留最近访问的"""
        expired = [k for k, v in self._store.items() if v < now]
        for k in expired:
            del self._store[k]
        # 如果仍然过大，移除最旧的
        while len(self._store) > self._max_size:
            self._store.popitem(last=False)
        self._last_cleanup = now


_token_blacklist = _TokenBlacklist()
_token_blacklist_lock = threading.Lock()

@app.route('/api/logout', methods=['POST'])
@require_jwt
def logout():
    """退出登录：将当前 JWT Token 加入黑名单"""
    try:
        # 获取当前请求的 JWT
        raw_jwt = None
        auth_header = request.headers.get('Authorization', '')
        if auth_header.startswith('Bearer '):
            raw_jwt = auth_header[7:]
        elif 'access_token_cookie' in request.cookies:
            raw_jwt = request.cookies.get('access_token_cookie')

        if raw_jwt:
            # 🔧 修复：优先使用 JWT jti，避免截断碰撞
            try:
                decoded = decode_token(raw_jwt)
                jti = decoded.get('jti', '')
                exp = decoded.get('exp', 0)
            except Exception:
                jti = raw_jwt[:64] if len(raw_jwt) >= 64 else raw_jwt
                exp = 0
            # 🔧 修复：使用带 TTL 的 _TokenBlacklist，自动过期清理
            with _token_blacklist_lock:
                _token_blacklist.add(jti, exp if exp > 0 else None)
            log.info(f'[Logout] Token 已加入黑名单: {g.current_user}')
            db.add_audit('LOGOUT', user=getattr(g, 'current_user', ''), ip=_get_real_ip())

        return jsonify({'status': 'ok'})
    except Exception:
        return jsonify({'status': 'ok'})


@app.route('/api/me', methods=['GET'])
@require_jwt
def me():
    return jsonify({
        'status': 'ok',
        'username': getattr(g, 'current_user', 'guest'),
        'is_default_password': config.IS_DEFAULT_PASSWORD
    })


# ══════════════════════════════════════════
#  连接管理 API
# ══════════════════════════════════════════

@app.route('/api/connections', methods=['GET'])
@require_jwt
def get_connections():
    conns = db.get_all_connections_light()
    safe = []
    for c in conns:
        s = dict(c)
        # 对已保存了凭据的连接标记 has_* 标志（通过单独查询，避免批量解密）
        s['has_password']  = False
        s['has_key']       = False
        s['has_passphrase'] = False
        safe.append(s)
    # 批量查询哪些连接有凭据（只查 id + 非空标志）
    with db.get_conn() as conn:
        rows = conn.execute(
            "SELECT id, password_enc!='' AS hp, private_key_enc!='' AS hk, "
            "private_key_passphrase_enc!='' AS hpp FROM connections "
            "WHERE password_enc!='' OR private_key_enc!='' OR private_key_passphrase_enc!=''"
        ).fetchall()
    flags = {r['id']: r for r in rows}
    for s in safe:
        f = flags.get(s['id'])
        if f:
            s['has_password']  = bool(f['hp'])
            s['has_key']       = bool(f['hk'])
            s['has_passphrase'] = bool(f['hpp'])
    return jsonify({'status': 'ok', 'data': safe})


@app.route('/api/connections', methods=['POST'])
@require_jwt
def add_connection():
    data = request.json or {}
    # 🔧 调试：记录前端传来的完整连接信息
    pw = data.get('password', '')
    key = data.get('private_key', '')
    log.info(f'[AddConnection] ═══ 收到保存连接请求 ═══')
    log.info(f'[AddConnection] name={data.get("name","")}, host={data.get("host","")}, port={data.get("port",22)}')
    log.info(f'[AddConnection] username={data.get("username","")}, authType={data.get("authType","password")}')
    log.info(f'[AddConnection] has_password={bool(pw)}, has_key={bool(key)}, has_passphrase={bool(data.get("private_key_passphrase",""))}')
    conn = db.add_connection(data)
    db.add_audit('ADD_CONN', user=getattr(g, 'current_user', ''),
                 target=data.get('host', ''), ip=_get_real_ip())
    # 🔧 安全修复：不返回完整的密码/私钥内容
    safe = {k: v for k, v in conn.items()
            if k not in ('password', 'private_key', 'private_key_passphrase')}
    safe['has_password'] = bool(conn.get('password'))
    safe['has_key'] = bool(conn.get('private_key'))
    safe['has_passphrase'] = bool(conn.get('private_key_passphrase'))
    return jsonify({'status': 'ok', 'data': safe})


@app.route('/api/connections/<conn_id>', methods=['GET'])
@require_jwt
def get_connection(conn_id):
    conn = db.get_connection(conn_id)
    if not conn:
        return jsonify({'status': 'error', 'message': '连接不存在'}), 404
    # 🔧 安全修复：不返回完整的私钥/密码内容，仅返回布尔标记
    safe = {k: v for k, v in conn.items()
            if k not in ('password', 'private_key', 'private_key_passphrase')}
    safe['has_password'] = bool(conn.get('password'))
    safe['has_key'] = bool(conn.get('private_key'))
    safe['has_passphrase'] = bool(conn.get('private_key_passphrase'))
    # 🔧 安全修复：返回真正的 SHA256 哈希指纹，而非私钥内容截断
    pk = conn.get('private_key', '')
    if pk:
        import hashlib
        safe['key_fingerprint'] = 'SHA256:' + hashlib.sha256(pk.encode()).hexdigest()[:16]
    return jsonify({'status': 'ok', 'data': safe})


@app.route('/api/connections/<conn_id>', methods=['PUT'])
@require_jwt
def update_connection(conn_id):
    data = request.json or {}
    conn = db.update_connection(conn_id, data)
    if not conn:
        return jsonify({'status': 'error', 'message': '连接不存在'}), 404
    db.add_audit('UPDATE_CONN', user=getattr(g, 'current_user', ''),
                 target=conn_id, ip=_get_real_ip())
    # 🔧 安全修复：不返回完整的密码/私钥内容，与 GET 接口一致
    safe = {k: v for k, v in conn.items()
            if k not in ('password', 'private_key', 'private_key_passphrase')}
    safe['has_password'] = bool(conn.get('password'))
    safe['has_key'] = bool(conn.get('private_key'))
    safe['has_passphrase'] = bool(conn.get('private_key_passphrase'))
    return jsonify({'status': 'ok', 'data': safe})


@app.route('/api/connections/<conn_id>', methods=['DELETE'])
@require_jwt
def delete_connection(conn_id):
    db.delete_connection(conn_id)
    db.add_audit('DEL_CONN', user=getattr(g, 'current_user', ''),
                 target=conn_id, ip=_get_real_ip())
    return jsonify({'status': 'ok'})


# ══════════════════════════════════════════
#  分组 API
# ══════════════════════════════════════════

@app.route('/api/groups', methods=['GET'])
@require_jwt
def get_groups():
    return jsonify({'status': 'ok', 'data': db.get_groups()})


@app.route('/api/groups', methods=['POST'])
@require_jwt
def add_group():
    data = request.json or {}
    group = db.add_group(data.get('name', '新分组'))
    return jsonify({'status': 'ok', 'data': group})


@app.route('/api/groups/<group_id>', methods=['DELETE'])
@require_jwt
def delete_group(group_id):
    db.delete_group(group_id)
    return jsonify({'status': 'ok'})


# ══════════════════════════════════════════
#  快速连接历史
# ══════════════════════════════════════════

@app.route('/api/quick-history', methods=['GET'])
@require_jwt
def get_quick_history():
    return jsonify({'status': 'ok',
                    'data': db.get_quick_history(config.QUICK_CONNECT_HISTORY_MAX)})


@app.route('/api/quick-history/<hid>', methods=['DELETE'])
@require_jwt
def delete_quick_history(hid):
    db.delete_quick_history(hid)
    return jsonify({'status': 'ok'})


@app.route('/api/quick-history/clear', methods=['POST'])
@require_jwt
def clear_quick_history():
    db.clear_quick_history()
    return jsonify({'status': 'ok'})


# ══════════════════════════════════════════
#  快捷命令
# ══════════════════════════════════════════

@app.route('/api/shortcuts', methods=['GET'])
@require_jwt
def get_shortcuts():
    return jsonify({'status': 'ok', 'data': db.get_shortcuts()})


@app.route('/api/shortcuts', methods=['POST'])
@require_jwt
def add_shortcut():
    data = request.json or {}
    try:
        s = db.add_shortcut(
            data.get('name', ''),
            data.get('command', ''),
            data.get('description', '')
        )
        return jsonify({'status': 'ok', 'data': s})
    except ValueError as e:
        return jsonify({'status': 'error', 'message': str(e)}), 400


@app.route('/api/shortcuts/<sid>', methods=['PUT'])
@require_jwt
def update_shortcut(sid):
    data = request.json or {}
    db.update_shortcut(sid, data.get('name', ''),
                       data.get('command', ''), data.get('description', ''))
    return jsonify({'status': 'ok'})


@app.route('/api/shortcuts/<sid>', methods=['DELETE'])
@require_jwt
def delete_shortcut(sid):
    db.delete_shortcut(sid)
    return jsonify({'status': 'ok'})


# ══════════════════════════════════════════
#  SFTP 辅助
# ══════════════════════════════════════════

def _get_sftp_or_error(session_id: str):
    session = ssh_manager.get_session(session_id)
    if not session:
        return None, (jsonify({'status': 'error', 'message': '会话不存在'}), 404)
    sftp = session.get_sftp()
    if not sftp:
        return None, (jsonify({'status': 'error', 'message': 'SFTP 连接失败'}), 500)
    return sftp, None


# 🔧 新增：上传临时文件清理辅助函数
def _cleanup_temp_upload(upload_sftp, tmp_path: str):
    """清理上传产生的临时文件"""
    try:
        upload_sftp.remove(tmp_path)
    except Exception:
        pass


# ══════════════════════════════════════════
#  SFTP API
# ══════════════════════════════════════════

@app.route('/api/sftp/<session_id>/list')
@require_jwt
def sftp_list(session_id):
    path = SFTPManager.normalize(request.args.get('path', '/'))
    sftp, err = _get_sftp_or_error(session_id)
    if err:
        return err
    files, error, code = SFTPManager.list_directory(sftp, path)
    if error:
        return jsonify({'status': 'error', 'message': error}), code
    return jsonify({'status': 'ok', 'data': files, 'path': path})


@app.route('/api/sftp/<session_id>/read')
@require_jwt
def sftp_read(session_id):
    path = request.args.get('path', '')
    sftp, err = _get_sftp_or_error(session_id)
    if err:
        return err
    content, error = SFTPManager.read_file(sftp, path)
    if error:
        return jsonify({'status': 'error', 'message': error}), 500
    return jsonify({'status': 'ok', 'data': content})


@app.route('/api/sftp/<session_id>/write', methods=['POST'])
@require_jwt
def sftp_write(session_id):
    data = request.json or {}
    sftp, err = _get_sftp_or_error(session_id)
    if err:
        return err
    ok, error = SFTPManager.write_file(sftp, data.get('path', ''), data.get('content', ''))
    if error:
        return jsonify({'status': 'error', 'message': error}), 500
    return jsonify({'status': 'ok'})


@app.route('/api/sftp/<session_id>/mkdir', methods=['POST'])
@require_jwt
def sftp_mkdir(session_id):
    data = request.json or {}
    sftp, err = _get_sftp_or_error(session_id)
    if err:
        return err
    ok, error = SFTPManager.create_directory(sftp, data.get('path', ''))
    if error:
        return jsonify({'status': 'error', 'message': error}), 500
    return jsonify({'status': 'ok'})


@app.route('/api/sftp/<session_id>/delete', methods=['POST'])
@require_jwt
def sftp_delete(session_id):
    data = request.json or {}
    sftp, err = _get_sftp_or_error(session_id)
    if err:
        return err
    fn = SFTPManager.delete_directory if data.get('is_dir') else SFTPManager.delete_file
    ok, error = fn(sftp, data.get('path', ''))
    if error:
        return jsonify({'status': 'error', 'message': error}), 500
    return jsonify({'status': 'ok'})


@app.route('/api/sftp/<session_id>/rename', methods=['POST'])
@require_jwt
def sftp_rename(session_id):
    data = request.json or {}
    sftp, err = _get_sftp_or_error(session_id)
    if err:
        return err
    ok, error = SFTPManager.rename(
        sftp, data.get('old_path', ''), data.get('new_path', '')
    )
    if error:
        return jsonify({'status': 'error', 'message': error}), 500
    return jsonify({'status': 'ok'})


@app.route('/api/sftp/<session_id>/chmod', methods=['POST'])
@require_jwt
def sftp_chmod(session_id):
    data = request.json or {}
    sftp, err = _get_sftp_or_error(session_id)
    if err:
        return err
    ok, error = SFTPManager.chmod(
        sftp, data.get('path', ''), data.get('mode', '755')
    )
    if error:
        return jsonify({'status': 'error', 'message': error}), 500
    return jsonify({'status': 'ok'})


@app.route('/api/sftp/<session_id>/download')
@require_jwt
def sftp_download(session_id):
    """流式下载 + 并发限制 + 独立 SFTP 通道"""
    path = request.args.get('path', '')
    if not path:
        return jsonify({'status': 'error', 'message': '缺少文件路径'}), 400

    session = ssh_manager.get_session(session_id)
    if not session or not session.client:
        return jsonify({'status': 'error', 'message': '会话不存在'}), 404

    if not _download_semaphore.acquire(blocking=False):
        return jsonify({
            'status': 'error',
            'message': f'下载并发已达上限（{config.MAX_CONCURRENT_DOWNLOADS}），请稍后再试'
        }), 429

    released = False

    def _release_once():
        nonlocal released
        if not released:
            released = True
            _download_semaphore.release()

    try:
        sftp, err = _get_sftp_or_error(session_id)
        if err:
            _release_once()
            return err

        file_stat = sftp.stat(path)
        file_size = file_stat.st_size or 0
        filename = posixpath.basename(path)

        download_sftp = session.open_extra_sftp()
        if not download_sftp:
            _release_once()
            return jsonify({'status': 'error', 'message': '打开下载通道失败'}), 500

        remote_file = download_sftp.open(path, 'rb')
        if file_size > 0:
            remote_file.prefetch(file_size)

        CHUNK_SIZE = 1024 * 1024

        def generate():
            try:
                while True:
                    chunk = remote_file.read(CHUNK_SIZE)
                    if not chunk:
                        break
                    yield chunk
            except GeneratorExit:
                # 客户端断开连接，正常清理
                pass
            except Exception as e:
                log.error(f'[Download] 流读取失败: {e}')
            finally:
                # 🔧 确保在任何异常情况下都执行清理
                try:
                    remote_file.close()
                except Exception:
                    pass
                try:
                    _release_once()
                except Exception:
                    pass
                try:
                    session.close_extra_sftp(download_sftp)
                except Exception:
                    pass

        try:
            resp = Response(
                stream_with_context(generate()),
                mimetype='application/octet-stream',
                direct_passthrough=True,
            )

            try:
                filename_latin = filename.encode('utf-8').decode('latin-1')
            except Exception:
                filename_latin = 'download'

            resp.headers['Content-Disposition'] = (
                f"attachment; filename=\"{filename_latin}\"; "
                f"filename*=UTF-8''{filename}"
            )
            if file_size > 0:
                resp.headers['Content-Length'] = str(file_size)
            resp.headers['X-Content-Type-Options'] = 'nosniff'
            resp.headers['Cache-Control'] = 'no-cache, no-store'

            log.info(f'[Download] 开始: {path} ({_fmt_size(file_size)})')
            return resp
        except Exception:
            # 如果 Response 创建或 header 设置失败，确保信号量被释放
            _release_once()
            try:
                remote_file.close()
            except Exception:
                pass
            session.close_extra_sftp(download_sftp)
            raise

    except PermissionError:
        _release_once()
        return jsonify({'status': 'error', 'message': '权限不足'}), 403
    except FileNotFoundError:
        _release_once()
        return jsonify({'status': 'error', 'message': '文件不存在'}), 404
    except Exception as e:
        _release_once()
        log.error(f'[Download] 失败: {e}')
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/sftp/<session_id>/upload', methods=['POST'])
@require_jwt
def sftp_upload(session_id):
    path = request.form.get('path', '/')

    session = ssh_manager.get_session(session_id)
    if not session or not session.client:
        return jsonify({'status': 'error', 'message': '会话不存在'}), 404

    if 'file' not in request.files:
        return jsonify({'status': 'error', 'message': '没有文件'}), 400

    f = request.files['file']
    filename = (f.filename or '').strip()
    if not filename:
        return jsonify({'status': 'error', 'message': '文件名为空'}), 400

    upload_path = path.rstrip('/')
    remote_path = posixpath.normpath(
        f"{upload_path}/{filename}" if upload_path else f"/{filename}"
    )

    upload_sftp = session.open_extra_sftp()
    if not upload_sftp:
        return jsonify({'status': 'error', 'message': '打开上传通道失败'}), 500

    # 🔧 原子性上传：先上传到临时文件，完成后再 rename 到目标路径
    tmp_path = f"{remote_path}.wt_upload_{int(time.time() * 1000)}"
    try:
        upload_sftp.putfo(f.stream, tmp_path)
        # 验证临时文件已写入（检查文件大小 > 0）
        try:
            st = upload_sftp.stat(tmp_path)
            if st.st_size == 0:
                raise OSError('上传后文件大小为 0，传输可能不完整')
        except FileNotFoundError:
            raise OSError('临时文件未创建，上传失败')
        # 原子性 rename 到目标路径
        upload_sftp.rename(tmp_path, remote_path)
        log.info(f'[Upload] 完成（原子性）: {remote_path}')
        return jsonify({'status': 'ok', 'path': remote_path})
    except PermissionError:
        _cleanup_temp_upload(upload_sftp, tmp_path)
        return jsonify({'status': 'error', 'message': '权限不足，无法写入文件'}), 403
    except OSError as e:
        log.error(f'[Upload] IO 错误: {e}')
        _cleanup_temp_upload(upload_sftp, tmp_path)
        return jsonify({'status': 'error', 'message': f'写入失败: {str(e)}'}), 500
    except Exception as e:
        log.error(f'[Upload] 失败: {e}')
        _cleanup_temp_upload(upload_sftp, tmp_path)
        return jsonify({'status': 'error', 'message': str(e)}), 500
    finally:
        session.close_extra_sftp(upload_sftp)


# ══════════════════════════════════════════
#  监控 / 测试 / 录制 / 审计 / 健康
# ══════════════════════════════════════════

@app.route('/api/monitor/<session_id>')
@require_jwt
def get_monitor(session_id):
    session = ssh_manager.get_session(session_id)
    if not session:
        return jsonify({'status': 'error', 'message': '会话不存在'}), 404
    return jsonify({'status': 'ok', 'data': session.get_system_info()})


@app.route('/api/test-connection', methods=['POST'])
@require_jwt
def test_connection():
    from ssh_manager import SSHSession
    data = request.json or {}
    host = data.get('host', '').strip()
    port = _validate_port(data.get('port', 22))
    if not host:
        return jsonify({'status': 'error', 'message': '请输入主机地址'})
    ok = SSHSession.test_port(host, port)
    msg = f'{host}:{port} 可达' if ok else f'{host}:{port} 不可达'
    return jsonify({'status': 'ok' if ok else 'error', 'message': msg})


@app.route('/api/recordings')
@require_jwt
def get_recordings():
    return jsonify({'status': 'ok', 'data': list_recordings()})


@app.route('/api/recordings/<filename>')
@require_jwt
def get_recording(filename):
    data = load_recording(filename)
    if not data:
        return jsonify({'status': 'error', 'message': '录制文件不存在'}), 404
    return jsonify({'status': 'ok', 'data': data})


@app.route('/api/audit-logs')
@require_jwt
def get_audit_logs():
    limit = min(int(request.args.get('limit', 100)), 1000)
    return jsonify({'status': 'ok', 'data': db.get_audit_logs(limit)})


@app.route('/health')
def health():
    # 🔧 安全修复：只返回基本健康状态，不暴露版本号
    return jsonify({'status': 'healthy'})


@app.route('/api/status', methods=['GET'])
@require_jwt
def api_status():
    """仪表盘系统状态（运行时间 + AI 就绪状态）"""
    effective = get_effective_ai_config()
    ai_ready = effective['enabled'] and bool(effective['api_key'])
    return jsonify({
        'status': 'ok',
        'data': {
            'uptime': time.time() - _start_time,
            'ai_ready': ai_ready,
        }
    })


# ══════════════════════════════════════════
#  会话恢复
# ══════════════════════════════════════════

@app.route('/api/session/recover/<session_id>', methods=['GET'])
@require_jwt
def recover_session(session_id):
    snapshot = SessionRecoveryManager.get_snapshot(session_id)
    if not snapshot:
        return jsonify({'status': 'error', 'message': '会话快照不存在'}), 404

    session = ssh_manager.get_session(session_id)
    if session and session.connected:
        # ✅ 会话仍存活，直接返回快照信息，让前端重建 UI
        return jsonify({
            'status': 'ok',
            'message': '会话仍在连接',
            'recovered': False,
            'still_alive': True,
            'snapshot': asdict(snapshot)
        })

    conn_info = db.get_connection(snapshot.conn_id)
    if not conn_info:
        # 尝试用快照中的信息重连
        conn_info = {
            'host': snapshot.host,
            'port': snapshot.port,
            'username': snapshot.username,
        }
        # 没有密码信息，无法重连
        SessionRecoveryManager.delete_snapshot(session_id)
        return jsonify({'status': 'error', 'message': '连接配置已删除，无法恢复'}), 404

    success, msg = ssh_manager.create_session(session_id, conn_info, snapshot.host)
    if not success:
        return jsonify({'status': 'error', 'message': msg}), 500

    session = ssh_manager.get_session(session_id)
    if session:
        # 🔧 安全修复：对 pwd 和 env_vars 进行 shell 转义，防止命令注入
        _safe_pwd = snapshot.pwd.replace('"', '\\"')
        session.send_command(f'cd "{_safe_pwd}"\n')
        for key, value in snapshot.env_vars.items():
            _safe_key = key.replace('"', '\\"').replace("'", "\\'")
            _safe_value = value.replace('"', '\\"').replace("'", "\\'")
            session.send_command(f'export {_safe_key}="{_safe_value}"\n')

    return jsonify({
        'status': 'ok',
        'message': '会话已恢复',
        'recovered': True,
        'still_alive': False,
        'snapshot': asdict(snapshot)
    })

# ══════════════════════════════════════════
#  告警 API
# ══════════════════════════════════════════

@app.route('/api/alerts', methods=['GET'])
@require_jwt
def get_alerts():
    limit = min(int(request.args.get('limit', 100)), 500)
    alerts = alert_engine.get_alerts(limit)
    return jsonify({'status': 'ok', 'data': [asdict(a) for a in alerts]})


@app.route('/api/alerts/clear', methods=['POST'])
@require_jwt
def clear_alerts():
    alert_engine.clear_alerts()
    return jsonify({'status': 'ok'})


@app.route('/api/alerts/<alert_id>/ack', methods=['POST'])
@require_jwt
def acknowledge_alert(alert_id):
    ok = alert_engine.acknowledge_alert(alert_id)
    if ok:
        return jsonify({'status': 'ok'})
    return jsonify({'status': 'error', 'message': '告警不存在'}), 404


# ══════════════════════════════════════════
#  文件分发 API
# ══════════════════════════════════════════

@app.route('/api/distribute', methods=['POST'])
@require_jwt
def api_distribute_files():
    import uuid as _uuid
    import os as _os
    try:
        from file_distributor import FileDistributor, FileDistributionTask, ConflictStrategy
    except ImportError:
        return jsonify({'status': 'error', 'message': '文件分发模块未加载'}), 500

    data = request.json or {}
    source_path = data.get('source_path', '').strip()
    target_path = data.get('target_path', '').strip()
    node_ids = data.get('node_ids', [])
    strategy_str = data.get('strategy', 'overwrite')

    if not source_path:
        return jsonify({'status': 'error', 'message': '请指定源文件路径'}), 400
    if not target_path:
        return jsonify({'status': 'error', 'message': '请指定目标路径'}), 400
    if not node_ids:
        return jsonify({'status': 'error', 'message': '请选择目标节点'}), 400
    if not _os.path.exists(source_path):
        return jsonify({'status': 'error', 'message': f'源文件不存在: {source_path}'}), 400

    try:
        strategy = ConflictStrategy(strategy_str)
    except ValueError:
        return jsonify({'status': 'error', 'message': f'无效的策略: {strategy_str}'}), 400

    task = FileDistributionTask(
        task_id=f"dist_{_uuid.uuid4().hex[:8]}",
        source_path=source_path,
        target_path=target_path,
        target_nodes=node_ids,
        strategy=strategy,
        verify_md5=data.get('verify_md5', True),
        preserve_perms=data.get('preserve_perms', True),
        is_local_source=True
    )

    distributor = FileDistributor()
    distributor.submit_task(task)

    db.add_audit('FILE_DISTRIBUTE', user=g.current_user,
                 target=f"{len(node_ids)} nodes",
                 detail=f"{source_path} -> {target_path}")

    return jsonify({
        'status': 'ok',
        'task_id': task.task_id,
        'total_nodes': len(node_ids),
        'message': f'文件分发已启动，目标 {len(node_ids)} 个节点'
    })


@app.route('/api/distribute/<task_id>/status', methods=['GET'])
@require_jwt
def api_distribute_status(task_id):
    # 🔧 优先从内存查询，失败则从数据库查询
    try:
        from file_distributor import FileDistributor
        task = FileDistributor().get_task(task_id)
        if task:
            return jsonify({
                'status': 'ok',
                'data': {
                    'task_id': task.task_id,
                    'status': task.status,
                    'total': task.total_nodes,
                    'completed': task.completed_nodes,
                    'results': task.results
                }
            })
    except ImportError:
        pass

    # 🔧 从数据库查询持久化的任务状态（支持页面刷新后恢复）
    db_task = db.get_distribute_task(task_id)
    if db_task:
        return jsonify({
            'status': 'ok',
            'data': {
                'task_id': db_task['task_id'],
                'status': db_task['status'],
                'total': db_task['total_nodes'],
                'completed': db_task['completed_nodes'],
                'results': db_task['results']
            }
        })

    return jsonify({
        'status': 'ok',
        'data': {
            'task_id': task_id,
            'status': 'done',
            'total': 0,
            'completed': 0,
            'results': {}
        }
    })

# ══════════════════════════════════════════
#  🆕 AI 诊断 API
# ══════════════════════════════════════════

@app.route('/api/ai/diagnose', methods=['POST'])
@require_jwt
def api_ai_diagnose():
    """
    AI 诊断接口
    方案：先同步采集系统信息，再用独立进程调用 Groq API
    完全绕开 eventlet/greenlet 限制
    """
    if not config.AI_ENABLED:
        return jsonify({
            'status': 'error',
            'message': 'AI 功能未启用，请设置 AI_ENABLED=true'
        }), 503

    data       = request.json or {}
    session_id = data.get('session_id')

    if not session_id:
        return jsonify({'status': 'error', 'message': '缺少 session_id 参数'}), 400

    session = ssh_manager.get_session(session_id)
    if not session:
        return jsonify({'status': 'error', 'message': '会话不存在或已断开'}), 404

    if not session.connected:
        return jsonify({'status': 'error', 'message': '会话未连接'}), 400

    ai_cfg = get_effective_ai_config()
    if not ai_cfg['api_key']:
        return jsonify({
            'status': 'error',
            'message': 'API Key 未配置，请在设置中配置 AI Key'
        }), 503

    try:
        # ══════════════════════════════════════════
        # 第一步：在当前线程同步采集系统信息
        # （SSH 调用本来就在 eventlet 管理下，没问题）
        # ══════════════════════════════════════════
        log.info(f"[AI Diagnose] 开始采集系统信息: {session_id}")
        context_data = collect_system_context(session)
        log.info(f"[AI Diagnose] 系统信息采集完成，长度: {len(context_data)}")

        # 检测 OS 类型（用于动态 Prompt）
        try:
            sysinfo = session.get_system_info()
            _os_type = sysinfo.get('os_type', 'unknown')
        except Exception:
            _os_type = 'unknown'
        log.info(f"[AI Diagnose] 检测到 OS 类型: {_os_type}")

        # ══════════════════════════════════════════
        # 第二步：用 subprocess 调用独立脚本请求 AI API
        # 完全独立进程，不受 eventlet 影响
        # ══════════════════════════════════════════
        import json as _json
        import tempfile
        import subprocess as _sub
        import sys as _sys
        import os as _os

        _api_key = ai_cfg['api_key']
        if not _api_key:
            return jsonify({'status': 'error', 'message': 'API Key 未配置'}), 503

        log.info('[AI Diagnose] API Key 已配置，启动 Groq 子进程')

        # 根据 OS 类型选择 System Prompt
        if _os_type == 'windows':
            _system_prompt = (
                '你是资深 SRE 专家，擅长 Windows Server 运维和故障排查。'
                '基于给定系统信息，输出 JSON 诊断结果。\n'
                '命令必须使用 Windows 语法（PowerShell / cmd），不要输出 Linux 命令。\n'
                '格式：{"summary":"","diagnosis":"","recommendations":[],"commands":[]}'
                '\n只输出 JSON，不要额外文字。'
            )
        else:
            _system_prompt = (
                '你是资深 SRE 专家，擅长 Linux 运维和故障排查。'
                '基于给定系统信息，输出 JSON 诊断结果。\n'
                '格式：{"summary":"","diagnosis":"","recommendations":[],"commands":[]}'
                '\n只输出 JSON，不要额外文字。'
            )

        input_data = {
            'api_key':    _api_key,
            'base_url':   ai_cfg['base_url'],
            'model':      ai_cfg['model'] or 'llama-3.3-70b-versatile',
            'messages': [
                {
                    'role':    'system',
                    'content': _system_prompt,
                },
                {
                    'role':    'user',
                    'content': f'请分析以下{_os_type}系统信息：\n\n{context_data}'
                },
            ],
            'max_tokens': 3072,
            'json_mode':  False,   # 🔧 客户端提取，避免小模型 json_mode token 不够
        }

        # 🔧 安全修复 v2：用安全临时目录避免权限竞态
        tmpdir = tempfile.mkdtemp(prefix='webshell_diag_')
        _os.chmod(tmpdir, 0o700)
        in_path = _os.path.join(tmpdir, 'diag_in.json')
        out_path = _os.path.join(tmpdir, 'diag_out.json')
        # 先创建空文件并设权限，再写入 — 消除 NamedTemporaryFile 的竞态窗口
        for p in (in_path, out_path):
            fd = _os.open(p, _os.O_CREAT | _os.O_WRONLY, 0o600)
            _os.close(fd)
        with open(in_path, 'w', encoding='utf-8') as f:
            _json.dump(input_data, f, ensure_ascii=False)

        script = os.path.join(os.path.dirname(__file__), '_groq_worker.py')
        log.info(f'[AI Diagnose] 启动 Groq 子进程...')

        # 🔧 修复 v3：将 stderr 重定向到临时日志文件（避免管道缓冲区死锁）
        #           同时将 stdout 重定向到 DEVNULL（子进程只用输出文件通信）
        stderr_log = _os.path.join(tmpdir, 'stderr.log')
        with open(stderr_log, 'w', encoding='utf-8') as stderr_f:
            proc = _sub.Popen(
                [_sys.executable, script, in_path, out_path],
                stdout=_sub.DEVNULL,
                stderr=stderr_f,
            )

        waited   = 0.0
        interval = 0.5
        timeout  = 90.0

        while waited < timeout:
            eventlet.sleep(interval)
            waited += interval
            if proc.poll() is not None:
                break

        if proc.poll() is None:
            proc.kill()
            # 🔧 读取子进程 stderr 日志用于诊断
            stderr_text = ''
            try:
                with open(stderr_log, 'r', encoding='utf-8', errors='replace') as f:
                    stderr_text = f.read().strip()
            except Exception:
                pass
            # 🔧 修复：超时时立即清理临时目录（含 API Key），防止泄露
            _cleanup_temp_files(tmpdir)
            log.error(f'[AI Diagnose] 子进程超时 (90s)，stderr: {stderr_text[:500]}')
            return jsonify({
                'status':  'error',
                'message': f'AI 诊断超时，请稍后重试。子进程日志: {stderr_text[:200]}'
            }), 504

        # 🔧 读取子进程 stderr（含 API 调用诊断信息）
        stderr_text = ''
        try:
            with open(stderr_log, 'r', encoding='utf-8', errors='replace') as f:
                stderr_text = f.read().strip()
            if stderr_text:
                for line in stderr_text.splitlines():
                    log.debug(f'[_groq_worker stderr] {line}')
        except Exception:
            pass

        try:
            with open(out_path, 'r', encoding='utf-8') as f:
                content = _json.load(f)
        except Exception as e:
            # 🔧 修复：解析失败时也要清理临时目录
            _cleanup_temp_files(tmpdir)
            log.error(f'[AI Diagnose] 结果解析失败: {e}, stderr: {stderr_text[:300]}')
            return jsonify({
                'status':  'error',
                'message': f'结果解析失败: {e}. 子进程日志: {stderr_text[:200]}'
            }), 500

        # 🔧 修复：读取完毕后立即清理临时目录
        _cleanup_temp_files(tmpdir)

        # 🔧 防御：content 可能为 None（理论上不应发生，但防止崩溃）
        if not isinstance(content, dict):
            log.error(f'[AI Diagnose] 结果格式异常，期望 dict，实际 {type(content).__name__}: {str(content)[:200]}')
            return jsonify({'status': 'error', 'message': 'AI 返回结果格式异常'}), 500

        if 'error' in content:
            log.error(f'[AI Diagnose] AI 返回错误: {content["error"][:200]}')
            return jsonify({'status': 'error', 'message': content['error']}), 500

        result = content.get('data', content)

        # 🔧 归一化：AI 可能返回 list 而非 str
        def _ensure_str(v):
            if isinstance(v, list): return '\n'.join(str(x) for x in v)
            return str(v) if v else ''
        result['diagnosis'] = _ensure_str(result.get('diagnosis', ''))
        result['summary']   = _ensure_str(result.get('summary', ''))

        # 🔧 兜底：AI 可能返回空 diagnosis，用 summary + recommendations 合成
        if not result['diagnosis'].strip():
            parts = []
            if result['summary'].strip():
                parts.append(result['summary'].strip())
            recs = result.get('recommendations', [])
            if recs and isinstance(recs, list):
                parts.append('关键建议：' + '；'.join(recs[:3]))
            result['diagnosis'] = '\n'.join(parts) if parts else 'AI 未提供详细诊断，请根据摘要和建议手动分析。'

        db.add_audit(
            'AI_DIAGNOSE',
            user=getattr(g, 'current_user', 'unknown'),
            target=session_id,
            detail=f"诊断完成，建议命令数: {len(result.get('commands', []))}",
        )

        log.info(f"[AI Diagnose] 完成: {result.get('summary', '')[:50]}")
        return jsonify({'status': 'ok', 'data': result})

    except Exception as e:
        log.error(f'[AI Diagnose] 处理失败: {e}')
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/ai/status', methods=['GET'])
@require_jwt
def api_ai_status():
    """检查 AI 服务状态"""
    effective = get_effective_ai_config()
    status = {
        'enabled': effective['enabled'],
        'api_key_configured': bool(effective['api_key']),
        'model': effective['model'],
        'base_url': effective['base_url'],
    }

    if effective['enabled'] and effective['api_key']:
        status['ready'] = True
    else:
        status['ready'] = False
        if not effective['enabled']:
            status['message'] = 'AI 功能未启用'
        elif not effective['api_key']:
            status['message'] = 'API Key 未配置'

    return jsonify({'status': 'ok', 'data': status})


# ══════════════════════════════════════════
#  AI 用户配置 ── 已迁移到 ai_config.py（打破循环依赖）
# ══════════════════════════════════════════

from ai_config import (
    get_effective_ai_config,
    save_ai_user_config,
    _load_ai_user_config,
    clear_ai_config_cache,
    invalidate_stored_key,
)

# 向后兼容别名
_save_ai_user_config = save_ai_user_config
# get_effective_ai_config 已从 ai_config 直接导入


# ══════════════════════════════════════════
#  GET /api/ai/config
# ══════════════════════════════════════════

@app.route('/api/ai/config', methods=['GET'])
@require_jwt
def api_ai_config_get():
    user = _load_ai_user_config()
    real_key = user.get('api_key', '')
    effective = get_effective_ai_config()
    return jsonify({
        'status': 'ok',
        'data': {
            'base_url': user.get('base_url', ''),
            'api_key':  _mask_key(real_key),
            'model':    user.get('model', ''),
            'has_key':  bool(real_key),
        },
        'effective': {
            'enabled':  effective['enabled'],
            'api_key':  bool(effective['api_key']),   # 只返回布尔，不返回内容
            'model':    effective['model'],
            'base_url': effective['base_url'],
            'ready':    effective['enabled'] and bool(effective['api_key']),
        } if config.AI_ENABLED else None,
    })


# ══════════════════════════════════════════
#  POST /api/ai/config
# ══════════════════════════════════════════

@app.route('/api/ai/config', methods=['POST'])
@require_jwt
def api_ai_config_save():
    data = request.json or {}

    base_url = data.get('base_url', '').strip() if 'base_url' in data else None
    model    = data.get('model', '').strip()    if 'model'    in data else None

    # api_key：掩码值不覆盖
    raw_key  = data.get('api_key', '').strip()
    api_key  = None   # None = 不修改
    if raw_key and '****' not in raw_key and '••••' not in raw_key:
        api_key = raw_key

    if not _save_ai_user_config(base_url=base_url, api_key=api_key, model=model):
        return jsonify({'status': 'error', 'message': '配置保存失败'}), 500

    log.info(f'[AI Config] 已保存: base_url={base_url}, '
             f'model={model}, has_key={api_key is not None}')
    return jsonify({'status': 'ok', 'message': 'AI 配置已保存'})


# ══════════════════════════════════════════
#  POST /api/ai/config/test
# ══════════════════════════════════════════

@app.route('/api/ai/config/test', methods=['POST'])
@require_jwt
def api_ai_config_test():
    """测试 AI 连接（强制刷新缓存）"""
    clear_ai_config_cache()

    effective = get_effective_ai_config()
    api_key   = effective['api_key']
    base_url  = effective['base_url']
    model     = effective['model']

    log.info(f'[AI Test] api_key_configured={bool(api_key)}, model={model}, base_url={base_url}')

    if not api_key:
        return jsonify({
            'status':  'error',
            'message': 'API Key 未配置，请在设置页面填写并保存。'
                       ' 提示：检查 .env 文件 GROQ_API_KEY 或通过前端设置页面配置。'
        }), 400

    try:
        import requests as _req
        # 🔧 代理策略与 _groq_worker.py 保持一致：
        #    如果设置了 HTTPS_PROXY/HTTP_PROXY 使用代理，否则直连
        env_proxy = os.environ.get('HTTPS_PROXY', '') or os.environ.get('HTTP_PROXY', '')
        proxies = {'http': env_proxy, 'https': env_proxy} if env_proxy else {'http': None, 'https': None}
        log.info(f'[AI Test] 代理: {"使用 " + env_proxy[:50] if env_proxy else "直连"}')

        resp = _req.post(
            f'{base_url}/chat/completions',
            headers={
                'Authorization': f'Bearer {api_key}',
                'Content-Type':  'application/json',
            },
            json={
                'model':      model,
                'messages':   [{'role': 'user', 'content': 'Hi'}],
                'max_tokens': 10,
            },
            timeout=20,
            proxies=proxies,
        )

        log.info(f'[AI Test] HTTP {resp.status_code}')

        if resp.status_code == 200:
            reply = resp.json()['choices'][0]['message']['content']
            return jsonify({
                'status':  'ok',
                'message': f'连接成功！模型 {model} 响应正常',
                'reply':   reply,
            })

        # 尝试解析错误详情
        err_detail = ''
        try:
            err_detail = resp.json().get('error', {}).get('message', '')
        except Exception:
            pass
        if not err_detail:
            err_detail = resp.text[:500]

        log.error(f'[AI Test] 错误响应 body: {err_detail[:300]}')

        if resp.status_code == 401:
            detail = f'API Key 认证失败 (401): {err_detail}'
        elif resp.status_code == 403:
            # 🔧 自动清理失效 Key，避免后续调用继续使用
            cleanup_result = invalidate_stored_key()
            log.warning(
                f'[AI Test] 403 Forbidden — 已自动清理本地 Key（{cleanup_result}），'
                f'请在 Groq 控制台生成新 Key: https://console.groq.com/keys'
            )
            detail = (
                f'API Key 已失效 (403 Forbidden)，本地 Key 已自动清除。\n'
                f'请前往 https://console.groq.com/keys 生成新 Key，\n'
                f'然后在本页面填写并保存。'
            )
        elif resp.status_code == 404:
            detail = f'模型不存在 (404): {model}'
        elif resp.status_code == 429:
            detail = '请求频率超限 (429)，稍后重试'
        else:
            detail = f'HTTP {resp.status_code}: {err_detail}'

        return jsonify({'status': 'error', 'message': f'连接失败: {detail}'}), 502

    except Exception as e:
        log.error(f'[AI Test] 异常: {e}')
        return jsonify({'status': 'error', 'message': f'测试失败: {str(e)[:200]}'}), 500


def _mask_key(key: str) -> str:
    """掩码显示 API Key，如 gsk_abc...xyz"""
    if not key:
        return ''
    if len(key) <= 12:
        return key[:4] + '****'
    return key[:8] + '****' + key[-4:]


# ────────────────────────────────────────
#  AI 调用辅助：获取生效的配置
# ────────────────────────────────────────


# ══════════════════════════════════════════
#  WebSocket 认证注册表
# ══════════════════════════════════════════

_ws_auth: dict = {}

# ══════════════════════════════════════════
#  高危命令确认 Token 机制
#  前端不能仅凭 _risk_confirmed 绕过检测，
#  必须由后端发放一次性确认 token
# ══════════════════════════════════════════

_pending_confirmations: dict = {}  # confirm_token -> {session_id, command, expires}
_confirmations_lock = threading.Lock()  # 🔧 新增：并发安全锁

def _normalize_command(command: str) -> str:
    """规范化命令：去除注释、压缩空白，防止 # 注释绕过 Token 匹配"""
    import re
    cleaned = []
    in_quote = False
    quote_char = None
    for ch in command:
        if ch in ("'", '"') and not in_quote:
            in_quote = True
            quote_char = ch
        elif ch == quote_char and in_quote:
            in_quote = False
            quote_char = None
        elif ch == '#' and not in_quote:
            break  # 注释开始，忽略后续
        cleaned.append(ch)
    result = ''.join(cleaned).strip()
    # 压缩多余空白字符
    result = re.sub(r'\s+', ' ', result)
    return result

def _generate_confirmation_token(session_id: str, command: str) -> str:
    """为高危命令生成一次性确认 token，有效期 60 秒"""
    import uuid as _uuid
    now = time.time()
    with _confirmations_lock:
        # 🔧 修复：只清理过期的 token，不清空所有（避免多标签页并发问题）
        expired = [k for k, v in _pending_confirmations.items() if v['expires'] < now]
        for k in expired:
            _pending_confirmations.pop(k, None)
        token = f"confirm_{_uuid.uuid4().hex[:16]}"
        # 🔧 修复：存储规范化后的命令，防止 # 注释绕过匹配
        _pending_confirmations[token] = {
            'session_id': session_id,
            'command': _normalize_command(command),
            'expires': now + 60,
        }
    return token

def _verify_confirmation_token(token: str, session_id: str, command: str) -> bool:
    """验证高危命令确认 token"""
    with _confirmations_lock:
        info = _pending_confirmations.get(token)
        if not info:
            return False
        if time.time() > info['expires']:
            _pending_confirmations.pop(token, None)
            return False
        if info['session_id'] != session_id:
            return False
        # 🔧 修复：比较规范化后的命令，防止注释/空白变化绕过
        if info['command'] != _normalize_command(command):
            return False
        _pending_confirmations.pop(token, None)
    return True

# 定期清理过期 token
def _cleanup_stale_confirmations():
    while True:
        try:
            socketio.sleep(30)
            now = time.time()
            with _confirmations_lock:
                expired = [k for k, v in _pending_confirmations.items() if v['expires'] < now]
                for k in expired:
                    _pending_confirmations.pop(k, None)
        except Exception:
            pass

socketio.start_background_task(_cleanup_stale_confirmations)


@socketio.on('connect')
def on_connect(auth):
    """
    🔧 修复：确保认证失败时完全阻止连接
    """
    sid = request.sid

    # 兼容不同格式的 auth 参数
    if isinstance(auth, dict):
        token = auth.get('token', '')
    elif isinstance(auth, str):
        # 某些客户端直接传字符串 token
        token = auth
    else:
        token = ''

    username = _verify_ws_token(token)
    if not username:
        log.warning(f'[WS] 未授权连接被拒绝: {sid}')
        # 🔧 先返回 False，让 socketio 处理断开
        # 不要在这里调用 ws_disconnect()，避免 eventlet 竞争
        return False

    _ws_auth[sid] = username
    log.info(f'[WS] 已认证: {sid} ({username})')
    # 🔧 显式返回 True 确认连接
    return True


@socketio.on('disconnect')
def on_disconnect():
    sid = request.sid
    username = _ws_auth.pop(sid, None)
    if username:
        log.info(f'[WS] 断开: {sid} ({username})')
    else:
        log.debug(f'[WS] 未认证连接断开: {sid}')


def _ws_require_auth(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if request.sid not in _ws_auth:
            # 🔧 修复：安全提取 session_id，处理 args[0] 非 dict 类型的情况
            session_id = ''
            if args and isinstance(args[0], dict):
                session_id = args[0].get('session_id', '')
            emit('terminal_error', {
                'message': '未授权，请先登录',
                'session_id': session_id
            })
            return
        return fn(*args, **kwargs)
    return wrapper


def _start_read_loop(client_sid: str, session_id: str):
    """
    🔧 修复：读取循环异常时通知前端
    """
    def _loop(sid, s_id):
        consecutive_errors = 0
        while True:
            session = ssh_manager.get_session(s_id)
            if not session:
                log.info(f'[read_loop] 会话不存在，退出: {s_id}')
                break
            if not session.connected:
                log.info(f'[read_loop] 会话已断开，退出: {s_id}')
                # 🔧 通知前端连接已断开
                socketio.emit(
                    'terminal_closed',
                    {'session_id': s_id, 'reason': 'SSH连接已断开'},
                    room=sid
                )
                break
            if session.should_stop():
                break

            try:
                out = session.read_output()
                if out:
                    socketio.emit(
                        'terminal_output',
                        {'data': out, 'session_id': s_id},
                        room=sid
                    )
                    consecutive_errors = 0  # 重置错误计数
                socketio.sleep(0.02)
            except Exception as e:
                consecutive_errors += 1
                log.debug(f'[read_loop] 错误({consecutive_errors}): {e}')
                # 🔧 连续错误超过阈值才退出，避免偶发错误断开
                if consecutive_errors >= 5:
                    log.warning(f'[read_loop] 连续错误过多，退出: {s_id}')
                    socketio.emit(
                        'terminal_error',
                        {'message': f'终端读取失败: {e}', 'session_id': s_id},
                        room=sid
                    )
                    break
                socketio.sleep(0.5)

        log.info(f'[read_loop] 已退出: {s_id}')

    socketio.start_background_task(_loop, client_sid, session_id)


# ══════════════════════════════════════════
#  WebSocket 终端事件
# ══════════════════════════════════════════

@socketio.on('open_terminal')
@_ws_require_auth
def on_open_terminal(data):
    client_sid = request.sid
    conn_id = data.get('conn_id')
    session_id = data.get('session_id', client_sid)

    log.info(f'[OpenTerminal] ═══ 打开终端请求 ═══')
    log.info(f'[OpenTerminal] 客户端={client_sid}, session={session_id}, conn_id={conn_id}')

    conn_info = db.get_connection(conn_id)
    if not conn_info:
        log.warning(f'[OpenTerminal] 连接配置不存在: {conn_id}')
        emit('terminal_error', {'message': '连接配置不存在', 'session_id': session_id})
        return

    conn_name = conn_info.get('name') or conn_info.get('host', '')
    pw = conn_info.get('password', '')
    key = conn_info.get('private_key', '')
    # 🔧 详细日志
    log.info(
        f'[OpenTerminal] 连接目标: name={conn_name}, '
        f'{conn_info.get("username")}@{conn_info.get("host")}:{conn_info.get("port")}'
    )
    log.info(
        f'[OpenTerminal] 认证方式: '
        f'has_password={bool(pw)}, has_key={bool(key)}, has_passphrase={bool(conn_info.get("private_key_passphrase",""))}'
    )
    success, msg = ssh_manager.create_session(session_id, conn_info, conn_name)
    if not success:
        log.warning(f'[OpenTerminal] 连接失败: session={session_id}, msg={msg}')
        emit('terminal_error', {'message': msg, 'session_id': session_id})
        return

    log.info(f'[OpenTerminal] ✅ 连接成功: session={session_id}')
    db.update_last_connected(conn_id)
    db.add_audit('CONNECT', user=_ws_auth.get(client_sid, ''),
                 target=conn_info.get('host', ''), ip=_get_real_ip())
    emit('terminal_connected', {'session_id': session_id})
    _start_read_loop(client_sid, session_id)


@socketio.on('quick_connect')
@_ws_require_auth
def on_quick_connect(data):
    client_sid = request.sid
    session_id = data.get('session_id', client_sid)
    save_history = data.get('save_history', True)

    conn_info = {
        'host': data.get('host', '').strip(),
        'port': _validate_port(data.get('port', 22)),
        'username': data.get('username', 'root').strip(),
        'password': data.get('password', ''),            # ✅ 密码不做 strip，保留原始值
        'private_key': data.get('private_key', ''),
        'private_key_passphrase': data.get('private_key_passphrase', ''),
    }

    # 🔧 快速连接日志（密码脱敏）
    log.info(
        f'[QuickConnect] 收到请求: session={session_id}, '
        f'host={conn_info["host"]}, port={conn_info["port"]}, '
        f'username={conn_info["username"]}, '
        f'has_password={bool(conn_info["password"])}, '
        f'has_key={bool(conn_info["private_key"])}'
    )

    conn_name = f"{conn_info['username']}@{conn_info['host']}"
    success, msg = ssh_manager.create_session(session_id, conn_info, conn_name)
    log.info(f'[QuickConnect] 连接结果: session={session_id}, success={success}, msg={msg}')
    if not success:
        emit('terminal_error', {'message': msg, 'session_id': session_id})
        return

    if save_history and conn_info['host']:
        try:
            db.upsert_quick_history(
                conn_info['host'], conn_info['port'],
                conn_info['username'], conn_info['password']
            )
        except Exception as e:
            log.warning(f'[QuickHistory] 保存失败: {e}')

    db.add_audit('QUICK_CONNECT', user=_ws_auth.get(client_sid, ''),
                 target=conn_info['host'], ip=_get_real_ip())
    emit('terminal_connected', {'session_id': session_id})
    _start_read_loop(client_sid, session_id)


@socketio.on('terminal_input')
@_ws_require_auth
def on_terminal_input(data):
    raw_data = data.get('data', '')                # 保留原始数据（含 \r），用于发送到 PTY
    command_text = raw_data.rstrip('\n\r')          # 去换行后的文本，用于风险分析
    session_id = data.get('session_id')
    session = ssh_manager.get_session(session_id)
    if not session:
        # 🔧 修复：session 不存在时发送错误通知（之前静默丢弃，用户无感知）
        emit('terminal_error', {
            'message': '会话已断开，请重新连接',
            'session_id': session_id
        })
        return

    # 🔧 修复：限制终端输入长度，防止超长命令导致 analyze_command_risk 正则性能问题
    MAX_INPUT_LENGTH = 10 * 1024  # 10KB
    if len(command_text) > MAX_INPUT_LENGTH:
        emit('terminal_error', {
            'message': f'命令过长（{len(command_text)} 字节），最大允许 {MAX_INPUT_LENGTH} 字节',
            'session_id': session_id
        })
        return

    # ────────────────────────────────────────
    # 高危命令二次确认（后端强制，不可绕过）
    # ────────────────────────────────────────
    if data.get('_risk_confirmed'):
        # 验证后端发放的确认 token
        confirm_token = data.get('_confirm_token', '')
        if _verify_confirmation_token(confirm_token, session_id, command_text):
            audit_log.warning(
                f'[SECURITY] 高危命令经后端确认执行: session={session_id}, '
                f'cmd={command_text[:100]}, user={_ws_auth.get(request.sid, "?")}'
            )
            if raw_data:
                session.send_command(raw_data)  # 🔧 发送原始数据（含 \r 换行符）
            else:
                session.send_command('\r')  # 🔧 空回车也要发送
            return
        else:
            audit_log.warning(
                f'[SECURITY] 高危命令确认 token 无效或过期: session={session_id}, '
                f'cmd={command_text[:100]}, user={_ws_auth.get(request.sid, "?")}'
            )
            emit('terminal_error', {
                'message': '⚠️ 命令确认已过期或无效，请重新执行并确认',
                'session_id': session_id
            })
            return

    if command_text and len(command_text) > 0:
        try:
            from ai_engine import analyze_command_risk
            risk = analyze_command_risk(command_text)

            if risk.level == 'critical':
                audit_log.warning(
                    f'[SECURITY] 高危命令被拦截: session={session_id}, '
                    f'cmd={command_text[:100]}, user={_ws_auth.get(request.sid, "?")}'
                )
                emit('terminal_error', {
                    'message': f'⛔ 命令被安全策略拦截\n\n风险等级：{risk.level.upper()}\n风险描述：{risk.description}\n安全建议：{risk.suggestion}',
                    'session_id': session_id,
                    'risk_level': risk.level,
                    'command': command_text
                })
                return

            if risk.level == 'high':
                # 🔧 high 级别：生成后端确认 token，前端必须回传此 token
                confirm_token = _generate_confirmation_token(session_id, command_text)
                audit_log.warning(
                    f'[SECURITY] 高危命令需后端确认: session={session_id}, '
                    f'cmd={command_text[:100]}, user={_ws_auth.get(request.sid, "?")}'
                )
                emit('command_requires_confirmation', {
                    'session_id': session_id,
                    'command': command_text,
                    'risk_level': risk.level,
                    'score': risk.score,
                    'description': risk.description,
                    'suggestion': risk.suggestion,
                    'confirm_token': confirm_token,
                    'message': f'⚠️ 高危命令需要二次确认\n\n命令：{command_text}\n风险等级：{risk.level.upper()}\n风险描述：{risk.description}\n建议：{risk.suggestion}'
                })
                return

            if risk.level == 'medium':
                # medium 级别命令：审计日志记录 + 可选前端提示
                audit_log.info(
                    f'[SECURITY] 中危命令已执行: session={session_id}, '
                    f'cmd={command_text[:100]}, user={_ws_auth.get(request.sid, "?")}'
                )
                # 向前端发出提醒（不阻止执行）
                emit('command_medium_risk', {
                    'session_id': session_id,
                    'command': command_text,
                    'risk_level': risk.level,
                    'score': risk.score,
                    'description': risk.description,
                    'suggestion': risk.suggestion,
                    'message': f'⚠️ 中危命令已执行：{risk.description}\n建议：{risk.suggestion}'
                })
        except Exception as e:
            log.warning(f'[Security] 命令风险检查失败（放行）: {e}')

    if raw_data:
        ok = session.send_command(raw_data)  # 🔧 发送原始数据（含 \r），不丢失换行符
        # 🔧 修复：send_command 失败时发送错误通知（之前静默丢弃，用户无感知）
        if not ok:
            emit('terminal_error', {
                'message': '命令发送失败，SSH 连接可能已断开',
                'session_id': session_id
            })


@socketio.on('terminal_resize')
@_ws_require_auth
def on_terminal_resize(data):
    session = ssh_manager.get_session(data.get('session_id'))
    if session:
        session.resize(int(data.get('cols', 80)), int(data.get('rows', 24)))


@socketio.on('close_terminal')
@_ws_require_auth
def on_close_terminal(data):
    session_id = data.get('session_id')
    ssh_manager.remove_session(session_id)
    emit('terminal_closed', {'session_id': session_id})


@socketio.on('terminal_state_sync')
@_ws_require_auth
def on_terminal_state_sync(data):
    session_id = data.get('session_id')
    state = data.get('state', {})
    session = ssh_manager.get_session(session_id)
    if not session:
        return

    snapshot = SessionRecoveryManager.get_snapshot(session_id)
    now = datetime.now().isoformat()

    if snapshot:
        snapshot.last_active = now
        snapshot.terminal_state = state
        snapshot.screen_buffer = state.get('screen_buffer', '')
        SessionRecoveryManager.save_snapshot(session_id, snapshot)
    else:
        conn_info = session.conn_info
        snapshot = SessionSnapshot(
            session_id=session_id,
            conn_id=conn_info.get('id', ''),
            host=conn_info.get('host', ''),
            port=conn_info.get('port', 22),
            username=conn_info.get('username', 'root'),
            created_at=now,
            last_active=now,
            terminal_state=state,
            pwd='/',
            env_vars={},
            history=[],
            screen_buffer=''
        )
        SessionRecoveryManager.save_snapshot(session_id, snapshot)

# ══════════════════════════════════════════
#  集群 API
# ══════════════════════════════════════════

@app.route('/api/cluster/nodes', methods=['GET'])
@require_jwt
def api_cluster_nodes():
    group_id = request.args.get('group_id')
    conn_ids = request.args.getlist('conn_ids')
    nodes = []

    def _to_node(conn, nid):
        return {
            'node_id':  nid,
            'conn_id':  nid,
            'host':     conn.get('host'),
            'port':     conn.get('port'),
            'username': conn.get('username'),
            'name':     conn.get('name'),
            'group_id': conn.get('group_id'),
            'status':   'active'
        }

    if conn_ids:
        for cid in conn_ids:
            conn = db.get_connection(cid)
            if conn:
                nodes.append(_to_node(conn, cid))
    elif group_id:
        for conn in db.get_all_connections_light():
            if conn.get('group_id') == group_id:
                nodes.append(_to_node(conn, conn['id']))
    else:
        for conn in db.get_all_connections_light():
            nodes.append(_to_node(conn, conn['id']))

    return jsonify({'status': 'ok', 'data': nodes})


@app.route('/api/cluster/batch-command', methods=['POST'])
@require_jwt
def api_cluster_batch_command():
    import uuid as _uuid
    data     = request.json or {}
    node_ids = data.get('node_ids', [])
    command  = data.get('command', '').strip()

    if not node_ids:
        return jsonify({'status': 'error', 'message': '请选择至少一个节点'}), 400
    if not command:
        return jsonify({'status': 'error', 'message': '请输入命令'}), 400

    # 🔧 安全修复：批量命令也需经过安全风险检查，不能绕过
    try:
        from ai_engine import analyze_command_risk
        risk = analyze_command_risk(command)
        if risk.level == 'critical':
            audit_log.warning(
                f'[SECURITY] 批量命令被拦截（{risk.level}）: '
                f'cmd={command[:100]}, user={g.current_user}'
            )
            return jsonify({
                'status': 'error',
                'message': f'⚠️ 命令被安全策略拦截（{risk.level}）：{risk.description}'
            }), 403
        if risk.level == 'high':
            # high 级别需要确认 token
            confirm_token = data.get('_confirm_token', '')
            if not _verify_confirmation_token(confirm_token, 'batch', command):
                audit_log.warning(
                    f'[SECURITY] 批量命令需确认: cmd={command[:100]}, user={g.current_user}'
                )
                token = _generate_confirmation_token('batch', command)
                return jsonify({
                    'status': 'confirm_required',
                    'message': f'⚠️ 高危命令需要确认（{risk.level}）：{risk.description}',
                    'confirm_token': token,
                    'risk_level': risk.level,
                    'description': risk.description,
                }), 409
    except Exception as e:
        log.warning(f'[Security] 批量命令风险检查失败（放行）: {e}')

    nodes = []
    for nid in node_ids:
        conn = db.get_connection(nid)
        if conn:
            nodes.append({'node_id': nid, 'host': conn.get('host'), 'conn_info': conn})

    if not nodes:
        return jsonify({'status': 'error', 'message': '未找到有效节点'}), 400

    results = {}
    for node in nodes:
        sid = f"batch_{_uuid.uuid4().hex[:8]}"
        ok, msg = ssh_manager.create_session(
            sid, node['conn_info'], f"batch-{node['host']}"
        )
        if not ok:
            results[node['node_id']] = {
                'success': False, 'error': msg, 'host': node['host']
            }
            continue
        session = ssh_manager.get_session(sid)
        try:
            stdout, stderr = session.execute_command(command, timeout=300)
            MAX_OUTPUT = 1024 * 1024  # 1MB 截断上限
            stdout_truncated = len(stdout) > MAX_OUTPUT
            stderr_truncated = len(stderr) > MAX_OUTPUT
            results[node['node_id']] = {
                'success': True,
                'host':    node['host'],
                'stdout':  stdout[:MAX_OUTPUT] if stdout_truncated else stdout,
                'stderr':  stderr[:MAX_OUTPUT] if stderr_truncated else stderr,
                'stdout_truncated': stdout_truncated,
                'stderr_truncated': stderr_truncated,
                'command': command
            }
        except Exception as e:
            results[node['node_id']] = {
                'success': False, 'error': str(e), 'host': node['host']
            }
        finally:
            ssh_manager.remove_session(sid)

    db.add_audit('BATCH_COMMAND', user=g.current_user,
                 target=f"{len(nodes)} nodes", detail=command[:100])

    return jsonify({
        'status':  'ok',
        'task_id': f"cmd_{_uuid.uuid4().hex[:8]}",
        'total':   len(nodes),
        'results': results,
        'message': f'批量命令执行完成，共 {len(nodes)} 个节点'
    })


@app.route('/api/cluster/task/<task_id>/status', methods=['GET'])
@require_jwt
def api_cluster_task_status(task_id):
    try:
        from cluster_scheduler import ClusterScheduler
        scheduler = ClusterScheduler()
        status = scheduler.get_task_status(task_id)
        if not status:
            return jsonify({'status': 'error', 'message': '任务不存在或已完成'}), 404
        return jsonify({'status': 'ok', 'data': status})
    except ImportError:
        return jsonify({
            'status': 'ok',
            'data': {
                'task_id': task_id,
                'status':  'done',
                'total':   0,
                'done':    0,
                'results': {}
            }
        })


@app.route('/api/cluster/task/<task_id>/cancel', methods=['POST'])
@require_jwt
def api_cluster_task_cancel(task_id):
    return jsonify({'status': 'ok', 'message': '任务已取消'})


# ══════════════════════════════════════════
#  巡检 API
# ══════════════════════════════════════════

@app.route('/api/inspection/run', methods=['POST'])
@require_jwt
def api_inspection_run():
    try:
        from inspection import inspection_engine
    except ImportError as e:
        return jsonify({'status': 'error', 'message': f'巡检模块加载失败: {e}'}), 500

    data     = request.json or {}
    node_ids = data.get('node_ids', [])

    if not node_ids:
        node_ids = [c['id'] for c in db.get_all_connections_light()]
    if not node_ids:
        return jsonify({'status': 'error', 'message': '没有可巡检的节点'}), 400

    report = inspection_engine.run_inspection(node_ids)
    db.add_audit('INSPECTION', user=g.current_user,
                 target=f"{len(node_ids)} nodes",
                 detail=f"在线: {report.online_nodes}, 异常: {report.abnormal_nodes}")

    return jsonify({
        'status': 'ok',
        'report': {
            'report_id':      report.report_id,
            'title':          report.title,
            'generated_at':   report.generated_at,
            'total_nodes':    report.total_nodes,
            'online_nodes':   report.online_nodes,
            'offline_nodes':  report.offline_nodes,
            'abnormal_nodes': report.abnormal_nodes,
            'avg_cpu':        report.avg_cpu,
            'avg_memory':     report.avg_memory,
            'avg_disk':       report.avg_disk,
            'nodes':          [asdict(n) for n in report.nodes]
        }
    })


@app.route('/api/inspection/export', methods=['POST'])
@require_jwt
def api_inspection_export():
    import os as _os
    import tempfile
    try:
        from inspection import inspection_engine, InspectionReport, NodeHealthStatus
    except ImportError as e:
        return jsonify({'status': 'error', 'message': f'巡检模块加载失败: {e}'}), 500

    data        = request.json or {}
    report_data = data.get('report', {})

    report = InspectionReport(
        report_id=report_data.get('report_id', 'unknown'),
        title=report_data.get('title', '巡检报告'),
        generated_at=report_data.get('generated_at', datetime.now().isoformat()),
        total_nodes=report_data.get('total_nodes', 0),
        online_nodes=report_data.get('online_nodes', 0),
        offline_nodes=report_data.get('offline_nodes', 0),
        abnormal_nodes=report_data.get('abnormal_nodes', 0),
        avg_cpu=report_data.get('avg_cpu', 0),
        avg_memory=report_data.get('avg_memory', 0),
        avg_disk=report_data.get('avg_disk', 0),
        max_cpu=report_data.get('max_cpu', 0),
        max_memory=report_data.get('max_memory', 0),
        max_disk=report_data.get('max_disk', 0)
    )
    for nd in report_data.get('nodes', []):
        try:
            report.nodes.append(NodeHealthStatus(**nd))
        except Exception:
            pass

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix='.xlsx', delete=False) as f:
            tmp_path = f.name
        inspection_engine.export_to_excel(report, tmp_path)

        # 🔧 修复：使用 after_this_request 钩子延迟清理，确保 send_file 完成流式传输后再删除
        @after_this_request
        def _cleanup(response):
            try:
                _os.unlink(tmp_path)
            except Exception:
                pass
            return response

        return send_file(
            tmp_path,
            as_attachment=True,
            download_name=f"巡检报告_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx",
            mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )
    except Exception:
        # 出错时立即清理
        if tmp_path:
            try:
                _os.unlink(tmp_path)
            except Exception:
                pass
        raise
# ══════════════════════════════════════════
#  AI 引擎路由（模块一～五）
# ══════════════════════════════════════════

from ai_engine import (
    knowledge_base,
    conversation_manager,
    analyze_command_risk,
    call_groq_sync,
    collect_system_context,
    KnowledgeEntry,
)
# 🔧 使用本模块的 _fmt_size，不再从 ai_engine 导入 fmt_bytes


# ────────────────────────────────────────
#  辅助函数
# ────────────────────────────────────────

def _extract_commands(text: str) -> list:
    """从 AI 回复中提取命令块"""
    import re
    cmds = []
    # ```commands``` 块（兼容 \r\n 和 \n）
    for block in re.findall(r'```commands?\r?\n(.*?)```', text,
                             re.DOTALL | re.IGNORECASE):
        for line in block.strip().split('\n'):
            line = line.strip().lstrip('⚠️').strip()
            if line and not line.startswith('#'):
                cmds.append(line)
    # ```bash/shell/sh``` 块也提取（兼容 \r\n 和 \n）
    for block in re.findall(r'```(?:bash|shell|sh)\r?\n(.*?)```', text,
                             re.DOTALL | re.IGNORECASE):
        for line in block.strip().split('\n'):
            line = line.strip()
            if line and not line.startswith('#') and not line.startswith('//'):
                cmds.append(line)
    # 行内反引号命令
    keywords = (
        'ls', 'ps', 'top', 'df', 'du', 'cat', 'grep', 'tail',
        'systemctl', 'service', 'nginx', 'mysql', 'journalctl',
        'find', 'rm', 'chmod', 'chown', 'kill', 'dd', 'iptables',
        'docker', 'kubectl', 'git', 'npm', 'pip', 'apt', 'yum',
        'curl', 'wget', 'ssh', 'scp', 'ping', 'netstat', 'ss',
        'free', 'echo', 'mkdir', 'touch', 'cp', 'mv', 'tar',
        'unzip', 'gzip', 'lsof', 'strace', 'crontab', 'mount',
        'htop', 'iotop', 'vmstat', 'iostat', 'mpstat', 'sar',
        'supervisorctl', 'pm2', 'firewall-cmd', 'ufw',
        'awk', 'sed', 'sort', 'uniq', 'wc', 'xargs', 'tee',
        'tcpdump', 'nmap', 'dig', 'nslookup', 'host',
        'ifconfig', 'ip', 'route', 'who', 'whoami', 'last',
    )
    for m in re.findall(r'`([^`\n]{3,80})`', text):
        m = m.strip()
        if any(m.startswith(k) for k in keywords):
            cmds.append(m)
    return list(dict.fromkeys(cmds))   # 去重保序

def _sanitize_ai_reply(text: str) -> str:
    """后处理：清理 AI 回复中的元信息、重复命令块"""
    import re as _re
    if not text:
        return text

    # 1. 去除「当前对话轮数：N」（中英文冒号均支持）
    text = _re.sub(r'\n?\s*当前对话轮数[：:]\s*\d+\s*$', '', text)

    # 2. 去除「当前对话轮数：N」在多行中间的情况
    text = _re.sub(r'\n当前对话轮数[：:]\s*\d+\n', '\n', text)

    # 3. 去除连续完全相同的命令行（如连着三行 rm ~/nul）
    lines = text.split('\n')
    deduped = []
    for line in lines:
        stripped = line.strip()
        if stripped and deduped and deduped[-1].strip() == stripped:
            continue  # 跳过与上一行完全相同的行
        deduped.append(line)
    text = '\n'.join(deduped)

    # 4. 去除末尾空行
    text = text.rstrip() + '\n'

    return text


# ────────────────────────────────────────
# 模块一：多轮对话
# ────────────────────────────────────────
@app.route('/api/ai/chat', methods=['POST'])
@require_jwt
def api_ai_chat():
    ai_cfg = get_effective_ai_config()
    if not ai_cfg['enabled'] or not ai_cfg['api_key']:
        return jsonify({'status': 'error', 'message': 'AI 未配置'}), 503

    data = request.json or {}
    session_id = data.get('session_id', '')
    # 🔧 修复：确保 chat_id 始终有值，使用 uuid 作为最终 fallback，避免不同会话污染
    import uuid as _uuid
    user = getattr(g, 'current_user', '') or 'anonymous'
    if data.get('chat_id', ''):
        chat_id = data.get('chat_id', '')
    elif session_id:
        chat_id = session_id
    else:
        chat_id = f"chat_{_uuid.uuid4().hex[:12]}"  # 无 session_id 时生成唯一 ID
    user_input = data.get('message', '').strip()

    if not user_input:
        return jsonify({'status': 'error', 'message': '消息不能为空'}), 400

    conv = conversation_manager.get_or_create(chat_id, session_id)

    # 🔧 修复：会话创建时固定 sys_context，避免多用户竞争
    sys_context = conversation_manager.get_context(chat_id).get('sys_context', '')
    if not sys_context and session_id:
        ssh_sess = ssh_manager.get_session(session_id)
        if ssh_sess and ssh_sess.connected:
            try:
                info = ssh_sess.get_system_info()
                sys_context = (
                    f"当前服务器: {ssh_sess.conn_info.get('host', 'unknown')} | "
                    f"CPU: {info.get('cpu_percent', 0)}% | "
                    f"内存: {info.get('memory', {}).get('percent', 0)}% | "
                    f"磁盘: {info.get('disk', {}).get('percent', 0)}%"
                )
                # 🔧 固定存储到会话上下文
                conversation_manager.update_context(chat_id, 'sys_context', sys_context)
            except Exception:
                pass

    system_prompt = (
        f'你是一个资深 SRE 运维专家助手，集成在 WebTerminal 运维平台中。\n'
        f'{"当前服务器状态：" + sys_context if sys_context else "（当前无活跃 SSH 连接）"}\n'
        f'\n'
        f'核心职责：\n'
        f'1. 理解用户意图（诊断/操作/查询/解释）\n'
        f'2. 将自然语言翻译为准确的 Linux 命令\n'
        f'3. 对高危操作（rm -rf/格式化/改权限等）必须风险提示\n'
        f'4. 引导用户逐步排查，每次只给 1-2 条最合适的命令\n'
        f'\n'
        f'行为准则（必须遵守）：\n'
        f'- 仔细阅读用户粘贴的命令输出，据此判断问题，不要凭空猜测\n'
        f'- 如果用户执行了命令但无效，说明之前的建议有误，必须换个思路，绝不要重复建议同一条命令\n'
        f'- 不要混淆文件名与系统路径：用户说的 "nul" 只是一个普通文件名，不是 /dev/null 设备\n'
        f'- 一条命令绝不能在回复中出现超过一次\n'
        f'- 当不确定时，诚实告诉用户并建议排查步骤，不要编造\n'
        f'- 不要在回复末尾追加任何元信息（如对话轮数、时间戳等）\n'
        f'\n'
        f'回复格式：\n'
        f'- 用中文回复，简洁专业，字数控制在 200 字以内\n'
        f'- 先给分析和建议，再给命令\n'
        f'- 命令放在末尾的代码块中：\n'
        f'```commands\n'
        f'单条命令\n'
        f'```\n'
        f'- 高危命令前加 ⚠️ 标记'
    )

    messages = [{'role': 'system', 'content': system_prompt}]
    messages.extend(conversation_manager.get_history_for_llm(chat_id))
    messages.append({'role': 'user', 'content': user_input})

    conversation_manager.add_message(chat_id, 'user', user_input)

    try:
        _aicfg = get_effective_ai_config()
        reply = call_groq_sync(
            messages=messages,
            model=_aicfg['model'],
            api_key=_aicfg['api_key'],
            base_url=_aicfg['base_url'],
            max_tokens=1000,
            json_mode=False,
            timeout=60,
        )

        # 🔧 防御：确保 reply 不是 None
        if not isinstance(reply, str):
            log.error(f'[AI Chat] 回复格式异常，期望 str，实际 {type(reply).__name__}')
            reply = str(reply) if reply is not None else '（AI 无响应）'

        # 🔧 后处理：清理 AI 回复中的元信息和重复内容
        reply = _sanitize_ai_reply(reply)

        conversation_manager.add_message(chat_id, 'assistant', reply)

        commands = _extract_commands(reply)
        command_risks = []
        for cmd in commands:
            risk = analyze_command_risk(cmd)
            command_risks.append({
                'command': cmd,
                'risk': asdict(risk),
            })

        db.add_audit('AI_CHAT', user=getattr(g, 'current_user', ''),
                     target=session_id, detail=user_input[:50])

        return jsonify({
            'status': 'ok',
            'reply': reply,
            'commands': command_risks,
            'chat_id': chat_id,
            'message_count': len(conv.messages),
        })
    except Exception as e:
        log.error(f'[AI Chat] 失败: {e}')
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/ai/chat/history', methods=['GET'])
@require_jwt
def api_ai_chat_history():
    chat_id = request.args.get('chat_id', '')
    limit   = min(int(request.args.get('limit', 100)), 500)
    history = conversation_manager.get_history(chat_id, limit)
    return jsonify({'status': 'ok', 'data': history})

@app.route('/api/ai/chat/sessions', methods=['GET'])
@require_jwt
def api_ai_chat_sessions():
    """获取所有历史对话列表"""
    sessions = conversation_manager.get_all_sessions()
    return jsonify({'status': 'ok', 'data': sessions})

@app.route('/api/ai/chat/clear', methods=['POST'])
@require_jwt
def api_ai_chat_clear():
    chat_id = (request.json or {}).get('chat_id', '')
    conversation_manager.clear(chat_id)
    return jsonify({'status': 'ok'})

@app.route('/api/ai/chat/delete', methods=['POST'])
@require_jwt
def api_ai_chat_delete():
    """删除整个对话会话及其所有消息"""
    chat_id = (request.json or {}).get('chat_id', '')
    if not chat_id:
        return jsonify({'status': 'error', 'message': '缺少 chat_id'}), 400
    conversation_manager.clear(chat_id)
    return jsonify({'status': 'ok', 'message': '已删除'})

@app.route('/api/ai/chat/search', methods=['GET'])
@require_jwt
def api_ai_chat_search():
    """搜索对话历史"""
    keyword = request.args.get('q', '').strip()
    chat_id = request.args.get('chat_id', '').strip()
    limit   = min(int(request.args.get('limit', 50)), 200)

    if not keyword:
        return jsonify({'status': 'error', 'message': '请输入搜索关键词'}), 400

    results = conversation_manager.search(keyword, chat_id or None, limit)
    return jsonify({'status': 'ok', 'data': results})


@app.route('/api/ai/chat/by-date', methods=['GET'])
@require_jwt
def api_ai_chat_by_date():
    """按日期查询对话"""
    date_str = request.args.get('date', '').strip()
    if not date_str:
        return jsonify({'status': 'error', 'message': '请指定日期'}), 400
    results = conversation_manager.get_messages_by_date(date_str)
    return jsonify({'status': 'ok', 'data': results})


@app.route('/api/ai/chat/stats', methods=['GET'])
@require_jwt
def api_ai_chat_stats():
    """对话统计"""
    stats = conversation_manager.get_stats()
    return jsonify({'status': 'ok', 'data': stats})

# ────────────────────────────────────────
# 模块二：命令风险分析
# ────────────────────────────────────────

@app.route('/api/ai/analyze-command', methods=['POST'])
@require_jwt
def api_analyze_command():
    data = request.json or {}
    command = data.get('command', '').strip()
    if not command:
        return jsonify({'status': 'error', 'message': '命令不能为空'}), 400
    risk = analyze_command_risk(command)
    ai_explanation = None

    _aicfg = get_effective_ai_config()
    if risk.level in ('high', 'critical') and _aicfg['api_key']:
        try:
            ai_explanation = call_groq_sync(
                messages=[{
                    'role': 'user',
                    'content': (
                        f'请用中文简要解释这条命令的作用、风险和更安全的替代方案'
                        f'（100字以内）：\n{command}'
                    )
                }],
                model=_aicfg['model'],
                api_key=_aicfg['api_key'],
                base_url=_aicfg['base_url'],
                max_tokens=200,
                timeout=15,
            )
        except Exception:
            pass

    return jsonify({
        'status': 'ok',
        'data': {
            'command': command,
            'risk': asdict(risk),
            'ai_explanation': ai_explanation,
        }
    })


# ────────────────────────────────────────
# 模块二：命令解释
# ────────────────────────────────────────

@app.route('/api/ai/explain-command', methods=['POST'])
@require_jwt
def api_explain_command():
    ai_cfg = get_effective_ai_config()
    if not ai_cfg['api_key']:
        return jsonify({'status': 'error', 'message': 'AI 未配置'}), 503
    data = request.json or {}
    command = data.get('command', '').strip()
    if not command:
        return jsonify({'status': 'error', 'message': '命令不能为空'}), 400

    try:
        _aicfg = get_effective_ai_config()
        reply = call_groq_sync(
            messages=[
                {
                    'role': 'system',
                    'content': '你是 Linux 命令专家，用简洁的中文解释命令。'
                },
                {
                    'role': 'user',
                    'content': (
                        f'请解释这条命令：{command}\n'
                        f'包含：1.功能 2.参数说明 3.风险提示（如有）4.使用建议'
                    )
                },
            ],
            model=_aicfg['model'],
            api_key=_aicfg['api_key'],
            base_url=_aicfg['base_url'],
            max_tokens=400,
            timeout=20,
        )
        return jsonify({'status': 'ok', 'data': {'explanation': reply}})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500

# ────────────────────────────────────────
# 模块三：容量预测
# ────────────────────────────────────────

@app.route('/api/ai/predict', methods=['POST'])
@require_jwt
def api_ai_predict():
    ai_cfg = get_effective_ai_config()
    if not ai_cfg['api_key']:
        return jsonify({'status': 'error', 'message': 'AI 未配置'}), 503

    import json as _json  # 添加这行
    
    data = request.json or {}
    session_id = data.get('session_id', '')

    session = ssh_manager.get_session(session_id)
    if not session or not session.connected:
        return jsonify({'status': 'error', 'message': '会话不存在或未连接'}), 404

    try:
        info = session.get_system_info()

        prompt = f"""分析以下系统资源数据，输出容量预测和优化建议。要求：

1. 只输出一个 JSON 对象，不要任何解释、注释、代码或 markdown 标记
2. 不要输出 python 代码、函数定义或任何编程语言语法
3. JSON 格式：
{{
    "predictions": [{{"resource": "CPU", "current_usage": "45%", "trend": "稳定", "estimated_full_days": -1, "risk_level": "low", "suggestions": ["建议"]}}],
    "overall_health": 75,
    "priority_actions": ["建议操作"]
}}

系统数据：
CPU 使用率: {info.get('cpu_percent', 0)}%，核心数: {info.get('cpu_cores', 1)}
内存: 使用 {info.get('memory', {}).get('percent', 0)}%，共 {_fmt_size(info.get('memory', {}).get('total', 0))}
磁盘 /: 使用 {info.get('disk', {}).get('percent', 0)}%，共 {_fmt_size(info.get('disk', {}).get('total', 0))}
负载: {info.get('load', {}).get('load1', 0)} / {info.get('load', {}).get('load5', 0)} / {info.get('load', {}).get('load15', 0)}
进程数: {info.get('process_count', 0)}
运行时间: {info.get('uptime', '-')}"""
        _aicfg = get_effective_ai_config()
        result_text = call_groq_sync(
            messages=[
                {'role': 'system', 'content': '你是一个服务器运维分析工具。只输出纯JSON对象，不含markdown代码块标记、不含python代码、不含任何解释文字。以 { 开头，以 } 结尾。'},
                {'role': 'user', 'content': prompt},
            ],
            model=_aicfg['model'],
            api_key=_aicfg['api_key'],
            base_url=_aicfg['base_url'],
            max_tokens=2048,
            json_mode=True,
            timeout=60,
        )

        # 🔧 安全解析：result_text 可能是 dict（已提取）或 str（纯文本/JSON 字符串）
        def _safe_load(val):
            """安全加载：dict 直接返回，str 尝试提取 JSON，失败返回空 dict"""
            if isinstance(val, dict):
                return val
            if not isinstance(val, str):
                return {}
            # 尝试直接解析（可能是 JSON 字符串）
            try:
                return _json.loads(val)
            except (_json.JSONDecodeError, ValueError, TypeError):
                pass
            # 尝试从文本中提取 { ... }
            _m = __import__('re').search(r'\{.*\}', val, __import__('re').DOTALL)
            if _m:
                try:
                    return _json.loads(_m.group(0))
                except Exception:
                    pass
            # 全部失败 → 返回带默认值的空 dict
            print(f'[AI] ⚠️ 无法从 AI 响应中提取 JSON, 原始前200字: {str(val)[:200]}')
            return {}

        result = _safe_load(result_text)
        result.setdefault('predictions', [])
        result.setdefault('overall_health', 50)
        result.setdefault('priority_actions', [])

        return jsonify({'status': 'ok', 'data': result})
    except Exception as e:
        log.error(f'[AI Predict] 失败: {e}')
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ────────────────────────────────────────
# 模块三：安全漏洞扫描
# ────────────────────────────────────────

@app.route('/api/ai/security-scan', methods=['POST'])
@require_jwt
def api_security_scan():
    ai_cfg = get_effective_ai_config()
    if not ai_cfg['api_key']:
        return jsonify({'status': 'error', 'message': 'AI 未配置'}), 503
    
    import json as _json  # 添加这行
    
    data = request.json or {}
    session_id = data.get('session_id', '')

    session = ssh_manager.get_session(session_id)
    if not session or not session.connected:
        return jsonify({'status': 'error', 'message': '会话不存在'}), 404

    try:
        pkg_out, _ = session.execute_command(
            'dpkg -l 2>/dev/null | head -60 '
            '|| rpm -qa 2>/dev/null | head -60',
            timeout=15,
        )
        os_out, _ = session.execute_command(
            'uname -a && cat /etc/os-release 2>/dev/null | head -5',
            timeout=5,
        )
        net_out, _ = session.execute_command(
            'ss -tuln 2>/dev/null | head -20',
            timeout=5,
        )

        prompt = f"""分析以下系统信息，识别潜在安全风险。
        输出严格 JSON：
        {{
            "vulnerabilities": [
                {{
                    "package": "软件包名",
                    "version": "当前版本",
                    "severity": "low/medium/high/critical",
                    "description": "漏洞描述",
                    "fix": "修复建议"
                }}
            ],
            "open_ports_risk": [
                {{
                    "port": 端口号整数,
                    "service": "服务名",
                    "risk": "风险说明"
                }}
            ],
            "security_score": 安全评分整数0到100,
            "recommendations": ["加固建议1", "加固建议2"]
        }}

        系统信息: {os_out[:300]}
        软件包列表: {pkg_out[:1500]}
        开放端口: {net_out[:500]}"""
        _aicfg = get_effective_ai_config()
        result_text = call_groq_sync(
            messages=[
                {'role': 'system', 'content': '你是安全专家，只输出严格 JSON'},
                {'role': 'user', 'content': prompt},
            ],
            model=_aicfg['model'],
            api_key=_aicfg['api_key'],
            base_url=_aicfg['base_url'],
            max_tokens=1000,
            json_mode=True,
            timeout=60,
        )

        # 🔧 兼容：call_groq_sync json_mode=True 可能返回 dict 或 str
        result = result_text if isinstance(result_text, dict) else _json.loads(result_text)
        result.setdefault('vulnerabilities', [])
        result.setdefault('open_ports_risk', [])
        result.setdefault('security_score', 50)
        result.setdefault('recommendations', [])

        db.add_audit('AI_SECURITY_SCAN',
                     user=getattr(g, 'current_user', ''),
                     target=session_id)

        return jsonify({'status': 'ok', 'data': result})

    except Exception as e:
        log.error(f'[AI SecurityScan] 失败: {e}')
        return jsonify({'status': 'error', 'message': str(e)}), 500

# ────────────────────────────────────────
# 模块四：知识库 CRUD
# ────────────────────────────────────────

@app.route('/api/ai/knowledge', methods=['GET'])
@require_jwt
def api_knowledge_list():
    category = request.args.get('category', '')
    query = request.args.get('q', '').strip()
    limit = min(int(request.args.get('limit', 50)), 200)
    entries = (
        knowledge_base.search(query, category or None, limit)
        if query
        else knowledge_base.get_all(category or None, limit)
    )
    return jsonify({'status': 'ok', 'data': [asdict(e) for e in entries]})


@app.route('/api/ai/knowledge', methods=['POST'])
@require_jwt
def api_knowledge_save():
    import uuid as _uuid
    data = request.json or {}
    entry = KnowledgeEntry(
        id=data.get('id') or _uuid.uuid4().hex[:8],
        title=data.get('title', '').strip(),
        content=data.get('content', '').strip(),
        tags=data.get('tags', []),
        category=data.get('category', 'qa'),
    )

    if not entry.title or not entry.content:
        return jsonify({'status': 'error', 'message': '标题和内容不能为空'}), 400

    knowledge_base.save(entry)
    db.add_audit('AI_KB_SAVE', user=getattr(g, 'current_user', ''),
                 detail=entry.title[:50])
    return jsonify({'status': 'ok', 'data': asdict(entry)})


@app.route('/api/ai/knowledge/<entry_id>', methods=['DELETE'])
@require_jwt
def api_knowledge_delete(entry_id):
    knowledge_base.delete(entry_id)
    return jsonify({'status': 'ok'})


@app.route('/api/ai/knowledge/generate', methods=['POST'])
@require_jwt
def api_knowledge_generate():
    """AI 辅助生成故障知识条目"""
    ai_cfg = get_effective_ai_config()
    if not ai_cfg['api_key']:
        return jsonify({'status': 'error', 'message': 'AI 未配置'}), 503
    import uuid as _uuid
    import json as _json
    data = request.json or {}
    symptom = data.get('symptom', '').strip()
    commands = data.get('commands', [])
    result = data.get('result', '')

    if not symptom:
        return jsonify({'status': 'error', 'message': '请描述故障现象'}), 400

    try:
        prompt = f"""基于以下故障排查过程，生成标准化知识库文档。要求：

1. 只输出一个 JSON 对象，不要任何解释、注释、代码或 markdown 标记
2. 不要输出 python 代码、函数定义或任何编程语言语法
3. JSON 格式：
{{
    "title": "简洁故障标题",
    "content": "## 故障现象\\n...\\n## 根因分析\\n...\\n## 解决方案\\n...",
    "tags": ["标签"],
    "category": "fault"
}}

故障现象：{symptom}
执行命令：{_json.dumps(commands, ensure_ascii=False)[:500]}
处理结果：{result[:500]}"""
        _aicfg = get_effective_ai_config()
        reply_text = call_groq_sync(
            messages=[
                {'role': 'system', 'content': '你是一个运维知识库工具。只输出纯JSON对象，不含markdown代码块标记、不含python代码、不含任何解释文字。以 { 开头，以 } 结尾。'},
                {'role': 'user', 'content': prompt},
            ],
            model=_aicfg['model'],
            api_key=_aicfg['api_key'],
            base_url=_aicfg['base_url'],
            max_tokens=2048,
            json_mode=True,
            timeout=60,
        )

        doc = reply_text if isinstance(reply_text, dict) else (_json.loads(reply_text) if isinstance(reply_text, str) and str(reply_text).strip().startswith('{') else {})
        entry = KnowledgeEntry(
            id=_uuid.uuid4().hex[:8],
            title=doc.get('title', '未命名故障案例'),
            content=doc.get('content', ''),
            tags=doc.get('tags', []),
            category='fault',
        )
        knowledge_base.save(entry)
        return jsonify({'status': 'ok', 'data': asdict(entry)})

    except Exception as e:
        log.error(f'[AI KB Generate] 失败: {e}')
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ────────────────────────────────────────
# 模块五：集群健康总览
# ────────────────────────────────────────

@app.route('/api/ai/cluster-summary', methods=['POST'])
@require_jwt
def api_cluster_summary():
    ai_cfg = get_effective_ai_config()
    if not ai_cfg['api_key']:
        return jsonify({'status': 'error', 'message': 'AI 未配置'}), 503
    import uuid as _uuid
    import json as _json
    data = request.json or {}
    node_ids = data.get('node_ids', [])

    if not node_ids:
        node_ids = [c['id'] for c in db.get_all_connections_light()]
    if not node_ids:
        return jsonify({'status': 'error', 'message': '没有可用节点'}), 400

    node_stats = []
    for nid in node_ids[:20]:
        conn = db.get_connection(nid)
        if not conn:
            continue
        sid = f"cs_{_uuid.uuid4().hex[:6]}"
        ok, _ = ssh_manager.create_session(sid, conn, conn.get('host', ''))
        if ok:
            sess = ssh_manager.get_session(sid)
            try:
                info = sess.get_system_info()
                node_stats.append({
                    'host': conn.get('host'),
                    'name': conn.get('name', conn.get('host')),
                    'cpu': info.get('cpu_percent', 0),
                    'memory': info.get('memory', {}).get('percent', 0),
                    'disk': info.get('disk', {}).get('percent', 0),
                    'load1': info.get('load', {}).get('load1', 0),
                    'status': 'online',
                })
            except Exception:
                node_stats.append({
                    'host': conn.get('host'), 'name': conn.get('name'),
                    'status': 'error',
                })
            finally:
                ssh_manager.remove_session(sid)
        else:
            node_stats.append({
                'host': conn.get('host'), 'name': conn.get('name'),
                'status': 'offline',
            })

    online = [n for n in node_stats if n['status'] == 'online']
    offline = [n for n in node_stats if n['status'] != 'online']
    abnormal = [
        n for n in online
        if n.get('cpu', 0) > 80
        or n.get('memory', 0) > 85
        or n.get('disk', 0) > 85
    ]

    try:
        prompt = f"""分析集群状态，输出严格 JSON：
        {{
            "summary": "一句话集群健康总结",
            "health_score": 健康评分整数0到100,
            "status": "healthy/warning/critical",
            "highlights": ["重要发现1", "重要发现2"],
            "recommendations": ["建议1", "建议2"]
        }}

        数据：

        总节点: {len(node_stats)}，在线: {len(online)}，离线: {len(offline)}，异常: {len(abnormal)}

        节点详情: {_json.dumps(node_stats[:10], ensure_ascii=False)}"""
        _aicfg = get_effective_ai_config()
        result_text = call_groq_sync(
            messages=[
                {'role': 'system', 'content': '你是集群健康分析专家，只输出严格 JSON'},
                {'role': 'user', 'content': prompt},
            ],
            model=_aicfg['model'],
            api_key=_aicfg['api_key'],
            base_url=_aicfg['base_url'],
            max_tokens=400,
            json_mode=True,
            timeout=30,
        )
        # 🔧 兼容：call_groq_sync json_mode=True 可能返回 dict 或 str
        ai_result = result_text if isinstance(result_text, dict) else _json.loads(result_text)
    except Exception as e:
        log.warning(f'[AI ClusterSummary] AI 分析失败，降级: {e}')
        ai_result = {
            'summary': (
                f'集群 {len(online)}/{len(node_stats)} 节点在线，'
                f'{len(abnormal)} 个节点存在异常'
            ),
            'health_score': max(0, 100 - len(offline) * 10 - len(abnormal) * 5),
            'status': ('critical' if offline else
                      ('warning' if abnormal else 'healthy')),
            'highlights': [],
            'recommendations': [],
        }

    return jsonify({
        'status': 'ok',
        'data': {
            **ai_result,
            'nodes': node_stats,
            'total': len(node_stats),
            'online_count': len(online),
            'offline_count': len(offline),
            'abnormal_count': len(abnormal),
        }
    })


# ────────────────────────────────────────
# 模块五：服务拓扑生成
# ────────────────────────────────────────

@app.route('/api/ai/topology', methods=['POST'])
@require_jwt
def api_ai_topology():
    ai_cfg = get_effective_ai_config()
    if not ai_cfg['api_key']:
        return jsonify({'status': 'error', 'message': 'AI 未配置'}), 503

    data = request.json or {}
    session_id = data.get('session_id', '')

    session = ssh_manager.get_session(session_id)
    if not session or not session.connected:
        return jsonify({'status': 'error', 'message': '会话不存在'}), 404

    try:
        import json as _json
        ports_out, _ = session.execute_command(
            'ss -tuln 2>/dev/null || netstat -tuln 2>/dev/null', timeout=8
        )
        proc_out, _ = session.execute_command(
            'ps aux --sort=-%cpu | head -30', timeout=8
        )
        conn_out, _ = session.execute_command(
            'ss -tnp 2>/dev/null | head -40', timeout=8
        )
        # 收集更多上下文信息
        mem_out, _ = session.execute_command(
            'free -h 2>/dev/null || cat /proc/meminfo 2>/dev/null | head -10', timeout=5
        )
        disk_out, _ = session.execute_command(
            'df -h 2>/dev/null | head -10', timeout=5
        )
        uptime_out, _ = session.execute_command(
            'uptime 2>/dev/null', timeout=5
        )

        prompt = f"""分析以下服务器信息，输出详细的服务拓扑图。要求：

1. 只输出一个 JSON 对象，不要任何解释、注释、代码或 markdown 标记
2. 不要输出 python 代码、函数定义或任何编程语言语法
3. 拓扑描述要详细、专业，包含：服务角色、数据流向、协议类型、依赖强度
4. JSON 格式如下：
{{
    "mermaid": "graph LR\\n    Web[Nginx Web服务<br/>端口:80<br/>HTTP反向代理] -->|HTTP请求| DB[(MySQL数据库<br/>端口:3306<br/>持久化存储)]\\n    DB -->|数据查询| App[应用服务<br/>端口:8080<br/>业务逻辑处理]",
    "services": [
        {{"name": "nginx", "port": 80, "type": "web", "status": "运行中", "pid": 1234, "version": "1.24.0", "description": "HTTP 反向代理与静态资源服务", "cpu_percent": "0.5", "mem_percent": "1.2"}}
    ],
    "dependencies": [
        {{"from": "nginx", "to": "mysql", "protocol": "TCP/MySQL", "direction": "单向", "description": "Web 层通过 MySQL 协议查询用户与业务数据", "strength": "强依赖"}}
    ],
    "summary": "该服务器运行典型的 LAMP/LEMP 架构：Nginx 作为前端反向代理接收 HTTP 请求，将动态请求转发至应用服务处理，应用服务依赖 MySQL 数据库进行数据持久化。三个服务形成链路式调用：Web → DB → App。MySQL 监听 3306 端口（内部通信），App 监听 8080 端口提供业务 API。"
}}

服务器信息：
操作系统信息: {uptime_out[:200]}
监听端口: {ports_out[:800]}
运行进程: {proc_out[:1000]}
网络连接: {conn_out[:600]}
内存使用: {mem_out[:400]}
磁盘使用: {disk_out[:400]}

请根据以上信息，尽可能详细地推断服务类型、版本、运行状态和调用关系，输出 JSON。如果某些字段无法从信息中推断（如 version），可省略。"""
        _aicfg = get_effective_ai_config()
        result_text = call_groq_sync(
            messages=[
                {'role': 'system', 'content': '你是一个服务器分析工具。只输出纯JSON对象，不含markdown代码块标记、不含python代码、不含任何解释文字。以 { 开头，以 } 结尾。'},
                {'role': 'user', 'content': prompt},
            ],
            model=_aicfg['model'],
            api_key=_aicfg['api_key'],
            base_url=_aicfg['base_url'],
            max_tokens=2048,
            json_mode=True,
            timeout=60,
        )

        # 🔧 防御性日志 + 安全解析
        log.info(f'[AI Topology] result_text type={type(result_text).__name__}, value preview={str(result_text)[:200]}')
        if result_text is None:
            log.error('[AI Topology] ⚠️ call_groq_sync 返回 None!')
            result = {}
        elif isinstance(result_text, dict):
            result = result_text
        elif isinstance(result_text, str):
            stripped = result_text.strip()
            if stripped.startswith('{'):
                try:
                    result = _json.loads(stripped)
                except Exception as e:
                    log.warning(f'[AI Topology] JSON 解析失败: {e}, 使用空字典')
                    result = {}
            else:
                log.info(f'[AI Topology] 纯文本响应（非JSON），前200字: {stripped[:200]}')
                result = {'summary': stripped[:500], 'mermaid': 'graph LR\n    Server[服务器]', 'services': [], 'dependencies': []}
        else:
            log.warning(f'[AI Topology] 意外的返回类型: {type(result_text).__name__}')
            result = {}
        result.setdefault('mermaid', 'graph LR\n    Server[服务器<br/>未检测到明确服务]')
        result.setdefault('services', [])
        result.setdefault('dependencies', [])
        result.setdefault('summary', '拓扑分析未返回有效结果，请确认服务器上运行了可检测的服务进程。')
        # 为每个 service 补充默认字段
        for svc in result.get('services', []):
            svc.setdefault('status', '未知')
            svc.setdefault('pid', None)
            svc.setdefault('version', '')
            svc.setdefault('description', '')
            svc.setdefault('cpu_percent', '')
            svc.setdefault('mem_percent', '')
        # 为每个 dependency 补充默认字段
        for dep in result.get('dependencies', []):
            dep.setdefault('protocol', '')
            dep.setdefault('direction', '单向')
            dep.setdefault('strength', '')

        return jsonify({'status': 'ok', 'data': result})

    except Exception as e:
        log.error(f'[AI Topology] 失败: {e}')
        return jsonify({'status': 'error', 'message': str(e)}), 500
@app.route('/favicon.ico')
def favicon():
    return send_from_directory('../frontend', 'favicon.svg',
                            mimetype='image/svg+xml')

@app.route('/api/health', methods=['GET'])
@require_jwt
def health_check():
    import psutil
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.now().isoformat(),
        'system': {
            'cpu_percent': psutil.cpu_percent(),
            'memory_percent': psutil.virtual_memory().percent,
        },
        'sessions': ssh_manager.session_count(),
        'connections': len(db.get_all_connections_light()),
        'ai_enabled': config.AI_ENABLED and bool(get_effective_ai_config()['api_key']),
    })

# 增加 WebSocket 心跳检测
@socketio.on('ping')
def handle_ping():
    socketio.emit('pong', {'timestamp': time.time()})
    
# ══════════════════════════════════════════
#  启动
# ══════════════════════════════════════════

if __name__ == '__main__':
    # ── Nginx 反向代理 ──
    nginx_ok = False
    if config.NGINX_ENABLED and config.NGINX_PATH:
        nginx_ok = start_nginx(config.NGINX_PATH, config.NGINX_PORT)

    public_port = config.NGINX_PORT if nginx_ok else config.PORT

    log.info('=' * 55)
    log.info('  WebTerminal Server v3.0 (Production - Eventlet)')
    log.info(f'  http://localhost:{public_port}')
    if nginx_ok:
        log.info(f'  Proxy    : Nginx:{config.NGINX_PORT} → Flask:{config.PORT}')
    log.info(f'  Data Dir : {config.DATA_DIR}')
    log.info(f'  DB       : {config.DB_PATH}')
    log.info(f'  Dev Mode : {config.IS_DEFAULT_PASSWORD}')
    log.info(f'  AI       : {"✅ 已启用" if config.AI_ENABLED and get_effective_ai_config()["api_key"] else "❌ 未配置"}')
    log.info('=' * 55)

    # 打印已注册路由，方便调试
    log.info('已注册路由:')
    for rule in sorted(app.url_map.iter_rules(), key=lambda r: str(r)):
        if '/api/' in str(rule):
            log.info(f'  {list(rule.methods - {"HEAD", "OPTIONS"})} {rule}')

    # monkey_patch 已在文件顶部执行（第5-6行），此处无需重复
    socketio.run(
        app,
        host=config.HOST,
        port=config.PORT,
        debug=False,           # 生产环境关闭 debug
        use_reloader=False,
        allow_unsafe_werkzeug=True
    )