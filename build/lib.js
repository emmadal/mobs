import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseEnv } from 'node:util';
import { gzipSync } from 'node:zlib';
export const PLATFORMS = ['ios', 'android'];
/** Flags that never take a value, so `--help sourcemaps` keeps `sourcemaps` positional. */
const BOOLEAN_FLAGS = new Set(['help', 'version']);
const SHORT_FLAGS = { '-h': 'help', '-v': 'version' };
/** Parses `--flag value` and `--flag=value` pairs, plus the `-h` and `-v` shorthands. */
export function parseFlags(argv) {
    const flags = {};
    const positional = [];
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const short = SHORT_FLAGS[arg];
        if (short) {
            flags[short] = 'true';
            continue;
        }
        if (!arg.startsWith('--')) {
            positional.push(arg);
            continue;
        }
        const body = arg.slice(2);
        const equals = body.indexOf('=');
        const name = equals === -1 ? body : body.slice(0, equals);
        const next = argv[index + 1];
        if (equals !== -1) {
            // Split on the first `=` only: values such as URLs may contain more.
            flags[name] = body.slice(equals + 1);
        }
        else if (next !== undefined && !next.startsWith('--') && !BOOLEAN_FLAGS.has(name)) {
            flags[name] = next;
            index += 1;
        }
        else {
            flags[name] = 'true';
        }
    }
    return { flags, positional };
}
/** Read in this order, so `.env.local` overrides `.env`, as in Expo CLI. */
const DOTENV_FILES = ['.env.local', '.env'];
async function readDotEnv(cwd) {
    const merged = {};
    for (const name of DOTENV_FILES) {
        let content;
        try {
            content = await readFile(join(cwd, name), 'utf8');
        }
        catch {
            continue;
        }
        for (const [key, value] of Object.entries(parseEnv(content))) {
            if (value && merged[key] === undefined)
                merged[key] = value;
        }
    }
    return merged;
}
/**
 * The app and the CLI share one setup: `EXPO_PUBLIC_MOBS_ENDPOINT` (also read
 * by the app), plus `MOBS_UPLOAD_TOKEN` for uploads. Flags win, then the
 * process environment, then the project's `.env.local` and `.env`.
 * `MOBS_ENDPOINT` still overrides the endpoint for the CLI alone.
 *
 * A token set by the operator (flag or environment, e.g. a CI secret) is only
 * sent to an endpoint the operator set too: a `.env` file is repository
 * content, and a pull request that edits it must not redirect the secret.
 */
