import { useState, type FormEvent } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { Bolt } from "./Icons";

export function Login() {
  const { signIn } = useAuthActions();
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (mode === "signUp" && password.trim().length < 12) {
      setError("Пароль має бути не коротшим за 12 символів.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signIn("password", { email, password, flow: mode });
    } catch {
      // Причину сервер стороннім не пояснює, тож і тут без подробиць.
      setError(
        mode === "signIn"
          ? "Невірна пошта або пароль."
          : "Реєстрацію закрито.",
      );
      setBusy(false);
    }
  }

  return (
    <main className="app login">
      <section className="card login-card">
      <span className="hero-icon login-icon" aria-hidden="true">
        <Bolt size={30} />
      </span>
      <h1 className="login-title">Світло вдома</h1>
      <form onSubmit={onSubmit}>
        <label>
          Пошта
          <input type="email" name="email" autoComplete="username" inputMode="email" autoCapitalize="none" required />
        </label>
        <label>
          Пароль
          <input
            type="password"
            name="password"
            autoComplete={mode === "signUp" ? "new-password" : "current-password"}
            required
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? "Зачекайте…" : mode === "signIn" ? "Увійти" : "Створити обліковий запис"}
        </button>
      </form>
      <p className="muted">
        <button
          type="button"
          className="link"
          onClick={() => {
            setMode(mode === "signIn" ? "signUp" : "signIn");
            setError(null);
          }}
        >
          {mode === "signIn" ? "Створити обліковий запис" : "Увійти"}
        </button>
      </p>
      </section>
    </main>
  );
}
