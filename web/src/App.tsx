import { useState, useRef, useEffect } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css";

const API_URL = import.meta.env.VITE_API_URL
  ?? (import.meta.env.DEV ? "http://localhost:3001/api/chat" : "/api/chat");

const transport = new DefaultChatTransport({ api: API_URL });

export default function App() {
  const { messages, status, sendMessage } = useChat({ transport });
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const isLoading = status === "submitted" || status === "streaming";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function submit(text?: string) {
    const content = text ?? input.trim();
    if (!content || isLoading) return;
    sendMessage({ text: content });
    setInput("");
  }

  return (
    <div className="app">
      <header>
        <h1>AI Ops Copilot</h1>
        <p className="subtitle">Dubai Super-App Operations</p>
      </header>

      <div className="messages">
        {messages.length === 0 && (
          <div className="empty-state">
            <p>Ask about operational issues across rides, delivery, and payments.</p>
            <div className="suggestions">
              <button onClick={() => submit("Which areas have the most delivery delays right now?")}>
                Delivery delays by area
              </button>
              <button onClick={() => submit("What's the driver availability situation?")}>
                Driver availability
              </button>
              <button onClick={() => submit("Dubai Marina delivery delays — what's going on?")}>
                Dubai Marina investigation
              </button>
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`message ${msg.role}`}>
            <div className="message-role">{msg.role === "user" ? "You" : "Copilot"}</div>
            <div className="message-content">
              {msg.parts.map((part, i) => {
                if (part.type === "text") {
                  return (
                    <div key={i} className="text-part">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
                    </div>
                  );
                }
                if (part.type === "step-start") return null;
                if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
                  const toolPart = part as {
                    type: string;
                    toolCallId: string;
                    toolName?: string;
                    state: string;
                    input?: unknown;
                    output?: unknown;
                    errorText?: string;
                  };
                  const toolName = toolPart.type === "dynamic-tool"
                    ? toolPart.toolName
                    : toolPart.type.replace(/^tool-/, "");
                  const done = toolPart.state === "output-available"
                    || toolPart.state === "output-error"
                    || toolPart.state === "output-denied";
                  return (
                    <details key={i} className="tool-part" open={!done}>
                      <summary>
                        <span className="tool-name">{formatToolName(toolName)}</span>
                        {done ? " — done" : " — running..."}
                      </summary>
                      {toolPart.state !== "input-streaming" && toolPart.input !== undefined && (
                        <pre className="tool-args">{JSON.stringify(toolPart.input, null, 2)}</pre>
                      )}
                      {done && (
                        <div className="tool-result">
                          {toolPart.state === "output-error"
                            ? <pre>{toolPart.errorText ?? "Tool execution failed"}</pre>
                            : renderToolResult(toolPart.output)}
                        </div>
                      )}
                    </details>
                  );
                }
                return null;
              })}
            </div>
          </div>
        ))}

        {isLoading && messages[messages.length - 1]?.role !== "assistant" && (
          <div className="message assistant">
            <div className="message-role">Copilot</div>
            <div className="message-content loading">Thinking...</div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="input-form">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about operations..."
          disabled={isLoading}
        />
        <button type="submit" disabled={isLoading || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

function formatToolName(name?: string): string {
  if (!name) return "Tool";
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderToolResult(result: unknown): React.ReactNode {
  if (!Array.isArray(result) || result.length === 0) {
    return <pre>{JSON.stringify(result, null, 2)}</pre>;
  }

  const rows = result as Record<string, unknown>[];
  const keys = Object.keys(rows[0]);

  return (
    <div className="table-wrapper">
      <table>
        <thead>
          <tr>{keys.map((k) => <th key={k}>{k.replace(/_/g, " ")}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>{keys.map((k) => <td key={k}>{String(row[k] ?? "")}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
