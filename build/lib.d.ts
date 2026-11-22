export type Platform = 'ios' | 'android';
export type Flags = Record<string, string>;
export interface FlagParse {
    flags: Flags;
    positional: string[];
}
/** Parses `--flag value` and `--flag=value` pairs. */
export declare function parseFlags(argv: string[]): FlagParse;
/** `update:<id>` for an EAS Update bundle, `build:<version>+<build>` for the embedded one. */
export declare function bundleKey(options: {
    updateId?: string;
    appVersion?: string;
    build?: string;
}): string;
export interface EasUpdate {
    platform?: string;
    id?: string;
}
/** Maps `eas update --json` output to { ios: id, android: id }. */
export declare function updateIdsFromEasJson(json: unknown): Partial<Record<Platform, string>>;
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
export declare function uploadSourceMap(options: UploadOptions): Promise<UploadResult>;
