/**
 * 终端管理器
 */
class TerminalManager {
    constructor() {
        this.terminals = {};
    }

    /**
     * 创建终端实例
     */
    create(sessionId, container) {
        const isDark = document.documentElement.getAttribute('data-theme') !== 'light';

        const term = new Terminal({
            cursorBlink: true,
            cursorStyle: 'block',
            cursorWidth: 2,
            fontSize: 14,
            fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code',Consolas,'Courier New',monospace",
            theme: isDark ? this._darkTheme() : this._lightTheme(),
            scrollback: 10000,
            convertEol: false,
            allowProposedApi: true,
            windowsMode: false,
            drawBoldTextInBrightColors: true,
            letterSpacing: 0,
            lineHeight: 1.2,
        });

        const fitAddon = new FitAddon.FitAddon();
        const webLinksAddon = new WebLinksAddon.WebLinksAddon();
        term.loadAddon(fitAddon);
        term.loadAddon(webLinksAddon);
        term.open(container);

        setTimeout(() => { try { fitAddon.fit(); } catch (_) {} }, 100);

        this.terminals[sessionId] = { term, fitAddon };
        return term;
    }

    _darkTheme() {
        return {
            background: '#1a1d23', foreground: '#abb2bf',
            cursor: '#4fc3f7', cursorAccent: '#1a1d23',
            selectionBackground: '#264f78',
            selectionForeground: '#ffffff',
            selection: '#264f78',
            black: '#1a1d23', red: '#e06c75', green: '#98c379',
            yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd',
            cyan: '#56b6c2', white: '#abb2bf',
            brightBlack: '#5c6370', brightRed: '#e06c75',
            brightGreen: '#98c379', brightYellow: '#e5c07b',
            brightBlue: '#61afef', brightMagenta: '#c678dd',
            brightCyan: '#56b6c2', brightWhite: '#ffffff'
        };
    }

    _lightTheme() {
        return {
            background: '#ffffff', foreground: '#383a42',
            cursor: '#0184bc', cursorAccent: '#ffffff',
            selectionBackground: '#add6ff',
            selectionForeground: '#000000',
            selection: '#add6ff',
            black: '#383a42', red: '#e45649', green: '#50a14f',
            yellow: '#986801', blue: '#0184bc', magenta: '#a626a4',
            cyan: '#0997b3', white: '#fafafa',
            brightBlack: '#4f525e', brightRed: '#e45649',
            brightGreen: '#50a14f', brightYellow: '#986801',
            brightBlue: '#0184bc', brightMagenta: '#a626a4',
            brightCyan: '#0997b3', brightWhite: '#ffffff'
        };
    }

    get(sessionId) { return this.terminals[sessionId]; }

    fit(sessionId) {
        const t = this.terminals[sessionId];
        if (t) {
            try {
                t.fitAddon.fit();
                return { cols: t.term.cols, rows: t.term.rows };
            } catch (_) {}
        }
        return null;
    }

    write(sessionId, data) {
        const t = this.terminals[sessionId];
        if (t) t.term.write(data);
    }

    destroy(sessionId) {
        const t = this.terminals[sessionId];
        if (t) {
            try { t.term.dispose(); } catch (_) {}
            delete this.terminals[sessionId];
        }
    }

    focus(sessionId) {
        const t = this.terminals[sessionId];
        if (t) t.term.focus();
    }

    bindDataHandler(sessionId, dataHandler) {
        const termObj = this.terminals[sessionId];
        if (!termObj) return;

        if (termObj._dataHandler) {
            termObj.term.offData(termObj._dataHandler);
        }

        termObj._dataHandler = dataHandler;
        termObj.term.onData(dataHandler);
    }

    unbindDataHandler(sessionId) {
        const termObj = this.terminals[sessionId];
        if (termObj && termObj._dataHandler) {
            termObj.term.offData(termObj._dataHandler);
            delete termObj._dataHandler;
        }
    }

    recreate(sessionId, container) {
        this.destroy(sessionId);
        return this.create(sessionId, container);
    }

    updateTheme(isDark) {
        Object.values(this.terminals).forEach(({ term }) => {
            term.options.theme = isDark ? this._darkTheme() : this._lightTheme();
        });
    }
}
// 增加终端自适应
TerminalManager.prototype.fitAndSync = function(sessionId) {
    const t = this.terminals[sessionId];
    if (!t) return;

    try {
        t.fitAddon.fit();
        const size = { cols: t.term.cols, rows: t.term.rows };
        if (App.socket) {
            App.socket.emit('terminal_resize', { session_id: sessionId, ...size });
        }
        return size;
    } catch (e) {
        console.warn('[Terminal] Fit failed:', e);
        return null;
    }
};

// 增加终端恢复
TerminalManager.prototype.recover = function(sessionId, container) {
    if (this.terminals[sessionId]) {
        this.destroy(sessionId);
    }
    return this.create(sessionId, container);
};

console.log('✅ Terminal 增强修复已加载');

window.terminalManager = new TerminalManager();