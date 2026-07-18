# Reference web sign-in server

This is a **concrete example** of the backend the chat's **“Sign in with web”** button
talks to. Out of the box, `openvsChat.<provider>.authUrl` is blank and the button has
nothing to call — this server fills that gap so you can see the whole login loop work,
and gives you a starting point for a real one.

## The sign-in contract

The extension never sees the user's password and never invents a token. It only knows
how to **hand off to a URL and receive a token back**:

```
1. User clicks “Sign in with web”.
2. Editor opens:
      <authUrl>?redirect_uri=<editor-callback>&state=<nonce>&provider=<id>
   where <editor-callback> is  <scheme>://openvs.openvs-chat/auth-callback?state=<nonce>
3. Your server authenticates the user however it likes.
4. Your server redirects the browser back to:
      <redirect_uri>&token=<api-token>      (state is preserved)
5. The editor’s URI handler matches <nonce>, extracts <api-token>,
   and stores it as that provider’s API key.
```

`token` may also be named `access_token` or `key`, and may be passed in the URL
fragment (`#token=...`) instead of the query string.

## Run it

```bash
cd extensions/openvs-chat/examples/auth-server
node server.mjs          # listens on http://localhost:7345
```

Then set the provider's auth URL in your settings:

```jsonc
// settings.json
"openvsChat.nvidia.authUrl": "http://localhost:7345/login"
```

Open the chat → ⚙ Providers → **Sign in with web** next to NVIDIA. The browser opens the
demo login page; submit a token and you'll be bounced back into the editor, signed in.

## Two modes it demonstrates

### 1. Interactive (default)
Shows a page that collects a token and redirects it back to the editor. In production
you'd replace this page with a **real OAuth flow** against the provider (or your own
identity service) that mints a short-lived, per-user token — the user never pastes
anything.

### 2. Shared key (zero-config for users)
If you set an environment variable, the server hands that key straight to every user
with no prompt — useful when *you* want to absorb the cost and give users instant,
keyless access:

```bash
SHARED_KEY_NVIDIA=nvapi-xxxxxxxx node server.mjs
```

Now “Sign in with web” logs the user in immediately, with no token entry. (Treat the
host as trusted — anyone who can reach it gets the shared key.)

## Keyless proxy (end-to-end worked setup)

The same server can also **proxy** the chat to the real provider, so the provider key
lives only on the server and **never reaches the client**. Users sign in and chat with no
key of their own.

Enable proxy mode with three env vars and a session token:

```bash
UPSTREAM=https://integrate.api.nvidia.com/v1 \
UPSTREAM_KEY=nvapi-your-real-key \
SESSION_TOKEN=openvs-demo-session \
node server.mjs
```

Then configure the extension to use the proxy for **both** sign-in and API calls:

```jsonc
// settings.json
"openvsChat.nvidia.authUrl": "http://localhost:7345/login",
"openvsChat.nvidia.baseUrl": "http://localhost:7345/v1"
```

Now the flow is fully keyless for the user:

1. **Sign in with web** → the server hands the client the `SESSION_TOKEN` (not the real key).
2. The extension calls `http://localhost:7345/v1/chat/completions` with that session token.
3. The server checks the session token, swaps in `UPSTREAM_KEY`, and forwards (and streams)
   the request to NVIDIA. The real key stays on the server.

`/v1/models` is proxied too, so the model dropdown's **↻ refresh** works through the proxy.

> This works for **OpenAI-compatible** providers (OpenAI, NVIDIA, most gateways). Anthropic
> uses a different auth header, so proxy it with a small adjustment if needed.

## Turning this into production

- Swap the demo page for the provider's OAuth authorize/redirect, or your own SSO.
- Mint per-user, short-lived tokens (and, ideally, proxy provider calls so the real
  provider key never reaches the client). You can then point `openvsChat.<provider>.baseUrl`
  at your proxy too.
- Serve over HTTPS and validate `state` to protect the redirect.
