#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  bundleKey,
  type Platform,
  parseFlags,
  updateIdsFromEasJson,
  uploadSourceMap,
} from './lib.js';

const HELP = `mobs: mobile-observability CLI

Upload one source map:
  mobs sourcemaps upload --platform ios|android --file <path.map>
       (--update-id <id> | --app-version <version> --build <build>)

Upload the maps of an EAS Update (after \`eas update --json > update.json\`):
  mobs sourcemaps upload-eas --dist dist --eas-json update.json

Common flags (or environment variables):
  --endpoint  MOBS_ENDPOINT      Dashboard URL, e.g. https://observability.example.com
  --token     MOBS_UPLOAD_TOKEN  Project upload token (Settings > project card)
`;

async function findMaps(dist: string, platform: Platform): Promise<string[]> {
  const directory = join(dist, '_expo', 'static', 'js', platform);
  const files = await readdir(directory).catch(() => [] as string[]);
  return files.filter((file) => file.endsWith('.map')).map((file) => join(directory, file));
}

async function main(): Promise<void> {
  const { flags, positional } = parseFlags(process.argv.slice(2));
  const [group, command] = positional;
  if (group !== 'sourcemaps' || !command || flags.help) {
    console.log(HELP);
    // Help was requested or nothing was asked: not an error.
    process.exit(flags.help || !group ? 0 : 1);
  }
  const endpoint = flags.endpoint ?? process.env.MOBS_ENDPOINT;
  const token = flags.token ?? process.env.MOBS_UPLOAD_TOKEN;
  const requireFlag = (name: string): string => {
    const value = flags[name];
    if (!value) {
      console.error(`mobs: missing --${name}`);
      process.exit(1);
    }
    return value;
  };

  if (command === 'upload') {
    const file = requireFlag('file');
    const result = await uploadSourceMap({
      endpoint,
      token,
      platform: flags.platform,
      key: bundleKey({
        updateId: flags['update-id'],
        appVersion: flags['app-version'],
        build: flags.build,
      }),
      file,
    });
    console.log(`Uploaded ${file} as ${result.platform} ${result.bundleKey}`);
    return;
  }

  if (command === 'upload-eas') {
    const parsed: unknown = JSON.parse(await readFile(requireFlag('eas-json'), 'utf8'));
    const ids = updateIdsFromEasJson(parsed);
    for (const platform of ['ios', 'android'] as Platform[]) {
      const updateId = ids[platform];
      if (!updateId) continue;
      for (const file of await findMaps(flags.dist ?? 'dist', platform)) {
        const result = await uploadSourceMap({
          endpoint,
          token,
          platform,
          key: bundleKey({ updateId }),
          file,
        });
        console.log(`Uploaded ${file} as ${result.platform} ${result.bundleKey}`);
      }
    }
    return;
  }

  console.log(HELP);
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error(`mobs: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
