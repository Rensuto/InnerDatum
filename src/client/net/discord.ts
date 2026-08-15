/**
 * THE DISCORD HANDSHAKE. The client's half, and only its half.
 *
 * WHAT THIS FILE PRODUCES IS A SESSION ID, NOT AN IDENTITY. It asks Discord for
 * an OAuth `code`, hands that code to our own server, and receives back an
 * opaque 43-character handle that means nothing anywhere else and cannot be
 * read by the page that holds it. The server exchanged the code with its own
 * client secret and then asked Discord `GET /users/@me` — that answer, which
 * this file never sees, is who the player is. CLAUDE.md non-negotiable #5 and
 * docs/discord-activity.md § 5 both say it plainly, and Discord's own rule is
 * blunter: "assume any data coming from the Discord Client could be falsified.
 * That includes data about the current user."
 *
 * So `commands.authenticate` gives us a `user` object here and this module
 * deliberately drops it on the floor. Our name, our avatar and everyone else's
 * arrive in `welcome`, `joined` and `party` — frames the SERVER composed. One
 * source of truth for a name means the client cannot end up drawing itself as
 * somebody the server has never heard of, and there is no code path in which a
 * Discord id this file learned reaches the socket. The protocol has no field
 * for one and must never gain one.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE STANDALONE PATH IS A FIRST-CLASS MODE, NOT AN ERROR PATH
 * ───────────────────────────────────────────────────────────────────────────
 * `npm run dev` in a browser tab, and tools/e2e-m1.mjs, have no Discord client
 * anywhere near them. docs/discord-activity.md § 7 is explicit that the
 * `DiscordSDK` constructor THROWS when `frame_id` is absent, so the mode is
 * decided by looking for that parameter BEFORE anything is constructed — never
 * by catching the throw. That distinction is the whole design of this file: a
 * try/catch around the constructor would turn "Discord answered with an error"
 * into "you are probably a browser tab", and the day the real handshake breaks
 * inside a real Activity every player would silently become anonymous instead
 * of being told. An error inside an Activity is reported AS an error, with a
 * sentence, and the session stays null.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * `rpc.voice.read` IS ALLOWED TO FAIL (PLAN.md R13)
 * ───────────────────────────────────────────────────────────────────────────
 * docs/discord-activity.md § 5 records it as available-but-unproven: the OAuth2
 * scope table marks it "only available to approved partners", while Discord's
 * own Activity Starter requests it uncommented. So the authorize call is made
 * TWICE if it has to be — once asking for everything, and if that is refused,
 * once asking only for what the game cannot run without. A speaking dot is
 * worth zero games. Whether it was granted is reported as `voice`, confirmed
 * against the scope list `authenticate` returns rather than assumed from the
 * absence of a throw.
 *
 * EVERY URL IS RESOLVED AGAINST `document.baseURI`, exactly as net/socket.ts
 * resolves `ws` and render/assets.ts resolves `./assets/`. Inside the Activity
 * the app is served through Discord's proxy, which may mount it under a
 * `/.proxy/` prefix; a root-absolute '/api/token' resolves against the proxy
 * root instead of the app's own path. Resolving against the document's own base
 * is correct under `/`, under `/.proxy/`, and under the Vite dev server, with no
 * environment switch and no `patchUrlMappings` (gotcha 8).
 */

import { DiscordSDK, Events } from '@discord/embedded-app-sdk';

/**
 * Which world this client woke up in.
 *
 * Not a boolean, because "we are in an Activity and the handshake failed" and
 * "we are a browser tab and there was no handshake to run" are opposite facts
 * that a boolean would flatten into one — and the first must produce a visible
 * error while the second must produce silence.
 */
export const ClientMode = {
  Activity: 'activity',
  Standalone: 'standalone',
} as const;
export type ClientMode = (typeof ClientMode)[keyof typeof ClientMode];

/**
 * One person connected to THIS Activity instance.
 *
 * `id` is a Discord snowflake and stays inside the client: it is here so a
 * future frame can join a roster row to a body, and it is never sent anywhere.
 * `name` is arbitrary user input — Discord does not sanitise nicknames — so it
 * may only ever reach the screen through `fillText` or `textContent`.
 */
export type DiscordParticipant = {
  readonly id: string;
  readonly name: string;
};

