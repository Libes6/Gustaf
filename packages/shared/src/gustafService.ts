/**
 * Addresses of the services Gustaf talks to. Gustaf uses none of T3 Code's own services
 * (hosted app, Connect relay, analytics, installers); new network code points here instead.
 */
export const GUSTAF_REPOSITORY = "Libes6/Gustaf";
export const GUSTAF_REPOSITORY_URL = `https://github.com/${GUSTAF_REPOSITORY}`;
export const GUSTAF_RELEASES_URL = `${GUSTAF_REPOSITORY_URL}/releases`;
export const GUSTAF_LATEST_RELEASE_URL = `${GUSTAF_RELEASES_URL}/latest`;
/** The manifest the desktop updater reads: version, notes, and a signed file per platform. */
export const GUSTAF_UPDATE_MANIFEST_URL = `${GUSTAF_LATEST_RELEASE_URL}/download/latest.json`;
export const GUSTAF_ISSUES_URL = `${GUSTAF_REPOSITORY_URL}/issues`;
export const GUSTAF_DOCS_URL = `${GUSTAF_REPOSITORY_URL}/blob/main/docs/user`;
export const GUSTAF_INSTALL_SCRIPT_URL = `https://raw.githubusercontent.com/${GUSTAF_REPOSITORY}/main/scripts/install.sh`;
export const GUSTAF_INSTALL_PS1_URL = `https://raw.githubusercontent.com/${GUSTAF_REPOSITORY}/main/scripts/install.ps1`;
export const GUSTAF_MODEL_MANIFEST_URL = `https://raw.githubusercontent.com/${GUSTAF_REPOSITORY}/main/apps/server/src/provider/model-manifest.json`;
/** Gustaf Cloud (`apps/api`): accounts, relay, usage totals, problem reports, client config. */
export const GUSTAF_CLOUD_API_URL = "https://api.libes6.ru";
