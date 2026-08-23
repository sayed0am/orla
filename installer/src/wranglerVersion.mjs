// The exact wrangler version this installer pins via `npx --yes wrangler@<version>`, matching
// the major/minor/patch this repo's own package.json devDependency uses (Orla's `.npmrc` has
// `save-exact=true`, so that field is always an exact version, never a range).
//
// This is a plain constant, not a runtime read of package.json, because create-orla is a
// separate published package with no guaranteed filesystem path back to the Orla repo (which
// hasn't even been cloned yet when this constant is needed, during preflight). Keep it in sync
// by hand when bumping wrangler in the root package.json — test/installer.test.ts's
// "wrangler version stays in sync" case fails CI if this constant and the root
// package.json's `devDependencies.wrangler` ever drift apart, so drift can't go unnoticed.
export const WRANGLER_VERSION = "4.125.0";
