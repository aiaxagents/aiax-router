import { fileURLToPath } from 'node:url';

/**
 * Where the files that ship with the router live: `routing-table.json`,
 * `skills-index.json`, `dist-web/`, `agents/`, `plugins/`.
 *
 * From a normal install that is the package directory, two levels above the
 * compiled `dist/<area>/` file. The desktop app runs the server as a single
 * self-contained binary with no package directory around it, so it points
 * `AIAX_ROUTER_ASSETS` at the bundle's resource folder instead.
 *
 * Read per call, never cached at import: tests and the app both set the
 * variable after this module is loaded.
 */
export function appRoot(): string {
  const override = process.env.AIAX_ROUTER_ASSETS;
  if (override) return override.endsWith('/') ? override : `${override}/`;
  return fileURLToPath(new URL('../../', import.meta.url));
}
