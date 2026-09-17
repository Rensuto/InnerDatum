import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import ts from 'typescript';

/**
 * Exact stems used by shipped raster assets.
 *
 * `chr` is deliberately split: accepting bare `chr_` also accepts persistent
 * character ids such as `chr_main`, which are save data rather than pictures.
 */
export const ASSET_STEMS = Object.freeze([
  'chr_player_',
  'chr_npc_',
  'enemy_',
  'favicon_',
  'icon_',
  'innerdatum_',
  'item_',
  'prop_',
  'tile_',
  'ui_',
]);

const IMAGE_EXTENSIONS = new Set(['.png', '.webp', '.jpg', '.jpeg', '.gif', '.svg']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const SEMANTIC_ID_FIELDS = new Set(['id', 'itemId']);

function assetStemOf(value) {
  return ASSET_STEMS.find((stem) => value.startsWith(stem));
}

export function isAssetId(value) {
  const stem = assetStemOf(value);
  if (stem === undefined || value === stem) return false;
  return /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(value);
}

function scriptKindFor(fileName) {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.(?:js|mjs|cjs)$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function propertyNameOf(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function unwrapExpression(node) {
  let cursor = node;
  while (
    ts.isParenthesizedExpression(cursor.parent) ||
    ts.isAsExpression(cursor.parent) ||
    ts.isSatisfiesExpression(cursor.parent) ||
    ts.isNonNullExpression(cursor.parent)
  ) {
    cursor = cursor.parent;
  }
  return cursor;
}

function isSemanticIdInitializer(node) {
  const root = unwrapExpression(node);
  const parent = root.parent;
  return (
    ts.isPropertyAssignment(parent) &&
    parent.initializer === root &&
    SEMANTIC_ID_FIELDS.has(propertyNameOf(parent.name) ?? '')
  );
}

function locationOf(sourceFile, node) {
  const start = node.getStart(sourceFile);
  const pos = sourceFile.getLineAndCharacterOfPosition(start);
  return {
    line: pos.line + 1,
    column: pos.character + 1,
    expression: node.getText(sourceFile),
  };
}

function collectRequestLiterals(node, into) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    if (isAssetId(node.text)) into.add(node.text);
    return;
  }
  ts.forEachChild(node, (child) => collectRequestLiterals(child, into));
}

function leftmostConcatenationText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return leftmostConcatenationText(node.left);
  }
  return undefined;
}

/**
 * Parse one source file and return only syntax-backed asset references.
 * Comments and documentation examples never enter the AST and therefore never
 * become accidental commissions.
 */
export function scanSource(text, fileName = 'source.ts') {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(fileName),
  );
  const runtimeIds = new Set();
  const requestedIds = new Set();
  const unresolvedDynamic = [];
  const dynamicStarts = new Set();

  const recordDynamic = (node) => {
    const start = node.getStart(sourceFile);
    if (dynamicStarts.has(start)) return;
    dynamicStarts.add(start);
    unresolvedDynamic.push(locationOf(sourceFile, node));
  };

  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text.endsWith('ART_REQUESTS') &&
      node.initializer !== undefined
    ) {
      collectRequestLiterals(node.initializer, requestedIds);
      return;
    }

    if (ts.isTemplateExpression(node)) {
      if (assetStemOf(node.head.text) !== undefined) recordDynamic(node);
      ts.forEachChild(node, visit);
      return;
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      !(
        ts.isBinaryExpression(node.parent) &&
        node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken
      )
    ) {
      const head = leftmostConcatenationText(node);
      if (head !== undefined && assetStemOf(head) !== undefined && !isAssetId(head)) {
        recordDynamic(node);
      }
    }

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (isAssetId(node.text) && !isSemanticIdInitializer(node)) runtimeIds.add(node.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  unresolvedDynamic.sort((a, b) => a.line - b.line || a.column - b.column);
  return {
    runtimeIds: [...runtimeIds].sort(),
    requestedIds: [...requestedIds].sort(),
    unresolvedDynamic,
  };
}

export function walkSourceFiles(repo, sourceDirs = ['src', 'content']) {
  const files = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else if (SOURCE_EXTENSIONS.has(extname(entry).toLowerCase())) files.push(full);
    }
  };
  for (const dir of sourceDirs) walk(join(repo, dir));
  return files.sort();
}

