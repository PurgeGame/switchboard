import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { startNotifications } from "./notify.ts";
import { startStore } from "./store.ts";
import "./styles.css";

startNotifications();
startStore();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
