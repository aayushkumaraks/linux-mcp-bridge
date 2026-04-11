import React from "react";
import { marked } from "marked";

function toIso(date) {
  return date ? new Date(date).toISOString() : new Date().toISOString();
}

function timeLabel(iso) {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizeLogLine(entry) {
  const t = entry?.ts ? timeLabel(entry.ts) : timeLabel(toIso());
  const level = (entry?.level || "info").toUpperCase();
  const message = entry?.message || "(no message)";
  return `${t} [${level}] ${message}`;
}

export default function App() {
  const [messages, setMessages] = React.useState([]);
  const [promptInput, setPromptInput] = React.useState("");
  const [thinkingText, setThinkingText] = React.useState("");
  const [isStreaming, setIsStreaming] = React.useState(false);
  const [streamStatus, setStreamStatus] = React.useState("");
  const [streamStages, setStreamStages] = React.useState([]);

  const [session, setSession] = React.useState(null);
  const [terminalLogs, setTerminalLogs] = React.useState([]);
  const [terminalCommand, setTerminalCommand] = React.useState("");
  const [terminalInput, setTerminalInput] = React.useState("");
  const [terminalHint, setTerminalHint] = React.useState("");
  const [awaitingInput, setAwaitingInput] = React.useState(false);
  const [serverLogs, setServerLogs] = React.useState([]);

  const chatEndRef = React.useRef(null);
  const terminalEndRef = React.useRef(null);
  const eventSourceRef = React.useRef(null);
  const serverLogSourceRef = React.useRef(null);

  React.useEffect(() => {
    void createTerminalSession();

    const serverLogStream = new EventSource("/api/logs/stream?tail=120");
    serverLogStream.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        setServerLogs((prev) => {
          const next = [...prev, normalizeLogLine(parsed)];
          if (next.length > 350) {
            return next.slice(next.length - 350);
          }
          return next;
        });
      } catch {
        setServerLogs((prev) => {
          const next = [...prev, `${timeLabel(toIso())} [WARN] Failed to parse server log frame`];
          return next.slice(Math.max(0, next.length - 350));
        });
      }
    };

    serverLogStream.onerror = () => {
      setServerLogs((prev) => {
        const next = [...prev, `${timeLabel(toIso())} [WARN] Server log stream disconnected`];
        return next.slice(Math.max(0, next.length - 350));
      });
    };

    serverLogSourceRef.current = serverLogStream;

    return () => {
      eventSourceRef.current?.close();
      serverLogSourceRef.current?.close();
    };
  }, []);

  React.useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, thinkingText, streamStatus]);

  React.useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [terminalLogs]);

  const addTerminalLog = React.useCallback((line) => {
    setTerminalLogs((prev) => [...prev, line]);
  }, []);

  const connectSessionStream = React.useCallback(
    (sessionId, fromId = 0) => {
      eventSourceRef.current?.close();

      const stream = new EventSource(
        `/api/terminal/sessions/${sessionId}/stream?fromId=${fromId}`
      );

      stream.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);

          if (typeof parsed.awaitingInput === "boolean") {
            setAwaitingInput(parsed.awaitingInput);
          }

          if (parsed.type === "session-started") {
            addTerminalLog(`[session] ${parsed.message}`);
            return;
          }

          if (parsed.type === "session-closed") {
            addTerminalLog(`[session] closed (${parsed.reason})`);
            return;
          }

          if (parsed.type === "command") {
            addTerminalLog(`\n$ ${parsed.data}\n`);
            return;
          }

          if (parsed.type === "input") {
            addTerminalLog(`[input] ${parsed.data.replace(/\n$/, "")}\n`);
            return;
          }

          if (parsed.type === "stdout") {
            addTerminalLog(parsed.data);
            return;
          }

          if (parsed.type === "stderr") {
            addTerminalLog(parsed.data);
            return;
          }

          if (parsed.type === "exit") {
            addTerminalLog(
              `\n[exit] code=${parsed.code ?? "null"} signal=${parsed.signal ?? "null"}\n`
            );
            return;
          }

          if (parsed.type === "error") {
            addTerminalLog(`\n[error] ${parsed.error}\n`);
          }
        } catch (error) {
          addTerminalLog(`[stream parse error] ${String(error)}\n`);
        }
      };

      stream.onerror = () => {
        addTerminalLog("[session] stream disconnected\n");
      };

      eventSourceRef.current = stream;
    },
    [addTerminalLog]
  );

  const createTerminalSession = React.useCallback(async () => {
    const response = await fetch("/api/terminal/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
      addTerminalLog(`[session error] ${data.error || "failed to create session"}\n`);
      return;
    }

    setSession(data.session);
    setAwaitingInput(Boolean(data.session.awaitingInput));
    setTerminalHint(data.session.lastInputHint || "");
    setTerminalLogs([]);
    connectSessionStream(data.session.id, 0);
  }, [addTerminalLog, connectSessionStream]);

  const closeTerminalSession = React.useCallback(async () => {
    if (!session?.id) return;

    await fetch(`/api/terminal/sessions/${session.id}`, { method: "DELETE" });
    setSession((prev) => (prev ? { ...prev, isAlive: false } : prev));
    setAwaitingInput(false);
    setTerminalHint("");
  }, [session]);

  const runTerminalCommand = React.useCallback(async () => {
    if (!session?.id || !terminalCommand.trim()) return;

    const command = terminalCommand.trim();
    setTerminalCommand("");

    const response = await fetch(`/api/terminal/sessions/${session.id}/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command }),
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
      addTerminalLog(`[exec error] ${data.error || "failed to execute command"}\n`);
    }
  }, [addTerminalLog, session, terminalCommand]);

  const sendTerminalInput = React.useCallback(async () => {
    if (!session?.id || !terminalInput) return;

    const input = terminalInput;
    setTerminalInput("");

    const response = await fetch(`/api/terminal/sessions/${session.id}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
      addTerminalLog(`[input error] ${data.error || "failed to send input"}\n`);
      return;
    }

    setAwaitingInput(false);
    setTerminalHint("");
  }, [addTerminalLog, session, terminalInput]);

  const clearChat = React.useCallback(() => {
    setMessages([]);
    setThinkingText("");
    setStreamStatus("");
    setStreamStages([]);
  }, []);

  const downloadChat = React.useCallback(() => {
    const blob = new Blob([JSON.stringify(messages, null, 2)], {
      type: "application/json",
    });

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `chat-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [messages]);

  const handleSendPrompt = React.useCallback(async () => {
    const prompt = promptInput.trim();
    if (!prompt || isStreaming) return;

    setPromptInput("");
    setThinkingText("");
    setIsStreaming(true);
    setStreamStatus("Submitting prompt to server...");
    setStreamStages([]);

    const userMessage = {
      role: "user",
      content: prompt,
      timestamp: toIso(),
    };

    const assistantMessage = {
      role: "assistant",
      content: "",
      thinking: "",
      timestamp: toIso(),
    };

    const assistantIndex = messages.length + 1;
    setMessages((prev) => [...prev, userMessage, assistantMessage]);

    try {
      const response = await fetch("/api/ask-stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt }),
      });

      if (!response.ok || !response.body) {
        const text = await response.text();
        throw new Error(text || "Request failed");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamThinking = "";
      let streamContent = "";

      const applyParsedMessage = (parsed) => {
        if (parsed.type === "status") {
          const detail = parsed.detail || parsed.stage || "Processing";
          setStreamStatus(detail);
          setStreamStages((prev) => {
            const next = [...prev, detail];
            return next.slice(Math.max(0, next.length - 6));
          });
          return;
        }

        if (parsed.error) {
          setMessages((prev) => {
            const next = [...prev];
            next[assistantIndex] = {
              ...next[assistantIndex],
              content:
                (next[assistantIndex]?.content || "") +
                `\n\n[Stream error]\n${parsed.error}`,
            };
            return next;
          });
          setStreamStatus("Stream error received");
          return;
        }

        if (parsed.message?.thinking) {
          streamThinking += parsed.message.thinking;
          setThinkingText(streamThinking);
          setStreamStatus("Model is thinking...");
        }

        if (parsed.message?.content) {
          streamContent += parsed.message.content;
          setMessages((prev) => {
            const next = [...prev];
            next[assistantIndex] = {
              ...next[assistantIndex],
              content: streamContent,
              thinking: streamThinking,
            };
            return next;
          });
          setStreamStatus("Receiving response...");
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf("\n");

        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);

          if (line) {
            try {
              applyParsedMessage(JSON.parse(line));
            } catch {
              // Ignore malformed partial frames.
            }
          }

          newlineIndex = buffer.indexOf("\n");
        }
      }

      const tail = buffer.trim();
      if (tail) {
        try {
          applyParsedMessage(JSON.parse(tail));
        } catch {
          // Ignore trailing malformed frame.
        }
      }

      setThinkingText("");
      setStreamStatus("Completed");
    } catch (error) {
      setMessages((prev) => {
        const next = [...prev];
        next[assistantIndex] = {
          ...next[assistantIndex],
          content: `Request failed: ${String(error)}`,
          thinking: "",
        };
        return next;
      });
      setThinkingText("");
      setStreamStatus(`Request failed: ${String(error)}`);
    } finally {
      setIsStreaming(false);
    }
  }, [isStreaming, messages.length, promptInput]);

  const handlePromptKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSendPrompt();
    }
  };

  return (
    <div className="workspace">
      <header className="topbar">
        <div>
          <p className="eyebrow">MCP Bridge Console</p>
          <h1>LLM Orchestration Workspace</h1>
        </div>
        <div className="topbar-actions">
          <button className="btn ghost" onClick={clearChat}>
            Clear chat
          </button>
          <button className="btn ghost" onClick={downloadChat}>
            Export JSON
          </button>
        </div>
      </header>

      <main className="layout">
        <section className="panel chat-panel">
          <div className="panel-header">
            <h2>Assistant</h2>
            <span className="status-chip">{isStreaming ? "Processing" : "Ready"}</span>
          </div>

          {isStreaming || streamStatus ? (
            <div className="stream-progress" aria-live="polite">
              <div className="stream-progress-row">
                <span className="spinner" />
                <strong>{streamStatus || "Processing..."}</strong>
              </div>
              {streamStages.length > 0 ? (
                <div className="stream-stages">{streamStages.join("  ->  ")}</div>
              ) : null}
              {thinkingText ? <div className="stream-thinking-flag">Thinking stream active</div> : null}
            </div>
          ) : null}

          <div className="messages" aria-live="polite">
            {messages.length === 0 ? (
              <div className="empty-state">
                Ask for diagnostics, automation, or command execution and monitor output in real time.
              </div>
            ) : null}

            {messages.map((message, index) => (
              <article key={`${message.timestamp}-${index}`} className={`message ${message.role}`}>
                <div className="message-meta">
                  <span className="role-label">{message.role === "user" ? "You" : "Assistant"}</span>
                  <span>{timeLabel(message.timestamp)}</span>
                </div>

                {message.thinking ? <div className="thinking">{message.thinking}</div> : null}
                <div
                  className="message-body"
                  dangerouslySetInnerHTML={{ __html: marked(message.content || "") }}
                />
              </article>
            ))}

            {thinkingText ? (
              <article className="message assistant thinking-only">
                <div className="message-meta">
                  <span className="role-label">Assistant</span>
                  <span>Thinking</span>
                </div>
                <div className="thinking">{thinkingText}</div>
              </article>
            ) : null}
            <div ref={chatEndRef} />
          </div>

          <div className="composer">
            <textarea
              value={promptInput}
              onChange={(event) => setPromptInput(event.target.value)}
              onKeyDown={handlePromptKeyDown}
              placeholder="Send a prompt. Enter to send, Shift+Enter for newline."
              disabled={isStreaming}
            />

            <div className="composer-row">
              <span className="hint-text">
                You now get live status, streamed thinking text, and backend logs in one view.
              </span>
              <button className="btn primary" onClick={() => void handleSendPrompt()} disabled={isStreaming}>
                {isStreaming ? "Working..." : "Send"}
              </button>
            </div>
          </div>
        </section>

        <aside className="panel terminal-panel">
          <div className="panel-header">
            <h2>Persistent Terminal</h2>
            <span className={`status-chip ${session?.isAlive ? "ok" : "warn"}`}>
              {session?.isAlive ? "Connected" : "Offline"}
            </span>
          </div>

          <div className="terminal-actions">
            <button className="btn ghost" onClick={() => void createTerminalSession()}>
              New Session
            </button>
            <button className="btn ghost" onClick={() => void closeTerminalSession()} disabled={!session?.isAlive}>
              Close Session
            </button>
          </div>

          <pre className="terminal-output">
            {terminalLogs.join("")}
            <span ref={terminalEndRef} />
          </pre>

          <div className="terminal-controls">
            <input
              type="text"
              value={terminalCommand}
              onChange={(event) => setTerminalCommand(event.target.value)}
              placeholder="Run command in current session"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void runTerminalCommand();
                }
              }}
            />
            <button className="btn primary" onClick={() => void runTerminalCommand()} disabled={!session?.isAlive}>
              Execute
            </button>
          </div>

          <div className="terminal-controls interactive">
            <input
              type="text"
              value={terminalInput}
              onChange={(event) => setTerminalInput(event.target.value)}
              placeholder={awaitingInput ? "Send required input" : "Manual stdin input"}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void sendTerminalInput();
                }
              }}
            />
            <button className="btn ghost" onClick={() => void sendTerminalInput()} disabled={!session?.isAlive}>
              Send Input
            </button>
          </div>

          {awaitingInput ? (
            <p className="input-warning">
              Input required. {terminalHint ? `Hint: ${terminalHint}` : "Command appears to be waiting for stdin."}
            </p>
          ) : null}

          <div className="server-logs-block">
            <div className="server-logs-title">Server Logs</div>
            <pre className="server-logs-output">{serverLogs.join("\n")}</pre>
          </div>
        </aside>
      </main>
    </div>
  );
}
