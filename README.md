# StormOfShadowss

The real, self-hosted version of the group-order site: a small Node server + **MariaDB**, run with
Docker on your Unraid box. This is the **foundation** — the database, the sign-in, the money
logic and the packing queue are real and tested; the rest of the screens are still being ported from
the design preview (see [ROADMAP.md](ROADMAP.md)).

```
public/            the pages the server hands out (a small sign-in page + preview.html, the design demo)
server/            the API (Node 20, Express, mysql2)
  src/routes/      auth · handles · catalog · claims · my (joiner) · admin (GOM)
  src/lib/         ledger.js (all the money rules) · parcels.js · money.js
  test/            884 tests that run against a real MariaDB
db/migrations/     001_init.sql — the whole database design (32 tables)
deploy/backup.sh   automatic database backups
docker-compose.yml app + MariaDB + backups (+ optional DB viewer)
.env.example       every setting, explained
```

## What is built, and what isn't

**Built and tested against a real MariaDB (884 tests):**

| Area | What it does |
|---|---|
| **Sign-in (no PIN)** | Emailed one-time links. Claiming needs only an Instagram handle. The GOM signs in at `/admin.html` with a **username and password** (hashed, locked after 5 wrong tries, 12-hour sessions). |
| **Handles** | A signed-in person links their Instagram handle; if that handle already has orders, you approve it once. |
| **Catalogue** | Groups, GOs (public or **private/off-site**), items, per-item proxy and pay-by date. Sets can have **parts at different prices** (photocards £3, Diary £2, washi tape £1) and can require **every part** to be claimed. |
| **Claims** | Claim without signing in; you secure them (all at once per GO, or individually). |
| **Money** | Five cost lines per claim, payments you verify, **joiner chooses credit or tip** when overpaying, credit that auto-applies, exchange-rate cost adjustments, penny-exact splits, a full audit trail of which payment settled what. **Cancelled claims return what was paid as credit.** |
| **Parcels** | Joiner requests shipping → first-come-first-served packing queue → you add postage, pack, ship → the joiner confirms it arrived → items complete. Each request also records the name for a **personalised Lomo** (their delivery name unless they pick another). |
| **Blocked handles & deleted accounts** | You can block a handle (even before it has ever ordered): it can't place claims, and if one of its claims is cancelled the money it paid is recorded as *forfeited* instead of credited. Each group has its **own page** (`/#/group/<id>-<name>`), with tabs between groups; the home page lists only groups that have orders open. There is a **privacy notice** at `/privacy.html` (linked from every page; set `CONTACT_EMAIL`). People can delete their own account from **My settings** (see below); anyone who leaves holding credit shows up on your flagged list. |
| **Backups** | Nightly dumps, tested to restore row-for-row. |

