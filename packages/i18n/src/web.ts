/**
 * The package for the browser: the same as the entry, without the catalogues
 * other than English bundled in. The app calls `loadCatalog` for the chosen
 * language (the web build points `@digitalbahi/i18n` here).
 */
export * from "./registry.js";
export * from "./format.js";
export * from "./translate.js";
export * from "./notifications.js";

import { setCatalogLoaders } from "./registry.js";

// A plain import: the bundler makes the JSON a script of its own.
setCatalogLoaders({ hi: () => import("./locales/hi.json") });
