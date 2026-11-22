import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

export type Platform = 'ios' | 'android';

export type Flags = Record<string, string>;

export interface FlagParse {
  flags: Flags;
  positional: string[];
}

/** Parses `--flag value` and `--flag=value` pairs. */
export function parseFlags(argv: string[]): FlagParse {
  const flags: Flags = {};
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name = '', inline] = arg.slice(2).split('=', 2);
    const next = argv[index + 1];
    if (inline !== undefined) {
      flags[name] = inline;
    } else if (next && !next.startsWith('--')) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = 'true';
    }
  }
  return { flags, positional };
}

/** `update:<id>` for an EAS Update bundle, `build:<version>+<build>` for the embedded one. */
export function bundleKey(options: {
  updateId?: string;
  appVersion?: string;
  build?: string;
}): string {
  if (options.updateId) return `update:${options.updateId}`;
  if (options.appVersion && options.build) return `build:${options.appVersion}+${options.build}`;
  throw new Error('Pass --update-id, or --app-version and --build');
}

export interface EasUpdate {
  platform?: string;
  id?: string;
}

/** Maps `eas update --json` output to { ios: id, android: id }. */
export function updateIdsFromEasJson(json: unknown): Partial<Record<Platform, string>> {
  const updates: EasUpdate[] = Array.isArray(json) ? (json as EasUpdate[]) : [json as EasUpdate];
  const ids: Partial<Record<Platform, string>> = {};
  for (const update of updates) {
    const platform = update?.platform;
    if ((platform === 'ios' || platform === 'android') && update.id) ids[platform] = update.id;
  }
  return ids;
}

export interface UploadOptions {
  endpoint?: string;
  token?: string;
  platform?: string;
  key: string;
  file: string;
  fetchImpl?: typeof fetch;
}

export interface UploadResult {
  ok: boolean;
  platform: Platform;
  bundleKey: string;
  sizeBytes: number;
}

export async function uploadSourceMap(options: UploadOptions): Promise<UploadResult> {
  const { endpoint, token, platform, key, file, fetchImpl = fetch } = options;
  if (!endpoint) throw new Error('Missing --endpoint (or MOBS_ENDPOINT)');
  if (!token) throw new Error('Missing --token (or MOBS_UPLOAD_TOKEN)');
  if (platform !== 'ios' && platform !== 'android')
    throw new Error('--platform must be ios or android');

  const content = await readFile(file);
  JSON.parse(content.toString('utf8')); // fail fast on a non-JSON file
  const url = new URL('/api/v1/sourcemaps', endpoint);
  url.searchParams.set('platform', platform);
  url.searchParams.set('bundleKey', key);
  url.searchParams.set('fileName', file.split('/').pop() ?? 'bundle.map');
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    },
    body: gzipSync(content),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Upload failed (${response.status}): ${text}`);
  return JSON.parse(text) as UploadResult;
}