function addLocation(map, id, where) {
  const locations = map.get(id) ?? new Set();
  locations.add(where);
  map.set(id, locations);
}

export function scanRepository(repo, sourceDirs = ['src', 'content']) {
  const runtime = new Map();
  const requests = new Map();
  const unresolvedDynamic = [];

  for (const file of walkSourceFiles(repo, sourceDirs)) {
    const where = relative(repo, file).replace(/\\/g, '/');
    const result = scanSource(readFileSync(file, 'utf8'), where);
    for (const id of result.runtimeIds) addLocation(runtime, id, where);
    for (const id of result.requestedIds) addLocation(requests, id, where);
    for (const item of result.unresolvedDynamic) unresolvedDynamic.push({ file: where, ...item });
  }

  unresolvedDynamic.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
  );
  return { runtime, requests, unresolvedDynamic };
}

export function collectAssetFiles(assetsDir) {
  const present = new Map();
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const info = statSync(full);
      if (info.isDirectory()) {
        walk(full);
      } else if (IMAGE_EXTENSIONS.has(extname(entry).toLowerCase())) {
        const id = basename(entry, extname(entry));
        const paths = present.get(id) ?? [];
        paths.push(relative(assetsDir, full).replace(/\\/g, '/'));
        present.set(id, paths);
      }
    }
  };
  walk(assetsDir);
  for (const paths of present.values()) paths.sort();
  return present;
}

export function reconcileInventory({ runtime, requests, present, standIns, upscaled }) {
  const runtimeIds = [...runtime.keys()].sort();
  const requestIds = [...requests.keys()].sort();
  const demanded = new Set([...runtimeIds, ...requestIds]);
  const missing = [...demanded].filter((id) => !present.has(id)).sort();
  const runtimeMissing = runtimeIds.filter((id) => !present.has(id));
  const requestMissing = requestIds.filter((id) => !present.has(id));
  const requestPresent = requestIds.filter((id) => present.has(id));
  const placeholder = runtimeIds.filter((id) => present.has(id) && standIns.has(id));
  const forTheOldCell = runtimeIds.filter((id) => present.has(id) && upscaled.has(id));
  const unused = [...present.keys()].filter((id) => !demanded.has(id)).sort();
  const duplicates = [...present.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([id, paths]) => ({ id, paths }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    runtimeIds,
    requestIds,
    missing,
    runtimeMissing,
    requestMissing,
    requestPresent,
    placeholder,
    forTheOldCell,
    unused,
    duplicates,
  };
}

/**
 * The client's load filter, read from syntax: the string literals of the
 * `NEEDED_ASSET_PREFIXES` array in `src/client/main.ts`.
 *
 * A THIRD PLACE AN ID CAN FAIL, AND THE INVENTORY ABOVE CANNOT SEE IT. Source
 * names an id and the file is on disk, so `reconcileInventory` calls it
 * present; but `main.ts` filters the manifest by these prefixes before loading,
 * and an id no prefix admits is never fetched. It draws as its fallback on
 * every machine with the art installed. That once hid the passive and sustain
 * talent icons, and then every town furnishing, while this report said nothing
 * was missing.
 *
 * Returns null when the declaration is gone, so a rename reads as a blind check
 * rather than as a filter that admits nothing.
 */
export function loadFilterPrefixes(text, fileName = 'main.ts') {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  let prefixes = null;
  const visit = (node) => {
    if (prefixes !== null) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'NEEDED_ASSET_PREFIXES' &&
      node.initializer !== undefined
    ) {
      let value = node.initializer;
      while (
        ts.isAsExpression(value) ||
        ts.isSatisfiesExpression(value) ||
        ts.isParenthesizedExpression(value)
      ) {
        value = value.expression;
      }
      if (ts.isArrayLiteralExpression(value)) {
        prefixes = value.elements
          .filter((element) => ts.isStringLiteralLike(element))
          .map((element) => element.text);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return prefixes;
}

/** Ids source draws that no load-filter prefix admits, present on disk or not. */
export function unloadedIds(runtime, prefixes) {
  return [...runtime.keys()]
    .filter((id) => !prefixes.some((prefix) => id.startsWith(prefix)))
    .sort();
}
