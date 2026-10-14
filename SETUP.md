# Setting up StormOfShadowss — in stages

Each stage works on its own. Stop after any of them and everything so far keeps working.

> **Where do I set the admin username and password?**
> With one command on your Unraid server (Stage 2). They are *not* in a settings file. The password is typed hidden,
> hashed, and stored in the database. You can change it any time with a second command.

Everything below assumes the folder is at `/mnt/user/appdata/stormofshadowss/` and that you're running commands
in that folder (Unraid: click the `>_` terminal icon, then `cd /mnt/user/appdata/stormofshadowss`).

---

## Stage 1 — Get it running on your home network (15 minutes)

1. Unzip the project into `/mnt/user/appdata/stormofshadowss/`.
2. `cp .env.example .env` then `nano .env` and set:
   - `DB_ROOT_PASSWORD` and `DB_PASSWORD` — two long random values (`openssl rand -base64 24` makes one).
   - `DATA_DIR=/mnt/user/appdata/stormofshadowss/data`
   - For this first test only: `PUBLIC_URL=http://YOUR-UNRAID-IP:3000`, `COOKIE_SECURE=false`, `APP_BIND=0.0.0.0`
3. `docker compose up -d --build`
4. `docker compose logs -f app` — you want to see `migrate: 4 migration(s) applied`, a notice that there is no admin yet,
   then `listening on :3000`. (Press Ctrl-C to stop watching; the site keeps running.)
5. Open `http://YOUR-UNRAID-IP:3000` — you should see the sign-in page.

> If you ran an earlier version of this project, delete `data/mariadb` first and start fresh (nothing real is in it yet).

**Check:** the page loads and `docker compose ps` shows `db`, `app` and `backup` running.

## Stage 2 — Create your GOM login (2 minutes)

```bash
docker compose run --rm app node src/admin-cli.js create
```

Answer the prompts: a username, your email (records only, never used to sign in), a password of **12+ characters**
(a few random words works well), and the password again. Nothing is shown while you type the password.

Then open `http://YOUR-UNRAID-IP:3000/admin.html` and sign in.

| I want to… | Command |
|---|---|
| change my password (or I forgot it) | `docker compose run --rm app node src/admin-cli.js set-password YOURNAME` |
| see who the admins are | `docker compose run --rm app node src/admin-cli.js list` |
| add a second admin (a helper) | the `create` command again |

Good to know: five wrong passwords lock that account for 15 minutes (the lock clears itself, or run `set-password`);
you stay signed in for 12 hours; changing the password signs out every device. Your admin email can't also be a joiner
login. To try the site as a joiner yourself, use a different email in a private/incognito window.

**Check:** you see the GOM screens with tabs **Group Orders · Claims · Payments · Packing · People**, and "Signed in as …" at the bottom.

## Stage 3 — Real email, so people can sign in (10 minutes)

Joiners sign in with an emailed one-time link, so the site needs to be able to send email. Pick any SMTP provider
(Brevo, Resend, Mailgun, a Gmail app password…) and put its details in `.env`:

```
SMTP_HOST=...   SMTP_PORT=587   SMTP_SECURE=false
SMTP_USER=...   SMTP_PASS=...
SMTP_FROM=StormOfShadowss <orders@yourdomain.com>
```

Then `docker compose up -d`. Use a "From" address on a domain you've verified with the provider, or the emails will land in spam.

**Check:** from a private window, request a link to a non-admin email address of yours; it arrives, the button signs you in,
and you can link an Instagram handle. (Until SMTP is set, links appear in `docker compose logs app` instead — fine for
testing, not for real people, because anyone who can read the logs could use them.)

## Stage 4 — Put it on the internet safely (20 minutes)

However you make the site reachable from outside (for example a reverse proxy that serves it over https), set these in `.env` once it's served over **https**: `PUBLIC_URL=https://orders.yourdomain.com`, `COOKIE_SECURE=true`, and — if it sits behind a reverse proxy — `TRUST_PROXY=1`. Keep the database and Unraid itself off the public internet.

**Check:** `https://orders.yourdomain.com/admin.html` loads over https and your login works.

## Stage 5 — Backups (5 minutes — do this before real people use it)

Backups run automatically into `data/backups`. Take one now and check it exists:

```bash
docker compose run --rm -e ONCE=1 backup
ls -la data/backups
```

Copy `data/backups` somewhere off the server regularly (another computer or cloud storage). Practise one restore using the
steps in the README before you need it.

## Stage 6 — Inviting alpha testers

**What the real site can do today:** the sign-in, handle linking and approval, the whole database, payments / credit /
cancellations / blocking, shipping requests and the packing queue — all behind the API and tested.

**What it can do today:** everything for ordinary items, end to end. Joiners browse, claim with just their handle, add an email, sign in, see what they
owe, pay (you verify), add delivery details, request shipping, and confirm arrival. You run the GOM side at `/admin.html`.
**What it can't do yet:** nothing from the original plan is missing. (See "Known limits" in RESUME.md for the small things deliberately left out.) Everything a joiner does, and everything
you do to run an order, is there. **It's ready for an alpha with ordinary items, member sets, fixed claims, and open-part decisions (split the cost and raffle).**

