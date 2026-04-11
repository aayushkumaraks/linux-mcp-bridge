import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(express.static("public"));

const OLLAMA_API = process.env.OLLAMA_API || "http://localhost:11434";
const OLLAMA_MODEL_NAME = process.env.OLLAMA_MODEL_NAME || "gemma4:e4b";
const LINUX_HTTP = process.env.LINUX_HTTP || "http://127.0.0.1:5379";
const LINUX_API_KEY = process.env.LINUX_API_KEY;
const PORT = Number(process.env.PORT || 3000);
const SESSION_IDLE_TIMEOUT_MS = Number(
  process.env.SESSION_IDLE_TIMEOUT_MS || 30 * 60 * 1000
);
const MAX_SESSION_EVENTS = Number(process.env.MAX_SESSION_EVENTS || 1500);
const MAX_SERVER_LOGS = Number(process.env.MAX_SERVER_LOGS || 2000);

if (!LINUX_API_KEY) {
  console.warn(
    "WARNING: LINUX_API_KEY is not set in .env - set it before using production."
  );
}

function nowIso() {
  return new Date().toISOString();
}

const serverLogClients = new Set();
const serverLogs = [];

function pushServerLog(level, message, meta = null) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    ts: nowIso(),
    level,
    message,
    meta,
  };

  serverLogs.push(entry);
  if (serverLogs.length > MAX_SERVER_LOGS) {
    serverLogs.splice(0, serverLogs.length - MAX_SERVER_LOGS);
  }

  for (const client of serverLogClients) {
    client.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  if (level === "error") {
    console.error(`[bridge] ${message}`, meta || "");
  } else if (level === "warn") {
    console.warn(`[bridge] ${message}`, meta || "");
  } else {
    console.log(`[bridge] ${message}`, meta || "");
  }

  return entry;
}

function detectInputPrompt(text) {
  return /password\s*:|passphrase\s*:|\[y\/n\]|yes\/no|continue\?|press\s+enter|enter\s+.*:/i.test(
    text
  );
}

function appendEvent(session, event) {
  session.seq += 1;
  const withMeta = {
    id: session.seq,
    ts: nowIso(),
    ...event,
  };

  session.events.push(withMeta);
  if (session.events.length > MAX_SESSION_EVENTS) {
    session.events.splice(0, session.events.length - MAX_SESSION_EVENTS);
  }

  for (const client of session.clients) {
    client.write(`data: ${JSON.stringify(withMeta)}\n\n`);
  }
}

function toSessionSummary(session) {
  return {
    id: session.id,
    shell: session.shell,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    isAlive: session.isAlive,
    awaitingInput: session.awaitingInput,
    lastInputHint: session.lastInputHint,
    seq: session.seq,
  };
}

const sessions = new Map();

function closeSession(session, reason = "terminated") {
  if (!session || !session.isAlive) return;

  session.isAlive = false;
  session.updatedAt = nowIso();

  try {
    session.process.kill("SIGTERM");
  } catch (err) {
    console.error("Failed to kill process:", err);
  }

  for (const client of session.clients) {
    try {
      client.end();
    } catch (err) {
      console.error("Failed to close SSE client:", err);
    }
  }
  session.clients.clear();

  appendEvent(session, {
    type: "session-closed",
    reason,
  });
}

