// MCP OAuth: discovery documents, PKCE, URL and request building, token handling and refresh policy (pure), and the
// whole sign-in / refresh flow against a fake authorization server, a fake browser, a fake loopback listener and a
// fake Keychain. The real loopback listener is tested in Rust (src-tauri/src/oauth.rs); nothing here touches a network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const o = await import('../src/agent/mcp/oauth.ts');
const flow = await import('../src/agent/mcp/oauthFlow.ts');
const cfg = await import('../src/agent/mcp/config.ts');

const SERVER = 'https://mcp.example/api/mcp';
const AS = 'https://auth.example';

test('WWW-Authenticate challenge parsing', () => {
  assert.deepEqual(
    o.parseWwwAuthenticate(
      'Bearer realm="x", resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/api/mcp", scope="read write", error=invalid_token',
    ),
    {
      resourceMetadata: 'https://mcp.example/.well-known/oauth-protected-resource/api/mcp',
      scope: 'read write',
      error: 'invalid_token',
    },
  );
  assert.deepEqual(o.parseWwwAuthenticate(null), {});
  assert.deepEqual(o.parseWwwAuthenticate('Basic realm="x"'), {});
});

test('endpoints must be https (http only for loopback) and resources must match the server', () => {
  for (const ok of ['https://a.example/x', 'http://localhost:8080/x', 'http://127.0.0.1/x', 'http://[::1]:1/x'])
    assert.equal(o.isSecureEndpoint(ok), true, ok);
  for (const bad of [
    'http://a.example/x',
    'http://192.168.1.5/x',
    'ftp://a',
    'https://u:p@a.example/',
    'https://a.example/#f',
    'javascript:1',
    '',
    null,
    5,
  ])
    assert.equal(o.isSecureEndpoint(bad), false, String(bad));
  assert.equal(o.canonicalResource('https://MCP.example/api/mcp/?q=1#x'), 'https://mcp.example/api/mcp');
  assert.equal(o.canonicalResource('https://mcp.example/'), 'https://mcp.example');
  assert.equal(o.resourceMatches(SERVER, 'https://mcp.example'), true);
  assert.equal(o.resourceMatches(SERVER, 'https://mcp.example/api'), true);
  assert.equal(o.resourceMatches(SERVER, 'https://mcp.example/ap'), false);
  assert.equal(o.resourceMatches(SERVER, 'https://evil.example'), false);
});

test('protected resource metadata: lookup order and validation', () => {
  assert.deepEqual(o.protectedResourceMetadataUrls(SERVER, 'https://hint.example/prm'), [
    'https://hint.example/prm',
    'https://mcp.example/.well-known/oauth-protected-resource/api/mcp',
    'https://mcp.example/.well-known/oauth-protected-resource',
  ]);
  assert.deepEqual(o.protectedResourceMetadataUrls('https://mcp.example/'), [
    'https://mcp.example/.well-known/oauth-protected-resource',
  ]);
  assert.deepEqual(o.protectedResourceMetadataUrls(SERVER, 'http://insecure.example/prm').length, 2);
  const pr = o.parseProtectedResource(
    {
      resource: 'https://mcp.example',
      authorization_servers: ['http://bad.example', AS],
      scopes_supported: ['a', 7, 'b'],
    },
    SERVER,
  );
  assert.deepEqual(pr, { resource: 'https://mcp.example', authorizationServers: [AS], scopes: ['a', 'b'] });
  assert.throws(
    () => o.parseProtectedResource({ resource: 'https://other.example', authorization_servers: [AS] }, SERVER),
    /does not describe this server/,
  );
  assert.throws(
    () =>
      o.parseProtectedResource(
        { resource: 'https://mcp.example', authorization_servers: ['http://bad.example'] },
        SERVER,
      ),
    /no usable/,
  );
  assert.throws(() => o.parseProtectedResource(null, SERVER));
});

test('authorization server metadata: discovery URLs, issuer match, PKCE and secure endpoints', () => {
  assert.deepEqual(o.authServerMetadataUrls(AS), [
    `${AS}/.well-known/oauth-authorization-server`,
    `${AS}/.well-known/openid-configuration`,
  ]);
  assert.deepEqual(o.authServerMetadataUrls(`${AS}/tenant1`), [
    `${AS}/.well-known/oauth-authorization-server/tenant1`,
    `${AS}/.well-known/openid-configuration/tenant1`,
    `${AS}/tenant1/.well-known/openid-configuration`,
  ]);
  const good = {
    issuer: AS,
    authorization_endpoint: `${AS}/authorize`,
    token_endpoint: `${AS}/token`,
    registration_endpoint: `${AS}/register`,
    code_challenge_methods_supported: ['plain', 'S256'],
  };
  assert.deepEqual(o.parseAuthServerMetadata(good, AS), {
    issuer: AS,
    authorizationEndpoint: `${AS}/authorize`,
    tokenEndpoint: `${AS}/token`,
    registrationEndpoint: `${AS}/register`,
  });
  assert.equal(o.parseAuthServerMetadata({ ...good, issuer: `${AS}/` }, AS).registrationEndpoint, `${AS}/register`);
  assert.equal(
    o.parseAuthServerMetadata({ ...good, registration_endpoint: undefined }, AS).registrationEndpoint,
    undefined,
  );
  assert.throws(() => o.parseAuthServerMetadata({ ...good, issuer: 'https://evil.example' }, AS), /different issuer/);
  assert.throws(
    () => o.parseAuthServerMetadata({ ...good, code_challenge_methods_supported: undefined }, AS),
    /PKCE with S256/,
  );
  assert.throws(
    () => o.parseAuthServerMetadata({ ...good, code_challenge_methods_supported: ['plain'] }, AS),
    /PKCE with S256/,
  );
  assert.throws(() => o.parseAuthServerMetadata({ ...good, token_endpoint: 'http://auth.example/token' }, AS), /https/);
  assert.throws(
    () => o.parseAuthServerMetadata({ ...good, registration_endpoint: 'http://auth.example/r' }, AS),
    /https/,
  );
  assert.throws(
    () => o.parseAuthServerMetadata({ ...good, grant_types_supported: ['implicit'] }, AS),
    /authorization code/,
  );
  // A local authorization server may use http on loopback.
  assert.equal(
    o.parseAuthServerMetadata(
      {
        ...good,
        issuer: 'http://localhost:9000',
        authorization_endpoint: 'http://localhost:9000/a',
        token_endpoint: 'http://localhost:9000/t',
      },
      'http://localhost:9000',
    ).tokenEndpoint,
    'http://localhost:9000/t',
  );
});

