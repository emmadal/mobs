#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bundleKey, parseFlags, updateIdsFromEasJson, uploadSourceMap } from './lib.mjs';

const HELP = `mobs: mobile-observability CLI

Upload one source map:
  mobs sourcemaps upload --platform ios|android --file <path.map>
       (--update-id <id> | --app-version <version> --build <build>)

Upload the maps of an EAS Update (after \`eas update --json > update.json\`):
  mobs sourcemaps upload-eas --dist dist --eas-json update.json

Common flags (or environment variables):
  --endpoint  MOBS_ENDPOINT      Dashboard URL, e.g. https://observability.example.com
  --token     MOBS_UPLOAD_TOKEN  Project upload token (Settings > Keys)
`;

async function findMaps(dist, platform) {
  const directory = join(dist, '_expo', 'static', 'js', platform);
  const files = await readdir(directory).catch(() => []);
  return files.filter((file) => file.endsWith('.map')).map((file) => join(directory, file));
}

async function main() {
  const [group, command, ...rest] = process.argv.slice(2);
  const { flags } = parseFlags(rest);
  if (group !== 'sourcemaps' || !command || flags.help) {
    console.log(HELP);
    process.exit(group ? 1 : 0);
  }
  const endpoint = flags.endpoint ?? process.env.MOBS_ENDPOINT;
  const token = flags.token ?? process.env.MOBS_UPLOAD_TOKEN;

  if (command === 'upload') {
    const key = bundleKey({
      updateId: flags['update-id'],
      appVersion: flags['app-version'],
      build: flags.build,
    });
    const result = await uploadSourceMap({
      endpoint,
      token,
      platform: flags.platform,
      key,
      file: flags.file,
    });
    console.log(`Uploaded ${flags.file} as ${result.platform} ${result.bundleKey}`);
    return;
  }

  if (command === 'upload-eas') {
    const ids = updateIdsFromEasJson(JSON.parse(await readFile(flags['eas-json'], 'utf8')));
    for (const platform of ['ios', 'android']) {
      if (!ids[platform]) continue;
      for (const file of await findMaps(flags.dist ?? 'dist', platform)) {
        const result = await uploadSourceMap({
          endpoint,
          token,
          platform,
          key: bundleKey({ updateId: ids[platform] }),
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

main().catch((error) => {
  console.error(`mobs: ${error.message}`);
  process.exit(1);
});
