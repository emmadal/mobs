# mobs

`mobs` is the source-map uploader for [mobile-observability](https://github.com/emmadal/mobile-observability): it sends the source maps of your Expo or React Native app to your self-hosted dashboard so stack traces are symbolicated back to the original `file:line` in your code.

Works with **Expo** (managed workflow, EAS Update) and **bare React Native** (Metro bundles), on iOS and Android, with Hermes and JSC maps.

## Install

A single zero-dependency Node package (Node ≥ 22) with no install scripts, written in strict TypeScript and compiled to ESM. The package is `@mobile-observability/cli`; the command it installs is `mobs`.

```sh
# inside your app, so CI can use it
npm install --save-dev @mobile-observability/cli   # or: pnpm add -D, yarn add -D, bun add -d

# or run it once without installing
npx --yes @mobile-observability/cli --help

# or install globally
npm install -g @mobile-observability/cli
```

`mobs --version` prints the installed version.

To try unreleased changes, install from GitHub. The committed `build/` is `tsc` output, so no build step runs:

```sh
npm install --save-dev --install-links github:emmadal/mobs
```

> `--install-links` tells npm to copy the git checkout instead of symlinking it; without it npm points `node_modules` at a temporary clone that it then deletes. `npx` and `bun` do not need the flag.

Credentials are the same for every command, and the endpoint is the variable your app already uses:

| Flag         | Variable                    | What it is                                                                                                                |
| ------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `--endpoint` | `EXPO_PUBLIC_MOBS_ENDPOINT` | Your dashboard URL, e.g. `https://observability.example.com`                                                              |
| `--token`    | `MOBS_UPLOAD_TOKEN`         | The project's **upload token**, shown once as a `MOBS_UPLOAD_TOKEN=` line in Settings (secret, not the public ingest key) |

`mobs` looks for each value in this order: the flag, the process environment, then `.env.local` and `.env` in the current directory (the files Expo loads). So an app set up like this needs no flags:

```sh
# .env
EXPO_PUBLIC_MOBS_ENDPOINT=https://observability.example.com
EXPO_PUBLIC_MOBS_KEY=mobs_pk_...   # read by the app, not by mobs

# .env.local (git-ignored)
MOBS_UPLOAD_TOKEN=mobs_sk_...
```

Never prefix the upload token with `EXPO_PUBLIC_`: Expo would inline it into the app bundle. `MOBS_ENDPOINT` is still read and overrides `EXPO_PUBLIC_MOBS_ENDPOINT`, for the rare case where uploads go through a different URL than the app.

## Expo (managed workflow)

### EAS Update (OTA)

After publishing an update, its source maps live in the export directory:

```sh
eas update --json > update.json
mobs sourcemaps upload-eas --dist dist --eas-json update.json
```

`upload-eas` reads `update.json`, finds the `.map` files under `dist/_expo/static/js/<platform>/`, and uploads each with the `update:<id>` bundle key for its platform — exactly the key the SDK reports when an error happens inside that update. A standard export contains one map per platform; if several exist, the server keeps the latest upload for that platform and update.

To automate it, add a script to `package.json`:

```json
{
  "scripts": {
    "observability:update": "eas update --json > update.json && mobs sourcemaps upload-eas --dist dist --eas-json update.json"
  }
}
```

Keep the token out of `eas.json`: `build.env` is not a secret store, and a token placed there can leak with the build environment. In CI, the endpoint comes from the app's committed `.env`; only the token needs a secret, for example in GitHub Actions:

```yaml
- run: eas update --json > update.json
- run: npx --yes @mobile-observability/cli sourcemaps upload-eas --dist dist --eas-json update.json
  env:
    MOBS_UPLOAD_TOKEN: ${{ secrets.MOBS_UPLOAD_TOKEN }}
```

`eas.json` stays useful for build profiles. If an EAS build hook invokes the CLI, add `MOBS_UPLOAD_TOKEN` as a **sensitive** or **secret** EAS environment variable next to the app's `EXPO_PUBLIC_MOBS_*` ones: EAS Build exposes them all to the hook, so `mobs` finds both values — never inline the token in `env`.

### Local export

```sh
npx expo export --source-maps
mobs sourcemaps upload --platform ios --file path/to/ios.map \
  --app-version 1.4.2 --build 42
```

`expo export` writes the maps under `dist/_expo/static/js/<platform>/`; pass the file for the platform you are uploading to `--file`.

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

iOS: upload the map your build produces. If your Xcode bundle phase sets `SOURCEMAP_FILE`, point `--file` at it; otherwise bundle with Metro as above.

## CI and Vercel

`mobs` runs wherever Node ≥ 22 runs: GitHub Actions, EAS build hooks, a Vercel build. It needs no install scripts, so package managers that block them by default (pnpm, recent npm) install it unchanged.

Every failure exits with code 1 and a one-line reason, so a CI step never passes with maps missing: an invalid token, a size limit, a redirect, an unreachable server, or an `upload-eas` run that finds no maps for a platform of the update.

### In a Vercel build

1. Add the CLI as a dev dependency (see [Install](#install)); Vercel installs devDependencies for the build.
2. In **Project Settings → Environment Variables**, add `MOBS_UPLOAD_TOKEN` and mark it **Sensitive**. Add `EXPO_PUBLIC_MOBS_ENDPOINT` too unless the app's committed `.env` already sets it.
3. Call it after the build step that writes `dist/` and `update.json`, for example as a `postbuild` script:

   ```json
   {
     "scripts": {
       "postbuild": "mobs sourcemaps upload-eas --dist dist --eas-json update.json"
     }
   }
   ```

Vercel's Node.js 22.x and newer images all satisfy the CLI's `engines` range.

### A dashboard hosted on Vercel

- **Size**: Vercel Functions accept request bodies up to 4.5 MB. `mobs` gzips each map, so most maps fit, but a larger one gets `413 FUNCTION_PAYLOAD_TOO_LARGE`, which `mobs` reports with a hint. Self-hosted (Docker) dashboards accept 50 MB.
- **Endpoint**: use the public production domain. Protected preview deployments answer with a redirect or a 401; `mobs` stops and reports it instead of resending the upload as a `GET`. A dashboard under a sub-path (`https://example.com/observability`) works: `--endpoint` keeps the path.

## Compatibility

|             | Expo (managed)                             | Bare React Native                                         |
| ----------- | ------------------------------------------ | --------------------------------------------------------- |
| SDK runtime | ≥ SDK 56 (expo/fetch and XHR both tracked) | RN ≥ 0.83                                                 |
| Engine      | Hermes (and JSC)                           | Hermes (and JSC)                                          |
| Source maps | EAS Update (`upload-eas`), `expo export`   | Metro `--sourcemap-output` (or `SOURCEMAP_FILE` in Xcode) |
| Bundle keys | `update:<updateId>`                        | `build:<appVersion>+<build>`                              |

The compatibility range reflects the SDK's peer dependencies; the in-repo example runs Expo 58 / React Native 0.88. The dashboard symbolicates errors at ingest by matching the SDK-reported bundle key (`update:…` for EAS Updates, `build:…` for store/native builds) against the uploaded maps — the same map format works for both workflows.

## Commands

```
mobs sourcemaps upload --platform ios|android --file <path.map>
     (--update-id <id> | --app-version <version> --build <build>)

mobs sourcemaps upload-eas --dist dist --eas-json update.json

mobs --help | --version
```

## License

[MIT](./LICENSE)