test('PKCE S256 matches the RFC 7636 example; state and verifier are random and long enough', async () => {
  assert.equal(
    await o.codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
  const a = await o.pkcePair();
  const b = await o.pkcePair();
  assert.notEqual(a.verifier, b.verifier);
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await o.codeChallenge(a.verifier), a.challenge);
  assert.match(o.randomToken(24), /^[A-Za-z0-9_-]{32}$/);
  assert.equal(
    o.randomToken(3, (x) => x.fill(255)),
    '____',
  );
});

test('authorization URL and request bodies', () => {
  const u = new URL(
    o.buildAuthorizationUrl({
      endpoint: `${AS}/authorize?tenant=1`,
      clientId: 'cid',
      redirectUri: o.redirectUri(5555),
      state: 'st',
      challenge: 'ch',
      resource: 'https://mcp.example/api/mcp',
      scope: 'a b',
    }),
  );
  assert.equal(u.origin + u.pathname, `${AS}/authorize`);
  assert.deepEqual(Object.fromEntries(u.searchParams), {
    tenant: '1',
    response_type: 'code',
    client_id: 'cid',
    redirect_uri: 'http://127.0.0.1:5555/callback',
    state: 'st',
    code_challenge: 'ch',
    code_challenge_method: 'S256',
    resource: 'https://mcp.example/api/mcp',
    scope: 'a b',
  });
  assert.ok(
    !new URL(
      o.buildAuthorizationUrl({
        endpoint: `${AS}/a`,
        clientId: 'c',
        redirectUri: 'r',
        state: 's',
        challenge: 'c',
        resource: 'x',
      }),
    ).searchParams.has('scope'),
  );
  const reg = o.registrationBody('http://127.0.0.1:5555/callback');
  assert.deepEqual(reg.redirect_uris, ['http://127.0.0.1:5555/callback']);
  assert.equal(reg.token_endpoint_auth_method, 'none');
  assert.deepEqual(o.parseRegistration({ client_id: 'x', client_secret: 's' }), { clientId: 'x', clientSecret: 's' });
  assert.throws(() => o.parseRegistration({}), /no client_id/);
  const code = new URLSearchParams(
    o.tokenRequestBody({
      grant: 'authorization_code',
      code: 'c',
      redirectUri: 'http://127.0.0.1:1/callback',
      clientId: 'cid',
      verifier: 'v',
      resource: 'r',
    }),
  );
  assert.deepEqual(Object.fromEntries(code), {
    grant_type: 'authorization_code',
    code: 'c',
    redirect_uri: 'http://127.0.0.1:1/callback',
    code_verifier: 'v',
    client_id: 'cid',
    resource: 'r',
  });
  const ref = new URLSearchParams(
    o.tokenRequestBody({
      grant: 'refresh_token',
      refreshToken: 'rt',
      clientId: 'cid',
      clientSecret: 'cs',
      resource: 'r',
    }),
  );
  assert.deepEqual(Object.fromEntries(ref), {
    grant_type: 'refresh_token',
    refresh_token: 'rt',
    client_id: 'cid',
    client_secret: 'cs',
    resource: 'r',
  });
});

