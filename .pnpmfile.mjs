/**
 * The openapi-typescript package relies on the TypeScript 5 compiler API, which TypeScript 7 no longer ships. Its
 * `typescript` peer would otherwise resolve to the workspace root's TypeScript 7, so it gets a private TypeScript 5
 * dependency instead.
 *
 * @param {{ name?: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string> }} pkg The
 *   package manifest to adjust.
 * @returns {typeof pkg} The adjusted package manifest.
 */
function readPackage(pkg) {
  if (pkg.name === "openapi-typescript") {
    delete pkg.peerDependencies?.typescript;
    pkg.dependencies = { ...pkg.dependencies, typescript: "5.9.3" };
  }
  return pkg;
}

// oxlint-disable-next-line import/prefer-default-export -- pnpm only reads a named `hooks` export
export const hooks = { readPackage };
