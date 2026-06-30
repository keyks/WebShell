# backend/ssh_manager.py
"""
SSH 连接管理器
"""
import paramiko
import threading
import socket
import io
import time
import json
import eventlet
import logging
from pathlib import Path
from config import config
from logger import log, audit_log
from session_recorder import SessionRecorder

# 🔧 调试：启用 paramiko 底层 transport 日志
_paramiko_logger = logging.getLogger("paramiko")
_paramiko_logger.setLevel(logging.DEBUG)
# 将 paramiko 日志输出到我们的日志系统
_paramiko_handler = logging.StreamHandler()
_paramiko_handler.setFormatter(logging.Formatter(
    '%(asctime)s [PARAMIKO] %(name)s: %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
))
_paramiko_logger.handlers = [_paramiko_handler]
_paramiko_logger.propagate = False


class SSHSession:

    def __init__(self, conn_info: dict, recorder: SessionRecorder = None):
        self.conn_info  = conn_info
        self.client     = None
        self.channel    = None
        self.sftp       = None
        self.connected  = False
        self.lock       = threading.Lock()
        self.recorder   = recorder
        self._stop_flag = threading.Event()

        self._disconnecting = threading.Lock()  # 防止重复 disconnect
        self._disconnected = False  # 标记已断开
        self._cached_os    = None   # 缓存 OS 类型，避免重复检测时创建 nul 文件

        self._extra_sftp_lock     = threading.Lock()
        self._extra_sftp_channels = []

        self._last_active = time.time()
        self._host_keys_path = str(config.DATA_DIR / 'known_hosts')
        self._output_bytes = 0  # 🔧 累计终端输出字节数，防止输出洪泛滥

    def __del__(self):
        """安全析构：确保资源被释放，不调用 disconnect 避免竞争"""
        try:
            self._stop_flag.set()
        except Exception:
            pass
        try:
            if self.recorder:
                self.recorder.save()
        except Exception:
            pass
        # 不在此处调用 disconnect，避免 eventlet 环境下的竞争

    # ════════════════════════════════
    #  独立 SFTP 通道
    # ════════════════════════════════

    def open_extra_sftp(self):
        if not (self.client and self.connected):
            return None
        try:
            sftp = self.client.open_sftp()
            with self._extra_sftp_lock:
                self._extra_sftp_channels.append(sftp)
            return sftp
        except Exception as e:
            log.error(f'[SSH] 打开独立 SFTP 失败: {e}')
            return None

    def close_extra_sftp(self, sftp):
        try:
            sftp.close()
        except Exception:
            pass
        with self._extra_sftp_lock:
            try:
                self._extra_sftp_channels.remove(sftp)
            except ValueError:
                pass

    # ════════════════════════════════
    #  静态工具
    # ════════════════════════════════

    @staticmethod
    def test_port(host: str, port: int, timeout: int = None) -> bool:
        timeout = timeout or config.PORT_TEST_TIMEOUT
        sock = None
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(timeout)
            result = sock.connect_ex((host, int(port)))
            return result == 0
        except (socket.gaierror, OSError):
            return False
        finally:
            # 🔧 修复：确保在任何异常情况下 sock 都被关闭
            if sock:
                try:
                    sock.close()
                except Exception:
                    pass

    def _load_private_key(self, key_str: str, passphrase: str = None):
        key_str    = key_str.strip()
        passphrase = passphrase or None

        for key_class, name in [
            (paramiko.RSAKey,     'RSA'),
            (paramiko.Ed25519Key, 'Ed25519'),
            (paramiko.ECDSAKey,   'ECDSA'),
            (paramiko.DSSKey,     'DSS'),
        ]:
            try:
                key = key_class.from_private_key(
                    io.StringIO(key_str),
                    password=passphrase.encode() if passphrase else None,
                )
                log.info(f'[SSH] 加载 {name} 私钥成功')
                return key
            except paramiko.PasswordRequiredException:
                return f'{name} 私钥需要密码，请填写"私钥密码"字段'
            except Exception as e:
                # 🔧 记录详细错误，便于定位私钥解析问题
                log.error(f'[SSH] {name} 私钥解析异常: {e}')
                continue

        return '无法识别私钥格式，支持 RSA / Ed25519 / ECDSA / DSS'

    # ════════════════════════════════
    #  连接
    # ════════════════════════════════

    def connect(self) -> tuple[bool, str]:
        _t0 = time.time()
        host       = self.conn_info.get('host', '').strip()
        port       = int(self.conn_info.get('port', 22))
        if not (1 <= port <= 65535):
            return False, f'端口号无效: {port}，必须在 1-65535 范围内'
        username   = self.conn_info.get('username', 'root').strip()
        password   = self.conn_info.get('password', '')
        key_str    = self.conn_info.get('private_key', '')
        passphrase = self.conn_info.get('private_key_passphrase', '')

        # 🔧 连接前日志（密码脱敏：仅记录长度）
        auth_method = '私钥' if key_str else '密码'
        log.info(
            f'[SSH] ════════════ 开始连接 ════════════'
        )
        log.info(
            f'[SSH] 目标: {username}@{host}:{port} | '
            f'认证方式: {auth_method} | '
            f'密码长度: {len(password)} | 私钥长度: {len(key_str)}'
        )
        log.info(
            f'[SSH] 超时配置: connect={config.SSH_CONNECT_TIMEOUT}s, '
            f'banner={config.SSH_BANNER_TIMEOUT}s, '
            f'auth={config.SSH_AUTH_TIMEOUT}s'
        )

        if not host:     return False, '主机地址不能为空'
        if not username: return False, '用户名不能为空'
        if not password and not key_str:
            return False, '请提供密码或私钥'

        # Step 1: TCP 连通性测试
        _t1 = time.time()
        log.info(f'[SSH] [步骤1] 测试 {host}:{port} TCP 连通性...')
        if not self.test_port(host, port):
            msg = (
                f'无法连接到 {host}:{port}\n'
                f'请检查：\n'
                f'  1. 主机地址是否正确\n'
                f'  2. 端口 {port} 是否开放\n'
                f'  3. SSH 服务是否运行\n'
                f'  4. 防火墙/安全组是否放行该端口'
            )
            log.warning(f'[SSH] [步骤1] ❌ 端口不可达: {host}:{port} (耗时 {time.time()-_t1:.2f}s)')
            return False, msg
        log.info(f'[SSH] [步骤1] ✅ TCP 端口可达 (耗时 {time.time()-_t1:.2f}s)')

        try:
            # Step 2: 创建 SSH 客户端
            _t2 = time.time()
            log.info(f'[SSH] [步骤2] 创建 SSH 客户端, known_hosts={self._host_keys_path} ...')
            # 🔧 确保 known_hosts 文件存在，否则 AutoAddPolicy 内部 save_host_keys
            # 调用 load_host_keys → open('r') 会抛出 FileNotFoundError
            _known_hosts_path = Path(self._host_keys_path)
            _known_hosts_path.parent.mkdir(parents=True, exist_ok=True)
            if not _known_hosts_path.exists():
                _known_hosts_path.write_text('')
            self.client = paramiko.SSHClient()
            self.client.load_host_keys(self._host_keys_path)
            log.info(f'[SSH] [步骤2] 已加载 known_hosts ({_known_hosts_path.stat().st_size} bytes)')
            # 使用 WarningPolicy：接受新主机密钥但记录警告日志（比 AutoAddPolicy 更安全）
            self.client.set_missing_host_key_policy(paramiko.WarningPolicy())
            log.info(f'[SSH] [步骤2] ✅ SSH 客户端就绪 (耗时 {time.time()-_t2:.2f}s)')

            # Step 3: 构建连接参数
            kw = dict(
                hostname=host, port=port, username=username,
                timeout=config.SSH_CONNECT_TIMEOUT,
                banner_timeout=config.SSH_BANNER_TIMEOUT,
                auth_timeout=config.SSH_AUTH_TIMEOUT,
                allow_agent=False, look_for_keys=False,
            )

            if key_str:
                key = self._load_private_key(key_str, passphrase)
                if isinstance(key, str):
                    log.warning(f'[SSH] 私钥加载失败: {key}')
                    return False, key
                kw['pkey'] = key
                log.info(f'[SSH] [步骤3] 使用私钥认证, 密钥类型={type(key).__name__}')
            else:
                kw['password'] = password
                log.info(
                    f'[SSH] [步骤3] 使用密码认证: '
                    f'username={username!r}, '
                    f'password_len={len(password)}'
                )

            # Step 4: paramiko connect
            _t4 = time.time()
            log.info(f'[SSH] [步骤4] 调用 paramiko.connect() ...')
            self.client.connect(**kw)
            _t4e = time.time()
            log.info(f'[SSH] [步骤4] ✅ connect() 成功 (耗时 {_t4e-_t4:.2f}s)')

            # Step 5: invoke_shell
            _t5 = time.time()
            log.info(f'[SSH] [步骤5] 打开交互式 shell (xterm-256color, 220x50)...')
            self.channel = self.client.invoke_shell(
                term='xterm-256color', width=220, height=50
            )
            self.channel.settimeout(0.1)
            self.connected    = True
            self._last_active = time.time()
            self._stop_flag.clear()

            # 🔧 启用 SSH Transport TCP Keepalive，防止空闲连接被防火墙/NAT 丢弃
            try:
                transport = self.client.get_transport()
                if transport:
                    transport.set_keepalive(config.SSH_KEEPALIVE_INTERVAL)
                    log.info(f'[SSH] TCP keepalive 已启用 ({config.SSH_KEEPALIVE_INTERVAL}s)')
            except Exception as e:
                log.warning(f'[SSH] 设置 keepalive 失败: {e}')

            log.info(f'[SSH] [步骤5] ✅ shell 已打开 (耗时 {time.time()-_t5:.2f}s)')

            _total = time.time() - _t0
            log.info(
                f'[SSH] ════════════ ✅ 连接成功 ════════════\n'
                f'[SSH] {username}@{host}:{port} | 总耗时 {_total:.2f}s'
            )
            return True, '连接成功'

        except paramiko.AuthenticationException as e:
            _elapsed = time.time() - _t0
            err_str = str(e)
            log.warning(
                f'[SSH] ════════════ ❌ 认证失败 ════════════\n'
                f'[SSH] 目标: {username}@{host}:{port}\n'
                f'[SSH] 错误: {err_str}\n'
                f'[SSH] 耗时: {_elapsed:.2f}s'
            )
            audit_log.warning(f'[AUDIT] SSH 认证失败 | 用户={username} 主机={host}:{port}')

            if 'timeout' in err_str.lower():
                msg = (
                    f'认证超时（{_elapsed:.0f}s）\n'
                    f'可能原因：\n'
                    f'  1. SSH 服务器禁用了密码认证（PasswordAuthentication no）\n'
                    f'  2. 服务器需要多因素认证（MFA/OTP）\n'
                    f'  3. PAM 模块配置异常导致认证挂起\n'
                    f'  建议：检查服务器 /etc/ssh/sshd_config 中 PasswordAuthentication 配置'
                )
            elif 'keyboard-interactive' in err_str.lower():
                msg = '认证失败：服务器要求键盘交互认证（可能需要OTP验证码）'
            elif 'publickey' in err_str.lower():
                msg = '认证失败：私钥被拒绝，请检查私钥是否正确'
            else:
                msg = f'认证失败：用户名或密码错误\n详情: {err_str[:100]}'

            return False, msg
        except paramiko.SSHException as e:
            _elapsed = time.time() - _t0
            err = str(e)
            # 🔧 针对常见 SSHException 给出具体提示
            if 'no acceptable' in err.lower():
                msg = (f'SSH 协议协商失败: {err}\n'
                       f'可能是加密算法不兼容，请检查服务器 SSH 版本')
            elif 'banner' in err.lower():
                msg = (f'SSH Banner 超时: 服务器响应过慢\n'
                       f'当前超时={config.SSH_BANNER_TIMEOUT}s')
            else:
                msg = f'SSH 错误: {err}'
            log.error(
                f'[SSH] ════════════ SSHException ════════════\n'
                f'[SSH] 目标: {username}@{host}:{port}\n'
                f'[SSH] 错误: {e}\n'
                f'[SSH] 耗时: {_elapsed:.2f}s',
                exc_info=True
            )
            return False, msg
        except socket.timeout:
            _elapsed = time.time() - _t0
            msg = (f'连接超时 ({config.SSH_CONNECT_TIMEOUT}s): {host}:{port}\n'
                   f'请检查网络连通性')
            log.error(
                f'[SSH] ════════════ 连接超时 ════════════\n'
                f'[SSH] 目标: {host}:{port}\n'
                f'[SSH] 耗时: {_elapsed:.2f}s'
            )
            return False, msg
        except socket.gaierror as e:
            msg = f'DNS 解析失败: 无法解析 "{host}"\n详情: {e}'
            log.error(f'[SSH] DNS 解析失败: {host} | {e}')
            return False, msg
        except ConnectionRefusedError as e:
            msg = f'连接被拒绝: {host}:{port} (端口未监听或防火墙拦截)'
            log.error(f'[SSH] 连接被拒绝: {host}:{port} | {e}')
            return False, msg
        except Exception as e:
            _elapsed = time.time() - _t0
            msg = f'连接失败 ({type(e).__name__}): {str(e)}'
            log.error(
                f'[SSH] ════════════ 连接异常 ════════════\n'
                f'[SSH] 目标: {username}@{host}:{port}\n'
                f'[SSH] 异常类型: {type(e).__name__}\n'
                f'[SSH] 异常消息: {str(e)}\n'
                f'[SSH] 耗时: {_elapsed:.2f}s',
                exc_info=True
            )
            return False, msg

    # ════════════════════════════════
    #  终端 I/O
    # ════════════════════════════════

    def send_command(self, command: str) -> bool:
        # 🔧 DoS 防护：单次命令最大长度，防止恶意超长命令
        if len(command) > config.MAX_COMMAND_LENGTH:
            log.warning(f'[SSH] 拒绝超长命令 ({len(command)} 字节)')
            return False
        if self.channel and self.connected:
            try:
                if self.recorder:
                    self.recorder.record_input(command)
                self.channel.send(command)
                self._last_active = time.time()
                return True
            except Exception as e:
                log.warning(f'[SSH] 发送失败: {e}')
                self.connected = False
        return False

    def read_output(self) -> str:
        if not (self.channel and self.connected):
            return ''
        # 🔧 DoS 防护：单会话累计输出上限，防止恶意进程输出洪泛
        max_bytes = config.MAX_TERMINAL_OUTPUT_BYTES
        if self._output_bytes > max_bytes:
            return ''
        try:
            if self.channel.recv_ready():
                data = self.channel.recv(65536)
                self._output_bytes += len(data)
                # 🔧 超出限制后截断，并发送警告到终端
                if self._output_bytes > max_bytes:
                    try:
                        self.channel.send('\r\n\x1b[31m[WebTerminal] 终端输出已超过限制，输出已中止。请使用重定向或分页。\r\n\x1b[0m'.encode('utf-8'))
                    except Exception:
                        pass
                    return ''
                text = data.decode('utf-8', errors='replace')
                if self.recorder:
                    self.recorder.record_output(text)
                self._last_active = time.time()
                return text
        except socket.timeout:
            pass
        except Exception:
            pass
        return ''

    def stop(self):
        self._stop_flag.set()

    def should_stop(self) -> bool:
        return self._stop_flag.is_set()

    def is_idle_timeout(self) -> bool:
        if config.SESSION_IDLE_TIMEOUT <= 0:
            return False
        return (time.time() - self._last_active) > config.SESSION_IDLE_TIMEOUT

    def resize(self, cols: int, rows: int):
        if self.channel and self.connected:
            try:
                self.channel.resize_pty(width=cols, height=rows)
            except Exception:
                pass

    # ════════════════════════════════
    #  主 SFTP
    # ════════════════════════════════

    def get_sftp(self):
        if not (self.client and self.connected):
            return None
        try:
            if self.sftp is None or self.sftp.get_channel().closed:
                self.sftp = self.client.open_sftp()
            return self.sftp
        except Exception as e:
            log.error(f'[SSH] SFTP 失败: {e}')
            return None

    # ════════════════════════════════
    #  命令执行（硬超时版）
    # ════════════════════════════════

    def execute_command(self, command: str, timeout: int = 10) -> tuple[str, str]:
        """
        在独立 channel 上执行命令，严格控制超时。
        避免 stdout.read() 在某些命令下无限阻塞。

        🔒 安全要求：调用方必须确保 command 已经过 sanitize，规则：
        1. 硬编码字面量命令（如 "uname -a"）→ 直接传入
        2. 包含用户可控参数的 → 必须使用 safe_command(template, **kwargs) 构建
        3. **严禁** 在此处使用 f-string 拼接用户输入（语句级禁止）

        详见本模块 safe_command() 工具函数。
        """
        if not (self.client and self.connected):
            return '', '未连接'

        chan = None
        try:
            transport = self.client.get_transport()
            if not transport or not transport.is_active():
                return '', 'SSH 传输不可用'

            chan = transport.open_session()
            chan.settimeout(1.0)
            chan.exec_command(command)

            stdout_chunks = []
            stderr_chunks = []
            start = time.time()

            while True:
                if chan.recv_ready():
                    stdout_chunks.append(chan.recv(65536))

                if chan.recv_stderr_ready():
                    stderr_chunks.append(chan.recv_stderr(65536))

                if chan.exit_status_ready():
                    # 读完剩余数据
                    while chan.recv_ready():
                        stdout_chunks.append(chan.recv(65536))
                    while chan.recv_stderr_ready():
                        stderr_chunks.append(chan.recv_stderr(65536))
                    break

                if time.time() - start > timeout:
                    try:
                        chan.close()
                    except Exception:
                        pass
                    log.warning(
                        f'[SSH] 命令超时 (>{timeout}s): {command[:80]}'
                    )
                    return '', f'命令执行超时（>{timeout}s）'

                # 🔧 修复：在 eventlet 环境下使用 eventlet.sleep 替代 time.sleep
                # 避免在 monkey-patched 环境中的潜在阻塞问题
                eventlet.sleep(0.05)

            stdout_text = b''.join(stdout_chunks).decode('utf-8', errors='replace')
            stderr_text = b''.join(stderr_chunks).decode('utf-8', errors='replace')
            return stdout_text, stderr_text

        except Exception as e:
            return '', str(e)

        finally:
            if chan:
                try:
                    chan.close()
                except Exception:
                    pass

    # ════════════════════════════════
    #  系统监控
    # ════════════════════════════════

    def _detect_os(self) -> str:
        # 缓存：OS 类型连接期间不变，避免重复执行 cmd /c ver 2>nul
        # 在 Linux 上该命令会因 shell 重定向创建字面量文件 "nul"
        if self._cached_os:
            return self._cached_os
        # 先检测 Unix（uname 不会在 Linux 上产生副作用文件）
        out, _ = self.execute_command('uname -s 2>/dev/null', timeout=5)
        s = out.strip().lower()
        if 'linux'  in s: self._cached_os = 'linux';  return 'linux'
        if 'darwin' in s: self._cached_os = 'macos';  return 'macos'
        if 'bsd'    in s: self._cached_os = 'bsd';    return 'bsd'
        # uname 无结果则检测 Windows
        out, _ = self.execute_command('cmd /c ver 2>nul', timeout=5)
        if 'Windows' in out or 'Microsoft' in out:
            self._cached_os = 'windows'; return 'windows'
        self._cached_os = 'unknown'; return 'unknown'

    def get_system_info(self) -> dict:
        info: dict = {}
        try:
            os_type = self._detect_os()
            info['os_type'] = os_type
            if   os_type == 'linux':   self._get_linux_info(info)
            elif os_type == 'windows': self._get_windows_info(info)
            elif os_type == 'macos':   self._get_macos_info(info)
            else:                      self._get_generic_info(info)
        except Exception as e:
            info['error'] = str(e)
        return info

    def _get_linux_info(self, info: dict):
        """合并 10 次独立 SSH exec → 1 次，大幅降低网络 RTT 耗时"""
        script = (
            "echo '==SYSINFO_CPU==';"
            "grep 'cpu ' /proc/stat 2>/dev/null | "
            "awk '{u=$2+$4;t=$2+$3+$4+$5;printf \"%.1f\",(u/t)*100}';"
            "echo '==SYSINFO_MEM==';"
            "free -b 2>/dev/null || free 2>/dev/null;"
            "echo '==SYSINFO_DSK==';"
            "df -B1 / 2>/dev/null | tail -1;"
            "echo '==SYSINFO_NET==';"
            "cat /proc/net/dev 2>/dev/null;"
            "echo '==SYSINFO_LOAD==';"
            "cat /proc/loadavg 2>/dev/null;"
            "echo '==SYSINFO_UP==';"
            "uptime -p 2>/dev/null || uptime 2>/dev/null;"
            "echo '==SYSINFO_SYS==';"
            "uname -srm 2>/dev/null;"
            "echo '==SYSINFO_CORES==';"
            "nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null;"
            "echo '==SYSINFO_PROCS==';"
            "ps aux 2>/dev/null | wc -l;"
            "echo '==SYSINFO_KERN==';"
            "uname -r 2>/dev/null"
        )
        out, _ = self.execute_command(script, timeout=15)
        self._parse_linux_info(info, out)

    def _parse_linux_info(self, info: dict, out: str):
        """解析合并后的 Linux 系统信息输出"""
        sections = {}
        for p in out.split('==SYSINFO_'):
            if '==' not in p:
                continue
            key, _, content = p.partition('==')
            key = key.strip()
            # 去掉下一个段标记
            idx = content.find('\n==SYSINFO_')
            if idx >= 0:
                content = content[:idx]
            sections[key] = content.strip()

        # --- CPU ---
        cpu_out = sections.get('CPU', '0')
        try:    info['cpu_percent'] = float(cpu_out.strip())
        except: info['cpu_percent'] = 0

        # --- 内存（兼容 busybox 与标准 Linux free 输出） ---
        mem_out = sections.get('MEM', '')
        lines = [l for l in mem_out.split('\n') if 'Mem' in l or 'mem' in l.lower()]
        if lines:
            parts = lines[0].split()
            if len(parts) >= 3:
                try:
                    total, used = int(parts[1]), int(parts[2])
                    info['memory'] = {
                        'total': total, 'used': used,
                        'percent': round(used/total*100, 1) if total else 0,
                    }
                except (ValueError, IndexError):
                    info['memory'] = {'total': 0, 'used': 0, 'percent': 0}
            else:
                info['memory'] = {'total': 0, 'used': 0, 'percent': 0}
        else:
            info['memory'] = {'total': 0, 'used': 0, 'percent': 0}

        # --- 磁盘 ---
        dsk_out = sections.get('DSK', '')
        parts = dsk_out.split()
        if len(parts) >= 4:
            try:
                total, used = int(parts[1]), int(parts[2])
                info['disk'] = {
                    'total': total, 'used': used,
                    'percent': round(used/total*100, 1) if total else 0,
                }
            except (ValueError, IndexError):
                info['disk'] = {'total': 0, 'used': 0, 'percent': 0}
        else:
            info['disk'] = {'total': 0, 'used': 0, 'percent': 0}

        # --- 网络（优先非 lo 接口，fallback 到 lo） ---
        net_out = sections.get('NET', '')
        found = False
        for line in net_out.split('\n'):
            if ':' not in line or 'Inter-' in line or 'face ' in line:
                continue
            if ' lo:' in line:
                continue  # 先跳过 lo
            parts = line.split()
            if len(parts) >= 10:
                info['network'] = {
                    'rx_bytes': int(parts[1]), 'tx_bytes': int(parts[9])
                }
                found = True
                break
        if not found:
            for line in net_out.split('\n'):
                if 'lo:' in line:
                    parts = line.split()
                    if len(parts) >= 10:
                        info['network'] = {
                            'rx_bytes': int(parts[1]),
                            'tx_bytes': int(parts[9])
                        }
                        found = True
                        break
        if not found:
            info['network'] = {'rx_bytes': 0, 'tx_bytes': 0}

        # --- 负载 ---
        load_out = sections.get('LOAD', '0 0 0')
        parts = load_out.split()
        info['load'] = {
            'load1':  float(parts[0]) if len(parts) > 0 else 0,
            'load5':  float(parts[1]) if len(parts) > 1 else 0,
            'load15': float(parts[2]) if len(parts) > 2 else 0,
        }

        # --- 运行时间 / 系统 / 核心数 / 进程数 / 内核 ---
        info['uptime']  = sections.get('UP', '-') or '-'
        info['system']  = sections.get('SYS', '-') or '-'
        try:    info['cpu_cores'] = int(sections.get('CORES', '1').strip().split('\n')[0])
        except: info['cpu_cores'] = 1
        try:    info['process_count'] = max(0, int(sections.get('PROCS', '0').strip()) - 1)
        except: info['process_count'] = 0
        info['kernel']  = sections.get('KERN', '-') or '-'

    def _get_macos_info(self, info: dict):
        info.update({
            'cpu_percent':   0,
            'memory':        {'total': 0, 'used': 0, 'percent': 0},
            'disk':          {'total': 0, 'used': 0, 'percent': 0},
            'network':       {'rx_bytes': 0, 'tx_bytes': 0},
            'load':          {'load1': 0, 'load5': 0, 'load15': 0},
            'uptime':        '-',
            'system':        '-',
            'kernel':        '-',
            'cpu_cores':     1,
            'process_count': 0,
        })
        out, _ = self.execute_command('uname -srm', timeout=5)
        info['system'] = out.strip() or '-'
        out, _ = self.execute_command('uptime', timeout=5)
        info['uptime'] = out.strip() or '-'

    def _get_windows_info(self, info: dict):
        """通过 PowerShell 采集 Windows 系统指标"""
        info.update({
            'cpu_percent':   0,
            'memory':        {'total': 0, 'used': 0, 'percent': 0},
            'disk':          {'total': 0, 'used': 0, 'percent': 0},
            'network':       {'rx_bytes': 0, 'tx_bytes': 0},
            'load':          {'load1': 0, 'load5': 0, 'load15': 0},
            'uptime':        '-',
            'system':        'Windows',
            'kernel':        '-',
            'cpu_cores':     1,
            'process_count': 0,
        })
        # 合并采集，减少 SSH RTT
        ps_script = (
            "powershell -NoProfile -Command \""
            "$cpu=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average;"
            "$os=Get-CimInstance Win32_OperatingSystem;"
            "$mem_total=[math]::Round($os.TotalVisibleMemorySize/1MB);"
            "$mem_free=[math]::Round($os.FreePhysicalMemory/1MB);"
            "$mem_used=$mem_total-$mem_free;"
            "$mem_pct=[math]::Round($mem_used/$mem_total*100,1);"
            "$disk=Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | "
            "Select @{N='Size';E={[math]::Round($_.Size/1GB)}},"
            "@{N='Free';E={[math]::Round($_.FreeSpace/1GB)}};"
            "$uptime=(Get-Date) - $os.LastBootUpTime;"
            "$procs=(Get-Process).Count;"
            "Write-Output \\\"CPU_PCT=$cpu\\\";"
            "Write-Output \\\"MEM_TOTAL=$mem_total\\\";"
            "Write-Output \\\"MEM_USED=$mem_used\\\";"
            "Write-Output \\\"MEM_PCT=$mem_pct\\\";"
            "Write-Output \\\"DISK_INFO=$($disk | ConvertTo-Json -Compress)\\\";"
            "Write-Output \\\"UPTIME=$($uptime.Days)d $($uptime.Hours)h $($uptime.Minutes)m\\\";"
            "Write-Output \\\"PROCS=$procs\\\";"
            "Write-Output \\\"KERNEL=$($os.Caption) $($os.Version)\\\";"
            "\""
        )
        try:
            out, _ = self.execute_command(ps_script, timeout=15)
            for line in out.strip().split('\n'):
                line = line.strip()
                if line.startswith('CPU_PCT='):
                    try: info['cpu_percent'] = float(line.split('=', 1)[1])
                    except Exception: pass
                elif line.startswith('MEM_TOTAL='):
                    try: info['memory']['total'] = int(float(line.split('=', 1)[1]))
                    except Exception: pass
                elif line.startswith('MEM_USED='):
                    try: info['memory']['used'] = int(float(line.split('=', 1)[1]))
                    except Exception: pass
                elif line.startswith('MEM_PCT='):
                    try: info['memory']['percent'] = float(line.split('=', 1)[1])
                    except Exception: pass
                elif line.startswith('DISK_INFO='):
                    try:
                        disks = json.loads(line.split('=', 1)[1])
                        total_gb = sum(d.get('Size', 0) for d in (disks if isinstance(disks, list) else [disks]))
                        free_gb  = sum(d.get('Free', 0) for d in (disks if isinstance(disks, list) else [disks]))
                        info['disk'] = {
                            'total': total_gb, 'used': total_gb - free_gb,
                            'percent': round((total_gb - free_gb) / total_gb * 100, 1) if total_gb > 0 else 0,
                        }
                    except Exception: pass
                elif line.startswith('UPTIME='):
                    info['uptime'] = line.split('=', 1)[1]
                elif line.startswith('PROCS='):
                    try: info['process_count'] = int(line.split('=', 1)[1])
                    except Exception: pass
                elif line.startswith('KERNEL='):
                    info['kernel'] = line.split('=', 1)[1]
        except Exception:
            pass  # 采集失败保留默认值

    def _get_generic_info(self, info: dict):
        info.update({
            'cpu_percent':   0,
            'memory':        {'total': 0, 'used': 0, 'percent': 0},
            'disk':          {'total': 0, 'used': 0, 'percent': 0},
            'network':       {'rx_bytes': 0, 'tx_bytes': 0},
            'load':          {'load1': 0, 'load5': 0, 'load15': 0},
            'uptime':        '-',
            'system':        'Unknown',
            'kernel':        '-',
            'cpu_cores':     1,
            'process_count': 0,
        })
        out, _ = self.execute_command('uptime', timeout=5)
        info['uptime'] = out.strip() or '-'

    # ════════════════════════════════
    #  断开
    # ════════════════════════════════

    def disconnect(self):
        """安全断开连接，防止重复调用和 eventlet 竞争"""
        with self._disconnecting:
            if self._disconnected:
                return
            self._disconnected = True
            self.connected = False
            self._stop_flag.set()

            if self.recorder:
                try:
                    self.recorder.save()
                except Exception:
                    pass

            with self._extra_sftp_lock:
                for sftp in self._extra_sftp_channels:
                    try:
                        sftp.close()
                    except Exception:
                        pass
                self._extra_sftp_channels.clear()

            for attr in ('sftp', 'channel', 'client'):
                try:
                    obj = getattr(self, attr, None)
                    if obj:
                        obj.close()
                        setattr(self, attr, None)
                except Exception:
                    pass

            log.info('[SSH] 连接已断开')