| Stage | What gets built | When alpha testers can… |
|---|---|---|
| **A** (done) | Server, database, sign-in, GOM login, backups, Docker | — |
| **B** (mostly done) | GOM screens on the real API: group orders and items, claims, **payments, packing queue** ✅; blocking and the overdue view (B3) still to come | *you* can run an order without touching the database |
| **C1** (done) | Joiner shop: browse, claim by handle, basket, add your email, sign in, see what you owe | testers can claim ordinary items |
| **C2** (done) | Joiner My Orders: pay, delivery details, request shipping, confirm received | **alpha testers can place and pay for ordinary items** |
| **D** (done) | Member sets, fixed claims, and open-part decisions (mixed prices, all-parts-required, quantity steppers, split + raffle) | …and claim set items |
| **E** | EMS boxes, proxy payments, overdue dashboard, images, shop stock | …the full thing |

Each stage ends with a tested zip and an updated `RESUME.md`, so if a conversation runs out, a new one continues from the file.

### Running the alpha (a practical checklist)

**Before you invite anyone**
1. Finish Stages 1–5 above (running, admin login, real email, HTTPS, a backup taken). Sign in as a joiner from a private window using a different email, to see the site as they will.
2. Add where to send payment: GOM screens → **Payments** → "Where joiners send payment".
3. Create one small, real group order: **Group Orders** → New group order → add 2–3 items. You can include a member set; people claim its parts in the shop and you secure each set from the **Sets** tab. Leave Pay-by dates a week or two out.

**A good first round (3–5 friendly joiners)**
1. Give them the site address and ask them to claim something using their real Instagram handle.
2. They'll be offered "add your email" after claiming. Ask them to do it and tell you if the email arrived and how long it took.
3. In **Claims**, press **Secure all requested** (and, for member sets, secure each set in the **Sets** tab). They should now see an amount owed in **My orders**.
4. Ask them to **make a payment**. In **Payments**, check it and press **Verify**. They should see it counted.
5. Move an item to "ready to pack / on hand" in **Claims**. They add delivery details and **request shipping**.
6. In **Packing**: tick off each item as it goes in the box, and confirm the address, Lomo name and bias name; enter postage and packaging; then **Mark packed** (it unlocks once everything is ticked), **shipped**, and ask them to press **It's arrived**.

**What to watch for and ask them**
- Anything confusing or any wording that felt wrong. Screenshots help.
- Did the sign-in email land in spam? Did the link work from a different device?
- Did any amount look wrong? (Check against **Payments → Credit and tips** and **Claims**.)

**Looking after people's data:** the site holds names, addresses and phone numbers. Keep backups running (Stage 5), keep the host updated, and tell testers it's an early version.

### Email notifications (optional)
Joiners can opt in to emails about their orders (claims secured, payments verified/rejected, parcel shipped, and one overdue-payment reminder) from **My orders → Email notifications**. They are **off unless a joiner turns them on**.
They use the same email setup as sign-in links, so once `SMTP_*` is set in `.env` (see above) they just work. Overdue reminders are checked an hour at a time while the app runs (`REMINDERS_ENABLED`, `REMINDER_EVERY_MINUTES` in `.env`).
**After setting up SMTP, test it:** make a test joiner, turn notifications on, secure a claim for them, and check the email arrives (check spam the first time). Until `SMTP_HOST` is set, emails are printed in the container log instead.

### Pictures (items, shop stock, group orders, artists)
Uploaded pictures are kept in `DATA_DIR/uploads` on the server, so they survive updates and rebuilds. **One-time step on Unraid/Linux:** the app runs as an unprivileged user, so give it that folder:
```
mkdir -p /mnt/user/appdata/stormofshadowss/uploads
chown -R 1000:1000 /mnt/user/appdata/stormofshadowss/uploads
```
(use your own `DATA_DIR` path). If this is missed, the app logs a clear `WARNING: the pictures folder … can't be written to` at start-up and uploads say "the server's uploads folder isn't writable" — fix the permission and restart.
Pictures are included in the nightly backup (`pictures-*.tar.gz` next to the database dumps). To restore: `tar -xzf pictures-<time>.tar.gz -C <DATA_DIR>/uploads`, then fix ownership as above.

### Moving your Notion masterlist across
1. **Back up first** (Stage 5), ideally try the whole thing on a throwaway copy of the site.
2. **GOM sign-in → Import.** In Notion, open the **Claims** database → ••• → Export → CSV, and upload the file ending `_all.csv`. Choose "Ongoing orders only" to start.
3. Work down the three decisions (who is who — tick *Looks right* on each guessed handle, or fix it; which artist each group order belongs to; what any unfamiliar status means), press **Save and preview**, read the preview, then **Import**. If anything looks wrong, **Undo this import** (it can be undone until people have paid against the imported orders).
4. **People tab → Invite people to claim their orders → Make links for everyone without one**, then **Download all as a spreadsheet** and send each person their link by Instagram DM. Links work for 7 days (`INVITE_DAYS` in `.env`); make a new one for anyone who loses theirs.
5. Imported group orders are hidden and closed (nobody can claim from them), but everyone's claims appear in their own **My orders** once they've linked their handle.

