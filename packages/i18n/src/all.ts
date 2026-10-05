import hi from "./locales/hi.json" with { type: "json" };
import { registerCatalog } from "./registry.js";

// Every catalogue at once, for the server (PDFs, messages, errors in any language).
registerCatalog("hi", hi);
