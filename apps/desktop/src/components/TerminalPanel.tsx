import { useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Plus, Send, Square, X } from "lucide-react";
import { needsTerminalConfirmation, onTerminalCommand, takeTerminalCommands } from "../lib/terminalBridge";
import { useT } from "../i18n";
import "@xterm/xterm/css/xterm.css";
import "./TerminalPanel.css";

type Event = { id: number; data: number[]; exitCode: number | null; error: string | null };
type Tab = { key: string; title: number; command?: string };

function Session({
  root,
  active,
  command,
  onSendSelection,
}: {
  root: string;
  active: boolean;
  command?: string;
  onSendSelection?: (text: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const id = useRef<number | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [selection, setSelection] = useState("");
  const [error, setError] = useState("");
  const [closed, setClosed] = useState(false);
  const [ready, setReady] = useState(false);
  // A single-line command is typed at the prompt without Enter; one that would execute or complete when typed waits for an explicit Run.
  const confirm = !!command && needsTerminalConfirmation(command);
  const [commandPending, setCommandPending] = useState(confirm);
  const [typed, setTyped] = useState(false);
  const typedOnce = useRef(false);
  const t = useT();
  const ru = t.locale === "ru";
  useEffect(() => {
    let disposed = false;
    setReady(false);
    setClosed(false);
    setError("");
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      scrollback: 3000,
      theme: { background: "#181818", foreground: "#dedede", cursor: "#dedede" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    termRef.current = term;
    fitRef.current = fit;
    fit.fit();
    const output = new Channel<Event>();
    output.onmessage = (event) => {
      if (disposed) return;
      if (event.data.length) term.write(new Uint8Array(event.data));
      if (event.error) setError(event.error);
      if (event.exitCode != null) {
        setClosed(true);
        term.writeln(`\r\n[exit ${event.exitCode}]`);
      }
    };
    const input = term.onData((data) => {
      if (id.current != null)
        invoke("terminal_write", { id: id.current, data }).catch((e) => {
          if (!disposed) setError(String(e));
        });
    });
    const selectionChange = term.onSelectionChange(() => setSelection(term.getSelection()));
    const resize = () => {
      if (disposed || !host.current?.offsetWidth) return;
      fit.fit();
      if (id.current != null)
        invoke("terminal_resize", { id: id.current, cols: term.cols, rows: term.rows }).catch((e) => {
          if (!disposed) setError(String(e));
        });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current!);
    invoke<number>("terminal_create", { root, cols: term.cols, rows: term.rows, output })
      .then((value) => {
        if (disposed) {
          invoke("terminal_close", { id: value }).catch(() => {});
          return;
        }
        id.current = value;
        setReady(true);
        resize();
        if (host.current?.offsetWidth) term.focus();
        if (command && !confirm && !typedOnce.current) {
          typedOnce.current = true;
          invoke("terminal_write", { id: value, data: command })
            .then(() => {
              if (!disposed) setTyped(true);
            })
            .catch((e) => {
              if (!disposed) setError(String(e));
            });
        }
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
      observer.disconnect();
      input.dispose();
      selectionChange.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      if (id.current != null) invoke("terminal_close", { id: id.current }).catch(() => {});
      id.current = null;
    };
  }, [root]);
  useEffect(() => {
    if (active) {
      fitRef.current?.fit();
    }
  }, [active]);
  return (
    <div className="terminal-session" hidden={!active}>
      <div className="terminal-actions">
        <span className="terminal-root" title={root}>
          {root}
        </span>
        <button
          className="icon-btn"
          disabled={closed || !ready}
          title={ru ? "Прервать команду (Ctrl+C)" : "Interrupt command (Ctrl+C)"}
          aria-label={ru ? "Прервать команду" : "Interrupt command"}
          onClick={() => invoke("terminal_write", { id: id.current, data: "\x03" }).catch((e) => setError(String(e)))}
        >
          <Square size={13} />
        </button>
        {onSendSelection && (
          <button
            className="icon-btn"
            disabled={!selection}
            title={ru ? "Отправить выделение в чат" : "Send selection to chat"}
            aria-label={ru ? "Отправить выделение в чат" : "Send selection to chat"}
            onClick={() => onSendSelection(`Terminal (${root}):\n\n${selection}`)}
          >
            <Send size={13} />
          </button>
        )}
      </div>
      {typed && command && (
        <div className="terminal-command-preview">
          <p>
            {ru
              ? "Команда набрана, но не запущена. Нажмите Enter в терминале, чтобы выполнить её."
              : "The command is typed but not run. Press Enter in the terminal to run it."}
          </p>
          <button className="btn-soft" onClick={() => setTyped(false)}>
            {ru ? "Скрыть" : "Dismiss"}
          </button>
        </div>
      )}
      {commandPending && command && (
        <div className="terminal-command-preview">
          <p>
            {ru
              ? "Команда из нескольких строк (или с табуляцией) будет запущена только после подтверждения:"
              : "A multi-line (or tab-containing) command runs only after confirmation:"}
          </p>
          <pre>{command}</pre>
          <button
            className="btn-soft"
            disabled={!ready || closed}
            onClick={async () => {
              try {
                await invoke("terminal_write", { id: id.current, data: command + "\r" });
                setCommandPending(false);
                termRef.current?.focus();
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            {ru ? "Запустить команду" : "Run command"}
          </button>
          <button className="btn-soft" onClick={() => setCommandPending(false)}>
            {ru ? "Отмена" : "Cancel"}
          </button>
        </div>
      )}
      <div className="terminal-host" ref={host} />
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/** Each tab owns a native session; hiding a tab preserves it, unmounting closes it. */
export function TerminalPanel({
  root,
  commandScope,
  onSendSelection,
}: {
  root: string;
  commandScope?: string;
  onSendSelection?: (text: string) => void;
}) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState("");
  const [notice, setNotice] = useState("");
  const tabCount = useRef(0);
  tabCount.current = tabs.length;
  const next = useRef(1);
  const t = useT();
  const ru = t.locale === "ru";
  const add = () => {
    const tab = { key: crypto.randomUUID(), title: next.current++ };
    setTabs((old) => [...old, tab]);
    setActive(tab.key);
  };
  useEffect(() => {
    const consume = () => {
      for (const request of takeTerminalCommands(commandScope ?? root)) {
        if (tabCount.current >= 16) {
          setNotice(ru ? "Закройте один из терминалов: максимум 16." : "Close a terminal first: the maximum is 16.");
          continue;
        }
        tabCount.current += 1;
        setNotice("");
        const tab = { key: request.id, title: next.current++, command: request.command };
        setTabs((old) => [...old, tab]);
        setActive(tab.key);
      }
    };
    consume();
    return onTerminalCommand(consume);
  }, [root, commandScope]);
  const close = (key: string) => {
    const remaining = tabs.filter((tab) => tab.key !== key);
    setTabs(remaining);
    if (active === key) setActive(remaining[remaining.length - 1]?.key ?? "");
  };
  return (
    <section className="terminal-panel" aria-label={t("terminal")}>
      <div className="terminal-tabs">
        {tabs.map((tab) => (
          <div className="terminal-tab" key={tab.key}>
            <button
              className={active === tab.key ? "active" : ""}
              aria-pressed={active === tab.key}
              onClick={() => setActive(tab.key)}
            >
              {t("terminal")} {tab.title}
            </button>
            <button
              className="icon-btn"
              aria-label={`${ru ? "Закрыть терминал" : "Close terminal"} ${tab.title}`}
              onClick={() => close(tab.key)}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button
          className="icon-btn"
          disabled={tabs.length >= 16}
          title={ru ? "Новый терминал" : "New terminal"}
          aria-label={ru ? "Новый терминал" : "New terminal"}
          onClick={add}
        >
          <Plus size={14} />
        </button>
      </div>
      {notice && (
        <div className="error-box" role="alert">
          {notice}
        </div>
      )}
      {!tabs.length && (
        <button className="btn-soft terminal-open" onClick={add}>
          {ru ? "Открыть терминал" : "Open terminal"}
        </button>
      )}
      {tabs.map((tab) => (
        <Session
          key={tab.key}
          root={root}
          active={active === tab.key}
          command={tab.command}
          onSendSelection={onSendSelection}
        />
      ))}
    </section>
  );
}