**People who signed up before their old claims were imported (e.g. alpha testers):** nothing special is needed. As long as the Notion name is matched to the handle they already use (the People step shows "already signed up" beside it), their old claims are added to their existing account and appear in My orders straight away. If old claims were imported under a different handle by mistake, tick them in the **Claims** tab and use **Move to another person…** — check first, and everything (including money already paid) moves with them.

### Shipping friends' items together
Sometimes joiners who live near each other want one parcel. There are two ways, and both end in the same place — **one parcel, posted to one person's address, with everyone's items in it** (up to **5 people**: the person it's posted to plus 4 friends):
- **They arrange it themselves.** When they request shipping, the person it will be posted to types their friends' handles in *Ship together with friends*. Each friend sees an invitation in My orders (and an email, if they've turned notifications on), chooses which of their own items go in, adds their own bias and Lomo name, and says yes — or no. They can ask more friends later, and take an invitation back. The parcel can't be packed while any invitation is unanswered; you can remove one from the Packing tab.
- **You combine requests.** If people have already requested shipping separately, open one of the parcels in the **Packing** tab, press **Combine with another parcel…**, pick another, and tick that you've checked with everyone. The first parcel's address is used. Repeat to add more people. *Split @x off* takes one person back out.

**How postage and packaging are split.** Automatically: **equally per person for UK postage**, and **by weight for worldwide (WW) postage**, because those prices depend on weight. In the Packing tab, a shared parcel has a **Split** panel where you can switch it either way, and type in what you weighed for each person (in grams). If you leave a weight blank, the site estimates it from the weights and sizes of that person's items — you can set an item's exact weight in the Claims tab. Saving re-shares any fees you've already entered; anyone whose share falls gets the difference back as credit. A person's share is then divided across their own items.

Things to know: everyone needs to have signed in to the site (to be invited); parcels combined by you must ask for the same postage method; the checklist covers *every* person's Lomo and bias names; and the person it's posted to presses **It's arrived**, which completes everyone's items (or you can mark it received for them). **Who is in a parcel can only change before you save postage or packaging** — until then you can add and remove people freely; after that, set the fees back to £0 first.

### When a joiner asks to cancel
In **My orders → Ongoing orders**, a joiner can press **Ask to cancel** on any item that hasn't been received — confirmed or not (so nobody can quietly remove a part from a set) — and give a reason. Nothing changes until you answer. The request appears in a **Cancellation requests** card at the top of the **Claims** tab (and a number on the tab).

For each request you can see the item, where it is, how much they've paid, and their reason. **Approve cancellation** cancels the item and sends back what they paid as credit — and you choose, each time, how much to **keep as a cancellation fee** (type it in the box; it can't be more than they've paid). **Decline** leaves everything as it was; you can add a message they'll see. They're emailed the outcome if they've turned notifications on.

