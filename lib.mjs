import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

/** Parses `--flag value` and `--flag=value` pairs. */
export function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) flags[name] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) flags[name] = argv[++index];
    else flags[name] = 'true';
  }
  return { flags, positional };
}

/** `update:<id>` for an EAS Update bundle, `build:<version>+<build>` for the embedded one. */
export function bundleKey({ updateId, appVersion, build }) {
  if (updateId) return `update:${updateId}`;
  if (appVersion && build) return `build:${appVersion}+${build}`;
  throw new Error('Pass --update-id, or --app-version and --build');
}

/** Maps `eas update --json` output to { ios: id, android: id }. */
export function updateIdsFromEasJson(json) {
  const updates = Array.isArray(json) ? json : [json];
  const ids = {};
  for (const update of updates) {
    if (update?.platform && update?.id) ids[update.platform] = update.id;
  }
  return ids;
}

export async function uploadSourceMap({ endpoint, token, platform, key, file, fetchImpl = fetch }) {
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
  return JSON.parse(text);
}