export type DiscordHandshake = {
  readonly mode: ClientMode;
  /**
   * The opaque session id from `POST /api/token`, or null when there is no
   * verified identity (standalone, or a refusal). Present it in `hello`; it is
   * a claim on a session the SERVER minted, not a claim about who anyone is.
   */
  readonly session: string | null;
  /** True only when `rpc.voice.read` was actually granted. See the header. */
  readonly voice: boolean;
  /** One readable sentence when the handshake failed, else null. */
  readonly error: string | null;
  /** Who is connected to the Activity instance right now. Never the VC roster. */
  readonly getParticipants: () => readonly DiscordParticipant[];
  /**
   * Watch the roster. ONE listener, because this client has exactly one
   * consumer (main.ts) and a listener array would be a subscription system
   * built for nobody. It fires immediately with the current roster so a caller
   * that registers late does not sit empty until the next change.
   */
  readonly onParticipants: (
    listener: (participants: readonly DiscordParticipant[]) => void,
  ) => void;
};

/**
 * What the game cannot run without.
 *
 * `identify` is the player. `guilds.members.read` is the server nickname, which
 * is the name their friends actually recognise — the party panel showing a
 * global username nobody uses is a panel people have to decode.
 */
const REQUIRED_SCOPES = ['identify', 'guilds.members.read'] as const;

/** The speaking indicator, and nothing else. Refusable; see the header. */
const VOICE_SCOPE = 'rpc.voice.read';

/**
 * How long the SDK gets to answer its own handshake.
 *
 * `ready()` resolves in milliseconds when Discord is listening and never at all
 * when it is not (an old client, a broken bridge, gotcha 7). Ten seconds turns
 * "the game never loads" into a sentence somebody can report.
 */
const READY_TIMEOUT_MS = 10_000;

/**
 * How long `POST /api/token` gets.
 *
 * Generous on purpose: the server makes TWO calls to Discord behind it, each
 * with its own eight-second budget (src/server/http/auth.ts), and gotcha 13 —
 * a residential IP inheriting a Cloudflare block — is exactly the case where
 * they run long. Better a slow success than a client that gave up at five.
 */
const TOKEN_TIMEOUT_MS = 20_000;

/** An RPC round trip inside the desktop client. Fast or broken, never slow. */
const COMMAND_TIMEOUT_MS = 10_000;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Bound a promise that has no timeout of its own.
 *
 * `Promise.race` rather than a wrapper that resolves twice: the loser is simply
 * ignored, and the `finally` clears the alarm so a fast success does not leave
 * a ten-second timer holding the event loop awake.
 */
