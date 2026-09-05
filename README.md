# mcp-local-filesystem

A minimal, security-first MCP (Model Context Protocol) server that gives Claude Desktop direct read/write access to your local filesystem over stdio. No HTTP server, no open ports, no network exposure.

## Why

The default Claude Desktop workflow for file creation is manual:

```
Claude generates file → you download it → you move it to your project directory
```

This MCP server eliminates that friction:

```
Claude generates file → MCP server writes it directly to disk
```

One command. Zero friction. Files land exactly where they belong.

## Features

- **7 filesystem tools** — `write_file`, `read_file`, `list_directory`, `check_allowed`, `read_binary`, `write_binary`, `str_replace`
- **Path sandboxing** — all operations are restricted to explicitly allowed directories
- **Auto-directory creation** — `write_file` creates parent directories on the fly
- **stdio transport only** — runs as a local child process, never opens a port
- **Minimal footprint** — under 30MB RAM at idle, sub-500ms startup
- **Zero runtime dependencies** beyond `@modelcontextprotocol/sdk`

## Quick Start

### 1. Clone and build

```bash
git clone https://github.com/Lanier-Developments/mcp-local-filesystem.git
cd mcp-local-filesystem
npm install
npm run build
```

### 2. Configure allowed directories

Edit `config.json` in the project root:

```json
{
  "allowedDirectories": [
    "/Users/yourname/Projects",
    "/Users/yourname/Development"
  ]
}
```

Only paths inside these directories (and their subdirectories) will be accessible. Everything else is rejected.

### 3. Connect to Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "local-filesystem": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-local-filesystem/dist/index.js"]
    }
  }
}
```

Replace `/absolute/path/to` with the actual path where you cloned the repo.

**Then restart Claude Desktop** (fully quit and reopen — not just close the window).

After restart, you'll see a tools icon (hammer) in Claude's chat input area. Your 4 filesystem tools are now available.

## Tools Reference

### `write_file`

Writes content to a file. Creates parent directories automatically. Overwrites existing files without prompting.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | Absolute path to write to |
| `content` | string | File content |

**Success response:**
```json
{ "success": true, "path": "/Users/you/Projects/app/src/main.ts", "bytesWritten": 1234 }
```

**Error response:**
```json
{ "success": false, "error": "Access denied: path is outside allowed directories." }
```

### `read_file`

Reads the content of a file and returns it as a string.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | Absolute path to read |

**Success response:**
```json
{ "success": true, "content": "file contents here...", "path": "/Users/you/Projects/app/README.md" }
```

### `list_directory`

Lists directory contents with metadata for each entry.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | Absolute path to directory |

**Success response:**
```json
{
  "success": true,
  "path": "/Users/you/Projects/app",
  "entries": [
    { "name": "src", "type": "directory", "size": 128, "modified": "2026-03-09T10:30:00.000Z" },
    { "name": "package.json", "type": "file", "size": 542, "modified": "2026-03-09T09:15:00.000Z" }
  ]
}
```

### `check_allowed`

Checks whether a path falls within the allowed directories. Does not require the path to exist. Never errors — always returns a result.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | Path to check |

**Response:**
```json
{ "allowed": true, "normalizedPath": "/Users/you/Projects/app/src/main.ts" }
```

### `read_binary` / `write_binary` — for binary files

For any file where byte-exact preservation matters (pdf, docx, pptx, xlsx,
png, jpg, zip, compiled/encoded formats), use `read_binary` and `write_binary`.

These tools base64-encode the file content over the JSON transport, avoiding
the UTF-8 corruption that would happen with `read_file` / `write_file` on a
binary file.

- **read_binary** — returns `content` as a base64 string plus `bytesRead`
- **write_binary** — takes a base64-encoded `content` string, decodes and writes raw bytes

For plain text files (md, txt, json, ts, py, rego), keep using `read_file`
and `write_file` — they are more efficient (no base64 overhead).

### `str_replace`

Replaces a single, unique occurrence of `old_str` with `new_str` in a UTF-8
text file. Use this for partial edits — changing a date, fixing a line, deleting
a block — when rewriting the whole file with `write_file` would be wasteful.

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | string | Absolute path to the file to edit |
| `old_str` | string | Exact substring to find — must match verbatim and uniquely |
| `new_str` | string | Replacement text. Empty string deletes the match. |
| `description` | string (optional) | Human-readable reason for the edit, for logging |

**Behavior:**
- 0 matches → error: `old_str not found in file`
- 2+ matches → error with match count; add surrounding context to disambiguate
- exactly 1 match → replaced and written back
- non-UTF-8 (binary) file → rejected with a hint to use `write_binary`

**Success response:**
```json
{
  "success": true,
  "path": "/Users/you/Projects/app/AGENTS.md",
  "matchLine": 2,
  "preview": "1: # AGENTS.md\n2: **Last Updated:** 2026-04-26\n3: \n4: body"
}
```

**Error response (ambiguous match):**
```json
{ "success": false, "error": "old_str matches 3 times, must be unique. Add surrounding context to disambiguate." }
```

## Security Model

Security is non-negotiable. Every filesystem operation goes through path validation before execution.

| Rule | Detail |
|------|--------|
| **Allowlist only** | Only paths inside `config.json` allowedDirectories are accessible |
| **Path normalization** | All paths are resolved (removing `../`, symlinks) before comparison |
| **Prefix attack prevention** | `/Users/you/ProjectsExtra` does NOT match `/Users/you/Projects` — separator-aware matching |
| **Fail-safe default** | Empty `allowedDirectories` array = all access denied |
| **No shell execution** | No `exec`, no `eval`, no dynamic `require` |
| **No network** | stdio transport only — no HTTP, no WebSocket, no open ports |
| **Error hygiene** | Error messages never expose filesystem paths outside allowed directories |

## Configuration Reference

### `config.json`

```json
{
  "allowedDirectories": [
    "/absolute/path/one",
    "/absolute/path/two",
    "./relative/path/resolved/from/config/location"
  ]
}
```

| Behavior | Detail |
|----------|--------|
| **Loaded at startup** | Changes require a server restart |
| **Relative paths** | Resolved from the `config.json` file's directory |
| **Empty array** | Fail-safe — no paths allowed |
| **Missing file** | Server refuses to start with a clear error |
| **Invalid JSON** | Server refuses to start with a clear error |

### Claude Desktop config

Location: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "local-filesystem": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-local-filesystem/dist/index.js"]
    }
  }
}
```

