# Power at home

A home power-outage monitor: a ~$3 ESP32 board tells your phone whether there is electricity at home, how long it has been out, the official outage schedule next to what actually happened, and the charge of an EcoFlow power station.

*[Українська версія](README.md)*

## How it works

```
backup power                               regular socket
  ├─ router                                  └─ indicator: any Wi-Fi device
  └─ ESP32-C3 board ── ping every 20 s ──▶      (boiler, Wi-Fi extender…)
        │  ╲
        │   ╲ Bluetooth: EcoFlow charge (optional)
        │ HTTPS, device key
        ▼
  Convex: report endpoint ─▶ database ◀─ crons: "board silent?", Yasno schedule
        ▲
        │ live updates, signed-in users only
  website (Vercel) ◀── phone
```

- **Indicator.** A Wi-Fi device in a socket without backup power. It answers ping: power is on. Two silent cycles in a row: power is off.
- **The board** sits on backup power next to the router. It reports once a minute and immediately on any change. An outage is timestamped with the first failed ping.
- **EcoFlow** (verified on DELTA 2 Max) broadcasts its charge in a Bluetooth advertisement. The board only listens: no account and no pairing.
- **No connection.** If the board is silent for over 5 minutes, the page shows "no connection to home" (internet or backup power is gone).
- **The official schedule** comes from the public Yasno API (Kyiv, DTEK Kyiv Electric Networks) every 20 minutes and is kept per day, so you can see where the schedule and reality differ.

## The page

- Status (power on / off / no connection), since when, a schedule pill ("power until 18:00") and a warning when reality differs from the schedule.
- Power station: percentage, trend and an estimate of time left or time to full.
- Day by hour, styled after the Kyiv Digital outage schedule: past hours show what happened, future hours show the schedule; tap an hour for details.
- Station charge over the last day, a week overview, a list of outages.
- Light and dark themes, mobile-first, animations that respect "reduce motion".

The interface is in Ukrainian.

## Repository layout

| Path | What it is |
|---|---|
| `firmware/` | ESP32-C3 firmware (PlatformIO, Arduino) and `make_secrets.py`, which writes `include/secrets.h` |
| `web/convex/` | Convex backend: report endpoint (`http.ts`), state and log (`power.ts`), Yasno schedule (`schedule.ts`), crons (`crons.ts`), sign-in (`auth.ts`) |
| `web/convex/lib/logic.ts` | All state logic with no Convex dependency, shared by the server and the page |
| `web/src/` | Website: Vite + React + TypeScript |
| `web/tests/` | Logic tests: `npm test` |
| `web/scripts/` | Deploy, sign-in keys, Yasno outage-group lookup by address |

## Hardware

- ESP32-C3 Super Mini (or another ESP32 with Wi-Fi and Bluetooth), USB power from the backup supply.
- An indicator device on non-backup power that answers ping. Give it a static DHCP lease on your router.
- Optional: an EcoFlow power station within Bluetooth range of the board.

## Case

A ready-made model by Jeroen van Grondelle: [GitHub](https://github.com/jeroenvangrondelle/esp32-super-mini-case) or [Printables](https://www.printables.com/model/1137008-esp32-c3-super-mini-case). The number in the file name is the board length without the connector: for a 25 mm ESP32-C3 Super Mini use `stl/26mm-case.stl` (about 1 mm of play). The file holds six parts on one plate; split it into objects in your slicer (Bambu Studio: "Split to objects") and print the low 8.5 mm case and one of the lids, solid or with the hex grid. No supports needed.

## Deploy

You need Node.js and accounts on [Convex](https://convex.dev) and [Vercel](https://vercel.com); the free tiers are enough. Run everything in `web/`.

1. `npm install`.
2. Convex project: `npx convex dev --once` (creates the project and writes `.env.local`), then `npm run deploy`.
3. Sign-in keys: `node scripts/auth-keys.mjs`; site URL: `npx convex env set --prod SITE_URL https://your-site`.
4. Device key, straight into the macOS keychain and Convex without showing it:
   ```bash
   security add-generic-password -a "$USER" -s home-power-device-token -w "$(openssl rand -hex 32)"
   security find-generic-password -s home-power-device-token -w | tr -d '\n' | npx convex env set --prod DEVICE_TOKEN
   ```
5. Official schedule (Kyiv): `node scripts/yasno-group.mjs "street" "house"` prints your group, then `npx convex env set --prod YASNO_GROUP 3.1`. Other regions: set `YASNO_REGION` and `YASNO_DSO`.
6. Website: `npx vercel link`, `npx vercel env add VITE_CONVEX_URL production` (`https://<name>.convex.cloud`), `npx vercel --prod`.
7. Your account: `npx convex env set --prod ALLOWED_EMAILS you@example.com`, sign up on the site, then `npx convex env remove --prod ALLOWED_EMAILS`. Without that variable nobody can sign up; e-mail is not verified, so do not keep it set longer than needed.
8. Firmware: in `firmware/` run `python3 make_secrets.py https://<name>.convex.site` (asks for Wi-Fi, the indicator address and the station serial), then `pio run -t upload`.

## Security

- The board can only write to `/report`, with its key; the key is compared in constant time.
- Data is served only by Convex queries for signed-in users. The Vercel site is static files with no data.
- `secrets.h`, `.env.local` and the Vercel/Convex link files are git-ignored.

## Free tiers

Designed to stay within the free Convex plan (1M function calls per month): one report a minute and only on change, the silence check every 5 minutes, the schedule every 20 minutes, daily history clean-up. About 100k calls a month; an always-open page adds up to 45k.

## Limitations

- The Yasno API is undocumented and may change; on failure the last known schedule is kept.
- EcoFlow advertisement parsing is verified only on DELTA 2 Max.
- One indicator device: a Wi-Fi glitch on it shows up as an outage.

## Licence

Code: [MIT](LICENSE). The case model is its author's work under its own licence and is not part of this repository.
