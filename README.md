# Ollama → Linux MCP Bridge

A web-based chat interface that bridges Ollama LLMs with a Linux MCP (Model Context Protocol) server, enabling AI models to execute shell commands on remote Linux systems through a secure API.

Note: THIS README WAS GENERATED USING LLM.

## Features

- 🤖 Chat interface for interacting with Ollama models
- 🔧 Tool calling support for executing Linux commands
- 💬 Real-time streaming responses with robust NDJSON parsing
- 🖥️ Persistent shell sessions with command history continuity
- ⌨️ Interactive stdin support for commands that require user input
- 📡 Live terminal output stream via Server-Sent Events (SSE)
- 🎨 Modern split-pane UI for chat and terminal operations
- 📝 Markdown rendering for AI responses
- 🔄 Automatic command execution and result polling

## Architecture

The bridge consists of three main components:

1. **Express Server** ([server.js](server.js)) - Handles API requests, Ollama tool calling, and persistent interactive shell sessions
2. **React UI** ([ui-src/App.jsx](ui-src/App.jsx)) - Provides a modern chat + terminal workspace
3. **Linux MCP Server** [Github Repo](https://github.com/aayushkumaraks/linux-mcp-redis) - Executes shell commands where-ever it is installed

## Prerequisites

- Node.js (v18 or higher recommended)
- Ollama server running with your preferred model
- Linux MCP server running and accessible
- API key for the Linux MCP server

## Installation

1. Clone the repository:

```bash
git clone <your-repo-url>
cd mcp-bridge
```

2. Install dependencies:

```bash
npm install
```

3. Create a `.env` file based on [.env.local](.env.local):

```bash
cp .env.local .env
```

4. Configure your environment variables in `.env`:

```env
OLLAMA_API=http://localhost:11434
OLLAMA_MODEL_NAME=gpt-oss:20b
LINUX_HTTP=http://127.0.0.1:5379
LINUX_API_KEY=your-api-key-here
PORT=3000
```

## Configuration

### Environment Variables

| Variable            | Description                          | Default                  |
| ------------------- | ------------------------------------ | ------------------------ |
| `OLLAMA_API`        | URL of your Ollama server            | `http://localhost:11434` |
| `OLLAMA_MODEL_NAME` | Name of the Ollama model to use      | `gpt-oss:20b`            |
| `LINUX_HTTP`        | URL of the Linux MCP server          | `http://127.0.0.1:5379`  |
| `LINUX_API_KEY`     | API key for Linux MCP authentication | _(required)_             |
| `PORT`              | Port for the bridge server           | `3000`                   |

## Usage

### Development

1. Build the UI:

```bash
npm run build:ui
```

2. Start the server:

```bash
npm start
```

3. Open your browser to `http://localhost:3000`

### Watch Mode (for UI development)

Run the UI builder in watch mode for live reloading:

```bash
npm run watch:ui
```

Then in another terminal:

```bash
npm start
```

## How It Works

1. User enters a prompt in the chat interface
2. The prompt is sent to the Ollama API with available tools (shell command execution)
3. If the model decides to use a tool:
   - The command is enqueued on the Linux MCP server
   - The bridge polls for the command result
   - The result is sent back to Ollama
   - Ollama generates a final response based on the command output
4. The response is streamed back to the UI in real-time

## API Endpoints

### POST `/api/ask`

Non-streaming endpoint for chat completion.

**Request:**

```json
{
  "prompt": "Delete every temp/thumbnail files store in the Home folder (~/)"
}
```

### POST `/api/ask-stream`

Streaming endpoint with real-time response updates.

**Request:**

```json
{
  "prompt": "List files in the current directory"
}
```

### Persistent Terminal Session Endpoints

#### GET `/api/terminal/sessions`

Lists all terminal sessions and their status.

#### POST `/api/terminal/sessions`

Creates a new persistent interactive shell session.

#### GET `/api/terminal/sessions/:id`

Gets session details and buffered events.

#### GET `/api/terminal/sessions/:id/stream`

Streams real-time session events via SSE.

#### POST `/api/terminal/sessions/:id/exec`

Runs a command in the existing shell context.

```json
{
  "command": "pwd && ls -la"
}
```

#### POST `/api/terminal/sessions/:id/input`

Sends interactive stdin to the running command.

```json
{
  "input": "y"
}
```

#### DELETE `/api/terminal/sessions/:id`

Stops and closes a session.

## UI Components

- **Assistant Panel** - Chat timeline with markdown rendering and streaming state
- **Composer** - Keyboard-friendly prompt input (`Enter` to send, `Shift+Enter` newline)
- **Terminal Panel** - Persistent session output with command and stdin controls
- **Session Controls** - Create and close shell sessions from the UI
- **Export Tools** - Clear chat and download conversation JSON

## Styling

The UI uses a modern responsive visual system defined in [ui-src/styles.css](ui-src/styles.css) with:

- Split-pane desktop layout and stacked mobile layout
- Custom typography (`Space Grotesk` + `IBM Plex Mono`)
- Layered atmospheric backgrounds and elevated surfaces
- Command-center style terminal treatment

## Security Notes

⚠️ **Important**: Always set the `LINUX_API_KEY` in production environments. The server will warn you if it's not set.

Persistent shell sessions execute commands on the bridge host process using the configured shell. Restrict access to this service and run it in a controlled environment.

## Development Tools

- **ESLint** - Configured in [eslint.config.mjs](eslint.config.mjs)
- **Prettier** - Code formatting configured in [.prettierrc](.prettierrc)
- **esbuild** - Fast bundling for the React UI

## Troubleshooting

### "WARNING: LINUX_API_KEY is not set"

Set the `LINUX_API_KEY` environment variable in your `.env` file.

### Model not responding

- Verify Ollama is running: `curl http://localhost:11434/api/tags`
- Check that the model name in `.env` matches an installed model

### Commands not executing

- Ensure the Linux MCP server is accessible at the configured URL
- Verify the API key is correct
- Check Linux MCP server logs