You can run multiple MCP servers side by side — just add more entries to `mcpServers`.

## Development

```bash
npm run build        # Compile TypeScript → dist/
npm run dev          # Watch mode — recompiles on save
npm test             # Run all 44 tests
npm run inspector    # Launch MCP Inspector UI at http://localhost:6274
```

### Project Structure

```
src/
  index.ts                 # MCP server entry point, tool registration
  config.ts                # Config loading, path normalization, validation
  tools/
    write-file.ts          # write_file implementation
    read-file.ts           # read_file implementation
    list-directory.ts      # list_directory implementation
    check-allowed.ts       # check_allowed implementation
    read-binary.ts         # read_binary implementation (base64, byte-exact)
    write-binary.ts        # write_binary implementation (base64, byte-exact)
    str-replace.ts         # str_replace implementation (unique-match partial edit)
tests/
  config.test.ts           # 22 unit tests — config loading, path validation
  tools.test.ts            # 16 integration tests — all 4 text tools
  binary.test.ts           # 6 integration tests — binary round-trip
  str-replace.test.ts      # 8 integration tests — str_replace match/error cases
config.json                # Allowed directories configuration
dist/                      # Compiled output (git-ignored)
```

### Testing

Tests cover:

- **Path validation** — inside/outside allowed dirs, exact matches, nested subdirectories, `../` traversal attacks, prefix attacks (`/ProjectsExtra` vs `/Projects`), empty allowlist
- **Config loading** — valid config, relative paths, missing file, invalid JSON, missing keys, wrong types, empty arrays
- **write_file** — successful writes, auto-mkdir, overwrites, path rejection
- **read_file** — existing files, missing files, path rejection
- **list_directory** — contents with metadata, missing directories, path rejection
- **check_allowed** — allowed/denied paths, non-existent paths, normalization, never throws

## Troubleshooting

### Server won't start
- Verify `config.json` exists in the project root
- Check that it contains valid JSON with an `"allowedDirectories"` array
- Run `node dist/index.js` manually to see the error message

### "Access denied" errors
- The path is outside the directories listed in `config.json`
- Check for typos in your allowed directories
- Remember: paths are normalized, so `../` traversal out of allowed dirs will be caught

### Tools not showing in Claude Desktop
- Make sure `claude_desktop_config.json` points to `dist/index.js` (not `src/index.ts`)
- Run `npm run build` to ensure `dist/` exists
- Fully quit and reopen Claude Desktop (not just close the window)
- Check Claude Desktop logs: `~/Library/Logs/Claude/`

### Config changes not taking effect
- Restart Claude Desktop — config is only loaded at startup

### MCP Inspector for debugging
Run `npm run inspector` to launch the MCP Inspector UI. It connects to the server the same way Claude Desktop does and lets you invoke each tool manually at `http://localhost:6274`.

## Architecture

This server uses the [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk) with stdio transport. Claude Desktop launches it as a child process — no daemon, no background service, no port binding.

```
Claude Desktop
  └── spawns node dist/index.js (stdio)
        └── McpServer handles tool calls
              └── Path validation gate
                    └── Filesystem operation
```

The server is stateless. Each tool call validates, executes, and responds. No caching, no watchers, no background tasks.

## License

MIT
