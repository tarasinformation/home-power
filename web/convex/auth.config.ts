/**
 * Реєструє провайдера входу на платформі Convex. Без цього файла токени підписуються,
 * але не проходять перевірку, і запити бачать користувача як неавтентифікованого.
 * CONVEX_SITE_URL — вбудована змінна: адреса HTTP-дій цього деплоймента (https://<назва>.convex.site).
 */
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