test('token responses, stored tokens and the refresh policy', () => {
  assert.deepEqual(
    o.parseTokenResponse(
      { access_token: 'at', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt', scope: 's' },
      1000,
    ),
    { accessToken: 'at', refreshToken: 'rt', expiresAt: 3_601_000, scope: 's' },
  );
  // A refresh response without a refresh token keeps the old one.
  assert.equal(
    o.parseTokenResponse({ access_token: 'at2', token_type: 'bearer' }, 0, { refreshToken: 'old' }).refreshToken,
    'old',
  );
  assert.equal(
    o.parseTokenResponse({ access_token: 'at', token_type: 'bearer', expires_in: '60' }, 0).expiresAt,
    60_000,
  );
  assert.equal(o.parseTokenResponse({ access_token: 'at', token_type: 'bearer' }, 0).expiresAt, undefined);
  assert.throws(() => o.parseTokenResponse({ access_token: 'at', token_type: 'mac' }, 0), /unsupported token type/);
  assert.throws(() => o.parseTokenResponse({ token_type: 'bearer' }, 0), /no access token/);
  try {
    o.parseTokenResponse({ error: 'invalid_grant', error_description: 'bad code SECRET-REFRESH' }, 0);
    assert.fail();
  } catch (e) {
    assert.equal(e.code, 'invalid_grant');
  }
  const st = { accessToken: 'a', tokenEndpoint: `${AS}/token`, clientId: 'c', resource: 'r', issuer: AS };
  assert.deepEqual(o.parseStored(JSON.stringify(st)), st);
  assert.equal(o.parseStored('not json'), null);
  assert.equal(
    o.parseStored(JSON.stringify({ ...st, tokenEndpoint: 'http://evil.example/token' })),
    null,
    'a tampered insecure token endpoint is not used',
  );
  assert.equal(o.parseStored(null), null);
  // Refresh within a minute of expiry; expired without a refresh token needs a new sign-in; unknown expiry is used until a 401.
  assert.equal(o.tokenDecision({ expiresAt: 1_000_000, refreshToken: 'r' }, 0), 'use');
  assert.equal(o.tokenDecision({ expiresAt: 1_000_000, refreshToken: 'r' }, 950_000), 'refresh');
  assert.equal(o.tokenDecision({ expiresAt: 1_000_000 }, 950_000), 'use');
  assert.equal(o.tokenDecision({ expiresAt: 1_000_000 }, 1_000_001), 'signin');
  assert.equal(o.tokenDecision({}, 5e12), 'use');
});

test('config: oauth is validated, never stores tokens, and stale Keychain entries are found', () => {
  const s = {
    ...cfg.blankServer('s1', 'http'),
    name: 'r',
    url: 'https://mcp.example/mcp',
    oauth: { clientId: 'cid', scope: 'a' },
  };
  assert.deepEqual(cfg.validateServer(s), []);
  assert.deepEqual(cfg.validateServer({ ...s, oauth: { clientId: 'x'.repeat(600) } }), ['oauth']);
  assert.deepEqual(cfg.validateServer({ ...s, oauth: { scope: 'a\nb' } }), ['oauth']);
  assert.equal(cfg.oauthSecretId('s1'), 'mcp:s1:oauth');
  const round = cfg.normalizeConfig({
    servers: [{ ...s, oauth: { clientId: ' cid ', scope: '', accessToken: 'LEAK' } }],
  }).servers[0];
  assert.deepEqual(round.oauth, { clientId: 'cid' });
  assert.deepEqual(cfg.staleSecretIds(s, s), []);
  assert.deepEqual(cfg.staleSecretIds(s, { ...s, oauth: { clientId: 'cid', scope: 'other' } }), []);
  assert.deepEqual(cfg.staleSecretIds(s, { ...s, url: 'https://other.example/mcp' }), ['mcp:s1:oauth']);
  assert.deepEqual(cfg.staleSecretIds(s, { ...s, oauth: undefined }), ['mcp:s1:oauth']);
  assert.deepEqual(cfg.staleSecretIds(s, { ...s, oauth: { clientId: 'new' } }), ['mcp:s1:oauth']);
  assert.deepEqual(cfg.staleSecretIds(s, null), ['mcp:s1:oauth']);
});

// ---- the flow against fakes ----------------------------------------------------------------------------------------

const j = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A fake world: MCP server, authorization server, browser, loopback listener, Keychain and clock. */
function world(over = {}) {
  const log = {
    fetches: [],
    opened: [],
    loopbackStates: [],
    cancelled: [],
    registered: [],
    tokenBodies: [],
    revoked: [],
  };
  const store = new Map();
  let clock = 1_000_000;
  let resolveCode;
  const codePromise = new Promise((r) => (resolveCode = r));
  const meta = {
    issuer: AS,
    authorization_endpoint: `${AS}/authorize`,
    token_endpoint: `${AS}/token`,
    registration_endpoint: `${AS}/register`,
    code_challenge_methods_supported: ['S256'],
    ...over.meta,
  };
  const fetch = async (url, init) => {
    log.fetches.push({ url, method: init.method });
    if (over.hook) {
      const r = await over.hook(url, init);
      if (r) return r;
    }
    if (url === `${AS}/revoke`) {
      const body = Object.fromEntries(new URLSearchParams(init.body));
      log.revoked.push(body);
      return over.revoke ? over.revoke(body) : new Response('', { status: 200 });
    }
    if (url === SERVER)
      return over.probe
        ? over.probe()
        : new Response('', {
            status: 401,
            headers: {
              'www-authenticate': `Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/api/mcp", scope="read"`,
            },
          });
    if (url === 'https://mcp.example/.well-known/oauth-protected-resource/api/mcp')
      return over.prm ? over.prm() : j({ resource: 'https://mcp.example/api/mcp', authorization_servers: [AS] });
    if (url === `${AS}/.well-known/oauth-authorization-server`) return over.asm ? over.asm() : j(meta);
    if (url === `${AS}/register`) {
      const body = JSON.parse(init.body);
      log.registered.push(body);
      return j({ client_id: 'dyn-client' }, 201);
    }
    if (url === `${AS}/token`) {
      const body = Object.fromEntries(new URLSearchParams(init.body));
      log.tokenBodies.push(body);
      if (over.token) return over.token(body);
      if (body.grant_type === 'authorization_code')
        return j({ access_token: 'AT1', token_type: 'Bearer', expires_in: 3600, refresh_token: 'RT1' });
      return j({ access_token: 'AT2', token_type: 'Bearer', expires_in: 3600 });
    }
    return new Response('', { status: 404 });
  };
  const deps = {
    fetch,
    openUrl: async (url) => {
      log.opened.push(url);
      const u = new URL(url);
      // The fake browser: the user approves and the redirect carries code and state back.
      resolveCode(over.redirect ? over.redirect(u) : 'CODE1');
    },
    loopback: {
      start: async (state) => (log.loopbackStates.push(state), { id: 'lb1', port: 4455 }),
      wait: async () => codePromise,
      cancel: async (id) => void log.cancelled.push(id),
    },
    store: {
      get: async (id) => store.get(id) ?? null,
      set: async (id, v) => void store.set(id, v),
      delete: async (id) => void store.delete(id),
    },
    now: () => clock,
  };
  return { deps, log, store, tick: (ms) => (clock += ms) };
}
const opts = (extra = {}) => ({ serverUrl: SERVER, secretId: 'mcp:s1:oauth', ...extra });

test('sign-in: discovery, dynamic registration, PKCE authorization URL, code exchange, tokens in the store', async () => {
  const w = world();
  const phases = [];
  await flow.signIn(w.deps, opts({ onPhase: (p) => phases.push(p) }));
  assert.deepEqual(phases, ['discovering', 'registering', 'browser', 'exchanging']);
  assert.deepEqual(w.log.registered[0].redirect_uris, ['http://127.0.0.1:4455/callback']);
  const url = new URL(w.log.opened[0]);
  assert.equal(url.origin + url.pathname, `${AS}/authorize`);
  const q = Object.fromEntries(url.searchParams);
  assert.equal(q.client_id, 'dyn-client');
  assert.equal(q.redirect_uri, 'http://127.0.0.1:4455/callback');
  assert.equal(q.code_challenge_method, 'S256');
  assert.equal(q.resource, 'https://mcp.example/api/mcp');
  assert.equal(q.scope, 'read', 'the challenge scope is requested');
  assert.equal(q.state, w.log.loopbackStates[0], 'the listener was given the very state sent to the browser');
  const tb = w.log.tokenBodies[0];
  assert.equal(tb.code, 'CODE1');
  assert.equal(tb.redirect_uri, q.redirect_uri, 'exact redirect URI on the exchange');
  assert.equal(await o.codeChallenge(tb.code_verifier), q.code_challenge, 'the verifier belongs to the challenge');
  const stored = o.parseStored(w.store.get('mcp:s1:oauth'));
  assert.deepEqual(stored, {
    accessToken: 'AT1',
    refreshToken: 'RT1',
    expiresAt: 4_600_000,
    tokenEndpoint: `${AS}/token`,
    clientId: 'dyn-client',
    resource: 'https://mcp.example/api/mcp',
    issuer: AS,
    scope: 'read',
  });
  assert.deepEqual(w.log.cancelled, [], 'a finished sign-in leaves nothing to cancel');
  assert.equal(await flow.authorizationHeader(w.deps, 'mcp:s1:oauth'), 'Bearer AT1');
  assert.equal(await flow.isSignedIn(w.deps, 'mcp:s1:oauth'), true);
  // No request other than https went anywhere.
  assert.ok(w.log.fetches.every((f) => f.url.startsWith('https://')));
});

test('sign-in with a configured client id skips registration; no registration endpoint is an error', async () => {
  const w2 = world();
  await flow.signIn(w2.deps, opts({ clientId: 'mine', scope: 'custom' }));
  assert.equal(w2.log.registered.length, 0);
  const q = Object.fromEntries(new URL(w2.log.opened[0]).searchParams);
  assert.equal(q.client_id, 'mine');
  assert.equal(q.scope, 'custom');
  const w3 = world({ meta: { registration_endpoint: undefined } });
  await assert.rejects(flow.signIn(w3.deps, opts()), /dynamic client registration/);
  assert.deepEqual(w3.log.cancelled, ['lb1'], 'the listener is closed when sign-in fails');
});

// ---- discovery paths: metadata present / only legacy metadata / only default endpoints / nothing ---------------------

const ORIGIN = 'https://mcp.example';
const notFound = () => new Response('', { status: 404 });
/** No RFC 9728 document anywhere (the world's own PRM answers 404 and the challenge carries no hint). */
const noPrm = {
  prm: notFound,
  probe: () => new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer realm="x"' } }),
};

test('discovery path 1: protected resource metadata, then the authorization server metadata (2025-06-18)', async () => {
  const w = world();
  let via;
  await flow.signIn(w.deps, opts({ onDiscovered: (v) => (via = v) }));
  assert.equal(via, 'protected_resource');
  assert.ok(!w.log.fetches.some((f) => f.url === `${ORIGIN}/authorize` || f.url === `${ORIGIN}/register`));
});

test('discovery path 2: no protected resource metadata, legacy /.well-known/oauth-authorization-server on the server origin (2025-03-26)', async () => {
  const meta = {
    issuer: ORIGIN,
    authorization_endpoint: `${ORIGIN}/oauth/authz`,
    token_endpoint: `${ORIGIN}/oauth/tok`,
    registration_endpoint: `${ORIGIN}/oauth/reg`,
    code_challenge_methods_supported: ['S256'],
  };
  const w = world({
    ...noPrm,
    hook: (url, init) => {
      if (url === `${ORIGIN}/.well-known/oauth-authorization-server`) return j(meta);
      if (url === `${ORIGIN}/oauth/reg`) return j({ client_id: 'legacy-client' }, 201);
      if (url === `${ORIGIN}/oauth/tok`)
        return j({ access_token: 'LAT', token_type: 'Bearer', expires_in: 60, refresh_token: 'LRT' });
    },
  });
  let via;
  await flow.signIn(w.deps, opts({ onDiscovered: (v) => (via = v) }));
  assert.equal(via, 'legacy_metadata');
  const u = new URL(w.log.opened[0]);
  assert.equal(u.origin + u.pathname, `${ORIGIN}/oauth/authz`);
  const q = Object.fromEntries(u.searchParams);
  assert.equal(q.client_id, 'legacy-client');
  assert.equal(q.code_challenge_method, 'S256');
  assert.equal(q.resource, 'https://mcp.example/api/mcp', 'the resource parameter is unchanged');
  assert.equal(o.parseStored(w.store.get('mcp:s1:oauth')).tokenEndpoint, `${ORIGIN}/oauth/tok`);
  // Found but invalid legacy metadata is an error, never a reason to guess the default endpoints.
  const bad = world({
    ...noPrm,
    hook: (url) =>
      url === `${ORIGIN}/.well-known/oauth-authorization-server`
        ? j({ ...meta, issuer: 'https://evil.example' })
        : undefined,
  });
  await assert.rejects(flow.signIn(bad.deps, opts()), (e) => e.code === 'issuer_mismatch');
  const nopkce = world({
    ...noPrm,
    hook: (url) =>
      url === `${ORIGIN}/.well-known/oauth-authorization-server`
        ? j({ ...meta, code_challenge_methods_supported: undefined })
        : undefined,
  });
  await assert.rejects(flow.signIn(nopkce.deps, opts()), (e) => e.code === 'no_pkce');
  assert.ok(!nopkce.log.fetches.some((f) => f.url === `${ORIGIN}/register`));
});

test('discovery path 3: no metadata at all (every lookup 404), the default /authorize, /token, /register endpoints (2025-03-26)', async () => {
  const w = world({
    ...noPrm,
    hook: (url, init) => {
      if (url === `${ORIGIN}/register`) {
        w.log.registered.push(JSON.parse(init.body));
        return j({ client_id: 'default-client' }, 201);
      }
      if (url === `${ORIGIN}/token`) {
        const body = Object.fromEntries(new URLSearchParams(init.body));
        w.log.tokenBodies.push(body);
        return j({ access_token: 'DAT', token_type: 'Bearer', expires_in: 60, refresh_token: 'DRT' });
      }
    },
  });
  let via;
  const phases = [];
  await flow.signIn(w.deps, opts({ onDiscovered: (v) => (via = v), onPhase: (p) => phases.push(p) }));
  assert.equal(via, 'default_endpoints');
  assert.deepEqual(phases, ['discovering', 'registering', 'browser', 'exchanging']);
  // Every metadata location was tried before the defaults were used.
  for (const url of [
    `${ORIGIN}/.well-known/oauth-protected-resource/api/mcp`,
    `${ORIGIN}/.well-known/oauth-protected-resource`,
    `${ORIGIN}/.well-known/oauth-authorization-server`,
    `${ORIGIN}/.well-known/openid-configuration`,
  ])
    assert.ok(
      w.log.fetches.some((f) => f.url === url),
      url,
    );
  const u = new URL(w.log.opened[0]);
  assert.equal(u.origin + u.pathname, `${ORIGIN}/authorize`);
  const q = Object.fromEntries(u.searchParams);
  assert.equal(q.client_id, 'default-client');
  assert.equal(q.code_challenge_method, 'S256');
  assert.equal(q.resource, 'https://mcp.example/api/mcp');
  assert.equal(q.redirect_uri, 'http://127.0.0.1:4455/callback', 'loopback redirect unchanged');
  assert.deepEqual(w.log.registered[0].redirect_uris, ['http://127.0.0.1:4455/callback']);
  const tb = w.log.tokenBodies[0];
  assert.equal(await o.codeChallenge(tb.code_verifier), q.code_challenge);
  const stored = o.parseStored(w.store.get('mcp:s1:oauth'));
  assert.equal(stored.tokenEndpoint, `${ORIGIN}/token`);
  assert.equal(stored.issuer, ORIGIN);
  assert.equal(stored.revocationEndpoint, undefined);
  // A configured client id skips the registration call in this path too.
  const w2 = world({ ...noPrm });
  await assert.rejects(flow.signIn(w2.deps, opts({ clientId: 'mine' })), (e) => e.code === 'http_404');
  assert.equal(new URL(w2.log.opened[0]).origin + new URL(w2.log.opened[0]).pathname, `${ORIGIN}/authorize`);
  assert.equal(w2.log.fetches.filter((f) => f.url === `${ORIGIN}/register`).length, 0);
});

test('discovery path 4: nothing works, clear error codes', async () => {
  // Defaults used but the server has no /register: a message that says what was tried and what to do.
  const w = world({ ...noPrm });
  await assert.rejects(
    flow.signIn(w.deps, opts()),
    (e) =>
      e.code === 'registration_failed' &&
      /no OAuth metadata/.test(e.message) &&
      /https:\/\/mcp\.example\/register/.test(e.message) &&
      /client ID/.test(e.message),
  );
  assert.deepEqual(w.log.cancelled, ['lb1']);
  assert.equal(w.store.size, 0);
  // Metadata lookups that fail with something other than 404 end discovery: no guessing endpoints.
  const flaky = world({
    ...noPrm,
    hook: (url) =>
      url === `${ORIGIN}/.well-known/oauth-authorization-server` ? new Response('', { status: 503 }) : undefined,
  });
  await assert.rejects(
    flow.signIn(flaky.deps, opts()),
    (e) => e.code === 'discovery_failed' && /could not be read/.test(e.message),
  );
  assert.deepEqual(flaky.log.loopbackStates, [], 'nothing was opened before discovery succeeded');
  assert.ok(!flaky.log.fetches.some((f) => f.url === `${ORIGIN}/register`));
  const junk = world({
    ...noPrm,
    hook: (url) =>
      url === `${ORIGIN}/.well-known/openid-configuration` ? new Response('<html>', { status: 200 }) : undefined,
  });
  await assert.rejects(flow.signIn(junk.deps, opts()), (e) => e.code === 'discovery_failed');
  const down = world({
    ...noPrm,
    hook: (url) => {
      if (url === `${ORIGIN}/.well-known/oauth-authorization-server`) throw new Error('network down');
    },
  });
  await assert.rejects(flow.signIn(down.deps, opts()), (e) => e.code === 'discovery_failed');
  // The challenge named a metadata document we could not read: the server wants RFC 9728, so the defaults are not used.
  const hinted = world({ prm: () => new Response('', { status: 500 }) });
  await assert.rejects(flow.signIn(hinted.deps, opts()), (e) => e.code === 'discovery_failed');
  // A protected resource names an authorization server without metadata: no_metadata, never the defaults of the MCP origin.
  const noAs = world({ asm: notFound });
  await assert.rejects(
    flow.signIn(noAs.deps, opts()),
    (e) => e.code === 'no_metadata' && /publishes no metadata/.test(e.message),
  );
  assert.ok(!noAs.log.fetches.some((f) => f.url === `${ORIGIN}/authorize` || f.url === `${ORIGIN}/register`));
});

test('discovery fallback never weakens the endpoint rules', async () => {
  // Plain http to a non-loopback server is refused before any request.
  const w = world();
  await assert.rejects(
    flow.signIn(w.deps, { serverUrl: 'http://mcp.example/mcp', secretId: 'x' }),
    (e) => e.code === 'insecure_endpoint',
  );
  assert.equal(w.log.fetches.length, 0);
  assert.throws(() => o.defaultAuthServer('http://mcp.example/mcp'), /https/);
  assert.deepEqual(o.defaultAuthServer('https://mcp.example:8443/a/b?q=1'), {
    issuer: 'https://mcp.example:8443',
    authorizationEndpoint: 'https://mcp.example:8443/authorize',
    tokenEndpoint: 'https://mcp.example:8443/token',
    registrationEndpoint: 'https://mcp.example:8443/register',
  });
  // A local development server may use http on loopback, defaults included.
  assert.equal(o.defaultAuthServer('http://localhost:3000/mcp').tokenEndpoint, 'http://localhost:3000/token');
});

test('a legacy SSE server that answers the probe POST with 405 gets its challenge from the GET', async () => {
  const seen = [];
  const w = world({
    prm: notFound,
    probe: () => new Response('', { status: 405 }),
    hook: (url, init) => {
      if (url === SERVER && init.method === 'GET') {
        seen.push(init.headers.Accept);
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate': `Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/api/mcp"`,
          },
        });
      }
    },
  });
  // The challenge's metadata hint is what makes the flow continue with RFC 9728 (the fake PRM answers 404 here, so discovery refuses to guess).
  await assert.rejects(flow.signIn(w.deps, opts()), (e) => e.code === 'discovery_failed');
  assert.deepEqual(seen, ['text/event-stream']);
});

