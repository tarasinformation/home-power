// Знаходить чергу відключень для адреси через відкритий API Yasno.
//   node scripts/yasno-group.mjs "Хрещатик" "1"
// Регіон і оператор за замовчуванням — Київ (25) і ДТЕК Київські електромережі (902);
// інші: YASNO_REGION=.. YASNO_DSO=.. node scripts/yasno-group.mjs ...
// Список регіонів: https://app.yasno.ua/api/blackout-service/public/shutdowns/addresses/v2/regions
const [street, house] = process.argv.slice(2);
if (!street || !house) {
  console.error('Використання: node scripts/yasno-group.mjs "назва вулиці" "номер будинку"');
  process.exit(1);
}
const region = process.env.YASNO_REGION ?? "25";
const dso = process.env.YASNO_DSO ?? "902";
const base = "https://app.yasno.ua/api/blackout-service/public/shutdowns/addresses/v2";
const get = async (path, params) => {
  const res = await fetch(`${base}/${path}?${new URLSearchParams({ regionId: region, dsoId: dso, ...params })}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
};

const streets = await get("streets", { query: street });
if (!streets.length) throw new Error("Вулицю не знайдено");
const s = streets[0];
const houses = await get("houses", { streetId: String(s.id), query: house });
const h = houses.find(x => x.value === house) ?? houses[0];
if (!h) throw new Error("Будинок не знайдено");
const g = await get("group", { streetId: String(s.id), houseId: String(h.id) });
console.log(`${s.value}, ${h.value}: черга ${g.group}.${g.subgroup}`);
console.log(`npx convex env set --prod YASNO_GROUP ${g.group}.${g.subgroup}`);
