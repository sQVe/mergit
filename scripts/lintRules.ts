import { existsSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ESTree, Plugin } from '@oxlint/plugins';

interface ModuleLocation {
  module: string;
  entry: boolean;
  directory: boolean;
}

type ImportSource =
  | ESTree.ImportDeclaration
  | ESTree.ExportNamedDeclaration
  | ESTree.ExportAllDeclaration;

const folderModules = new Set(['github', 'work', 'session', 'ui', 'localState', 'config']);

const flatModules = new Set(['actions', 'commands', 'invariant', 'query', 'index', 'terminal']);

const allowedImports = new Map<string, Set<string>>([
  ['work', new Set(['invariant'])],
  ['config', new Set(['commands', 'invariant'])],
  ['invariant', new Set()],
  ['query', new Set(['work', 'invariant'])],
  ['github', new Set(['work', 'invariant'])],
  ['localState', new Set(['work', 'invariant'])],
  ['actions', new Set(['work', 'config', 'invariant'])],
  ['session', new Set(['work', 'query', 'invariant'])],
  ['commands', new Set(['work', 'session', 'invariant'])],
  ['ui', new Set(['work', 'session', 'commands', 'invariant'])],
  ['terminal', new Set(['ui', 'session', 'commands', 'config', 'invariant'])],
  ['index', new Set([...folderModules, ...flatModules])],
]);

const typeOnlyImports = new Map([['session', new Set(['github', 'actions', 'localState'])]]);
const runtimeModules = new Set(['work', 'invariant', 'query', 'session', 'commands', 'ui']);
const rendererFreeModules = new Set(['work', 'invariant', 'query', 'session', 'commands']);
const packageRoots = new Map<string, string | undefined>();

// The nearest package.json marks the root, so a `src` segment above it never counts.
const packageRootOf = (directory: string): string | undefined => {
  if (packageRoots.has(directory)) {
    return packageRoots.get(directory);
  }

  const parent = dirname(directory);
  let root: string | undefined = directory;

  if (!existsSync(join(directory, 'package.json'))) {
    root = parent === directory ? undefined : packageRootOf(parent);
  }

  packageRoots.set(directory, root);

  return root;
};

const escapesDirectory = (path: string): boolean =>
  path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);

const locate = (path: string): ModuleLocation | undefined => {
  const segments = path.replace(/\.[jt]sx?$/, '').split(sep);
  const [first = '', second] = segments;
  const flatModule = first.replace(/\.test$/, '');

  if (segments.length === 1 && flatModules.has(flatModule)) {
    return { module: flatModule, entry: first === flatModule, directory: false };
  }

  if (!folderModules.has(first)) {
    return undefined;
  }

  const entry = segments.length === 2 && second === first;

  return { module: first, entry, directory: segments.length === 1 };
};

const filePathOf = (url: string): string | undefined => {
  try {
    return fileURLToPath(url);
  } catch {
    return undefined;
  }
};

// Returns `undefined` for a package name and `null` for a file URL that names no local path.
const localPathOf = (specifier: string, directory: string): string | null | undefined => {
  if (/^file:/i.test(specifier)) {
    return filePathOf(specifier) ?? null;
  }

  if (!specifier.startsWith('.') && !isAbsolute(specifier)) {
    return undefined;
  }

  return resolve(directory, specifier);
};

const isRuntimeBuiltin = (specifier: string): boolean => {
  const bunBuiltin = specifier === 'bun' || specifier.startsWith('bun:');

  return bunBuiltin || specifier.startsWith('node:') || isBuiltin(specifier);
};

const isRendererPackage = (specifier: string): boolean =>
  specifier === 'react' || specifier.startsWith('react/') || specifier.startsWith('@opentui/');

const packageBoundary = (
  importer: string,
  specifier: string,
  testFile: boolean,
): string | undefined => {
  const testRunner = testFile && specifier === 'bun:test';

  if (runtimeModules.has(importer) && !testRunner && isRuntimeBuiltin(specifier)) {
    return 'builtin';
  }

  return rendererFreeModules.has(importer) && isRendererPackage(specifier) ? 'renderer' : undefined;
};

const moduleBoundary = (
  importer: string,
  target: ModuleLocation,
  typeOnly: boolean,
): string | undefined => {
  if (target.directory) {
    return 'directory';
  }

  if (target.module === importer) {
    return undefined;
  }

  if (!target.entry) {
    return 'private';
  }

  if (allowedImports.get(importer)?.has(target.module) === true) {
    return undefined;
  }

  if (typeOnlyImports.get(importer)?.has(target.module) !== true) {
    return 'module';
  }

  return typeOnly ? undefined : 'typeOnly';
};

