import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import { ConvexError } from "convex/values";
import { emailAllowed } from "./lib/logic";

/**
 * Вхід за поштою й паролем. Сайт приватний, тому реєстрація закрита за замовчуванням:
 * створити обліковий запис можна лише для пошти з переліку у змінній середовища
 * ALLOWED_EMAILS (через кому). Порожня або відсутня змінна — реєстрація неможлива взагалі.
 *
 * Порядок для власника: задати ALLOWED_EMAILS, одразу зареєструватися, видалити змінну.
 * Після цього новий обліковий запис не створить ніхто, а вхід працює далі.
 *
 * Перевірки виконуються НА СЕРВЕРІ: форма в браузері нічого не вирішує.
 * Усі п'ять функцій мають бути реекспортовані звідси, інакше не потраплять у деплоймент.
 */
function validatePassword(password: string) {
  const p = String(password ?? "");
  if (p.trim().length < 12) throw new ConvexError("Пароль має бути не коротшим за 12 символів");
  if (p.length > 128) throw new ConvexError("Пароль задовгий (максимум 128 символів)");
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password({
      validatePasswordRequirements: validatePassword,
      profile(params) {
        const email = String(params.email ?? "").trim().toLowerCase();
        if (params.flow === "signUp" && !emailAllowed(email, process.env.ALLOWED_EMAILS)) {
          throw new ConvexError("Реєстрацію закрито");
        }
        return { email };
      },
    }),
  ],
});
