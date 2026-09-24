/**
 * Where the app gets its data:
 *  - "live": the Vyapaar API (default for `vite dev` and production builds);
 *  - "mock": the built-in demo data set, used by the single-file preview build
 *    and whenever VITE_DATA_SOURCE=mock (e.g. design work without a server).
 */
export const LIVE = import.meta.env.MODE !== "singlefile" && import.meta.env.VITE_DATA_SOURCE !== "mock";
