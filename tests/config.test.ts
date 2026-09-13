import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { loadConfig, normalizePath, isPathAllowed, validatePath, resolveRealPath } from '../src/config';

describe('normalizePath', () => {
  it('resolves relative paths to absolute', () => {
    const result = normalizePath('./foo/bar');
    expect(path.isAbsolute(result)).toBe(true);
  });

  it('resolves .. segments', () => {
    const result = normalizePath('/Users/test/foo/../bar');
    expect(result).toBe('/Users/test/bar');
  });

  it('returns absolute paths unchanged (after normalization)', () => {
    const result = normalizePath('/Users/test/foo');
    expect(result).toBe('/Users/test/foo');
  });
});

describe('isPathAllowed', () => {
  const allowed = ['/Users/test/Projects', '/Users/test/Development'];

  it('allows paths inside allowed directories', () => {
    expect(isPathAllowed('/Users/test/Projects/myfile.txt', allowed)).toBe(true);
  });

  it('allows the allowed directory itself', () => {
    expect(isPathAllowed('/Users/test/Projects', allowed)).toBe(true);
  });

  it('allows nested subdirectories', () => {
    expect(isPathAllowed('/Users/test/Projects/deep/nested/file.ts', allowed)).toBe(true);
  });

  it('rejects paths outside allowed directories', () => {
    expect(isPathAllowed('/Users/test/Desktop/file.txt', allowed)).toBe(false);
  });

  it('rejects paths that are prefixes but not subdirectories', () => {
    // /Users/test/ProjectsExtra should NOT match /Users/test/Projects
    expect(isPathAllowed('/Users/test/ProjectsExtra/file.txt', allowed)).toBe(false);
  });

  it('rejects root path', () => {
    expect(isPathAllowed('/', allowed)).toBe(false);
  });

  it('rejects all paths when allowedDirectories is empty', () => {
    expect(isPathAllowed('/Users/test/Projects/file.txt', [])).toBe(false);
  });

  it('handles paths with .. traversal', () => {
    // /Users/test/Projects/../Desktop resolves to /Users/test/Desktop
    const traversalPath = normalizePath('/Users/test/Projects/../Desktop/file.txt');
    expect(isPathAllowed(traversalPath, allowed)).toBe(false);
  });

  it('allows second allowed directory', () => {
    expect(isPathAllowed('/Users/test/Development/app.js', allowed)).toBe(true);
  });
});

describe('symlink escape (sandbox-defeating)', () => {
  let sandbox: string;
  let outside: string;

  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-symlink-test-'));
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(base, 'sandbox-')));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(base, 'outside-')));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  });

  afterEach(() => {
    fs.rmSync(path.dirname(sandbox), { recursive: true, force: true });
  });

  it('resolveRealPath follows a symlink inside the sandbox to its true (outside) target', () => {
    const link = path.join(sandbox, 'escape');
    fs.symlinkSync(outside, link);

    const real = resolveRealPath(path.join(link, 'secret.txt'));
    expect(real).toBe(path.join(outside, 'secret.txt'));
  });

  it('isPathAllowed rejects a path that traverses a symlink pointing outside the allowed directory', () => {
    const link = path.join(sandbox, 'escape');
    fs.symlinkSync(outside, link);

    // The raw string still looks like it's inside the sandbox...
    const lexicallyInside = path.join(sandbox, 'escape', 'secret.txt');
    expect(lexicallyInside.startsWith(sandbox + path.sep)).toBe(true);

    // ...but it must be rejected because it really resolves outside it.
    expect(isPathAllowed(lexicallyInside, [sandbox])).toBe(false);
  });

  it('validatePath throws for a path that escapes the sandbox via a symlink', () => {
    fs.symlinkSync(outside, path.join(sandbox, 'escape'));
    const target = path.join(sandbox, 'escape', 'secret.txt');

    expect(() => validatePath(target, [sandbox])).toThrow('Access denied');
  });

  it('still allows a symlink whose target stays inside the allowed directory', () => {
    const realDir = path.join(sandbox, 'real');
    fs.mkdirSync(realDir);
    fs.writeFileSync(path.join(realDir, 'file.txt'), 'fine');
    fs.symlinkSync(realDir, path.join(sandbox, 'internal-link'));

    const target = path.join(sandbox, 'internal-link', 'file.txt');
    expect(isPathAllowed(target, [sandbox])).toBe(true);
    expect(() => validatePath(target, [sandbox])).not.toThrow();
  });

  it('still resolves a not-yet-created path (e.g. a new file) inside the sandbox', () => {
    const target = path.join(sandbox, 'brand-new-file.txt');
    expect(isPathAllowed(target, [sandbox])).toBe(true);
  });
});

describe('validatePath', () => {
  const allowed = ['/Users/test/Projects'];

  it('returns normalized path when allowed', () => {
    const result = validatePath('/Users/test/Projects/file.txt', allowed);
    expect(result).toBe('/Users/test/Projects/file.txt');
  });

  it('throws when path is not allowed', () => {
    expect(() => validatePath('/etc/passwd', allowed)).toThrow('Access denied');
  });

  it('throws when allowedDirectories is empty', () => {
    expect(() => validatePath('/Users/test/Projects/file.txt', [])).toThrow('Access denied');
  });
});

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-config-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads valid config', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      allowedDirectories: ['/Users/test/Projects']
    }));
    const config = loadConfig(configPath);
    expect(config.allowedDirectories).toEqual(['/Users/test/Projects']);
  });

  it('resolves relative paths from config location', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      allowedDirectories: ['./relative']
    }));
    const config = loadConfig(configPath);
    expect(config.allowedDirectories[0]).toBe(path.resolve(tmpDir, './relative'));
  });

  it('throws for missing config file', () => {
    expect(() => loadConfig(path.join(tmpDir, 'nonexistent.json'))).toThrow('not found');
  });

  it('throws for invalid JSON', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, 'not json');
    expect(() => loadConfig(configPath)).toThrow('invalid JSON');
  });

  it('throws for missing allowedDirectories key', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ other: true }));
    expect(() => loadConfig(configPath)).toThrow('allowedDirectories');
  });

  it('throws when allowedDirectories is not an array', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ allowedDirectories: 'string' }));
    expect(() => loadConfig(configPath)).toThrow('must be an array');
  });

  it('returns empty array for empty allowedDirectories', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ allowedDirectories: [] }));
    const config = loadConfig(configPath);
    expect(config.allowedDirectories).toEqual([]);
  });
});