function createSession({
  shell = process.env.SHELL || "bash",
  cwd = process.cwd(),
} = {}) {
  const id = randomUUID();
  const child = spawn(shell, ["-i"], {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const session = {
    id,
    process: child,
    shell,
    cwd,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    isAlive: true,
    awaitingInput: false,
    lastInputHint: null,
    seq: 0,
    events: [],
    clients: new Set(),
    lastInteractionAt: Date.now(),
  };

  sessions.set(id, session);

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    session.updatedAt = nowIso();
    session.lastInteractionAt = Date.now();

    if (detectInputPrompt(text)) {
      session.awaitingInput = true;
      session.lastInputHint = text.trim().slice(-300);
    }

    appendEvent(session, {
      type: "stdout",
      data: text,
      awaitingInput: session.awaitingInput,
    });
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    session.updatedAt = nowIso();
    session.lastInteractionAt = Date.now();

    if (detectInputPrompt(text)) {
      session.awaitingInput = true;
      session.lastInputHint = text.trim().slice(-300);
    }

    appendEvent(session, {
      type: "stderr",
      data: text,
      awaitingInput: session.awaitingInput,
    });
  });

  child.on("close", (code, signal) => {
    session.isAlive = false;
    session.updatedAt = nowIso();
    appendEvent(session, {
      type: "exit",
      code,
      signal,
    });

    for (const client of session.clients) {
      client.end();
    }
    session.clients.clear();
  });

  child.on("error", (error) => {
    session.updatedAt = nowIso();
    appendEvent(session, {
      type: "error",
      error: String(error),
    });
  });

  appendEvent(session, {
    type: "session-started",
    message: `Shell started: ${shell}`,
  });

  return session;
}

setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (!session.isAlive) continue;
    if (now - session.lastInteractionAt > SESSION_IDLE_TIMEOUT_MS) {
      closeSession(session, "idle-timeout");
    }
  }
}, 60_000);

async function enqueueOnLinux(command) {
  const response = await fetch(`${LINUX_HTTP}/enqueue`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": LINUX_API_KEY,
    },
    body: JSON.stringify({ command }),
  });
  return response.json();
}

async function pollResult(jobId, timeoutMs = 60000, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetch(`${LINUX_HTTP}/result/${jobId}`, {
      headers: {
        "X-API-KEY": LINUX_API_KEY,
      },
    });

    const json = await response.json();
    if (json.status === "done") return json.payload;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error("Timed out waiting for job result");
}

async function* parseNdjsonStream(body) {
  let buffer = "";

  for await (const chunk of body) {
    const text =
      chunk instanceof Buffer
        ? chunk.toString("utf8")
        : Buffer.from(chunk).toString("utf8");

    buffer += text;

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line) {
        try {
          yield JSON.parse(line);
        } catch (error) {
          console.warn("Failed to parse NDJSON line", error);
        }
      }

      newlineIndex = buffer.indexOf("\n");
    }
  }

  const tail = buffer.trim();
  if (tail) {
    try {
      yield JSON.parse(tail);
    } catch (error) {
      console.warn("Failed to parse trailing NDJSON line", error);
    }
  }
}

async function runEnqueueCommand(toolCall) {
  if (toolCall.function?.name !== "enqueueCommand") {
    throw new Error(`Unsupported tool: ${toolCall.function?.name}`);
  }

  const command = toolCall.function.arguments?.command;
  if (!command) throw new Error("Tool called without command");

  const enqueueResponse = await enqueueOnLinux(command);
  if (!enqueueResponse.jobId) throw new Error("Enqueue failed");

  return pollResult(enqueueResponse.jobId, 60_000);
}

app.get("/api/logs", (req, res) => {
  const fromTs = req.query.fromTs ? Number(req.query.fromTs) : null;
  const logs =
    fromTs && Number.isFinite(fromTs)
      ? serverLogs.filter((log) => new Date(log.ts).getTime() > fromTs)
      : serverLogs;

  res.json({ ok: true, logs });
});

app.get("/api/logs/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const tailCount = Number(req.query.tail || 100);
  const safeTail = Number.isFinite(tailCount)
    ? Math.max(0, Math.min(500, tailCount))
    : 100;

  const tailLogs = serverLogs.slice(-safeTail);
  for (const entry of tailLogs) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  serverLogClients.add(res);
  req.on("close", () => {
    serverLogClients.delete(res);
  });
});

app.get("/api/terminal/sessions", (_req, res) => {
  const list = Array.from(sessions.values()).map(toSessionSummary);
  res.json({ ok: true, sessions: list });
});