**Joiner site (at `/`):** browse group orders, a basket, claim with just an Instagram handle, then an offer to add an email (one link signs in and connects the handle), and `/my.html` (My orders) to sign in, see what you owe, make a payment, add delivery details, request shipping, follow parcels and confirm they've arrived. You can **import your Notion masterlist** (Import tab: upload the export, confirm who's who, preview, import — and undo it if needed), then send each person a **one-time "claim your orders" link** (People tab) so they can link their handle without waiting for approval. Up to 5 friends can **ship together** in one parcel (a joiner invites them, or you combine requests in the Packing tab). Postage and packaging are split equally per person for UK parcels, or **by weight** for worldwide ones (you can override either way and type in what you weighed). There is also a stand-alone Unraid stack — one YAML plus one env box, built straight from GitHub, with the first admin created from the settings (`deploy/unraid/`; SETUP.md has the steps). The server can be updated from a private GitHub repository with one command (`bash deploy/update.sh` — it backs up first). You can **delete** a group order or item (never one with real orders or payments behind it). Joiners can **ask to cancel** an item at any stage (you approve or decline, and choose any cancellation fee to keep; a set can't be secured while one of its parts has a request waiting). Claims can also be **moved to another person** (with the money that was paid on them) from the Claims tab. You can host an item before its price is final (**price TBC**): people can claim it, nothing can be secured until you set the price, and the claims pick it up. Items, shop stock, group orders and artists can each have a **picture** (shrunk for the web, with hidden location data removed). Items you already have on hand can be sold from a **Shop** page (held at once, ready to send once paid). Joiners can opt in to **email notifications** (claims secured, payments verified or rejected, parcels shipped, and one overdue reminder) from My orders — off unless they turn it on. Member sets can be claimed too — pick parts with +/−, and each goes in the right set. Regulars can have **fixed claims**, and manage them from a Fixed claims page.

**GOM screens (at `/admin.html`):** Group Orders (create and edit orders and every kind of item, each with an optional description joiners see), Claims (secure, edit costs, move stages — one at a time or many at once, cancel; filter and sort by stage or unpaid; each person's overall owed/paid/credit), **Shop** (stock on hand: add items, see who has claimed them and who hasn't paid), **Proxy** (a log of what you owe your proxies, so nothing is paid twice and nothing slips past its date), **Warehouse** (boxes from your proxy: split EMS by weight and customs by value, track them in and tick items ready to pack), **Overdue** (who owes money past their pay-by date, and items kept past their storage deadline, with a way to extend), **Sets** (see who holds each part of a member set, secure it, cancel it, put someone into an open part or split its cost and raffle it, and approve regulars' requests to swap or give up fixed claims),
Payments (verify, credit, tips, where to pay), Packing (the queue, addresses, a **packing checklist** — tick each item, and confirm the address, Lomo name and bias name — plus a postage and a packaging-fee box you fill in per parcel, and Mark packed only unlocks once everything is ticked; then ship/receive) and People (handle requests, recently linked emails to check, and blocking — with a flagged list showing what blocked or departed people owe or hold).

**Not built yet (still only in the design preview):** member-set claiming and fixed claims, inbound
EMS boxes and the weight split, proxy payments, the Shop (leftover) stock, image uploads, the overdue
dashboard, and the screens themselves talking to this API. [ROADMAP.md](ROADMAP.md) has the order I'd do them in.

> **What I could not test from where this was built:** `docker compose up` itself, the Unraid
> Compose-Manager screens and a real SMTP server — there's no Docker or
> internet in the build environment. Everything *inside* the container was tested for real: the
> server on a fresh database exactly as the container starts it, the install step the Dockerfile
> runs, the backup/restore, and the sign-in. Expect to read the first startup log carefully.

---

## Deploy on Unraid

**You need:** Unraid with Docker enabled; either the **Docker Compose Manager** plugin
(Community Applications) or SSH access; for a public site, a domain and an SMTP
account for the sign-in emails.

### 1. Put the files on the server

Copy this whole folder to `/mnt/user/appdata/stormofshadowss/`.

### 2. Create your settings

```bash
cd /mnt/user/appdata/stormofshadowss
cp .env.example .env
nano .env
```

Set at least: `DB_ROOT_PASSWORD`, `DB_PASSWORD` (generate with `openssl rand -base64 24`),
`PUBLIC_URL`, and `DATA_DIR=/mnt/user/appdata/stormofshadowss/data`
so the database and backups live under appdata.

### 3. First start — on your home network, over plain http

For the very first test, use these three settings (undo them in step 6):

```
APP_BIND=0.0.0.0
PUBLIC_URL=http://YOUR-UNRAID-IP:3000
COOKIE_SECURE=false
```

> Browsers refuse to keep a login cookie marked "Secure" over plain `http`, which is why
> `COOKIE_SECURE=false` is needed for this test — and only for it.

```bash
docker compose up -d --build
docker compose logs -f app
```

You want to see `migrate: 1 migration(s) applied` then `StormOfShadowss listening on :3000`.
(In Compose Manager: add a stack pointing at this folder, paste your `.env`, then "Compose Up".)

### 4. Create your GOM login and sign in

The admin username and password are **not** in `.env`. You create them once with a command, and they're stored hashed in the database:

```bash
docker compose run --rm app node src/admin-cli.js create
```

It asks for a username, your email (for your records only), and a password (12+ characters; typed hidden). Then open
`http://YOUR-UNRAID-IP:3000/admin.html` and sign in. Other commands: `set-password <username>` and `list`.
See [SETUP.md](SETUP.md) for the full staged walkthrough.

### 5. Real email (needed before anyone else can sign in)

Add these to `.env` and run `docker compose up -d`:

```
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=StormOfShadowss <orders@yourdomain.com>
```

Any SMTP provider works (Brevo, Resend, Mailgun, a Gmail app password, …). Check the provider's
current free-tier limits; a group-order community sends very little. Use a `From` address on a
domain you've verified with them so the emails don't land in spam.

> While SMTP is blank, anyone who can read the container logs can sign in as anyone. Fine on your own
> network while testing; **don't leave it that way** on a public site.

### 6. Making it public (HTTPS)

However you make the site reachable from outside (for example a reverse proxy), once it's served over **https** set in `.env`: `PUBLIC_URL=https://orders.yourdomain.com`, `COOKIE_SECURE=true`, and `TRUST_PROXY=1` if it sits behind a reverse proxy. Keep the database and Unraid itself off the public internet.

### 7. Backups

Automatic: a dump every `BACKUP_EVERY_HOURS` into `DATA_DIR/backups`, keeping `BACKUP_KEEP_DAYS` days.
A backup only counts if the dump finished; a failure is logged and **never deletes** older backups.

```bash
docker compose run --rm -e ONCE=1 backup            # take one right now
ls data/backups                                      # see them
```

**Restore** (this replaces the current database):

```bash
docker compose stop app
docker compose exec db sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" -e "DROP DATABASE sos; CREATE DATABASE sos CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"'
gunzip -c data/backups/sos-YYYYMMDD-HHMMSS.sql.gz | docker compose exec -T db sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" sos'
docker compose start app
```

(If you changed `DB_NAME`, use that instead of `sos`.) **Copy `data/backups` somewhere off the server**
too (another machine, cloud storage via rclone/Duplicati) — a backup on the same disk doesn't protect
you from that disk dying. Try a restore once, on purpose, before you need it.

### 8. Updating

Replace the files (keep your `.env` and `data/`), then:

```bash
docker compose up -d --build
```

Database changes apply automatically on start. Take a backup first (step 7).

### Using your existing MariaDB container instead

If you already run MariaDB on Unraid, don't start the bundled one. Create a database and user there:

```sql
CREATE DATABASE sos CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'sos'@'%' IDENTIFIED BY 'a-long-random-password';
GRANT ALL PRIVILEGES ON sos.* TO 'sos'@'%';
```

In `.env` set `DB_HOST` (its IP or container name), `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, then:

```bash
docker compose up -d --build --no-deps app
```

(Back that database up with your own routine; the `backup` service here is for the bundled one.)

---

## Cancelled claims, blocked handles and deleted accounts

- **Cancelling a claim** (one at a time, or many at once for a set that won't proceed) returns everything
  paid towards it to that person as **credit**, which then pays off anything else they owe. A claim that is already
  inside a parcel can't be cancelled until the parcel is cancelled or finished.
- **The exception: blocked handles.** Block a handle with a reason (`POST /api/admin/joiners/block`). They can no longer
  place claims, and if one of their claims is cancelled, what they paid is **not** credited — it is recorded in their
  ledger as *forfeited* (£ amount, never part of a balance, never mistaken for a tip). If they turn up, unblock them
  and add the credit back by hand (`/api/admin/credit/add`, with a reason).
- **Deleting an account** (My settings → Delete my account). It is **refused** while they owe money on a confirmed order, a payment or a cancellation request is waiting, or a parcel (theirs, or with their items in it) is on its way — the screen says exactly why and the button stays off. Otherwise the login, email, sessions and delivery details go and their unconfirmed requests are removed (set parts are freed). Then: **nothing financial on record** (no confirmed order, confirmed payment or credit movement) → everything about them is erased; **a financial record exists** → the record stays (orders, amounts, dates) but every personal detail is stripped and they become `deleted-<id>`, unless they hold **credit** or are **blocked**, when the handle stays (so you can settle it / a block can't be shed). The person is only told their account and details were deleted. They are warned about credit they'd leave behind and paid items not yet delivered. Leavers who kept their handle appear on `GET /api/admin/joiners/flagged`; anonymised ones don't.
  If they come back with a new email, the handle needs your approval (it has orders on it), and approving clears the flag.
- There are no screens for blocking or the flagged list yet — only the API. They're on the roadmap.

## How sign-in works (and why there's no PIN)

- **Claiming needs no account** — just an Instagram handle. A claim commits nobody to anything until
  you secure it, so a mistaken or mischievous claim costs no one anything.
- **Seeing orders, addresses and paying needs an emailed link.** Enter your email → get a link → press
  the button. Links work **once** and expire in 15 minutes. The page doesn't sign you in by merely
  being opened, because mail scanners open links automatically and would use them up.
- **Adding your email after claiming:** the first time a handle is used, the claim goes straight through and that browser is
  quietly marked as "the one that made it". The page then offers: *add your email to see your orders, pay, and confirm your
  address.* Adding it from that browser links the handle immediately, **no approval from you**, and the emailed link works
  from any device. A claim never needs an account; the email is only for My Orders, payments and addresses.
- **The rare fallback:** if someone returns on a different phone or has cleared their cookies, and never added an email,
  their link request waits for your approval (the "Handle requests" list). Nothing else waits on it: claims still go
  through, and you can approve whenever you're next around.
- **Trust, honestly:** Instagram handles can't be verified automatically, so the first person to claim a handle owns its
  email link. Two safety nets: `GET /api/admin/joiners/recent-links` lists every new link for after-the-fact review (with an
  unlink option), and the packing queue flags handles you haven't marked verified (`/api/admin/joiners/verify`) — so you can DM
  someone on Instagram before sending their *first* parcel. After that they're never flagged again.
- **You (the GOM)** sign in at `/admin.html` with a username and password. Passwords are stored as salted scrypt hashes;
  5 wrong tries lock that account for 15 minutes; admin sessions last 12 hours; changing a password signs every device out.
  An admin account can't be used with the emailed-link route, so the password can't be bypassed through an inbox. If you forget
  the password, run `set-password` on the server (there is deliberately no "email me a reset").
- Sessions last 30 days, are HttpOnly + SameSite, and are stored hashed. Sign-in links are stored
  hashed too. Every change request must carry a header a cross-site form can't send.

## Safety notes

- It stores people's **names, addresses, emails and phone numbers**. Keep it behind HTTPS,
  keep Unraid itself off the public internet, use long database passwords, and keep the images updated
  (`docker compose pull && docker compose up -d --build`).
- Under UK GDPR you need a way to **delete someone's data on request**, and since you run this as a
  business it's worth checking whether you must register with the ICO. I'm not a lawyer — please
  confirm with the ICO's guidance.
- Rate limits are held in memory, so they reset if the container restarts.
- There's no second factor beyond access to the email account the link goes to.

## Running the tests

They need a MariaDB they can create temporary databases in:

```sql
CREATE USER 'sos'@'%' IDENTIFIED BY 'sos_pw';
GRANT ALL ON `sos%`.* TO 'sos'@'%';
```

```bash
cd server && npm install
TEST_DB_HOST=127.0.0.1 npm test
```

(Defaults: user `sos`, password `sos_pw`; each test file builds and drops its own throwaway database.)

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| App logs `waiting for the database (n/40)` forever | Wrong `DB_*` values, or the database isn't up. `docker compose logs db`. |
| Sign-in "works" but you're immediately signed out | `COOKIE_SECURE=true` while using plain `http`. Use https, or set `false` for a LAN test. |
| Sign-in email never arrives | `SMTP_*` wrong — the app log says `mail failed: …`. Check spam; check the `From` domain is verified. |
| `Missing X-Requested-With header` | Something other than the site's own pages is calling the API. Add header `X-Requested-With: sos`. |
| Sign-in link says "expired" | Links work once and last 15 minutes; mail scanners can't use it up, but opening it in two browsers can. Request a new one. |
