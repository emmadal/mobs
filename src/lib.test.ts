import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bundleKey,
  parseFlags,
  resolveCredentials,
  updateIdsFromEasJson,
  uploadEasUpdate,
  uploadSourceMap,
} from './lib.js';

const MAP = '{"version":3,"sources":[],"mappings":""}';

async function mapFile(name = 'main.jsbundle.map'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mobs-'));
  const file = join(dir, name);
  await writeFile(file, MAP);
  return file;
}

/** A fetch stub that records calls and answers every request with `respond()`. */
function stubFetch(respond: (url: URL) => Response) {
  const calls: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url);
    return respond(url);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const accepted = (url: URL) =>
  Response.json(
    {
      ok: true,
      platform: url.searchParams.get('platform'),
      bundleKey: url.searchParams.get('bundleKey'),
      sizeBytes: MAP.length,
    },
    { status: 201 },
  );

const upload = { endpoint: 'https://obs.example.com', token: 'mobs_sk_x' };

describe('mobs CLI helpers', () => {
  it('parses flags in both forms', () => {
    expect(parseFlags(['--platform', 'ios', '--file=a.map', '--dry']).flags).toEqual({
      platform: 'ios',
      file: 'a.map',
      dry: 'true',
    });
  });

  it('keeps every = after the first in an inline value', () => {
    expect(parseFlags(['--endpoint=https://obs.example.com/?a=b']).flags.endpoint).toBe(
      'https://obs.example.com/?a=b',
    );
  });

  it('parses -h, -v and boolean flags without swallowing the next argument', () => {
    expect(parseFlags(['-v']).flags).toEqual({ version: 'true' });
    expect(parseFlags(['-h']).flags).toEqual({ help: 'true' });
    expect(parseFlags(['--help', 'sourcemaps'])).toEqual({
      flags: { help: 'true' },
      positional: ['sourcemaps'],
    });
  });

  it('builds bundle keys', () => {
    expect(bundleKey({ updateId: 'u1' })).toBe('update:u1');
    expect(bundleKey({ appVersion: '1.2.0', build: '42' })).toBe('build:1.2.0+42');
    expect(() => bundleKey({})).toThrow();
  });

  it('reads update ids per platform from eas update --json', () => {
    expect(
      updateIdsFromEasJson([
        { platform: 'ios', id: 'a' },
        { platform: 'android', id: 'b' },
      ]),
    ).toEqual({ ios: 'a', android: 'b' });
  });

  it('posts the gzip map with the bearer token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mobs-'));
    const file = join(dir, 'main.jsbundle.map');
    await writeFile(file, '{"version":3,"sources":[],"mappings":""}');
    const calls: { url: string; init?: RequestInit }[] = [];
    const result = await uploadSourceMap({
      endpoint: 'https://obs.example.com',
      token: 'mobs_sk_x',
      platform: 'ios',
      key: 'build:1.0+1',
      file,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(
          JSON.stringify({ ok: true, platform: 'ios', bundleKey: 'build:1.0+1' }),
          { status: 201 },
        );
      },
    });
    expect(result.bundleKey).toBe('build:1.0+1');
    expect(calls).toHaveLength(1);
    const [call] = calls;
    if (!call) throw new Error('fetch was not called');
    expect(call.url).toBe(
      'https://obs.example.com/api/v1/sourcemaps?platform=ios&bundleKey=build%3A1.0%2B1&fileName=main.jsbundle.map',
    );
    expect(new Headers(call.init?.headers).get('authorization')).toBe('Bearer mobs_sk_x');
  });
});

