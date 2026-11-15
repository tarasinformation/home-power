import { useConvexAuth } from "convex/react";
import { Login } from "./Login";
import { StatusPage } from "./Status";

export default function App() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  if (isLoading) {
    return (
      <main className="app">
        <p className="loading" aria-label="Завантаження">
          <i />
          <i />
          <i />
        </p>
      </main>
    );
  }
  return isAuthenticated ? <StatusPage /> : <Login />;
}
