# mobs

`mobs` is the source-map uploader for [mobile-observability](https://github.com/emmadal/mobile-observability): it sends the source maps of your Expo or React Native app to your self-hosted dashboard so stack traces are symbolicated back to the original `file:line` in your code.

Works with **Expo** (managed workflow, EAS Update) and **bare React Native** (Metro bundles), on iOS and Android, with Hermes and JSC maps.

## Install

The CLI is a single zero-dependency Node package (Node ≥ 22) with the compiled build committed, so it installs straight from GitHub without a build step.

```sh
# install globally
npm install -g --install-links github:emmadal/mobs

# or run without installing
npx --yes --package github:emmadal/mobs mobs sourcemaps upload --help
```

Inside a project (so CI can use it):

```sh
npm install --save-dev --install-links github:emmadal/mobs
```

> `--install-links` tells npm to copy the git checkout instead of symlinking it; without it npm points `node_modules` at a temporary clone that it then deletes. `npx` and `bun` do not need the flag.

Credentials are the same for every command:

| Flag         | Environment variable | What it is                                                                           |
| ------------ | -------------------- | ------------------------------------------------------------------------------------ |
| `--endpoint` | `MOBS_ENDPOINT`      | Your dashboard URL, e.g. `https://observability.example.com`                         |
| `--token`    | `MOBS_UPLOAD_TOKEN`  | The project's **upload token** (Settings → Keys — secret, not the public ingest key) |

## Expo (managed workflow)

### EAS Update (OTA)

After publishing an update, its source maps live in the export directory:

```sh
eas update --json > update.json
mobs sourcemaps upload-eas --dist dist --eas-json update.json
```

`upload-eas` reads `update.json`, finds every runtime/platform map under `dist/_expo/static/js/**`, and uploads one map per `(runtimeVersion, platform)` with the matching `update:<id>` bundle key — exactly the key the SDK reports when an error happens inside that update.

To automate it, add a script to `package.json`:

```json
{
  "scripts": {
    "observability:update": "eas update --json > update.json && mobs sourcemaps upload-eas --dist dist --eas-json update.json"
  }
}
```

and the credentials in `eas.json` (recommended: keep the token in EAS environment variables rather than the file):

```json
{
  "cli": { "version": ">= 13.0.0" },
  "build": {
    "production": {
      "env": {
        "MOBS_ENDPOINT": "https://observability.example.com",
        "MOBS_UPLOAD_TOKEN": "mobs_sk_…"
      }
    }
  }
}
```

```sh
eas env:create --name MOBS_UPLOAD_TOKEN --value mobs_sk_…   # then reference it
```

### Local export

```sh
npx expo export --source-maps
mobs sourcemaps upload --platform ios --file dist/_expo/static/js/ios/*.map \
  --app-version 1.4.2 --build 42
```

## Bare React Native

Bundle with Metro yourself (or take the map from a native build) and upload with the app version and build number that will crash:

```sh
npx react-native bundle \
  --platform android --dev false \
  --entry-file index.js \
  --bundle-output index.android.bundle \
  --sourcemap-output index.android.map

mobs sourcemaps upload --platform android --file index.android.map \
  --app-version 1.4.2 --build 42
```

iOS: use the `main.jsbundle`'s map produced by the Xcode build script phase, then `--platform ios --file ios/main.map`.

## Compatibility

|             | Expo (managed)                             | Bare React Native                             |
| ----------- | ------------------------------------------ | --------------------------------------------- |
| SDK runtime | ≥ SDK 56 (expo/fetch and XHR both tracked) | RN ≥ 0.83                                     |
| Engine      | Hermes (and JSC)                           | Hermes (and JSC)                              |
| Source maps | EAS Update (`upload-eas`), `expo export`   | Metro `--sourcemap-output`, Xcode build phase |
| Bundle keys | `update:<updateId>`                        | `build:<appVersion>+<build>`                  |

The dashboard symbolicates errors at ingest by matching the SDK-reported bundle key (`update:…` for EAS Updates, `build:…` for store/native builds) against the uploaded maps — the same map format works for both workflows.

## Commands

```
mobs sourcemaps upload --platform ios|android --file <path.map>
     (--update-id <id> | --app-version <version> --build <build>)

mobs sourcemaps upload-eas --dist dist --eas-json update.json
```

## License

[MIT](./LICENSE)
