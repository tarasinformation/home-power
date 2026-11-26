/**
 * Плавна крива через точки графіка (кубічні криві Без'є з монотонними дотичними, метод Фрітша–Карлсона).
 *
 * Крива проходить точно через кожну точку і ніде не «вистрибує» за сусідні значення: між двома
 * вимірами вона лишається між ними, тож згладжування не домальовує піків і провалів, яких не було.
 * Точки мають іти зліва направо; ті, що не просуваються по x, пропускаються.
 */
export type XY = { x: number; y: number };

export function smoothPath(points: XY[]): string {
  const p: XY[] = [];
  for (const q of points) {
    if (!p.length || q.x > p[p.length - 1].x + 1e-6) p.push(q);
  }
  const n = p.length;
  if (!n) return "";
  const f = (v: number) => v.toFixed(1);
  let d = `M${f(p[0].x)} ${f(p[0].y)}`;
  if (n === 1) return d;
  if (n === 2) return `${d} L${f(p[1].x)} ${f(p[1].y)}`;

  const h: number[] = [];
  const s: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(p[i + 1].x - p[i].x);
    s.push((p[i + 1].y - p[i].y) / h[i]);
  }
  // Дотична в кожній точці: нуль на вершинах і западинах, інакше не крутіша за подвоєний пологіший із сусідніх схилів.
  const t: number[] = [s[0]];
  for (let i = 1; i < n - 1; i++) {
    if (s[i - 1] * s[i] <= 0) {
      t.push(0);
    } else {
      const mean = (s[i - 1] * h[i] + s[i] * h[i - 1]) / (h[i - 1] + h[i]);
      t.push(Math.sign(s[i]) * Math.min(Math.abs(s[i - 1]), Math.abs(s[i]), 0.5 * Math.abs(mean)) * 2);
    }
  }
  t.push(s[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    const k = h[i] / 3;
    d += ` C${f(p[i].x + k)} ${f(p[i].y + t[i] * k)} ${f(p[i + 1].x - k)} ${f(p[i + 1].y - t[i + 1] * k)} ${f(p[i + 1].x)} ${f(p[i + 1].y)}`;
  }
  return d;
}
