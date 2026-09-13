import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { writeFile } from '../src/tools/write-file';
import { readFile } from '../src/tools/read-file';
import { listDirectory } from '../src/tools/list-directory';
import { checkAllowed } from '../src/tools/check-allowed';

let tmpDir: string;
let allowed: string[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tools-test-'));
  allowed = [tmpDir];
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('write_file', () => {
  it('writes a file successfully', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    const result = await writeFile(filePath, 'hello world', allowed);

    expect(result.success).toBe(true);
    expect(result.path).toBe(filePath);
    expect(result.bytesWritten).toBe(11);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('hello world');
  });

  it('auto-creates parent directories', async () => {
    const filePath = path.join(tmpDir, 'deep', 'nested', 'dir', 'file.txt');
    const result = await writeFile(filePath, 'nested content', allowed);

    expect(result.success).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('overwrites existing files', async () => {
    const filePath = path.join(tmpDir, 'overwrite.txt');
    fs.writeFileSync(filePath, 'original');

    const result = await writeFile(filePath, 'replaced', allowed);

    expect(result.success).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('replaced');
  });

  it('rejects paths outside allowed directories', async () => {
    const result = await writeFile('/tmp/evil.txt', 'hack', allowed);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Access denied');
  });

  it('rejects with empty allowed directories', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    const result = await writeFile(filePath, 'content', []);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Access denied');
  });
});

describe('read_file', () => {
  it('reads an existing file', async () => {
    const filePath = path.join(tmpDir, 'read-me.txt');
    fs.writeFileSync(filePath, 'file contents');

    const result = await readFile(filePath, allowed);

    expect(result.success).toBe(true);
    expect(result.content).toBe('file contents');
    expect(result.path).toBe(filePath);
  });

  it('returns error for non-existent file', async () => {
    const filePath = path.join(tmpDir, 'nope.txt');
    const result = await readFile(filePath, allowed);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('rejects paths outside allowed directories', async () => {
    const result = await readFile('/etc/passwd', allowed);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Access denied');
  });
});

describe('list_directory', () => {
  it('lists directory contents', async () => {
    fs.writeFileSync(path.join(tmpDir, 'file1.txt'), 'a');
    fs.writeFileSync(path.join(tmpDir, 'file2.txt'), 'bb');
    fs.mkdirSync(path.join(tmpDir, 'subdir'));

    const result = await listDirectory(tmpDir, allowed);

    expect(result.success).toBe(true);
    expect(result.entries).toBeDefined();
    expect(result.entries!.length).toBe(3);

    const names = result.entries!.map((e) => e.name).sort();
    expect(names).toEqual(['file1.txt', 'file2.txt', 'subdir']);

    const subdir = result.entries!.find((e) => e.name === 'subdir');
    expect(subdir!.type).toBe('directory');

    const file1 = result.entries!.find((e) => e.name === 'file1.txt');
    expect(file1!.type).toBe('file');
    expect(file1!.size).toBe(1);
    expect(file1!.modified).toBeDefined();
  });

  it('returns error for non-existent directory', async () => {
    const result = await listDirectory(path.join(tmpDir, 'nope'), allowed);

    expect(result.success).toBe(false);
  });

  it('rejects paths outside allowed directories', async () => {
    const result = await listDirectory('/etc', allowed);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Access denied');
  });
});

describe('symlink escape (sandbox-defeating)', () => {
  let outsideDir: string;

  beforeEach(() => {
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-outside-'));
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'top secret contents');
  });

  afterEach(() => {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('read_file refuses to follow a symlink out of the sandbox', async () => {
    fs.symlinkSync(outsideDir, path.join(tmpDir, 'escape'));

    const result = await readFile(path.join(tmpDir, 'escape', 'secret.txt'), allowed);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Access denied');
  });

  it('write_file refuses to follow a symlink and write outside the sandbox', async () => {
    fs.symlinkSync(outsideDir, path.join(tmpDir, 'escape'));

    const result = await writeFile(path.join(tmpDir, 'escape', 'pwned.txt'), 'pwned', allowed);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Access denied');
    expect(fs.existsSync(path.join(outsideDir, 'pwned.txt'))).toBe(false);
  });
});

describe('check_allowed', () => {
  it('returns allowed=true for paths inside allowed directories', () => {
    const result = checkAllowed(path.join(tmpDir, 'anything.txt'), allowed);

    expect(result.allowed).toBe(true);
    expect(result.normalizedPath).toBe(path.join(tmpDir, 'anything.txt'));
  });

  it('returns allowed=false for paths outside allowed directories', () => {
    const result = checkAllowed('/etc/passwd', allowed);

    expect(result.allowed).toBe(false);
  });

  it('works for non-existent paths', () => {
    const result = checkAllowed(path.join(tmpDir, 'does', 'not', 'exist.txt'), allowed);

    expect(result.allowed).toBe(true);
  });

  it('never throws', () => {
    expect(() => checkAllowed('', allowed)).not.toThrow();
    expect(() => checkAllowed('/anything', [])).not.toThrow();
  });

  it('normalizes the path in the result', () => {
    const result = checkAllowed(tmpDir + '/foo/../bar.txt', allowed);

    expect(result.normalizedPath).toBe(path.join(tmpDir, 'bar.txt'));
  });
});