const isTypeOnly = (node: ImportSource): boolean => {
  if (node.type === 'ExportAllDeclaration') {
    return node.exportKind === 'type';
  }

  if (node.type === 'ExportNamedDeclaration') {
    const typeSpecifiers =
      node.specifiers.length > 0 &&
      node.specifiers.every((specifier) => specifier.exportKind === 'type');

    return node.exportKind === 'type' || typeSpecifiers;
  }

  const typeSpecifiers =
    node.specifiers.length > 0 &&
    node.specifiers.every(
      (specifier) => specifier.type === 'ImportSpecifier' && specifier.importKind === 'type',
    );

  return node.importKind === 'type' || typeSpecifiers;
};

const literalSourceOf = (source: ESTree.Expression): string | undefined => {
  if (source.type === 'Literal' && typeof source.value === 'string') {
    return source.value;
  }

  if (source.type !== 'TemplateLiteral' || source.expressions.length > 0) {
    return undefined;
  }

  return source.quasis[0]?.value.cooked ?? undefined;
};

const lintRules: Plugin = {
  meta: { name: 'mergit' },
  rules: {
    'module-boundaries': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          unknownFile: 'File "{{file}}" is not in a known module. Move it into one.',
          unknownTarget:
            'Module "{{importer}}" imports "{{target}}", which is not in a known module.',
          escape: 'Module "{{importer}}" imports "{{target}}", which is outside src/.',
          directory:
            'Module "{{importer}}" imports the directory "{{target}}". Import its entry file.',
          private:
            'Module "{{importer}}" imports "{{target}}", a private file of another module. Import its entry file.',
          module:
            'Module "{{importer}}" may not import "{{target}}": the module table refuses that edge.',
          typeOnly:
            'Module "{{importer}}" may import only types from "{{target}}". Use `import type`.',
          builtin: 'Module "{{importer}}" must not import the runtime built-in "{{target}}".',
          renderer: 'Module "{{importer}}" must not import the renderer package "{{target}}".',
          dynamic:
            'Module "{{importer}}" has a computed dynamic import. Use a string literal so its boundary can be checked.',
        },
      },
      create(context) {
        const filename = context.physicalFilename;
        const root = packageRootOf(dirname(filename));
        const sourceDirectory = root === undefined ? undefined : join(root, 'src');

        if (sourceDirectory === undefined) {
          return {};
        }

        const path = relative(sourceDirectory, filename);

        if (escapesDirectory(path)) {
          return {};
        }

        // A file named after a folder module, such as `src/session.ts`, sits outside that folder.
        const location = locate(path);
        const importer = location?.directory === false ? location.module : undefined;

        if (importer === undefined) {
          return {
            Program(node) {
              context.report({ node, messageId: 'unknownFile', data: { file: path } });
            },
          };
        }

        const testFile = /\.test\.tsx?$/.test(filename);

        const boundaryOf = (specifier: string, typeOnly: boolean): string | undefined => {
          const localPath = localPathOf(specifier, dirname(filename));

          if (localPath === undefined) {
            return packageBoundary(importer, specifier, testFile);
          }

          if (localPath === null) {
            return 'unknownTarget';
          }

          const targetPath = relative(sourceDirectory, localPath);

          if (escapesDirectory(targetPath)) {
            return 'escape';
          }

          const target = locate(targetPath);

          return target === undefined
            ? 'unknownTarget'
            : moduleBoundary(importer, target, typeOnly);
        };

        const check = (source: ESTree.StringLiteral, typeOnly: boolean) => {
          const messageId = boundaryOf(source.value, typeOnly);

          if (messageId !== undefined) {
            context.report({ node: source, messageId, data: { importer, target: source.value } });
          }
        };

        const checkSource = (node: ImportSource) => {
          if (node.source !== null) {
            check(node.source, isTypeOnly(node));
          }
        };

        return {
          ImportDeclaration: checkSource,
          ExportNamedDeclaration: checkSource,
          ExportAllDeclaration: checkSource,
          TSImportType(node) {
            check(node.source, true);
          },
          ImportExpression(node) {
            const specifier = literalSourceOf(node.source);

            if (specifier === undefined) {
              context.report({ node, messageId: 'dynamic', data: { importer } });

              return;
            }

            const messageId = boundaryOf(specifier, false);

            if (messageId !== undefined) {
              context.report({ node, messageId, data: { importer, target: specifier } });
            }
          },
        };
      },
    },
  },
};

export default lintRules;