Good to know: **a set can't be secured while one of its parts has a cancellation request waiting** (the part is marked on the Sets tab — answer the request first), and "Secure all" skips anything a joiner has asked to cancel; while a request is waiting, the item can't be put in a parcel or moved to someone else; (changing a *fixed claim* works as before — it's not part of this); an item that's already in a parcel can't be cancelled until the parcel is dealt with; and if you cancel an item yourself while a request is waiting, the request is closed for you.

### Deleting an item or a group order
In **Group Orders**, every group order and every item has a **Delete** button. It checks first, then tells you exactly what will go before you confirm (and does nothing until you do).
- **It can be deleted** when nothing real depends on it. Any unconfirmed requests people had made on it are removed with it (the confirmation tells you how many people that affects), along with its pictures, sizes, members and sets.
- **It can't be deleted** if anyone has a **confirmed** claim on it (those are real orders — cancel them first on the Claims tab), or if any claim on it has had **payments, a parcel or a box** behind it (even if later cancelled — those records have to stay), or if the item was included in a **proxy payment**. It tells you which. In those cases, **close the order and tick private** instead, which hides it from the shop without losing anything.

### Looking at the site as a joiner
The top of the admin page has **View the shop ↗** and **View My orders ↗** links that open the joiner-facing site in a new tab.

### Keeping the server up to date with GitHub
Put the code on GitHub once, and from then on updating the server is one command that **backs up first**, pulls the new code, rebuilds, and checks the site came back.

**Set up (once)**
1. **GitHub → New repository.** Name it `stormofshadowss`, choose **Private**, and leave "Add a README" unticked.
2. **Put this folder in it.** Easiest is **GitHub Desktop** (desktop.github.com): *File → Add local repository* → pick the unzipped folder (let it create the repository) → *Publish repository* → keep *Keep this code private* ticked. The project's `.gitignore` already keeps your `.env`, your data and `node_modules` off GitHub — glance at the list of files and check `.env` isn't in it. (GitHub's website only lets you upload 100 files at a time and this project has about 160, so use GitHub Desktop.)
3. **Make a read-only key for the server.** GitHub → your picture → *Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token*. Name it "StormOfShadowss server"; expiry 1 year (set a reminder); *Repository access → Only select repositories →* `stormofshadowss`; *Repository permissions → Contents → Read-only*. Copy the token — GitHub shows it once.
4. **On the server** (Unraid: the terminal icon):
   ```
   cd /mnt/user/appdata
   git clone https://YOUR_TOKEN@github.com/YOUR_USERNAME/stormofshadowss.git
   cd stormofshadowss
   cp .env.example .env && nano .env
   docker compose up -d --build
   ```
   In `.env` fill in the settings as in Stage 1, and set `DATA_DIR=/mnt/user/appdata/stormofshadowss-data` so your data lives **outside** the code folder. If the terminal says `git: command not found`, run the clone like this instead (nothing to install): `docker run --rm -v /mnt/user/appdata:/git alpine/git clone https://YOUR_TOKEN@github.com/YOUR_USERNAME/stormofshadowss.git`. Then carry on with Stage 2 (creating the admin).

**Every time there's a new version**
1. On your computer, copy the new files over the repository folder (replace the old ones). GitHub Desktop lists what changed; type a short summary, press **Commit to main**, then **Push origin**.
2. On the server:
   ```
   cd /mnt/user/appdata/stormofshadowss
   bash deploy/update.sh
   ```
   It shows what's changing, takes a backup (and **stops without changing anything if the backup fails**), pulls, rebuilds, and waits for the site to answer. If anything goes wrong it prints the exact command to go back.

**Going back to an earlier version:** `bash deploy/update.sh abc1234` (use the 7-character code from the "was …" line). `bash deploy/update.sh` with nothing after it returns to the newest. If an update had changed the database layout and the old version won't start, restore the backup (see Stage 5).

**Good to know**
- Don't edit files on the server — the script refuses to update if you have, so nothing is silently overwritten. Make changes on your computer and push them.
- Your `.env` and your data are never touched by an update.
- When the token expires, make a new one and run `git remote set-url origin https://NEWTOKEN@github.com/YOUR_USERNAME/stormofshadowss.git` in the server folder.
- Updates are deliberately **manual**. The database changes itself when the new version starts, so you choose when to do it (and a backup is taken first), rather than having it happen unattended.

### Fresh install on Unraid with Docker Compose Manager (one YAML + one env box)
The simplest way to run it: no cloning, no terminal. The stack builds the app straight from your GitHub repository, and creates your first admin login from the settings. It uses its own names, folder (`/mnt/user/appdata/sos`), network and port (**2999**), so it won't clash with any other install — you can run it beside an older one and stop the old one when you're happy.

**You need:** Unraid's **Docker Compose Manager** plugin (Community Applications), and this version of the project on GitHub (the build downloads it from there).

1. **Decide how the build reaches GitHub.** *Public repository:* nothing to do. *Private repository:* put a read-only token in the address (step 4).
2. **Docker tab → Compose → Add New Stack.** Name it `sos`.
3. **Compose file:** paste the whole of `deploy/unraid/docker-compose.yml` (open it on GitHub and copy).
4. **Env file:** paste `deploy/unraid/stack.env.example` and fill in the first section:
   - `REPO_URL` — your repository, e.g. `https://github.com/YOUR_USERNAME/stormofshadowss.git#main`. Private: `https://YOUR_TOKEN@github.com/YOUR_USERNAME/stormofshadowss.git#main`.
   - `DB_PASSWORD` — a long random value (in the terminal: `openssl rand -base64 24`).
   - `PUBLIC_URL` — `http://YOUR_UNRAID_IP:2999`.
   - `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` — your GOM login. The password needs 12+ characters and must not contain the username. (Left as `CHANGE-ME`, no admin is made and the app's log says so.)
   (The labels in the plugin may differ slightly between versions.)
5. **Compose Up.** The first build takes a few minutes. When the `sos-app` container is running, open `http://YOUR_UNRAID_IP:2999/admin.html` and sign in.
6. **Then, in the admin:** add your artists/groups, payment methods, proxies and group orders (or use the Import tab for the Notion masterlist). Once you've signed in, delete the `INITIAL_ADMIN_PASSWORD` line from the env box — it's ignored once an admin exists anyway.

**Updating:** after new files are on GitHub, press **Compose Up** again. It rebuilds from the newest code (instantly from cache if nothing changed) and restarts the app; the database changes itself on start. Nightly backups run automatically; for an extra one just before an update, in the Unraid terminal: `docker exec -e ONCE=1 sos-backup /bin/sh /backup.sh`.

**Where things are:** database, pictures and backups are all under `/mnt/user/appdata/sos`. Containers are `sos-app`, `sos-db`, `sos-backup`. One optional extra, switched on with `COMPOSE_PROFILES=tools` in the env box: a database viewer on port 8081 (this machine only).

**If something's wrong**
- *Build fails with "repository not found":* `REPO_URL` has a typo, or the repository is private and has no token in the address.
- *You can sign in but it signs you straight out:* `COOKIE_SECURE` must be `false` while you use plain `http://`.
- *The page opens but looks bare — no styling, no group cards, just a link or two:* this happens when the site is opened over plain `http://` and the server tells the browser to fetch its stylesheet and scripts over `https://`. It was a bug in earlier versions; update to this version and keep `COOKIE_SECURE=false` in the env box while you use plain `http://` (set it to `true` only once the site is served over https). To check, press F12 → Network, reload, and look for failed requests to `https://…`.
- *Page won't load:* check `sos-app` is running, that nothing else uses port 2999, and the log (`docker logs sos-app`) — it prints `Created the first admin …` or says why not.
- *Forgot the admin password:* in the terminal, `docker exec -it sos-app node src/admin-cli.js set-password gom`.
- Port 2999 on `0.0.0.0` means anyone on your home network can reach the login page over plain http. That's normal for a home server.

### Joiner settings, and deleting an account
On their **My orders** page joiners now have a **My settings** card. It holds:
- **Instagram handles** — add another, or **remove** one (only when it has no orders in progress, nothing owing and no credit). The box that used to sit on the home page moved here; a brand-new person with no handle still sees "Link your Instagram handle" on the home page so they know where to start.
- **Sign-in email** — change it: a confirmation link goes to the **new** address and nothing changes until it's opened there; they're signed out on other devices and the old address is told.
- **Shipping defaults** — a saved bias and Lomo name, pre-filled (never forced) when they ask for shipping or accept a friend's invitation.
- **Emails from us** — leads to the email page, where each kind of email (claims confirmed, payment decisions, parcel posted, friend invitations, cancellation answers, overdue reminders) can be switched on or off.
- **Delete my account** — see below.

**What deleting an account does** (the person is never told this part — the screen just says their account and details are deleted):
- **Blocked while** they owe money on a confirmed order, a payment is waiting to be checked, they've asked to cancel something and you haven't answered, or a parcel is on its way (theirs, or one with their items in it). The Settings page lists exactly what's in the way.
- **If they have no financial record** (no confirmed order, confirmed payment or credit movement): everything about them is erased, including the handle.
- **If they do:** the orders, amounts, payments and dates stay, but their login, email, delivery details, bias/Lomo names, parcel notes, payer names and their handle in your activity log are removed, and they appear to you as **deleted-123**. (A payment's *reference* is kept as the financial identifier; their handle and names are replaced if they typed them into it, but it can't catch anything else typed there.)
- **Their handle is kept instead** if they hold **credit** (so you can settle it — they then appear on the People tab's flagged list) or are **blocked** (so deleting can't shed a block).
- What is kept after deletion is explained in the site's **privacy notice** (below) — deliberately there, not on the delete screen.

### The privacy notice
Every page people order on (the shop, My orders, claim-your-orders) has a **Privacy notice** link at the bottom, and My settings links to it too. The notice is the page `public/privacy.html`: plain-English sections on who runs the site, what is kept and why, cookies, who else sees it, the legal reasons, **how long it's kept** (including what survives when someone deletes their account), people's rights, and the Information Commissioner's Office.

**Please read it once and make it yours.** It's a sensible draft written from what the site actually does — it isn't legal advice. Check especially:
- **Contact:** set `CONTACT_EMAIL` in your env box to an address people can write to (it appears as a link in "Who we are"). Without it the notice says to get in touch the way people normally order.
- **"Who else sees it":** it says delivery details go to postal/courier services only to deliver parcels, and that the site runs on a server you control. Change those lines if that stops being true (for example if a proxy or a friend handles posting).
- **"How long we keep it":** it says financial records are kept "for as long as accounting, tax and dispute rules require". If you know the period that applies to you, put it in.
- Change the **"Last updated"** date whenever you edit it.

The tests that guard it fail if the site starts setting a new cookie, loads something from another company's server, or changes who can delete their account — so the notice can't quietly stop being true.

### Group pages
Each artist/group has **its own page** on the shop. The **home page** is now just the groups that have group orders **open** (each a card with its picture and how many orders are open) plus the Shop card; the orders themselves live on each group's page, at an address like `/#/group/3-stray-kids`. A group page has **tabs along the top** to jump between groups (the groups with orders open, plus the one you're on), that group's open orders, and its **closed orders** tucked into a collapsible list. Private orders appear nowhere.

A group with **nothing open is left off the home page and the tabs** — but its page still works by its link, says "No group orders are open … right now", and shows its closed orders. The moment you open an order for it, it appears on the home page and in everyone's tabs. **Creating a new group** in the admin gives it a page automatically (it just stays off the home page until it has an open order).

Things to know: closed orders are now only reachable from a group's page (the home page no longer lists them), so a quiet group's closed orders can only be found by its link. A group's id is what matters in the link — the name part is just for reading.

**If you've edited `public/site/shop.js`:** the home page and group pages now come from a new file, `public/site/shop-groups.js`, loaded before `shop.js` in `public/index.html`. In `shop.js` three small things change — the end of `route()` hands over to it, the order page's "back" link names the group, and the three item-type pills (`member set`, `pick any members`, `random`) are removed. The home page's intro wording now lives in `public/site/shop-groups.js` (the old `home()` in `shop.js` is only a fallback if that file doesn't load), so edit it there from now on. The order cards on group pages are drawn by `shop-groups.js` too.

### Day-to-day admin tidy-ups
- **Select all.** On the **Claims** tab, *Select all N confirmed claims shown* ticks everything currently listed — narrow with *Group order*, *Stage* or the search box first to select just those. (Each group order and each person also has its own select button.) On the **Warehouse** tab, *Select all*, *Select all in "<group order>"* and *Clear* tick the items going into a box.
- **Packing list.** The "Delivery address checked" tick is gone — it isn't needed to pack. Each item that has a picture shows a small thumbnail: tap it to open the picture under that item, tap again to close it.
- **Parcels on their way.** Joiners now see a highlighted *Parcels on their way* card at the **top** of My orders (and at the top of the Ongoing page), with the *It's arrived* button, instead of at the very bottom.
- **Being your own proxy.** On the **Proxy** tab, *Your proxies* lists each proxy with a *this is me* tick. Orders (or single items) that use a proxy you've ticked never appear in the "to pay a proxy" list, and can't be logged as a proxy payment.

### Cancelling a group order or an item
For something that can't be fulfilled (say a photocard set sold out). On **Group Orders**, press **Cancel…** on the group order's row — or open its **Items** and press **Cancel…** on one item.
1. **See the impact first.** A panel shows how many claims (confirmed and unconfirmed) and how many people are affected, and how much of what they've paid will go back to them as **credit**. Anything in the way — a claim already inside a parcel or a warehouse box — is listed, and the cancel button isn't offered until you've sorted it (it's all-or-nothing: nothing is cancelled if anything is blocked).
2. **Type the name** of the order or item to unlock the button (capitals and spacing don't matter), then press it.
3. **One last "are you sure".** Then every live claim on it is cancelled and the money returned as credit. Claims already **received** are left alone.
- **Nobody is emailed.** You tell people yourself.
- A cancelled **group order** closes and disappears from the shop; a cancelled **item** disappears and can't be claimed. Both stay visible to you in Group Orders, marked *Cancelled*, and are removed from the Sets tab and the proxy "to pay" list. Standing (fixed) claims on them end.
- A blocked handle's payment is **not** credited, as with any cancellation — the panel says so before you confirm.
- Later you can still **Delete** a cancelled order if nothing was ever paid on it; one that had payments on it is kept (its records stay).

### Test data, launching and going live
There's a **Launch** tab (at the end of the tab row) for the move from testing to the real thing.
- **Mark test orders.** When you create or edit a group order, tick **Test order**. It gets a *Test* pill in the list.
- **Delete a test order with everything on it.** On the Launch tab, *Delete…* shows exactly what goes — its claims, the payments made towards them, parcels, boxes, proxy payments, pictures — and puts anyone's credit back to how it was before that order. Type the order's name, then confirm once more. The people stay. It **refuses** (and says why, deleting nothing) if something on it is shared with another order — a payment that also paid for another order, a parcel/box/proxy payment that also holds other orders' items — or if removing it would leave someone's credit negative because that credit was spent elsewhere. In those cases delete the other test orders too, or use Reset.
- **Reset for launch.** Wipes **every** order, item, claim, payment, parcel, box, proxy payment, shop item, picture and log. **Kept:** your artists/groups, payment methods, proxies and your own GOM login. You choose whether to **keep people** (accounts, Instagram handles, delivery details — their orders, payments and credit are still wiped).
  1. **Take a backup first** (the tab shows the command): `docker exec -e ONCE=1 sos-backup /bin/sh /backup.sh`, then tick *I've taken a backup just now*. The site can't check that you did, so this is on you.
  2. Type **RESET**, press the button, confirm once more.
  Do it when nobody is using the site, and **before** the Notion import.
- **Go live.** The last step, once real data is in: type **GO LIVE**. It is **permanent** — resetting and deleting test orders are then switched off for good, so a real order can never be wiped by accident. (If you ever press it by mistake, the only way back is the database: `docker exec -it sos-db mariadb -u sos -p sos` then `UPDATE launch_state SET launched_at = NULL WHERE id = 1;`.)
- **Suggested order:** finish testing → Launch tab: backup, **Reset** → check your groups, payment methods and proxies → Notion import → **Go live**.

### Claims and Payments when there's a lot
- **Claims tab: By person / By item.** The two buttons at the top switch the grouping (your choice is remembered in that browser). *By person* is the familiar view; *By item* shows one block per item — claims, people, stage mix, what's owed — and opening it lists who has it. In either view the tick-box on a person, an item or a merged row selects those claims, and the bar at the top moves them all to a stage in one go.
- **Identical claims are one row.** Several confirmed claims of the same item for the same person (same stage and same costs) show as **"independent item — Felix ×5"**. Change the stage on that row and all five move; *Show the 5* opens the individual claims (to edit costs or cancel one). Claims that differ — a different cost, a request that isn't confirmed yet — stay separate.
- **A collapsed person still tells you where things are:** their claim count, what they owe, and up to three stages with counts.
- **The stage strip** under the filters shows how many claims are at each stage (plus *owing money* and *waiting to be secured*). Click one to show just those; click it again to clear. Combine it with *Select all N confirmed claims shown* and the move bar for "everything that's arrived → ready to pack".
- **Expand all / Collapse all**, and **Show more** (25 people or items at a time per group order). Searching for a handle or item opens every match and is never cut off at 25.
- **Nothing is silently left out.** The list now carries up to 20,000 claims (it used to stop at 1,000, so people late in the alphabet could be missing). If there were ever more, a box at the top says so — narrow with *Group order*.
- **Payments tab.** *Where joiners send payment* is now a collapsed one-line summary ("3 methods: PayPal Friends & Family, Bank Transfer, Wise · click to edit") once you have methods; it opens by itself only when there are none, stays open if you open it, and tucks itself away again after **Save**.

### Open spots in sets
- **New claims fill the earliest open spot — including in a set you've already secured.** A secured set is already bought, so a spot that opens in it (someone's claim was cancelled) is real. The next person to claim that member goes there before a new set is started. Sets you've **cancelled** are never refilled.
- **That claim waits as "requested" until you confirm it.** On the **Sets** tab the secured set shows *N new requests waiting* with a **Confirm** button (the Sets tab badge counts them too); on the **Claims** tab they count as "waiting to be secured" and **Secure all requested** confirms them. Confirming starts what the person owes (their credit is used first) and emails them if they've asked for that. A request in a set still waiting for your decision is still secured with the set, as before.
- **What people see while claiming.** Under each member: *open in Set 1, 3 +2 more*, or *next one starts a new set*. Under the members, a collapsed **"See where the open spots are"** grid lists the sets that have room (first 20; the rest are counted), each part marked *taken* or *open*, with secured sets marked. "Where they'll go" says when a part will join an already-secured set.
- **A deadlock fix (rare, but real):** claiming at the exact moment you secured, cancelled or assigned in the same set could make one request fail with a server error. Every set action now takes its locks in the same order as claiming, so that can't happen.

