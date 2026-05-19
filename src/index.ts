import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { writeFile } from './tools/write-file.js';
import { readFile } from './tools/read-file.js';
import { listDirectory } from './tools/list-directory.js';
import { checkAllowed } from './tools/check-allowed.js';
import { readBinary } from './tools/read-binary.js';
import { writeBinary } from './tools/write-binary.js';
import { strReplace } from './tools/str-replace.js';

const config = loadConfig();
const allowedDirs = config.allowedDirectories;

const server = new McpServer({
  name: 'local-filesystem',
  version: '1.1.0',
});

server.registerTool(
  'write_file',
  {
    description: 'Write content to a file on the local filesystem. Auto-creates parent directories.',
    inputSchema: {
      path: z.string().describe('Absolute path to the file to write'),
      content: z.string().optional().describe('Content to write to the file (canonical field)'),
      file_text: z.string().optional().describe('Alias for content (client-compat); content takes precedence'),
    },
  },
  async ({ path, content, file_text }) => {
    const body = content ?? file_text;
    if (body === undefined) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'write_file requires "content" (or alias "file_text")' }, null, 2) }],
        isError: true,
      };
    }
    const result = await writeFile(path, body, allowedDirs);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.registerTool(
  'read_file',
  {
    description: 'Read the content of a file from the local filesystem.',
    inputSchema: {
      path: z.string().describe('Absolute path to the file to read'),
    },
  },
  async ({ path }) => {
    const result = await readFile(path, allowedDirs);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.registerTool(
  'list_directory',
  {
    description: 'List the contents of a directory on the local filesystem.',
    inputSchema: {
      path: z.string().describe('Absolute path to the directory to list'),
    },
  },
  async ({ path }) => {
    const result = await listDirectory(path, allowedDirs);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.registerTool(
  'check_allowed',
  {
    description: 'Check if a path is within the allowed directories. Does not require the path to exist.',
    inputSchema: {
      path: z.string().describe('Path to check'),
    },
  },
  async ({ path }) => {
    const result = checkAllowed(path, allowedDirs);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.registerTool(
  'write_binary',
  {
    description: 'Write base64-encoded content to a file as raw bytes on the local filesystem. Auto-creates parent directories. Use this for any file where byte-exact preservation matters: pdf, docx, pptx, xlsx, png, jpg, zip, or any compiled/encoded format. For plain text files (md, txt, json, ts, py), use write_file instead.',
    inputSchema: {
      path: z.string().describe('Absolute path to the file to write'),
      content: z.string().optional().describe('Base64-encoded binary content (canonical field)'),
      file_text: z.string().optional().describe('Alias for content (client-compat); content takes precedence'),
    },
  },
  async ({ path, content, file_text }) => {
    const body = content ?? file_text;
    if (body === undefined) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'write_binary requires "content" (or alias "file_text")' }, null, 2) }],
        isError: true,
      };
    }
    const result = await writeBinary(path, body, allowedDirs);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.registerTool(
  'read_binary',
  {
    description: 'Read a file from the local filesystem and return its content as base64-encoded bytes. Use this for any file where byte-exact preservation matters: pdf, docx, pptx, xlsx, png, jpg, zip, or any compiled/encoded format. For plain text files (md, txt, json, ts, py), use read_file instead.',
    inputSchema: {
      path: z.string().describe('Absolute path to the file to read'),
    },
  },
  async ({ path }) => {
    const result = await readBinary(path, allowedDirs);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

server.registerTool(
  'str_replace',
  {
    description: 'Replace a single, unique occurrence of old_str with new_str in a UTF-8 text file. Errors if old_str is not found, or if it matches more than once (add surrounding context to disambiguate). Use this for partial edits when rewriting the whole file with write_file would be wasteful. For binary files, use write_binary.',
    inputSchema: {
      path: z.string().describe('Absolute path to the file to edit'),
      old_str: z.string().describe('Exact substring to find — must match verbatim and uniquely'),
      new_str: z.string().describe('Replacement text. Empty string deletes the match.'),
      description: z.string().optional().describe('Optional human-readable reason for the edit, for logging'),
    },
  },
  async ({ path, old_str, new_str, description }) => {
    const result = await strReplace(path, old_str, new_str, allowedDirs, description);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal error starting MCP server:', err);
  process.exit(1);
});