// ---- revocation (RFC 7009) -----------------------------------------------------------------------------------------

test('revocation endpoint: parsed leniently from the metadata and stored with the tokens', () => {
  const good = {
    issuer: AS,
    authorization_endpoint: `${AS}/authorize`,
    token_endpoint: `${AS}/token`,
    code_challenge_methods_supported: ['S256'],
  };
  assert.equal(
    o.parseAuthServerMetadata({ ...good, revocation_endpoint: `${AS}/revoke` }, AS).revocationEndpoint,
    `${AS}/revoke`,
  );
  assert.equal(
    o.parseAuthServerMetadata({ ...good, revocation_endpoint: 'http://auth.example/revoke' }, AS).revocationEndpoint,
    undefined,
    'an insecure revocation endpoint is ignored, not fatal',
  );
  assert.equal(o.parseAuthServerMetadata(good, AS).revocationEndpoint, undefined);
  const st = {
    accessToken: 'a',
    tokenEndpoint: `${AS}/token`,
    clientId: 'c',
    resource: 'r',
    issuer: AS,
    revocationEndpoint: `${AS}/revoke`,
  };
  assert.deepEqual(o.parseStored(JSON.stringify(st)), st);
  assert.equal(
    o.parseStored(JSON.stringify({ ...st, revocationEndpoint: 'http://evil.example/r' })).revocationEndpoint,
    undefined,
    'a tampered insecure endpoint is dropped',
  );
  assert.deepEqual(
    Object.fromEntries(new URLSearchParams(o.revocationRequestBody('T', 'refresh_token', 'cid', 'sec'))),
    { token: 'T', token_type_hint: 'refresh_token', client_id: 'cid', client_secret: 'sec' },
  );
});