function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer = 0;
  const alarm = new Promise<never>((_resolve, reject) => {
    timer = window.setTimeout(() => {
      reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)}s`));
    }, ms);
  });
  return Promise.race([work, alarm]).finally(() => {
    window.clearTimeout(timer);
  });
}

/**
 * Are we inside a Discord Activity?
 *
 * `frame_id` is the parameter Discord appends when it opens the iframe, and
 * docs/discord-activity.md § 7 names it as the gate. Checked BEFORE the SDK is
 * constructed — see the header for why this is not a try/catch.
 *
 * Only `frame_id` is tested even though the constructor also wants
 * `instance_id` and `platform`. That is deliberate: a launch carrying a
 * `frame_id` and nothing else IS an Activity launch that has gone wrong, and it
 * deserves the real error rather than being quietly demoted to a browser tab.
 */
function isEmbedded(): boolean {
  return new URLSearchParams(window.location.search).get('frame_id') !== null;
}

/**
 * The Activity's client id, which is public by construction — it is in the
 * Activity's own URL. vite.config.ts explains at length why this is the only
 * secret-shaped value allowed to carry a `VITE_` prefix.
 *
 * Narrowed through `unknown` rather than used as it comes: Vite types every
 * custom key as `any`, and an `any` flowing into the authorize call is one typo
 * away from sending `undefined` as a client id and getting an error message
 * about OAuth instead of about a missing .env line. Written as the literal
 * member expression `import.meta.env.VITE_DISCORD_CLIENT_ID` because that is the
 * form Vite replaces with the value at build time; reaching it through a
 * variable makes it inline the whole env object instead.
 */
function readClientId(): string {
  const raw: unknown = import.meta.env.VITE_DISCORD_CLIENT_ID;
  return typeof raw === 'string' ? raw.trim() : '';
}

/** Same origin, same path prefix, whatever Discord served. See the header. */
function tokenUrl(): string {
  return new URL('./api/token', document.baseURI).href;
}

/**
 * The shape this client reads off a participant. Structural on purpose: the SDK
 * hands back a dozen more fields (premium type, avatar decorations, flags) and
 * naming only these four means a future SDK release adding a column cannot
 * break the build.
 */
type RawParticipant = {
  readonly id: string;
  readonly username: string;
  readonly global_name?: string | null;
  readonly nickname?: string;
};

/**
 * The name a friend in the voice channel would recognise, in the order Discord
 * itself prefers: server nickname, then display name, then the account name.
 */
function toParticipant(raw: RawParticipant): DiscordParticipant {
  const nickname = raw.nickname ?? '';
  const globalName = raw.global_name ?? '';
  const name = nickname !== '' ? nickname : globalName !== '' ? globalName : raw.username;
  return { id: raw.id, name };
}

/** The server's answer to `POST /api/token`, narrowed from `unknown`. */
type TokenBody = {
  readonly accessToken: string;
  readonly session: string;
};

/**
 * Read the two fields this client needs out of a JSON body it has not typed.
 *
 * `response.json()` is `any`, and an `any` reaching `authenticate` would be a
 * silent `undefined` inside an RPC call. This is a shape check on our own
 * server's output, not a trust boundary — but it must not throw, because the
 * only thing worse than a failed sign-in is a failed sign-in that took the boot
 * sequence with it.
 */
function readTokenBody(value: unknown): TokenBody | null {
  if (typeof value !== 'object' || value === null) return null;
  if (!('access_token' in value) || !('session_id' in value)) return null;
  const accessToken = value.access_token;
  const session = value.session_id;
  if (typeof accessToken !== 'string' || accessToken === '') return null;
  if (typeof session !== 'string' || session === '') return null;
  return { accessToken, session };
}

/**
 * The server's refusal, in the server's own words.
 *
 * src/server/http/auth.ts answers every failure with `{ error, message }` where
 * the message is written for a player ("this Discord account is not on the
 * allowlist — ask to be added"). Showing it beats anything this file could
 * invent, and the status code is the fallback when the body is not what we
 * expected — which is itself worth saying out loud rather than papering over.
 */
function readRefusal(value: unknown, status: number): string {
  if (typeof value === 'object' && value !== null && 'message' in value) {
    const message = value.message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return `the server refused the sign-in (HTTP ${status})`;
}

/**
 * Ask Discord for a code, giving up the speaking indicator rather than the game.
 *
 * The first attempt asks for everything. If it is refused — and per the header
 * `rpc.voice.read` is the one scope here that plausibly will be — the second
 * asks only for what the game needs. A failure of THAT one is a real failure
 * and propagates: without `identify` there is no player.
 *
 * DELIBERATELY UNBOUNDED, unlike every other call in this file: a first-time
 * launch puts a consent dialog in front of a human being, and a timeout here
 * would cancel the sign-in of anyone who looked away for ten seconds.
 */
async function requestCode(
  sdk: DiscordSDK,
  clientId: string,
): Promise<{ readonly code: string; readonly voice: boolean }> {
  try {
    const granted = await sdk.commands.authorize({
      client_id: clientId,
      response_type: 'code',
      prompt: 'none',
      scope: [...REQUIRED_SCOPES, VOICE_SCOPE],
    });
    return { code: granted.code, voice: true };
  } catch (error) {
    console.warn(
      `discord: authorize was refused with ${VOICE_SCOPE}; retrying without the speaking indicator`,
      error,
    );
  }

  const granted = await sdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    prompt: 'none',
    scope: [...REQUIRED_SCOPES],
  });
  return { code: granted.code, voice: false };
}

/**
 * Trade the code for a session id at our own server.
 *
 * `credentials: 'omit'` and no cookie anywhere: gotcha 6 says a cookie in an
 * Activity iframe needs `SameSite=None; Partitioned` and is silently dropped
 * otherwise, so the whole class is avoided — the session id lives in memory in
 * this module's caller and dies with the page, which is also what makes it
 * unreadable by anything else in the frame.
 */
async function exchangeCode(code: string): Promise<TokenBody> {
  const response = await fetch(tokenUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });

  // Read the body once, whatever the status: the refusal path needs it too, and
  // a body that is not JSON at all (a proxy error page) must not throw here.
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) throw new Error(readRefusal(payload, response.status));

  const body = readTokenBody(payload);
  if (body === null) throw new Error('the server answered the sign-in with something unexpected');
  return body;
}

/**
 * Establish who this client is, or say why it could not.
 *
 * NEVER THROWS. Every failure comes back as `error` with `session: null`,
 * because the caller's job on a bad handshake is to draw a sentence, not to
 * catch an exception on the boot path.
 */
export async function establishDiscordSession(): Promise<DiscordHandshake> {
  let participants: readonly DiscordParticipant[] = [];
  let listener: ((next: readonly DiscordParticipant[]) => void) | null = null;

  const publish = (next: readonly DiscordParticipant[]): void => {
    participants = next;
    listener?.(next);
  };

  const finish = (
    mode: ClientMode,
    session: string | null,
    voice: boolean,
    error: string | null,
  ): DiscordHandshake => ({
    mode,
    session,
    voice,
    error,
    getParticipants: () => participants,
    onParticipants: (next) => {
      listener = next;
      next(participants);
    },
  });

  if (!isEmbedded()) {
    // A browser tab. No SDK, no handshake, no error — the server decides what
    // an unauthenticated socket may do, and in development it lets it play.
    return finish(ClientMode.Standalone, null, false, null);
  }

  const clientId = readClientId();
  if (clientId === '') {
    return finish(
      ClientMode.Activity,
      null,
      false,
      'VITE_DISCORD_CLIENT_ID is not set — rebuild the client with it in .env',
    );
  }

  try {
    const sdk = new DiscordSDK(clientId);
    await withTimeout(sdk.ready(), READY_TIMEOUT_MS, 'the Discord client');

    const { code, voice: asked } = await requestCode(sdk, clientId);
    const { accessToken, session } = await exchangeCode(code);

    // Hand the token back to the Discord client so ITS commands are authorised
    // too. The `user` it returns is deliberately unused — see the header.
    const authenticated = await withTimeout(
      sdk.commands.authenticate({ access_token: accessToken }),
      COMMAND_TIMEOUT_MS,
      'authenticate',
    );
    // The grant is confirmed against the scopes Discord actually issued rather
    // than inferred from the absence of a throw: an authorize that succeeds
    // having quietly dropped a scope is exactly the shape R13 warns about.
    const voice = asked && authenticated.scopes.includes(VOICE_SCOPE);

    // FROM HERE ON, NOTHING MAY FAIL THE HANDSHAKE. The player is signed in;
    // the roster is a nicety, and gotcha 7 says an older Discord client throws
    // INVALID_COMMAND on commands it has never heard of.
    try {
      const roster = await withTimeout(
        sdk.commands.getInstanceConnectedParticipants(),
        COMMAND_TIMEOUT_MS,
        'getInstanceConnectedParticipants',
      );
      publish(roster.participants.map(toParticipant));

      // Live roster changes. NOT the voice channel: gotcha 4 — somebody sitting
      // in the VC who has not opened the game never appears here, and pretending
      // otherwise would make the panel lie about who can be spoken to.
      //
      // Bounded like every other command, and for a sharper reason: `subscribe`
      // waits for the host to acknowledge, and an acknowledgement that never
      // arrives would hang this function — which the caller awaits BEFORE it
      // draws anything. An unbounded await here is a black screen.
      await withTimeout(
        sdk.subscribe(Events.ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE, (event) => {
          publish((event.participants ?? []).map(toParticipant));
        }),
        COMMAND_TIMEOUT_MS,
        'subscribe',
      );
    } catch (error) {
      console.warn('discord: the participant roster is unavailable on this client', error);
    }

    // THE SPEAKING SEAM. `voice` says the scope is granted, which is the half
    // that had to be settled during the handshake. SPEAKING_START/SPEAKING_STOP
    // are not subscribed to here because nothing could yet be done with them:
    // those events name a DISCORD USER ID, the party panel's rows are keyed by
    // ACTOR ID, and the only honest way to join the two is a server frame that
    // does not exist. Until it does, `PartyMember.voice` — which the server
    // derives from who has spoken in the Margin — is the whole indicator.
    return finish(ClientMode.Activity, session, voice, null);
  } catch (error) {
    // A REAL FAILURE INSIDE A REAL ACTIVITY. Reported as one.
    console.error('discord: the sign-in handshake failed', error);
    return finish(ClientMode.Activity, null, false, describe(error));
  }
}
