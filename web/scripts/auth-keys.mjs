// Створює ключі входу для @convex-dev/auth (JWT_PRIVATE_KEY і JWKS) і записує їх
// у змінні середовища продакшн-деплоймента Convex, не показуючи на екрані.
//   node scripts/auth-keys.mjs            — продакшн
//   node scripts/auth-keys.mjs --dev      — деплоймент для розробки
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";
import { spawnSync } from "node:child_process";

const target = process.argv.includes("--dev") ? [] : ["--prod"];
const keys = await generateKeyPair("RS256", { extractable: true });
const privateKey = (await exportPKCS8(keys.privateKey)).trimEnd().replace(/\n/g, " ");
const jwks = JSON.stringify({ keys: [{ use: "sig", ...(await exportJWK(keys.publicKey)) }] });

for (const [name, value] of [
  ["JWT_PRIVATE_KEY", privateKey],
  ["JWKS", jwks],
]) {
  const r = spawnSync("npx", ["convex", "env", "set", ...target, name], { input: value, encoding: "utf8" });
  console.log(name, r.status === 0 ? "задано" : "ПОМИЛКА");
}