### The look of the shop (Soft Pop) and light / dark
- **Soft Pop** is the look: white and lavender with an orange accent, soft shadows and rounded cards. It's the same colour scheme in the GOM pages, just tighter (smaller corners, no big shadows, denser rows) so they stay easy to work in.
- **Light / dark.** The footer button *Dark mode* / *Light mode* switches a deep-aubergine dark look; the choice is remembered in that browser only. Dark is optional — light is what everyone sees first.
- **Change the colours** in one place: the first lines of `public/style.css` (`--accent` is the orange; `--accent-ink` is the same orange used for text and links). If you change a colour, run the tests — one checks, with numbers, that every text/background pairing is readable in both looks.
- **Home page.** A single row of round group avatars (scroll sideways), **filter chips** (All / Boy bands / Girl groups / Solos / Duos — only the types you've set on groups appear), and quiet tabs: **Open now**, **Closing soon** (closing within 7 days), **New** (created in the last 7 days). Orders show as picture cards with a small flag.
- **Set a group's type** on the Group Orders tab → *Artist / group pictures and type*. A group with no type only shows under All.
- **Claiming.** The order page shows each item as a compact row (small picture or a coloured tile with its initials, the details, the +/− buttons) under a **1 Choose → 2 Check → 3 Claim** tracker that carries on through the basket and the "claims submitted" page. On a phone a bar along the bottom has **Home, Basket (with a count) and My orders**.

### Part-paid parcels (a heads-up, never a block)
- **How part-payments work.** A person can pay any amount up to what they owe; each payment is verified by you separately and applied **oldest claim first**, and within a claim in the order Initials → EMS → Customs → Doms → Packaging. The claim shows what's left, and flips to paid only when the last pound is verified. A claim stays **overdue** until the whole amount is in (the Overdue tab shows what's still owing, and the reminder email goes out once per claim). If they pay more than they owe they choose credit or tip.
- **On the Packing tab.** If anything is still owing on what's in a parcel, its card shows an amber **Still owing** banner: who (a shared parcel can hold a friend's items), how much, split into items / EMS / customs / postage / packaging — and whether a payment from them is **already waiting for you to verify** (the "paying the last balance together with the postage" case). The **Mark packed** confirmation repeats the figure. It's only a warning: you can still pack, ship and receive. Once the final payment is verified the banner disappears.

