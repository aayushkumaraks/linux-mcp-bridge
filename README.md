# Ollama → Linux MCP Bridge

A web-based chat interface that bridges Ollama LLMs with a Linux MCP (Model Context Protocol) server, enabling AI models to execute shell commands on remote Linux systems through a secure API.

Note: THIS README WAS GENERATED USING LLM.

## Features

- 🤖 Chat interface for interacting with Ollama models
- 🔧 Tool calling support for executing Linux commands
- 💬 Real-time streaming responses with thinking indicators
- 🎨 Modern, gradient-based dark UI
- 📝 Markdown rendering for AI responses
- 🔄 Automatic command execution and result polling

## Architecture

The bridge consists of three main components:

1. **Express Server** ([server.js](server.js)) - Handles API requests and orchestrates communication between Ollama and Linux MCP
2. **React UI** ([ui-src/App.jsx](ui-src/App.jsx)) - Provides the chat interface
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

## UI Components

- **Chat Area** - Displays conversation history with user and assistant messages
- **Thinking Indicator** - Shows when the model is processing (with spinner)
- **Input Bar** - Text area for entering prompts
- **Toolbar** - Clear and download JSON buttons (UI placeholders)

## Styling

The UI uses a custom dark theme defined in [ui-src/styles.css](ui-src/styles.css) with:

- Gradient backgrounds
- Teal accent color (`#2dd4bf`)
- Responsive design for mobile devices
- Chat bubble layout

## Security Notes

⚠️ **Important**: Always set the `LINUX_API_KEY` in production environments. The server will warn you if it's not set.

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