const revMeta = { revocation_endpoint: `${AS}/revoke` };

test('sign-out revokes the refresh and the access token, then deletes the Keychain entry', async () => {
  const w = await signedIn({ meta: revMeta });
  assert.equal(o.parseStored(w.store.get('mcp:s1:oauth')).revocationEndpoint, `${AS}/revoke`);
  const r = await flow.signOut(w.deps, 'mcp:s1:oauth');
  assert.deepEqual(r, { attempted: 2, revoked: 2 });
  assert.deepEqual(w.log.revoked, [
    { token: 'RT1', token_type_hint: 'refresh_token', client_id: 'dyn-client' },
    { token: 'AT1', token_type_hint: 'access_token', client_id: 'dyn-client' },
  ]);
  assert.equal(w.store.size, 0);
  assert.equal(await flow.isSignedIn(w.deps, 'mcp:s1:oauth'), false);
  // The revocation requests are POSTs with a form body to the https endpoint only.
  assert.ok(w.log.fetches.filter((f) => f.url === `${AS}/revoke`).every((f) => f.method === 'POST'));
});

test('sign-out without a revocation endpoint sends nothing and still deletes the tokens', async () => {
  const w = await signedIn();
  const before = w.log.fetches.length;
  assert.deepEqual(await flow.signOut(w.deps, 'mcp:s1:oauth'), { attempted: 0, revoked: 0 });
  assert.equal(w.log.fetches.length, before);
  assert.equal(w.store.size, 0);
  // Nothing stored at all: nothing to do, no error.
  assert.deepEqual(await flow.signOut(world().deps, 'mcp:s1:oauth'), { attempted: 0, revoked: 0 });
});