### Incoming: orders you place with shops
**Warehouse tab → Incoming** (the *Boxes / Incoming* switch at the top). For when you order yourself — or a proxy does — and have to split an order across shops because of purchase limits or stock, and then need to know what has reached your Korean warehouse and which shop to chase.
- **Save your warehouse address** once (top card) and use *Copy address* at any shop's checkout.
- **+ New store order**: the shop, your order number, a **link** to the order/confirmation page, the date, who placed it (Me, Sam, Yuki…), notes, **what's on it** (item + how many, so "3 of the 12 from this shop, 5 from that one") and **tracking numbers** to your warehouse (add them now or later; any number per order). *Confirmations are kept as a link + number + notes only* — no file uploads.
- **Waiting / Arrived / Cancelled / All** chips list your store orders; *Waiting* is **oldest first**. Each card shows how many days it has been waiting, a **Chase this shop** flag once it's 14+ days old (and not chased in the last week), and *no tracking yet* if there's none. Type **how many have arrived** on each line (it saves as you change it) — the card goes *Waiting → Part arrived → Arrived*. **All arrived** does the lot in one go; **Chased today** records it. Each tracking number has **Copy**, a **Track ↗** link to the carrier's own page (CJ Logistics, Korea Post/EMS, Lotte, Hanjin, Logen, DHL, FedEx, UPS — the site never looks parcels up itself, so your tracking numbers aren't sent anywhere), and **Mark arrived**.
- **By item** chip: for each item, **needed** (confirmed claims, or secured sets) / **ordered** / **arrived**, and what's *still to order*, *on the way*, or *over*. **Mark ordered… / Mark arrived…** work out which claims should move on — **the oldest ones**, up to what you've ordered / what has arrived — show you who, ask first, and then use the ordinary *move stage* action (so it still leaves alone cancelled claims and ones already in a parcel or box). Sets move as whole sets.
- Counts are **per item**, not per size or member — use the note on a line for that ("size L ×2"). An item that's on a store order can't be deleted until you remove it from the order. **Reset for launch** clears store orders (your warehouse address is kept).