app.post("/api/terminal/sessions", (req, res) => {
  try {
    const session = createSession({
      shell: req.body?.shell,
      cwd: req.body?.cwd,
    });

    res.json({ ok: true, session: toSessionSummary(session) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.get("/api/terminal/sessions/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ ok: false, error: "session not found" });
  }

  const fromId = Number(req.query.fromId || 0);
  const events = session.events.filter((event) => event.id > fromId);

  return res.json({
    ok: true,
    session: toSessionSummary(session),
    events,
  });
});

app.get("/api/terminal/sessions/:id/stream", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ ok: false, error: "session not found" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const fromId = Number(req.query.fromId || 0);
  for (const event of session.events.filter((item) => item.id > fromId)) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  session.clients.add(res);

  req.on("close", () => {
    session.clients.delete(res);
  });
});

app.post("/api/terminal/sessions/:id/exec", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ ok: false, error: "session not found" });
  }

  if (!session.isAlive) {
    return res.status(409).json({ ok: false, error: "session not running" });
  }

  const command = req.body?.command;
  if (!command || typeof command !== "string") {
    return res.status(400).json({ ok: false, error: "missing command" });
  }

  session.process.stdin.write(`${command.trim()}\n`);
  session.awaitingInput = false;
  session.lastInputHint = null;
  session.updatedAt = nowIso();
  session.lastInteractionAt = Date.now();

  appendEvent(session, {
    type: "command",
    data: command,
  });

  return res.json({ ok: true });
});

app.post("/api/terminal/sessions/:id/input", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ ok: false, error: "session not found" });
  }

  if (!session.isAlive) {
    return res.status(409).json({ ok: false, error: "session not running" });
  }

  const input = req.body?.input;
  const submit = req.body?.submit !== false;

  if (typeof input !== "string") {
    return res.status(400).json({ ok: false, error: "missing input" });
  }

  session.process.stdin.write(submit ? `${input}\n` : input);
  session.awaitingInput = false;
  session.lastInputHint = null;
  session.updatedAt = nowIso();
  session.lastInteractionAt = Date.now();

  appendEvent(session, {
    type: "input",
    data: submit ? `${input}\\n` : input,
  });

  return res.json({ ok: true });
});

app.delete("/api/terminal/sessions/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ ok: false, error: "session not found" });
  }

  closeSession(session, "user-request");
  return res.json({ ok: true });
});

app.post("/api/ask", async (req, res) => {
  try {
    const userPrompt = req.body?.prompt;
    if (!userPrompt) {
      return res.status(400).json({ error: "missing prompt" });
    }

    const tools = [
      {
        type: "function",
        function: {
          name: "enqueueCommand",
          description: "Enqueue a shell command on the Linux MCP server.",
          parameters: {
            type: "object",
            required: ["command"],
            properties: {
              command: {
                type: "string",
                description: "Command to run",
              },
            },
          },
        },
      },
    ];

    const first = await fetch(`${OLLAMA_API}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL_NAME,
        messages: [{ role: "user", content: userPrompt }],
        tools,
        stream: false,
      }),
    });

    if (!first.ok) {
      const text = await first.text();
      throw new Error(`Ollama error ${first.status}: ${text}`);
    }

    const firstJson = await first.json();
    const toolCall = firstJson?.message?.tool_calls?.[0];

    if (!toolCall) {
      return res.json({ ok: true, final: firstJson });
    }

    const payload = await runEnqueueCommand(toolCall);

    const second = await fetch(`${OLLAMA_API}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL_NAME,
        messages: [
          { role: "user", content: userPrompt },
          { role: "assistant", content: "", tool_calls: [toolCall] },
          {
            role: "tool",
            name: "enqueueCommand",
            content: JSON.stringify(payload),
          },
        ],
        stream: false,
      }),
    });

    if (!second.ok) {
      const text = await second.text();
      throw new Error(`Ollama error ${second.status}: ${text}`);
    }

    const secondJson = await second.json();
    return res.json({ ok: true, final: secondJson });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: String(error) });
  }
});

