import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { initAppearance } from "./app/theme";
import { setupPwa } from "./lib/pwa";
import "./styles/app.css";

initAppearance();
setupPwa();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
