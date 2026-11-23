#!/usr/bin/env node
import { createRequire } from 'node:module';
import { bundleKey, parseFlags, uploadEasUpdate, uploadSourceMap, } from './lib.js';
const { version } = createRequire(import.meta.url)('../package.json');
const HELP = `mobs ${version}: mobile-observability CLI

Upload one source map:
  mobs sourcemaps upload --platform ios|android --file <path.map>
       (--update-id <id> | --app-version <version> --build <build>)

Upload the maps of an EAS Update (after \`eas update --json > update.json\`):
  mobs sourcemaps upload-eas --dist dist --eas-json update.json

Common flags (or environment variables):
  --endpoint  MOBS_ENDPOINT      Dashboard URL, e.g. https://observability.example.com
  --token     MOBS_UPLOAD_TOKEN  Project upload token (Settings > project card)

  -h, --help     Show this help
  -v, --version  Print the version
`;
function fail(message) {
    console.error(`mobs: ${message}`);
    process.exit(1);
}
function printUploaded(file, result) {
    const size = typeof result.sizeBytes === 'number' ? ` (${result.sizeBytes} bytes)` : '';
    console.log(`Uploaded ${file} as ${result.platform} ${result.bundleKey}${size}`);
}
async function main() {
    const { flags, positional } = parseFlags(process.argv.slice(2));
    if (flags.version) {
        console.log(version);
        return;
    }
    const [group, command] = positional;
    if (flags.help || !group) {
        console.log(HELP);
        return;
    }
    const endpoint = flags.endpoint ?? process.env.MOBS_ENDPOINT;
    const token = flags.token ?? process.env.MOBS_UPLOAD_TOKEN;
    const requireFlag = (name) => flags[name] ?? fail(`missing --${name}`);
    if (group === 'sourcemaps' && command === 'upload') {
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
        printUploaded(file, result);
        return;
    }
    if (group === 'sourcemaps' && command === 'upload-eas') {
        await uploadEasUpdate({
            endpoint,
            token,
            dist: flags.dist ?? 'dist',
            easJson: requireFlag('eas-json'),
            onUploaded: printUploaded,
        });
        return;
    }
    console.error(HELP);
    fail(`unknown command: ${positional.join(' ')}`);
}
main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
});