describe('uploadSourceMap failures', () => {
  const failWith = (response: Response) => stubFetch(() => response.clone()).fetchImpl;

  it('reports a redirect instead of following it as a GET', async () => {
    const fetchImpl = failWith(
      new Response(null, { status: 308, headers: { location: 'https://www.obs.example.com/' } }),
    );
    await expect(
      uploadSourceMap({
        ...upload,
        platform: 'ios',
        key: 'build:1+1',
        file: await mapFile(),
        fetchImpl,
      }),
    ).rejects.toThrow('Upload redirected (308) to https://www.obs.example.com/');
  });

  it('explains a rejected token', async () => {
    const fetchImpl = failWith(Response.json({ error: 'invalid_upload_token' }, { status: 401 }));
    await expect(
      uploadSourceMap({
        ...upload,
        platform: 'ios',
        key: 'build:1+1',
        file: await mapFile(),
        fetchImpl,
      }),
    ).rejects.toThrow(/401: invalid_upload_token\)\. Hint: use the project upload token/);
  });

  it('explains a body size limit and trims an HTML error page', async () => {
    const page = `<html><body>${'Request Entity Too Large '.repeat(40)}</body></html>`;
    const fetchImpl = failWith(new Response(page, { status: 413 }));
    const error = await uploadSourceMap({
      ...upload,
      platform: 'android',
      key: 'build:1+1',
      file: await mapFile(),
      fetchImpl,
    }).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    const { message } = error as Error;
    expect(message).toMatch(/^Upload failed \(413: <html>/);
    expect(message).toContain('Vercel Functions: 4.5 MB');
    expect(message.length).toBeLessThan(450);
  });

  it('keeps the sub-path of an endpoint, like the SDK transport', async () => {
    const { calls, fetchImpl } = stubFetch(accepted);
    await uploadSourceMap({
      ...upload,
      endpoint: 'https://example.com/observability/',
      platform: 'ios',
      key: 'build:1+1',
      file: await mapFile(),
      fetchImpl,
    });
    expect(calls[0]?.pathname).toBe('/observability/api/v1/sourcemaps');
  });

  it('names the host and network error when the server is unreachable', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    }) as typeof fetch;
    await expect(
      uploadSourceMap({
        ...upload,
        platform: 'ios',
        key: 'build:1+1',
        file: await mapFile(),
        fetchImpl,
      }),
    ).rejects.toThrow('Cannot reach https://obs.example.com: ECONNREFUSED');
  });

  it('rejects a 200 that is not an upload result (wrong endpoint)', async () => {
    const fetchImpl = failWith(
      new Response('<!doctype html><title>Login</title>', { status: 200 }),
    );
    await expect(
      uploadSourceMap({
        ...upload,
        platform: 'ios',
        key: 'build:1+1',
        file: await mapFile(),
        fetchImpl,
      }),
    ).rejects.toThrow('Unexpected response from https://obs.example.com (200)');
  });
});

describe('uploadEasUpdate', () => {
  async function easExport(platforms: ('ios' | 'android')[]) {
    const root = await mkdtemp(join(tmpdir(), 'mobs-eas-'));
    const dist = join(root, 'dist');
    for (const platform of platforms) {
      const directory = join(dist, '_expo', 'static', 'js', platform);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `entry-${platform}.hbc.map`), MAP);
      await writeFile(join(directory, `entry-${platform}.hbc`), 'bytecode');
    }
    const easJson = join(root, 'update.json');
    return { dist, easJson };
  }

  it('uploads each platform map under its update id', async () => {
    const { dist, easJson } = await easExport(['ios', 'android']);
    await writeFile(
      easJson,
      JSON.stringify([
        { platform: 'ios', id: 'aaa-111' },
        { platform: 'android', id: 'bbb-222' },
      ]),
    );
    const { calls, fetchImpl } = stubFetch(accepted);
    const results = await uploadEasUpdate({ ...upload, dist, easJson, fetchImpl });
    expect(results.map((result) => `${result.platform} ${result.bundleKey}`)).toEqual([
      'ios update:aaa-111',
      'android update:bbb-222',
    ]);
    expect(calls.map((url) => url.searchParams.get('fileName'))).toEqual([
      'entry-ios.hbc.map',
      'entry-android.hbc.map',
    ]);
  });

  it('fails instead of passing silently when a platform has no maps', async () => {
    const { dist, easJson } = await easExport(['ios']);
    await writeFile(
      easJson,
      JSON.stringify([
        { platform: 'ios', id: 'aaa-111' },
        { platform: 'android', id: 'bbb-222' },
      ]),
    );
    const { calls, fetchImpl } = stubFetch(accepted);
    await expect(uploadEasUpdate({ ...upload, dist, easJson, fetchImpl })).rejects.toThrow(
      /No android source maps in .*_expo\/static\/js\/android/,
    );
    // Nothing is uploaded when the export is incomplete.
    expect(calls).toHaveLength(0);
  });

  it('fails when the update json has no ios or android update', async () => {
    const { dist, easJson } = await easExport(['ios']);
    await writeFile(easJson, JSON.stringify({ platform: 'web', id: 'x' }));
    const { fetchImpl } = stubFetch(accepted);
    await expect(uploadEasUpdate({ ...upload, dist, easJson, fetchImpl })).rejects.toThrow(
      'No ios or android update ids',
    );
  });
});