### Behind Cloudflare and a reverse proxy: `TRUST_PROXY`
`TRUST_PROXY` tells the site how many proxies are in front of it so it can see each visitor's **real** address. Left at `0` behind a proxy, every visitor looks like one address, so the sign-in-link, claim and admin-login **limits are shared by everyone** (ten people claiming at once can lock each other out). Use **`1`** for one reverse proxy (e.g. Nginx Proxy Manager) and **`2`** for Cloudflare with the orange cloud in front of one. To check it's right: sign in from your phone on mobile data, then run `docker exec -it sos-db mariadb -usos -p sos` and `SELECT created_at, ip FROM sessions ORDER BY id DESC LIMIT 5;` — you should see your phone's public address, not your proxy's.

### The Sets tab at scale
- **One line per set:** its number, a row of dots (one per part: hollow = open, orange = held and waiting, green = confirmed — hover a dot for the part and who holds it), `5/8`, which parts are still open, a status (*ready to secure*, *needs 2 more*, *secured*, *cancelled*) and quick buttons (**Secure**, **Cancel set**, or **Confirm** for new requests that joined a secured set). Click the line to open its parts (add someone, split cost & raffle…). A list of three sets or fewer opens by itself.
- **Grouped under their item,** with counts (sets / ready / to fill / secured), 12 sets at a time with *Show more*.
- **Chips:** *To decide* (the default), *Ready to secure*, *Secured*, *Cancelled*, *All* — each with a count. **Find a handle, member or item** searches (with or without the @) and opens whatever matches. **Open all / Close all.**
- **Secure all N…** (when sets are *ready*: every part held, no price TBC, no pending cancel request): confirms them one after another and tells you if any couldn't be secured. A set that can't be secured yet says why under its line.