export async function resolveCredentials(flags, env = process.env, cwd = process.cwd()) {
    const files = await readDotEnv(cwd);
    const fromEnv = (name) => env[name] || undefined;
    const fromFiles = (name) => files[name] || undefined;
    const operatorToken = flags.token ?? fromEnv('MOBS_UPLOAD_TOKEN');
    const operatorEndpoint = flags.endpoint ?? fromEnv('MOBS_ENDPOINT') ?? fromEnv('EXPO_PUBLIC_MOBS_ENDPOINT');
    const fileEndpoint = fromFiles('MOBS_ENDPOINT') ?? fromFiles('EXPO_PUBLIC_MOBS_ENDPOINT');
    if (operatorToken && !operatorEndpoint && fileEndpoint) {
        throw new Error('MOBS_UPLOAD_TOKEN comes from the environment or --token, so the endpoint must too: set EXPO_PUBLIC_MOBS_ENDPOINT in the environment or pass --endpoint. The value in .env is not used with it, so a committed file cannot redirect the token.');
    }
    return {
        endpoint: operatorEndpoint ?? fileEndpoint,
        token: operatorToken ?? fromFiles('MOBS_UPLOAD_TOKEN'),
    };
}
/** `update:<id>` for an EAS Update bundle, `build:<version>+<build>` for the embedded one. */
export function bundleKey(options) {
    if (options.updateId)
        return `update:${options.updateId}`;
    if (options.appVersion && options.build)
        return `build:${options.appVersion}+${options.build}`;
    throw new Error('Pass --update-id, or --app-version and --build');
}
/** Maps `eas update --json` output to { ios: id, android: id }. */
export function updateIdsFromEasJson(json) {
    const updates = Array.isArray(json) ? json : [json];
    const ids = {};
    for (const update of updates) {
        const platform = update?.platform;
        if ((platform === 'ios' || platform === 'android') && update.id)
            ids[platform] = update.id;
    }
    return ids;
}
const FAILURE_HINTS = {
    401: 'use the project upload token (mobs_sk_..., Settings > project card), not the public ingest key',
    413: 'the server refused the map size; the dashboard accepts 50 MB, but some hosts cap request bodies lower (Vercel Functions: 4.5 MB)',
};
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
function isUploadResult(value) {
    return (isRecord(value) &&
        value.ok === true &&
        typeof value.bundleKey === 'string' &&
        (value.platform === 'ios' || value.platform === 'android'));
}
/** One line: the server's error code, or the start of a non-JSON body (an HTML error page). */
function failureReason(text) {
    const parsed = parseJson(text);
    if (isRecord(parsed) && typeof parsed.error === 'string')
        return parsed.error;
    const compact = text.replace(/\s+/g, ' ').trim();
    return compact.length > 200 ? `${compact.slice(0, 200)}...` : compact;
}
export async function uploadSourceMap(options) {
    const { endpoint, token, platform, key, file, fetchImpl = fetch } = options;
    if (!endpoint)
        throw new Error('Missing --endpoint (or EXPO_PUBLIC_MOBS_ENDPOINT)');
    if (!token)
        throw new Error('Missing --token (or MOBS_UPLOAD_TOKEN)');
    if (platform !== 'ios' && platform !== 'android')
        throw new Error('--platform must be ios or android');
    const content = await readFile(file);
    JSON.parse(content.toString('utf8')); // fail fast on a non-JSON file
    // Appended like the SDK transport does, so a dashboard served under a sub-path keeps it.
    const url = new URL(`${endpoint.replace(/\/+$/, '')}/api/v1/sourcemaps`);
    url.searchParams.set('platform', platform);
    url.searchParams.set('bundleKey', key);
    url.searchParams.set('fileName', basename(file));
    let response;
    try {
        response = await fetchImpl(url, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
                'content-encoding': 'gzip',
            },
            body: gzipSync(content),
            // Following a 301/302 would resend the upload as a body-less GET; report it instead.
            redirect: 'manual',
        });
    }
    catch (error) {
        // fetch() only says "fetch failed"; the cause names the network error (ECONNREFUSED, ENOTFOUND...).
        const cause = error.cause;
        const detail = cause?.code ?? cause?.message ?? error.message;
        throw new Error(`Cannot reach ${url.origin}: ${detail}`);
    }
    if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        throw new Error(`Upload redirected (${response.status})${location ? ` to ${location}` : ''}: set --endpoint to the final dashboard URL. Password- or SSO-protected deployments cannot receive uploads.`);
    }
    const text = await response.text();
    if (!response.ok) {
        const reason = failureReason(text);
        const hint = FAILURE_HINTS[response.status];
        throw new Error(`Upload failed (${response.status}${reason ? `: ${reason}` : ''})${hint ? `. Hint: ${hint}` : ''}`);
    }
    const result = parseJson(text);
    if (!isUploadResult(result)) {
        throw new Error(`Unexpected response from ${url.origin} (${response.status}): is --endpoint the dashboard URL?`);
    }
    return result;
}
/** Source maps of one platform in an `expo export` / `eas update` output directory. */
export function easMapDirectory(dist, platform) {
    return join(dist, '_expo', 'static', 'js', platform);
}
export async function findMaps(dist, platform) {
    const directory = easMapDirectory(dist, platform);
    const files = await readdir(directory).catch(() => []);
    return files
        .filter((file) => file.endsWith('.map'))
        .sort()
        .map((file) => join(directory, file));
}
/**
 * Uploads every map of an EAS Update under its `update:<id>` key. Fails when
 * nothing would be uploaded, so a CI step never passes with maps missing.
 */
export async function uploadEasUpdate(options) {
    const { dist, easJson, onUploaded, ...upload } = options;
    const ids = updateIdsFromEasJson(JSON.parse(await readFile(easJson, 'utf8')));
    const platforms = PLATFORMS.filter((platform) => ids[platform]);
    if (platforms.length === 0) {
        throw new Error(`No ios or android update ids in ${easJson}: pass the output of eas update --json`);
    }
    const plan = [];
    for (const platform of platforms) {
        const files = await findMaps(dist, platform);
        if (files.length === 0) {
            throw new Error(`No ${platform} source maps in ${easMapDirectory(dist, platform)}: check --dist and that the update was exported with source maps`);
        }
        plan.push({ platform, updateId: ids[platform], files });
    }
    const results = [];
    for (const { platform, updateId, files } of plan) {
        for (const file of files) {
            const result = await uploadSourceMap({
                ...upload,
                platform,
                key: bundleKey({ updateId }),
                file,
            });
            onUploaded?.(file, result);
            results.push(result);
        }
    }
    return results;
}