describe('resolveCredentials', () => {
  async function project(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mobs-env-'));
    for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
    return dir;
  }

  it("reads the app's endpoint and the upload token from the project's .env", async () => {
    const cwd = await project({
      '.env': [
        '# shared with the app',
        'EXPO_PUBLIC_MOBS_ENDPOINT=https://obs.example.com',
        'EXPO_PUBLIC_MOBS_KEY=mobs_pk_public',
        'MOBS_UPLOAD_TOKEN="mobs_sk_secret"',
      ].join('\n'),
    });
    await expect(resolveCredentials({}, {}, cwd)).resolves.toEqual({
      endpoint: 'https://obs.example.com',
      token: 'mobs_sk_secret',
    });
  });

  it('prefers flags, then the environment, then .env.local, then .env', async () => {
    const cwd = await project({
      '.env': 'EXPO_PUBLIC_MOBS_ENDPOINT=https://env.example.com\nMOBS_UPLOAD_TOKEN=from-env-file',
      '.env.local': 'EXPO_PUBLIC_MOBS_ENDPOINT=https://local.example.com',
    });
    await expect(resolveCredentials({}, {}, cwd)).resolves.toEqual({
      endpoint: 'https://local.example.com',
      token: 'from-env-file',
    });
    await expect(
      resolveCredentials(
        {},
        {
          MOBS_UPLOAD_TOKEN: 'from-process',
          EXPO_PUBLIC_MOBS_ENDPOINT: 'https://process.example.com',
        },
        cwd,
      ),
    ).resolves.toEqual({ endpoint: 'https://process.example.com', token: 'from-process' });
    await expect(
      resolveCredentials(
        { endpoint: 'https://flag.example.com', token: 'from-flag' },
        { MOBS_UPLOAD_TOKEN: 'from-process' },
        cwd,
      ),
    ).resolves.toEqual({ endpoint: 'https://flag.example.com', token: 'from-flag' });
  });

  it('never sends a token from the environment or a flag to an endpoint read from a .env file', async () => {
    // A committed (or pull-request) .env must not redirect a CI secret or a shell token.
    const cwd = await project({ '.env': 'EXPO_PUBLIC_MOBS_ENDPOINT=https://attacker.example.com' });
    const refusal = /MOBS_UPLOAD_TOKEN comes from the environment or --token/;
    await expect(resolveCredentials({}, { MOBS_UPLOAD_TOKEN: 'ci-secret' }, cwd)).rejects.toThrow(
      refusal,
    );
    await expect(resolveCredentials({ token: 'flag-secret' }, {}, cwd)).rejects.toThrow(refusal);
    // The same token with an endpoint the operator set is fine.
    await expect(
      resolveCredentials(
        {},
        { MOBS_UPLOAD_TOKEN: 'ci-secret', MOBS_ENDPOINT: 'https://ok.example.com' },
        cwd,
      ),
    ).resolves.toEqual({ endpoint: 'https://ok.example.com', token: 'ci-secret' });
  });

  it('lets MOBS_ENDPOINT override the app endpoint for the CLI only', async () => {
    const cwd = await project({ '.env': 'EXPO_PUBLIC_MOBS_ENDPOINT=https://app.example.com' });
    await expect(
      resolveCredentials({}, { MOBS_ENDPOINT: 'https://cli.example.com' }, cwd),
    ).resolves.toEqual({ endpoint: 'https://cli.example.com', token: undefined });
  });

  it('works without any .env file', async () => {
    const cwd = await project({});
    await expect(resolveCredentials({}, {}, cwd)).resolves.toEqual({
      endpoint: undefined,
      token: undefined,
    });
  });

  it('names the shared app variable when the endpoint is missing', async () => {
    await expect(
      uploadSourceMap({ token: 'mobs_sk_x', platform: 'ios', key: 'build:1+1', file: 'x.map' }),
    ).rejects.toThrow('Missing --endpoint (or EXPO_PUBLIC_MOBS_ENDPOINT)');
  });
});
