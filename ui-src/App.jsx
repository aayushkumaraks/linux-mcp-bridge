import React from "react";
import { marked } from "marked";

export default function App() {

  const [chatData, setChatData] = React.useState([]);
  const [streamData, setStreamData] = React.useState([]);
  const [promptInput, setPromptInput] = React.useState("");
  const currentIndexRef = React.useRef(0);

  const getTimestamp = (date) => {
    if (date) return new Date(date).toISOString();
    return new Date().toISOString();
  }

  const sendPromptToServer = async (prompt, currentChatData) => {
    const activeIndex = currentIndexRef.current;
    const req = await fetch("/api/ask-stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
      }),
    });
    if (!req.ok) {
      const textData = await req.text();
      console.warn("Error: " + textData);
      // assistBody.textContent = "Error: " + t;
      // entry.raw = {
      //   error: t,
      // };
      // entry.assistant = assistBody.textContent;
      return;
    }

    const decoder = new TextDecoder();
    let streamThink = "";
    let streamContent = "";
    let time = "";
    if (req.body && typeof req.body.getReader === "function") {
      const reader = req.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        };
        const chunk = decoder.decode(value, {
          stream: true,
        });
        try {
          // usual JSON parsing 😢
          const parsed = JSON.parse(chunk);
          if (parsed.message?.thinking) {
            streamThink += parsed.message.thinking;
            setStreamData(prevStreamData => [...prevStreamData, parsed]);
            time = time || getTimestamp(parsed.created_at);
          }
          if (parsed.message.content) {
            streamContent += parsed.message.content;
            setStreamData([]);
            setChatData(prevChatData => {
              const chatDataCpy = prevChatData.length === activeIndex ? [...prevChatData] : [...currentChatData];
              chatDataCpy[activeIndex] = {
                role: "assistant", content: streamContent, timestamp: getTimestamp(time), thinking: streamThink
              }
              return [...chatDataCpy]
            });
          }
        } catch (e) {
          console.warn("Failed to parse chunk as JSON:", chunk);
        }
        // if (chunk.trim().startsWith("{") && chunk.trim().endsWith("}")) {
        //   streamText += chunk;
        // } else {
        //   if (assistBody.contains(spinner)) assistBody.removeChild(spinner);
        //   appendToElement(assistBody, chunk);
        //   streamText += chunk;
        // }
      }
    }
  }

  const handleSend = () => {
    const promptInput = document.getElementById("prompt");
    const prompt = promptInput.value.trim();
    setChatData(prevChatData => {
      const newArr = [...prevChatData, {role: "user", content: prompt, timestamp: getTimestamp()}]
      currentIndexRef.current = newArr.length;
      sendPromptToServer(prompt, newArr);
      return newArr;
    });
    if (prompt) {
      setPromptInput("");
    }
  }

  const handleInput = (event) => {
    setPromptInput(event.target.value);
  }

  return (
    <div className="app">
      <div className="app" role="application" aria-label="Ollama Linux Bridge Chat">
        <header>
          <h1>Ollama → Linux MCP Bridge</h1>
          <div className="toolbar" style={{marginLeft: "auto"}}>
            <button id="clearAll" className="ghost">Clear</button>
            <button id="downloadAll" className="ghost">Download JSON</button>
          </div>
        </header>

        <div className="main">
          <div id="chat" className="chat" aria-live="polite">
            Bridge ready! Go ahead and type a prompt below.
            {chatData.map((message, index) => (
              <div key={index} className={`msg ${message?.role}`}>
                <div className="meta">{new Date(message?.timestamp).toLocaleTimeString()}</div>
                <div className="body thinking-text">{message?.thinking}</div>
                <div className="body" dangerouslySetInnerHTML={{__html: marked(message?.content)}}></div>
              </div>
            ))}
            {
              streamData.length > 0 ?
              <div className="msg assistant">
                <div className="meta">Thinking <span className="spinner"></span></div>
                <div className="body thinking-text">
                  {streamData.map((streamingData, index) => (
                    <span key={"streaming" + index}>{streamingData?.message?.thinking}</span>
                  ))}
                </div>
              </div>
              : ""
            }
          </div>

          <div className="inputbar">
            <div className="composer">
              <textarea
                id="prompt"
                placeholder="Type your prompt. Press Enter to send, Shift+Enter for newline."
                onChange={handleInput}
                value={promptInput}
              ></textarea>
              <div className="small" style={{marginTop: "6px"}}>
                Tip: Ask the model to run commands if needed; it will call the
                tool automatically.
              </div>
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-end",
                gap: 8,
              }}
            >
              <div className="controls">
                <button id="send" onClick={handleSend}>Send</button>
                <button id="sendStream" className="ghost">Send (stream)</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}