test('a failing, hanging or erroring revocation never blocks the local sign-out', { timeout: 30_000 }, async () => {
  const bad = await signedIn({ meta: revMeta, revoke: () => j({ error: 'server_error' }, 503) });
  assert.deepEqual(await flow.signOut(bad.deps, 'mcp:s1:oauth'), { attempted: 2, revoked: 0 });
  assert.equal(bad.store.size, 0);
  const net = await signedIn({ meta: revMeta });
  const inner = net.deps.fetch;
  net.deps.fetch = async (url, init) => {
    if (url === `${AS}/revoke`) throw new Error('connection refused');
    return inner(url, init);
  };
  assert.deepEqual(await flow.signOut(net.deps, 'mcp:s1:oauth'), { attempted: 2, revoked: 0 });
  assert.equal(net.store.size, 0);
  // A server that never answers is cut off by the deadline (5 s per request, shortened here).
  const hang = await signedIn({ meta: revMeta });
  hang.deps.revokeTimeoutMs = 100;
  const inner2 = hang.deps.fetch;
  hang.deps.fetch = (url, init) =>
    url === `${AS}/revoke`
      ? new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))))
      : inner2(url, init);
  const t0 = Date.now();
  const r = await flow.signOut(hang.deps, 'mcp:s1:oauth');
  assert.equal(r.revoked, 0);
  assert.ok(Date.now() - t0 < 2_000);
  assert.equal(hang.store.size, 0);
});