# ════════════════════════════════════════════
#  SSH 会话管理器
# ════════════════════════════════════════════

# ══════════════════════════════════════════
#  🔧 安全命令构建工具
# ══════════════════════════════════════════

def safe_command(template: str, **kwargs) -> str:
    """
    安全地拼接命令字符串，自动对用户可控路径/参数进行 shlex 转义。

    用法::

        cmd = safe_command("ls -la {path}", path=user_input)
        session.execute_command(cmd)

    规则：
    - 所有 `.format(**kwargs)` 的参数都会经过 `shlex.quote()` 处理
    - **绝不** 在调用方自己拼接 f-string 后再传入 execute_command
    - 如果参数是 None，则跳过替换（保留占位符报错）

    安全审计点：搜索本项目中所有 `session.execute_command(` 调用，
    确保传入的命令要么是 **硬编码字面量**，要么通过此函数构建。
    """
    import shlex
    safe_kwargs = {}
    for k, v in kwargs.items():
        if v is None:
            raise ValueError(f'safe_command: 参数 {k} 不能为 None')
        # 🔧 shlex.quote 会为参数添加引号并转义所有 shell 特殊字符
        safe_kwargs[k] = shlex.quote(str(v))
    return template.format(**safe_kwargs)


class SSHManager:

    def __init__(self):
        self.sessions: dict[str, SSHSession] = {}
        self.lock = threading.Lock()
        self._session_versions: dict[str, int] = {}

    def create_session(
        self, session_id: str, conn_info: dict, conn_name: str = ''
    ) -> tuple[bool, str]:
        from session_recorder import SessionRecorder
        recorder = (
            SessionRecorder(session_id, conn_name)
            if config.ENABLE_RECORDING else None
        )
        session = SSHSession(conn_info, recorder=recorder)
        log.info(f'[SSHManager] 创建会话: {session_id}, 目标: {conn_name}')
        success, msg = session.connect()
        log.info(f'[SSHManager] 会话 {session_id} 连接结果: {"成功" if success else "失败"}, 消息: {msg}')
        if success:
            with self.lock:
                old = self.sessions.pop(session_id, None)
                if old:
                    log.info(f'[SSHManager] 替换旧会话: {session_id}')
                    old.disconnect()
                session._version = self._session_versions.get(session_id, 0) + 1
                self._session_versions[session_id] = session._version
                self.sessions[session_id] = session
        return success, msg

    def get_session_version(self, session_id: str) -> int:
        return self._session_versions.get(session_id, 0)

    def get_session(self, session_id: str) -> SSHSession | None:
        return self.sessions.get(session_id)

    def remove_session(self, session_id: str):
        with self.lock:
            s = self.sessions.pop(session_id, None)
            if s:
                s.disconnect()
            # 🔧 不删除版本号，确保 read_loop 的版本检查在会话重建后仍然有效
            # 版本号单调递增，旧 read_loop 的 expected_version 与新 session 的 _version 不会相等

    def get_active_sessions(self) -> list[str]:
        return list(self.sessions.keys())

    def session_count(self) -> int:
        return len(self.sessions)

    def cleanup_idle_sessions(self) -> list[str]:
        if config.SESSION_IDLE_TIMEOUT <= 0:
            return []
        cleaned = []
        to_disconnect = []
        with self.lock:
            for sid, session in list(self.sessions.items()):
                if session.is_idle_timeout():
                    to_disconnect.append((sid, session))
                    del self.sessions[sid]
                    # 🔧 不删除版本号，保持版本单调递增
                    cleaned.append(sid)
        # 🔧 修复：在锁外执行 I/O 操作（disconnect 会保存录制文件）
        for sid, session in to_disconnect:
            session.disconnect()
            log.info(f'[SSH] 空闲超时，自动断开: {sid}')
        return cleaned