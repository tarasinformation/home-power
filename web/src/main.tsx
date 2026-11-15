import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import App from "./App";
import "./index.css";

// Адреса бекенда (https://<назва>.convex.cloud). Значення публічне: воно потрапляє в зібраний сайт.
// Локально її записує у .env.local команда `npx convex dev`, на Vercel це змінна VITE_CONVEX_URL.
const url = import.meta.env.VITE_CONVEX_URL as string | undefined;
const root = createRoot(document.getElementById("root")!);

if (!url) {
  root.render(
    <main>
      <p className="status unknown">Сайт не налаштовано</p>
      <p className="note">Не задано адресу бекенда VITE_CONVEX_URL. Кроки розгортання описано в README проєкту.</p>
    </main>,
  );
} else {
  const convex = new ConvexReactClient(url);
  root.render(
    <StrictMode>
      <ConvexAuthProvider client={convex}>
        <App />
      </ConvexAuthProvider>
    </StrictMode>,
  );
}