test('revocation requests carry no tokens in URLs and use the stored client secret when there is one', async () => {
  const w = await signedIn({ meta: revMeta });
  const stored = o.parseStored(w.store.get('mcp:s1:oauth'));
  w.store.set('mcp:s1:oauth', JSON.stringify({ ...stored, clientSecret: 'CS' }));
  await flow.signOut(w.deps, 'mcp:s1:oauth');
  assert.ok(w.log.revoked.every((b) => b.client_secret === 'CS'));
  assert.ok(!w.log.fetches.some((f) => /AT1|RT1/.test(f.url)));
});

test('sign-in refuses insecure or inconsistent authorization servers and servers that need no sign-in', async () => {
  await assert.rejects(
    flow.signIn(world({ meta: { code_challenge_methods_supported: undefined } }).deps, opts()),
    /PKCE/,
  );
  await assert.rejects(
    flow.signIn(world({ meta: { token_endpoint: 'http://auth.example/token' } }).deps, opts()),
    /https/,
  );
  await assert.rejects(
    flow.signIn(world({ meta: { issuer: 'https://evil.example' } }).deps, opts()),
    /different issuer/,
  );
  await assert.rejects(
    flow.signIn(
      world({ prm: () => j({ resource: 'https://evil.example', authorization_servers: [AS] }) }).deps,
      opts(),
    ),
    /does not describe this server/,
  );
  await assert.rejects(
    flow.signIn(world({ probe: () => j({ ok: true }) }).deps, opts()),
    /did not ask for authorization/,
  );
  const w = world({
    meta: { token_endpoint: 'https://auth.example/token' },
    token: () => j({ error: 'invalid_grant', error_description: 'nope' }, 400),
  });
  await assert.rejects(flow.signIn(w.deps, opts()), /invalid_grant: nope/);
  assert.equal(w.store.size, 0);
});

