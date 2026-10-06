import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { AppErrorBoundary } from "./components/ErrorBoundary";
import { installErrorReporting } from "./lib/errorReport";
import { initAppearance } from "./app/theme";
import { initTextSize } from "./app/comfort";
import { setupPwa } from "./lib/pwa";
import { startNativeApp } from "./platform/app";
import { startScrollFade } from "./lib/scrollFade";
import "./styles/app.css";

installErrorReporting();
initAppearance();
initTextSize();
setupPwa();
startNativeApp();
startScrollFade();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
