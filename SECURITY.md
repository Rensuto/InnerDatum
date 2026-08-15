# Security Policy

Inner Datum is a hobby game for a handful of friends, but every instance is a **self-hosted server
exposed to the public internet** — the Discord Activity proxy can only reach it if the whole world
can. So security reports are genuinely useful here, and I would much rather hear about a problem
quietly than read about it in a public issue.

## Reporting

Use **GitHub's private vulnerability reporting**: repository → **Security** tab → **Report a
vulnerability**.

That keeps the report private until there is a fix, and avoids putting an email address in a public
repo for scrapers.

Please include what you did, what happened, and what you expected. A curl command or a WebSocket frame
is worth three paragraphs of prose.

**Scrub personal data first.** Logs and crash dumps contain real people's Discord user IDs and display
names — replace them with `<user1>`.

## What I care about

Roughly in order:

- **Auth bypass** — anything that lets an unauthorised Discord account connect, or lets a client assert
  an identity the server didn't verify via `/users/@me`.
- **Session token forgery** — anything that produces a valid WebSocket handshake token without an OAuth
  round-trip.
- **Exposure of the ops control panel** — it binds `127.0.0.1:3001` by design and is never routed
  through Caddy or the Discord URL Mapping. Any path that makes it reachable from off-box is a real
  finding.
- **Remote code execution or path traversal**, particularly in save loading, content loading, or the GM
  command surface.
- **Reading another player's data** — save files, characters, or FOV-hidden map state leaking through
  the state projector.
- **Secret disclosure** — any path where the client secret, bot token or session key reaches a log, an
  error body, or the client bundle.

## What I don't

- Self-hosting misconfiguration (you opened port 3000 to the internet, you disabled the allowlist, you
  forwarded 3001, you put a credential in a screenshot).
- Denial of service by an authorised party member. Everyone who can connect is someone I invited; if a
  friend wants to crash my server they can just ask.
- "The game is cheatable." The server is authoritative for damage, randomness and inventory — if you
  find a case where it *isn't*, that IS in scope and I want it. But an invited player being able to
  play badly on purpose is not a vulnerability.
- Missing hardening headers on a static asset route.
- Automated scanner output with no demonstrated impact.

## Supported versions

| Version | Supported |
|---|---|
| `main` | Yes — it is the only version that exists |
| Anything else | No |

There are no release branches and no backports. The fix for any security issue is: pull `main`.

## Please do not test against the live host

The only running instance is a PC in someone's house, and the people connected to it are their
friends, on their real Discord accounts. Scanning it, fuzzing it, or "just checking" the auth boundary
against it hits real people, not a staging environment.

**Run your own instance instead.** The hosting and Discord-Activity runbooks under `docs/` get you
there in an afternoon, and you can then break it as thoroughly as you like.

## What to expect

One person, evenings and weekends, on a game for about six people.

**There is no response time, no triage commitment, no fix timeline, and no bounty**, and I will not
agree to a disclosure deadline as a condition of receiving a report. I read reports when I read them.
If that is incompatible with your disclosure policy, publish on whatever schedule suits you — I would
rather you did that than have me promise something I cannot keep. The blast radius here is one
household PC and up to ten friends' Discord user IDs.

You'll get a credit in the fix commit if you want one.

What I *can* commit to, because it is a mechanism rather than a promise: reports arrive as GitHub
security advisories, so they sit in the repository's Security tab rather than in an inbox I might not
read. Nothing gets lost even when nothing gets answered quickly.

## If you are self-hosting this

The hardening checklist is the security section of the hosting runbook under `docs/`. The three lines
that matter most:
bind Node to `127.0.0.1` only, keep the Discord snowflake allowlist populated, and never forward port
3001. A tunnel or a reverse proxy makes your *network* safe, not your *app*.

---

# If a secret is ever committed

This applies to maintainers and contributors alike. Do these **in this order**.

### 1. Rotate first. Immediately. Before anything else.

History rewriting is cleanup; rotation is the fix. Assume the secret is already public the moment it
is pushed — public-repo commits are streamed through GitHub's public events firehose and scraped by
bots within seconds, routinely faster than a human can react.

| Leaked | Rotate |
|---|---|
| Discord **client secret** | Portal → OAuth2 → **Reset Secret**. Effective immediately |
| Discord **bot token** | Portal → Bot → **Reset Token** |
| **SESSION_SECRET** | Generate a new one, restart. Everyone gets logged out; that's the whole cost |
| **No-IP DUC password** | Change it at noip.com and update the DUC. It controls where your hostname points |
| **Cloudflare tunnel token** | Zero Trust → Networks → Tunnels → delete the tunnel and create a new one. Reinstall the service. Do not merely "refresh" and assume |
| **cloudflared `cert.pem`** | Cloudflare dash → revoke the origin cert, re-run `cloudflared tunnel login`. Treat as account-level: this file creates tunnels and DNS on your zones |
| **Caddy `%AppData%\Caddy\data\`** | Delete the directory and let Caddy re-issue. It holds the ACME account key and every issued private key |
| **Backup deploy key / PAT** | Revoke on GitHub, issue a new one |

Helpfully, Discord participates in GitHub's secret-scanning partner programme, so a bot token pushed
to a public repo is often auto-revoked and reported to you within minutes. **Do not rely on that** —
it does not cover the client secret, your own session key, or your hosting credentials.

### 2. Then, and only then, clean history

```bash
# git-filter-repo (preferred over BFG and over filter-branch)
pip install git-filter-repo
git filter-repo --invert-paths --path=.env
git push --force --all
git push --force --tags
```

**Understand what this does not do.** It does not reach:

- Anyone's existing clone or fork. Forks of a public repo are independent copies and GitHub will not
  rewrite them for you.
- GitHub's own cached views. A dangling commit stays fetchable by SHA through the web UI and API until
  GitHub garbage-collects it — you have to open a support request to force that.
- Search-engine caches, archive sites, and whatever a scraper already stored.

That is the entire reason step 1 comes first.

### 3. Clean up around it

- Delete forks you control; ask collaborators to delete and re-clone (a stale clone will happily push
  the old history back).
- Ask GitHub Support to purge cached views of the affected commits.
- Check for abuse: your hosting provider's audit log for activity you didn't cause; Discord Portal for
  a bot in servers you never invited it to.

### 4. Make it not happen again

- Repo → Settings → **Code security**: enable **secret scanning** and **push protection** (free on
  public repos). Push protection blocks the push at the point of the mistake — but only for pushes made
  after you turn it on, so turn it on *before* the first push, not after the first leak.
- Run `gitleaks protect --staged` in a pre-commit hook.
- Keep the habit that makes all of this moot: secrets only ever in `.env`, and `.env` in `.gitignore`
  in the **very first commit**.
