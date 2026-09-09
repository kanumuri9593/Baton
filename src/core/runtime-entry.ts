import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve a package entry that may be compiled JavaScript or TypeScript source.
 *
 * Global npm installs ship `dist/*.js`. A git checkout used for development may
 * only have `src/*.ts`. Prefer `.js` whenever it exists so auto-start never
 * tries to spawn `main.ts` from a published tarball.
 *
 * @param directory Directory that contains `{stem}.js` and/or `{stem}.ts`.
 * @param stem File name without extension, for example `main` or `index`.
 * @returns An absolute path. If neither file exists, the compiled `.js` path is
 *   returned so the spawn error names the production artifact.
 */
export function resolveRuntimeEntry(directory: string, stem: string): string {
  const compiled = join(directory, `${stem}.js`);
  if (existsSync(compiled)) return compiled;
  const source = join(directory, `${stem}.ts`);
  if (existsSync(source)) return source;
  return compiled;
}