app.post("/api/ask-stream", async (req, res) => {
  try {
    const userPrompt = req.body?.prompt;
    if (!userPrompt) {
      return res.status(400).json({ error: "missing prompt" });
    }

    const tools = [
      {
        type: "function",
        function: {
          name: "enqueueCommand",
          description: "Enqueue a shell command on the Linux MCP server.",
          parameters: {
            type: "object",
            required: ["command"],
            properties: {
              command: {
                type: "string",
                description: "Command to run",
              },
            },
          },
        },
      },
    ];

    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");

    const writeStatus = (stage, detail) => {
      res.write(
        `${JSON.stringify({
          type: "status",
          stage,
          detail,
          ts: nowIso(),
        })}\n`
      );
    };

    pushServerLog("info", "Ask-stream request received", {
      promptChars: userPrompt.length,
      model: OLLAMA_MODEL_NAME,
    });

    writeStatus("start", "Contacting model");

    const firstResp = await fetch(`${OLLAMA_API}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL_NAME,
        messages: [{ role: "user", content: userPrompt }],
        tools,
        stream: true,
      }),
    });

    if (!firstResp.ok) {
      const txt = await firstResp.text();
      pushServerLog("error", "First Ollama call failed", {
        status: firstResp.status,
        response: txt,
      });
      res.write(
        `${JSON.stringify({
          error: `Ollama error ${firstResp.status}: ${txt}`,
        })}\n`
      );
      res.end();
      return;
    }

    writeStatus("first-stream", "Streaming initial model response");

    let toolCall = null;
    let firstChunkSeen = false;

    for await (const message of parseNdjsonStream(firstResp.body)) {
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        pushServerLog("info", "First model stream started");
      }

      if (!toolCall && message?.message?.tool_calls?.length) {
        toolCall = message.message.tool_calls[0];
        pushServerLog("info", "Tool call detected", {
          tool: toolCall.function?.name,
        });
        writeStatus("tool-call", "Command execution requested");
      }

      res.write(`${JSON.stringify(message)}\n`);

      if (toolCall) {
        break;
      }
    }

    if (!toolCall) {
      pushServerLog("info", "Ask-stream completed without tool call");
      writeStatus("done", "Completed without tool execution");
      res.end();
      return;
    }

    const command = toolCall.function?.arguments?.command;
    if (command) {
      pushServerLog("info", "Dispatching command to Linux MCP", { command });
    }
    writeStatus("tool-running", "Executing command on Linux MCP");

    const payload = await runEnqueueCommand(toolCall);

    pushServerLog("info", "Tool execution completed", {
      hasPayload: Boolean(payload),
    });
    writeStatus("tool-complete", "Command finished, generating final answer");

    const secondResp = await fetch(`${OLLAMA_API}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL_NAME,
        messages: [
          { role: "user", content: userPrompt },
          { role: "assistant", content: "", tool_calls: [toolCall] },
          {
            role: "tool",
            name: "enqueueCommand",
            content: JSON.stringify(payload),
          },
        ],
        stream: true,
      }),
    });

    if (!secondResp.ok) {
      const txt = await secondResp.text();
      pushServerLog("error", "Second Ollama call failed", {
        status: secondResp.status,
        response: txt,
      });
      res.write(
        `${JSON.stringify({
          error: `Second Ollama call error ${secondResp.status}: ${txt}`,
        })}\n`
      );
      res.end();
      return;
    }

    writeStatus("second-stream", "Streaming final model response");

    for await (const message of parseNdjsonStream(secondResp.body)) {
      res.write(`${JSON.stringify(message)}\n`);
    }

    pushServerLog("info", "Ask-stream response completed");
    writeStatus("done", "Completed");
    res.end();
  } catch (error) {
    pushServerLog("error", "ask-stream handler error", {
      error: String(error),
    });
    if (!res.headersSent) {
      return res.status(500).json({ error: String(error) });
    }

    try {
      res.write(`${JSON.stringify({ error: String(error) })}\n`);
      res.end();
    } catch (streamError) {
      console.error("failed to write stream error:", streamError);
    }
  }
});

app.listen(PORT, () => {
  pushServerLog("info", `Bridge server running on http://localhost:${PORT}`);
});
