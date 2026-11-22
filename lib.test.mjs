import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundleKey, parseFlags, updateIdsFromEasJson, uploadSourceMap } from './lib.mjs';

describe('mobs CLI helpers', () => {
  it('parses flags in both forms', () => {
    expect(parseFlags(['--platform', 'ios', '--file=a.map', '--dry']).flags).toEqual({
      platform: 'ios',
      file: 'a.map',
      dry: 'true',
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
    const calls = [];
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
    expect(calls[0].url).toBe(
      'https://obs.example.com/api/v1/sourcemaps?platform=ios&bundleKey=build%3A1.0%2B1&fileName=main.jsbundle.map',
    );
    expect(calls[0].init.headers.authorization).toBe('Bearer mobs_sk_x');
  });
});
