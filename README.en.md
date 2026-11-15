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
- **Power draw.** The board's CPU runs at 80 MHz instead of 160. Bluetooth starts only when a station is configured and listens once a minute, until the first advertisement is heard and for 4 seconds at most.
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
| `firmware/` | ESP32-C3 firmware (PlatformIO, Arduino), `make_secrets.py`, which writes `include/secrets.h`, and `ota_upload.py` for updates over Wi-Fi |
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
8. Firmware: in `firmware/` run `python3 make_secrets.py https://<name>.convex.site` (asks for Wi-Fi, the indicator address and the station serial), then `pio run -t upload` (over USB). Later versions can be sent [over Wi-Fi](#updates-over-wi-fi).

## Updates over Wi-Fi

The first firmware with update support (version 0.6 or newer) is flashed over USB: `pio run -t upload`. After that no cable is needed. In `firmware/`:

```bash
pio run && python3 ota_upload.py <board-address>
```

- **The update password** is created by `make_secrets.py` and kept in the macOS keychain; `secrets.h` gets its SHA-256. If you already have a `secrets.h`, `python3 make_secrets.py --ota-only` is enough: the rest of the file stays untouched. Without the `OTA_PASSWORD_SHA256` line the firmware builds with Wi-Fi updates disabled.
- **The board address** comes from the argument or the `BOARD_IP` environment variable; it is not in the repository. The script reads the password from the keychain itself, so it never shows up on screen or on the command line.
- **Rollback.** New firmware has 5 minutes to join Wi-Fi and send a report (or at least stay reachable on the network). If it does not, hangs or reboots before that, the board returns to the previous firmware by itself. A power cut in those minutes is also a rollback: send the update again. Until the new firmware is confirmed, the board accepts no further update.
- **Verification.** At the end the script asks the board (UDP 3233: version, build id, state, no secrets) which build is running and reports success only when it is the build just sent and the board has confirmed it.

## Security

- The board can only write to `/report`, with its key; the key is compared in constant time.
- Data is served only by Convex queries for signed-in users. The Vercel site is static files with no data.
- `secrets.h`, `.env.local` and the Vercel/Convex link files are git-ignored.
- Wi-Fi updates are password-protected, but the actual key is the SHA-256 of the password stored in `secrets.h`: whoever has that hash or a built `firmware.bin` can update the board. The image also holds the Wi-Fi password and the device key and travels over the local network unencrypted. This protection is meant for a home network without untrusted devices; do not copy `secrets.h` or the `.pio/` folder anywhere.

## Free tiers

Designed to stay within the free Convex plan (1M function calls per month): one report a minute and only on change, the silence check every 5 minutes, the schedule every 20 minutes, daily history clean-up. About 100k calls a month; an always-open page adds up to 45k.

## Limitations

- The Yasno API is undocumented and may change; on failure the last known schedule is kept.
- EcoFlow advertisement parsing is verified only on DELTA 2 Max.
- One indicator device: a Wi-Fi glitch on it shows up as an outage.

## Licence

Code: [MIT](LICENSE). The case model is its author's work under its own licence and is not part of this repository.
