import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(express.static("public"));

const OLLAMA_API = process.env.OLLAMA_API || "http://localhost:11434";
const OLLAMA_MODEL_NAME = process.env.OLLAMA_MODEL_NAME || "gpt-oss:20b";
const LINUX_HTTP = process.env.LINUX_HTTP || "http://127.0.0.1:5379";
const LINUX_API_KEY = process.env.LINUX_API_KEY;
const PORT = process.env.PORT || 3000;

if (!LINUX_API_KEY) {
  console.warn(
    "WARNING: LINUX_API_KEY is not set in .env - set it before using production."
  );
}

async function enqueueOnLinux(command) {
  const r = await fetch(`${LINUX_HTTP}/enqueue`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": LINUX_API_KEY,
    },
    body: JSON.stringify({
      command,
    }),
  });
  return r.json();
}
async function pollResult(jobId, timeoutMs = 60000, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${LINUX_HTTP}/result/${jobId}`, {
      headers: {
        "X-API-KEY": LINUX_API_KEY,
      },
    });
    const j = await r.json();
    if (j.status === "done") return j.payload;
    await new Promise((r2) => setTimeout(r2, intervalMs));
  }
  throw new Error("Timed out waiting for job result");
}

app.post("/api/ask", async (req, res) => {
  try {
    const userPrompt = req.body?.prompt;
    if (!userPrompt)
      return res.status(400).json({
        error: "missing prompt",
      });

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

    const messages = [
      {
        role: "user",
        content: userPrompt,
      },
    ];

    const ollamaResp = await fetch(`${OLLAMA_API}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL_NAME,
        messages,
        tools,
        stream: false,
      }),
    });
    if (!ollamaResp.ok) {
      const txt = await ollamaResp.text();
      throw new Error(`Ollama error ${ollamaResp.status}: ${txt}`);
    }
    const j = await ollamaResp.json();

    const toolCalls = j?.message?.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      const tc = toolCalls[0];
      if (tc.function?.name === "enqueueCommand") {
        const command = tc.function.arguments?.command;
        if (!command)
          return res.json({
            error: "tool called without command",
          });
        const enqueueResp = await enqueueOnLinux(command);
        if (!enqueueResp.jobId)
          return res.json({
            error: "enqueue failed",
            raw: enqueueResp,
          });
        const payload = await pollResult(enqueueResp.jobId, 60000);
        const followMessages = [
          {
            role: "user",
            content: userPrompt,
          },
          {
            role: "assistant",
            content: "",
            tool_calls: [tc],
          },
          {
            role: "tool",
            name: "enqueueCommand",
            content: JSON.stringify(payload),
          },
        ];
        const finalResp = await fetch(`${OLLAMA_API}/api/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: OLLAMA_MODEL_NAME,
            messages: followMessages,
            stream: false,
          }),
        });
        const finalJson = await finalResp.json();
        return res.json({
          ok: true,
          final: finalJson,
        });
      }
    }

    return res.json({
      ok: true,
      final: j,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      error: String(e),
    });
  }
});

async function* streamToChunks(body) {
  if (body && typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) {
      const txt =
        chunk instanceof Buffer
          ? chunk.toString("utf8")
          : new TextDecoder().decode(chunk);
      yield txt;
    }
    return;
  }

  if (body && typeof body.on === "function") {
    const reader = body.getReader ? body.getReader() : null;

    if (reader) {
      for await (const chunk of reader) {
        const txt =
          chunk instanceof Buffer
            ? chunk.toString("utf8")
            : new TextDecoder().decode(chunk);
        yield txt;
      }
      return;
    }

    for await (const chunk of body) {
      const txt =
        chunk instanceof Buffer
          ? chunk.toString("utf8")
          : new TextDecoder().decode(chunk);
      yield txt;
    }
    return;
  }

  // Fallback: read entire body as text
  const txt = await body.text();
  yield txt;
}

async function runEnqueueCommand(tc) {
  if (tc.function?.name !== "enqueueCommand") {
    throw new Error(`Unsupported tool: ${tc.function?.name}`);
  }
  const command = tc.function.arguments?.command;
  if (!command) throw new Error("Tool called without command");

  const enqueueResp = await enqueueOnLinux(command);
  if (!enqueueResp.jobId) throw new Error("Enqueue failed");

  const payload = await pollResult(enqueueResp.jobId, 60000);
  return payload;
}

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
              command: { type: "string", description: "Command to run" },
            },
          },
        },
      },
    ];

    const firstResp = await fetch(`${OLLAMA_API}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL_NAME,
        messages: [{ role: "user", content: userPrompt }],
        tools,
        stream: true,
      }),
    });

    if (!firstResp.ok) {
      const txt = await firstResp.text();
      return res
        .status(500)
        .json({ error: `Ollama error ${firstResp.status}: ${txt}` });
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("X-Accel-Buffering", "no");

    let toolCall = null;

    for await (const chunk of streamToChunks(firstResp.body)) {
      const lines = chunk.split("\n").filter(Boolean);

      for (const line of lines) {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (err) {
          console.warn("Failed to parse line:", err, line);
          continue;
        }

        if (!toolCall && parsed.message?.tool_calls?.length) {
          toolCall = parsed.message.tool_calls[0];
          res.write(line + "\n");
          break;
        }

        res.write(line + "\n");
      }

      if (toolCall) break;
    }

    if (!toolCall) {
      res.end();
      return;
    }

    const payload = await runEnqueueCommand(toolCall);

    const followMessages = [
      { role: "user", content: userPrompt },
      { role: "assistant", content: "", tool_calls: [toolCall] },
      {
        role: "tool",
        name: "enqueueCommand",
        content: JSON.stringify(payload),
      },
    ];

    const secondResp = await fetch(`${OLLAMA_API}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL_NAME,
        messages: followMessages,
        stream: true,
      }),
    });

    if (!secondResp.ok) {
      const txt = await secondResp.text();
      res.write(`\n\n Second Ollama call error ${secondResp.status}: ${txt}\n`);
      res.end();
      return;
    }

    for await (const chunk of streamToChunks(secondResp.body)) {
      res.write(chunk);
    }

    res.end();
  } catch (err) {
    console.error("ask-stream error:", err);
    try {
      res.status(500).json({ error: String(err) });
    } catch (e) {
      console.error("failed to send 500 response:", e);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Bridge server running on http://localhost:${PORT}`);
});
