import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';

// Exercises the actual shipped server (dist/index.js) over real JSON-RPC/stdio —
// this is the only place server.registerTool()'s schema shapes and the
// content/file_text alias logic (src/index.ts) are covered; the tests/*.test.ts
// suites only cover the src/tools/* helpers those handlers call into.
// Requires a build (`npm run build`, wired as `pretest`) — fails clearly if missing.

const DIST_ENTRY = path.resolve(__dirname, '..', 'dist', 'index.js');

let tmpDir: string;
let configPath: string;
let proc: ChildProcessWithoutNullStreams;
let nextId: number;
let rxBuf: string;
const pending = new Map<number, (msg: any) => void>();

function send(method: string, params?: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
  const resp = await send('tools/call', { name, arguments: args });
  if (resp.error) throw new Error(`RPC error calling ${name}: ${JSON.stringify(resp.error)}`);
  const text = resp.result.content[0].text;
  return { parsed: JSON.parse(text), isError: resp.result.isError === true };
}

beforeAll(() => {
  if (!fs.existsSync(DIST_ENTRY)) {
    throw new Error(`${DIST_ENTRY} does not exist — run "npm run build" before this suite.`);
  }
});

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-index-test-'));
  configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ allowedDirectories: [tmpDir] }));

  proc = spawn('node', [DIST_ENTRY], {
    env: { ...process.env, MCP_FS_CONFIG_PATH: configPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  nextId = 1;
  rxBuf = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    rxBuf += chunk.toString();
    let idx: number;
    while ((idx = rxBuf.indexOf('\n')) >= 0) {
      const line = rxBuf.slice(0, idx).trim();
      rxBuf = rxBuf.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    }
  });

  await send('initialize', {
    protocolVersion: '2026-06-18',
    capabilities: {},
    clientInfo: { name: 'jest-integration', version: '1.0' },
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
});

afterEach(() => {
  proc.kill();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('write_file (content/file_text alias)', () => {
  it('writes via the canonical content field', async () => {
    const filePath = path.join(tmpDir, 'content.txt');
    const { parsed } = await callTool('write_file', { path: filePath, content: 'via content' });

    expect(parsed.success).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('via content');
  });

  it('writes via the file_text alias (claude.ai client field)', async () => {
    const filePath = path.join(tmpDir, 'filetext.txt');
    const { parsed } = await callTool('write_file', { path: filePath, file_text: 'via file_text' });

    expect(parsed.success).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('via file_text');
  });

  it('prefers content over file_text when both are set', async () => {
    const filePath = path.join(tmpDir, 'both.txt');
    const { parsed } = await callTool('write_file', { path: filePath, content: 'winner', file_text: 'loser' });

    expect(parsed.success).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('winner');
  });

  it('returns a clean isError when neither content nor file_text is set', async () => {
    const filePath = path.join(tmpDir, 'neither.txt');
    const { parsed, isError } = await callTool('write_file', { path: filePath });

    expect(isError).toBe(true);
    expect(parsed.error).toMatch(/requires "content"/);
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

describe('write_binary (content/file_text alias)', () => {
  const b64 = Buffer.from('binary payload').toString('base64');
  const altB64 = Buffer.from('alias payload').toString('base64');

  it('writes via the canonical content field', async () => {
    const filePath = path.join(tmpDir, 'content.bin');
    const { parsed } = await callTool('write_binary', { path: filePath, content: b64 });

    expect(parsed.success).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('binary payload');
  });

  it('writes via the file_text alias', async () => {
    const filePath = path.join(tmpDir, 'filetext.bin');
    const { parsed } = await callTool('write_binary', { path: filePath, file_text: altB64 });

    expect(parsed.success).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('alias payload');
  });

  it('prefers content over file_text when both are set', async () => {
    const filePath = path.join(tmpDir, 'both.bin');
    const { parsed } = await callTool('write_binary', { path: filePath, content: b64, file_text: altB64 });

    expect(parsed.success).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('binary payload');
  });

  it('returns a clean isError when neither content nor file_text is set', async () => {
    const filePath = path.join(tmpDir, 'neither.bin');
    const { parsed, isError } = await callTool('write_binary', { path: filePath });

    expect(isError).toBe(true);
    expect(parsed.error).toMatch(/requires "content"/);
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

describe('remaining tool registrations wire up correctly', () => {
  it('read_file round-trips a file written by write_file', async () => {
    const filePath = path.join(tmpDir, 'roundtrip.txt');
    await callTool('write_file', { path: filePath, content: 'round trip' });

    const { parsed } = await callTool('read_file', { path: filePath });
    expect(parsed.success).toBe(true);
    expect(parsed.content).toBe('round trip');
  });

  it('list_directory sees files written into the sandbox', async () => {
    await callTool('write_file', { path: path.join(tmpDir, 'listed.txt'), content: 'x' });

    const { parsed } = await callTool('list_directory', { path: tmpDir });
    expect(parsed.success).toBe(true);
    expect(parsed.entries.map((e: { name: string }) => e.name)).toContain('listed.txt');
  });

  it('check_allowed reports paths outside the sandbox as denied', async () => {
    const { parsed } = await callTool('check_allowed', { path: '/etc/passwd' });
    expect(parsed.allowed).toBe(false);
  });

  it('str_replace edits a file written by write_file', async () => {
    const filePath = path.join(tmpDir, 'replace.txt');
    await callTool('write_file', { path: filePath, content: 'hello world' });

    const { parsed } = await callTool('str_replace', { path: filePath, old_str: 'world', new_str: 'there' });
    expect(parsed.success).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('hello there');
  });

  it('read_binary round-trips a file written by write_binary', async () => {
    const filePath = path.join(tmpDir, 'roundtrip.bin');
    const payload = Buffer.from('bytes').toString('base64');
    await callTool('write_binary', { path: filePath, content: payload });

    const { parsed } = await callTool('read_binary', { path: filePath });
    expect(parsed.success).toBe(true);
    expect(Buffer.from(parsed.content, 'base64').toString('utf-8')).toBe('bytes');
  });
});
