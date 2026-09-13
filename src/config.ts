import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Config {
  allowedDirectories: string[];
}

/**
 * Loads and validates the configuration from config.json.
 * Resolves relative paths from the config.json location.
 * Throws if config.json is missing, invalid, or has no allowedDirectories key.
 */
export function loadConfig(configPath?: string): Config {
  const resolvedPath = configPath ?? path.resolve(__dirname, '..', 'config.json');

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Configuration file not found: config.json. Server cannot start without it.`);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(resolvedPath, 'utf-8');
  } catch {
    throw new Error(`Failed to read configuration file.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Configuration file contains invalid JSON.`);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('allowedDirectories' in parsed)
  ) {
    throw new Error(`Configuration file must contain an "allowedDirectories" array.`);
  }

  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.allowedDirectories)) {
    throw new Error(`"allowedDirectories" must be an array.`);
  }

  const configDir = path.dirname(resolvedPath);
  const allowedDirectories: string[] = obj.allowedDirectories.map((dir: unknown) => {
    if (typeof dir !== 'string') {
      throw new Error(`Each entry in "allowedDirectories" must be a string.`);
    }
    return path.resolve(configDir, dir);
  });

  return { allowedDirectories };
}

/**
 * Normalizes a path by resolving it to an absolute path.
 * Does NOT check existence — just normalizes for comparison.
 * This is purely lexical (like `path.resolve`): it does NOT resolve symlinks,
 * so it must never be the sole basis for a sandbox decision — see
 * `resolveRealPath` for the canonicalization used in security checks.
 */
export function normalizePath(inputPath: string): string {
  return path.resolve(inputPath);
}

/**
 * Canonicalizes a path for security comparisons by resolving symlinks.
 *
 * `path.resolve`/`normalizePath` only does lexical `..`/`.` collapsing — it
 * has no idea a path component is a symlink. If a symlink sits inside an
 * allowed directory and points outside it, lexical normalization leaves the
 * symlink's literal (in-sandbox-looking) path untouched, the prefix check
 * passes, and the subsequent `fs` call follows the symlink out of the
 * sandbox. This function walks up to the longest existing ancestor of the
 * path, resolves *that* with `fs.realpathSync` (which follows symlinks and
 * canonicalizes case per the OS), and reattaches any remaining path segments
 * that don't exist yet (e.g. a new file about to be created). The result is
 * the true, symlink-resolved location the path refers (or will resolve) to.
 */
export function resolveRealPath(inputPath: string): string {
  const absolute = path.resolve(inputPath);
  const trailing: string[] = [];
  let current = absolute;

  while (true) {
    try {
      const real = fs.realpathSync(current);
      return trailing.length > 0 ? path.join(real, ...trailing.reverse()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw err;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the filesystem root without finding an existing ancestor
        // (e.g. permission denied all the way up); fall back to the lexical
        // path rather than looping forever.
        return absolute;
      }
      trailing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Checks whether a path falls within one of the allowed directories.
 * Compares canonical (symlink-resolved) forms of both the input path and
 * each allowed directory — never raw strings — so a symlink inside an
 * allowed directory can't be used to point outside it undetected.
 */
export function isPathAllowed(inputPath: string, allowedDirectories: string[]): boolean {
  if (allowedDirectories.length === 0) {
    return false;
  }

  const real = resolveRealPath(inputPath);

  return allowedDirectories.some((dir) => {
    const realDir = resolveRealPath(dir);
    return real === realDir || real.startsWith(realDir + path.sep);
  });
}

/**
 * Validates a path against allowed directories.
 * Returns the normalized path if allowed, throws if not.
 */
export function validatePath(inputPath: string, allowedDirectories: string[]): string {
  const normalized = normalizePath(inputPath);

  if (!isPathAllowed(normalized, allowedDirectories)) {
    throw new Error(`Access denied: path is outside allowed directories.`);
  }

  return normalized;
}
