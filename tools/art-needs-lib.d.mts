export type ArtLocation = {
  readonly line: number;
  readonly column: number;
  readonly expression: string;
};

export type RepositoryArtLocation = ArtLocation & { readonly file: string };
export type ReferenceMap = Map<string, Set<string>>;
export type AssetFileMap = Map<string, string[]>;

export const ASSET_STEMS: readonly string[];

export function isAssetId(value: string): boolean;

export function scanSource(
  text: string,
  fileName?: string,
): {
  runtimeIds: string[];
  requestedIds: string[];
  unresolvedDynamic: ArtLocation[];
};

export function walkSourceFiles(repo: string, sourceDirs?: readonly string[]): string[];

export function scanRepository(
  repo: string,
  sourceDirs?: readonly string[],
): {
  runtime: ReferenceMap;
  requests: ReferenceMap;
  unresolvedDynamic: RepositoryArtLocation[];
};

export function collectAssetFiles(assetsDir: string): AssetFileMap;

export function reconcileInventory(input: {
  runtime: ReferenceMap;
  requests: ReferenceMap;
  present: AssetFileMap;
  standIns: ReadonlySet<string>;
  upscaled: ReadonlySet<string>;
}): {
  runtimeIds: string[];
  requestIds: string[];
  missing: string[];
  runtimeMissing: string[];
  requestMissing: string[];
  requestPresent: string[];
  placeholder: string[];
  forTheOldCell: string[];
  unused: string[];
  duplicates: { id: string; paths: string[] }[];
};

export function loadFilterPrefixes(text: string, fileName?: string): string[] | null;

export function unloadedIds(runtime: ReferenceMap, prefixes: readonly string[]): string[];