### Folding, overdue and Select all (found while importing real data)
- **My orders (joiners):** *Ongoing* and *Completed orders* are one card per group order that **folds away** (click its name; **Open all / Close all**). A short list (three or fewer) opens by itself; with more, they start folded — **except any group order with something overdue, which stays open**. The header says how many items and what's owed (*£X to pay*) or, in red, *N overdue · £X*.
- **Overdue is red** everywhere: the pill, the item's left edge, "was due 20/09/2026", the cost chip, the order's badge — and the **dashboard** shows a red *You have overdue payments* notice at the very top (the total, how many items, which orders, *Pay now* and *See which items*). It only counts what is still owed and clears once it's paid.
- **Request shipping** has **Select all N** and **Clear** above the item list (also when joining a friend's parcel), shown when there are two or more items.
- **GOM → Claims:** each group order is **one line** (its name, claim counts, what's owed, and *Secure all requested*) until you click it open. Three group orders or fewer open by themselves; **Expand all / Collapse all** work on everything; **searching or choosing a stage / "still owes money" always opens what it found**. Works in *By person* and *By item*.

### Adding a claim for someone (Claims tab → **+ Add a claim**)
For **a gap in an import** (a person who's missing a claim) and for **orders that come by message** (often on a *private* group order). It follows exactly the same rules as when a joiner claims — same prices, same TBC rule, same placement into member sets — except that **you can add to private and closed group orders**.
- **Person:** type their handle (suggestions appear as you type — including people who have no claims yet). If they're not on the site at all, tick **New person** to create them.
- **Group order → item → how many.** A size item asks for the size; a member item asks which members and how many of each; a member set asks which parts (and *keep together*), and says afterwards which set each part went into.
- **Status — you choose every time, there's no default:** **Requested** waits for you to secure it, like a joiner's claim. **Confirmed** counts as owed straight away and uses any credit they hold; it also asks *where it is now* (e.g. already arrived at the warehouse). A set part can't be confirmed until its set is secured, and a TBC-priced item can't be confirmed until the price is set — those stay as requests and the message says so.
- **They see it in My orders like any other claim. No email is sent.** After adding, **Show @handle's claims** takes you to them; you can then record anything already paid with *Edit costs*.
- A **new person** you create has no account yet; when they sign in and add that handle, it asks for your approval (because the handle already has claims) — the usual safety.
- *Not included:* on-hand **Shop** items (those are claimed from the Shop page).
