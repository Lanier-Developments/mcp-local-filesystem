// Functional smoke test: spawn dist/index.js as an MCP stdio server,
// call each tool over JSON-RPC, assert results. Exits non-zero on failure.
import { spawn } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const PROBE = '/Users/kmcallorum/Projects/ClaudeStuff/_jrprobe.txt';
const STR_TMP = '/Users/kmcallorum/Projects/ClaudeStuff/_jrprobe_str.txt';
const BIN_TMP = '/Users/kmcallorum/Projects/ClaudeStuff/_jrprobe_bin.bin';

const proc = spawn('node', ['dist/index.js'], {
  cwd: '/Users/kmcallorum/Projects/mcp-local-filesystem',
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderrBuf = '';
proc.stderr.on('data', (d) => { stderrBuf += d.toString(); });

let nextId = 1;
const pending = new Map();
let rxBuf = '';
proc.stdout.on('data', (chunk) => {
  rxBuf += chunk.toString();
  let idx;
  while ((idx = rxBuf.indexOf('\n')) >= 0) {
    const line = rxBuf.slice(0, idx).trim();
    rxBuf = rxBuf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method, params };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify(msg) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout on ${method}`));
      }
    }, 5000);
  });
}

function callTool(name, args) {
  return rpc('tools/call', { name, arguments: args });
}

function parseResult(resp, label) {
  if (resp.error) throw new Error(`${label} → JSON-RPC error: ${JSON.stringify(resp.error)}`);
  const txt = resp.result?.content?.[0]?.text;
  if (typeof txt !== 'string') throw new Error(`${label} → no text content: ${JSON.stringify(resp.result)}`);
  return JSON.parse(txt);
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

try {
  // Initialize handshake
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.0.0' },
  });
  if (init.error) throw new Error('init: ' + JSON.stringify(init.error));
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // 1. write_file
  {
    const resp = await callTool('write_file', { path: PROBE, content: 'ok' });
    const r = parseResult(resp, 'write_file');
    const content = await readFile(PROBE, 'utf8');
    const ok = r.success === true && content === 'ok';
    record('write_file', ok, ok ? `wrote "${content}"` : `success=${r.success} content="${content}"`);
    await unlink(PROBE);
  }

  // 2. str_replace
  {
    await writeFile(STR_TMP, 'a\nb\nc');
    const resp = await callTool('str_replace', { path: STR_TMP, old_str: 'b', new_str: 'B' });
    const r = parseResult(resp, 'str_replace');
    const content = await readFile(STR_TMP, 'utf8');
    const ok = r.success === true && content === 'a\nB\nc';
    record('str_replace', ok, ok ? 'b→B applied' : `content="${content}" r=${JSON.stringify(r)}`);
    await unlink(STR_TMP);
  }

  // 3. write_binary + read_binary round-trip
  {
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
    const b64 = payload.toString('base64');
    const wResp = await callTool('write_binary', { path: BIN_TMP, content: b64 });
    const wR = parseResult(wResp, 'write_binary');
    const rResp = await callTool('read_binary', { path: BIN_TMP });
    const rR = parseResult(rResp, 'read_binary');
    const got = Buffer.from(rR.content, 'base64');
    const ok = wR.success === true && got.equals(payload);
    record('write_binary+read_binary round-trip', ok, ok ? `${payload.length}B match` : `wR=${JSON.stringify(wR)} got=${got.toString('hex')}`);
    await unlink(BIN_TMP);
  }

  // 4. read_file regression
  {
    const resp = await callTool('read_file', { path: '/Users/kmcallorum/Projects/mcp-local-filesystem/package.json' });
    const r = parseResult(resp, 'read_file');
    const ok = typeof r.content === 'string' && r.content.includes('mcp-local-filesystem');
    record('read_file', ok, ok ? `${r.content.length}B` : JSON.stringify(r).slice(0, 200));
  }

  // 5. list_directory regression
  {
    const resp = await callTool('list_directory', { path: '/Users/kmcallorum/Projects/mcp-local-filesystem' });
    const r = parseResult(resp, 'list_directory');
    const entries = r.entries ?? r.items ?? r.files ?? r;
    const arr = Array.isArray(entries) ? entries : Array.isArray(r) ? r : [];
    const ok = arr.length > 0;
    record('list_directory', ok, ok ? `${arr.length} entries` : JSON.stringify(r).slice(0, 200));
  }
} catch (e) {
  console.error('FATAL:', e.message);
  console.error('stderr:', stderrBuf);
  proc.kill();
  process.exit(2);
}

proc.kill();
const fails = results.filter((r) => !r.ok);
if (fails.length > 0) {
  console.error(`\n${fails.length} of ${results.length} failed`);
  process.exit(1);
}
console.log(`\nAll ${results.length} smoke tests passed.`);
process.exit(0);