test('sign-in can be cancelled: the listener is closed and nothing is stored', async () => {
  const w = world();
  let release;
  w.deps.loopback.wait = () => new Promise((_, rej) => (release = rej));
  w.deps.loopback.cancel = async (id) => {
    w.log.cancelled.push(id);
    release(new Error('sign-in cancelled'));
  };
  w.deps.openUrl = async (url) => void w.log.opened.push(url);
  const ctl = new AbortController();
  const p = flow.signIn(w.deps, opts({ signal: ctl.signal }));
  while (!w.log.opened.length) await new Promise((r) => setTimeout(r, 5));
  ctl.abort();
  await assert.rejects(p, /cancelled/);
  assert.ok(w.log.cancelled.includes('lb1'));
  assert.equal(w.store.size, 0);
});

test('a redirect error (state mismatch, denial, timeout) surfaces and stores nothing', async () => {
  const w = world();
  w.deps.loopback.wait = async () => {
    throw new Error('state mismatch: the redirect did not belong to this sign-in');
  };
  await assert.rejects(flow.signIn(w.deps, opts()), /state mismatch/);
  assert.equal(w.store.size, 0);
  assert.equal(w.log.tokenBodies.length, 0, 'no token request without a verified code');
});

async function signedIn(over) {
  const w = world(over);
  await flow.signIn(w.deps, opts());
  return w;
}

test('refresh: proactive before expiry, rotating tokens kept, concurrent calls share one request', async () => {
  const w = await signedIn();
  assert.equal(await flow.authorizationHeader(w.deps, 'mcp:s1:oauth'), 'Bearer AT1');
  w.tick(3_560_000); // 40 s before expiry: inside the 60 s skew
  const [a, b] = await Promise.all([
    flow.authorizationHeader(w.deps, 'mcp:s1:oauth'),
    flow.authorizationHeader(w.deps, 'mcp:s1:oauth'),
  ]);
  assert.deepEqual([a, b], ['Bearer AT2', 'Bearer AT2']);
  const refreshes = w.log.tokenBodies.filter((t) => t.grant_type === 'refresh_token');
  assert.equal(refreshes.length, 1);
  assert.deepEqual(refreshes[0], {
    grant_type: 'refresh_token',
    refresh_token: 'RT1',
    scope: 'read',
    client_id: 'dyn-client',
    resource: 'https://mcp.example/api/mcp',
  });
  const stored = o.parseStored(w.store.get('mcp:s1:oauth'));
  assert.equal(stored.refreshToken, 'RT1', 'the old refresh token is kept when the server sends none');
  assert.equal(stored.accessToken, 'AT2');
});

test('refresh failures: invalid_grant clears the tokens, network errors keep them', async () => {
  const w = await signedIn({
    token: (b) =>
      b.grant_type === 'authorization_code'
        ? j({ access_token: 'AT1', token_type: 'Bearer', expires_in: 10, refresh_token: 'RT1' })
        : j({ error: 'invalid_grant' }, 400),
  });
  w.tick(20_000);
  await assert.rejects(flow.authorizationHeader(w.deps, 'mcp:s1:oauth'), new RegExp(o.SIGN_IN_NEEDED));
  assert.equal(w.store.size, 0);
  assert.equal(await flow.refreshTokens(w.deps, 'mcp:s1:oauth'), false, 'nothing to refresh after sign-out');
  const w2 = await signedIn({
    token: (b) =>
      b.grant_type === 'authorization_code'
        ? j({ access_token: 'AT1', token_type: 'Bearer', expires_in: 10, refresh_token: 'RT1' })
        : j({ error: 'temporarily_unavailable' }, 503),
  });
  w2.tick(20_000);
  await assert.rejects(flow.refreshTokens(w2.deps, 'mcp:s1:oauth'), /temporarily_unavailable/);
  assert.equal(w2.store.size, 1, 'tokens survive a transient failure');
  // Not signed in at all, and expired without a refresh token.
  await assert.rejects(flow.authorizationHeader(world().deps, 'mcp:s1:oauth'), new RegExp(o.SIGN_IN_NEEDED));
  const w3 = await signedIn({ token: () => j({ access_token: 'AT1', token_type: 'Bearer', expires_in: 10 }) });
  w3.tick(20_000);
  await assert.rejects(flow.authorizationHeader(w3.deps, 'mcp:s1:oauth'), new RegExp(o.SIGN_IN_NEEDED));
});

test('tokens never appear in errors or in anything the flow logs', async () => {
  const w = await signedIn({
    token: (b) =>
      b.grant_type === 'authorization_code'
        ? j({ access_token: 'AT-SECRET', token_type: 'Bearer', expires_in: 10, refresh_token: 'RT-SECRET' })
        : j({ error: 'invalid_grant', error_description: 'echo RT-SECRET' }, 400),
  });
  w.tick(20_000);
  try {
    await flow.authorizationHeader(w.deps, 'mcp:s1:oauth');
    assert.fail();
  } catch (e) {
    assert.ok(!String(e.message).includes('SECRET'));
  }
  assert.ok(!w.log.opened.some((u) => u.includes('SECRET')));
  assert.ok(!w.log.fetches.some((f) => f.url.includes('SECRET')));
});
