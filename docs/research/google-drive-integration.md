# Google Drive integration: verified research inputs

| Field | Value |
| --- | --- |
| Status | Research input for the Wave 3 Google Drive RFC (design track). Not a decision: the ARB decides. |
| Author | research-gdrive (AI-assisted research, disclosed per `AI_USAGE.md`) |
| Date | 2026-09-30. Every source below was fetched and checked on this date unless a row says otherwise. |
| Scope | OAuth 2.0 for a web-server app, Drive scopes and verification, Google user-data policies (Limited Use, AI/ML), Drive API v3, behaviour under Plotinium's COOP/COEP/CSP headers, branding, security and privacy obligations, decision inputs. |
| Out of scope | Code. File layout of the implementation. Final choice of option (ARB). |

**Labels used in this document**

- **[F]** Verified fact, quoted or closely paraphrased from the cited official source.
- **[P]** Probe: an observation I made myself on 2026-09-30 (the command is given). It is evidence, not documentation.
- **[I]** Inference or interpretation by the author. Reviewers should challenge these.
- **[S]** Needs a spike before the RFC relies on it.

---

## 0. Summary for reviewers (one page)

1. **Endpoints [F].** Auth `https://accounts.google.com/o/oauth2/v2/auth`, token `https://oauth2.googleapis.com/token`, revoke `https://oauth2.googleapis.com/revoke`, userinfo `https://openidconnect.googleapis.com/v1/userinfo`, discovery `https://accounts.google.com/.well-known/openid-configuration`. Discovery advertises `code_challenge_methods_supported: ["plain","S256"]` and `authorization_response_iss_parameter_supported: true`.
2. **Refresh tokens [F].** You get a refresh token only with `access_type=offline`, and only on the first code exchange unless you send `prompt=consent`. In **Testing** with an **External** user type, refresh tokens **expire after 7 days**. The only exception is an app that requests nothing beyond name, email and profile. Testing is capped at **100 test users**. There is also a cap of 100 live refresh tokens per Google Account per client ID; the oldest is silently invalidated.
3. **Granular consent [F].** Users can untick scopes. The `scope` field of the token response is the source of truth, and features must degrade per scope.
4. **Scopes [F].** `drive.file` is **non-sensitive** (recommended). `drive`, `drive.readonly`, `drive.metadata` and `drive.metadata.readonly` are all **restricted**. A restricted scope needs restricted-scope verification in production. If the app can reach data "from or through a third-party server", it also needs an **annual CASA security assessment**. Testing, development and personal use (under 100 users) are exempt from verification.
5. **Policy [F].** Workspace data may be transferred to a third party (such as Anthropic) only "to provide or improve … user-facing features that are visible and prominent … and only with the user's consent". Training a model beyond "that specific user's personalized model" is prohibited. The disclosure must be **in-product**, immediately before the consent, and must be more than a privacy-policy entry. For restricted scopes, the required security measures now **explicitly include OAuth tokens encrypted at rest, HSM-grade key management, and prompt-injection protection**. You must also notify `security@google.com` of security incidents.
6. **Drive API v3 [F].** It has **no ETags on files**: v3 dropped `etag`, so there is no `If-Match`. Use `version`, `headRevisionId` or `md5Checksum` for optimistic checks, which are not atomic. `files.export` is capped at **10 MB**. Resumable upload sessions last **one week**, with chunks in multiples of 256 KB. Quotas are now measured in **quota units**: `files.list` costs 100 and `files.get` costs 5. Charges for exceeding quota are "planned … later in 2026 with at least 90 days' notice". Back off exponentially on 403 `userRateLimitExceeded`/`rateLimitExceeded`, on 429, and on 5xx.
7. **Our headers [F+P+I].**
   - **The Google Picker will not work in the OS window as it is today.** It needs third-party scripts (`apis.google.com`), a `docs.google.com` iframe and an API key. Our CSP (`script-src 'self'`, `frame-src` via `default-src 'self'`), COEP `require-corp` and `Referrer-Policy: no-referrer` each block or break a piece of it.
   - **The OAuth consent should run as a server-driven redirect flow inside a popup or tab that we open**, not as a GIS in-page flow. Our session cookie is `SameSite=Strict`, so the callback (a cross-site top-level navigation) arrives **without** the Plotinium session cookie [F: RFC 6265bis]. The design needs a two-step callback.
   - Reporting "connected" back through a `BroadcastChannel`, or through our own WebSocket, works because both pages are same-origin top-level documents in the same storage partition [F: MDN + I].
8. **Recommendation (section 9).**
   - **(a) Capstone demo in Testing:** use a server-side proxy with the `drive.file` scope (plus `openid`), and mount a Plotinium-owned Drive folder at `/mnt/gdrive` (the "SSD" metaphor). A flagged, test-users-only, incremental `drive.readonly` "Browse all of Drive (read-only)" mode is optional. Do not add the Picker until a spike proves it can run in a separate non-isolated helper window.
   - **(b) Production:** stay on `drive.file`, add the Picker through that helper window, verify the brand, and publish a privacy policy with the Limited Use statement. Use restricted scopes only with a funded CASA plan.

---

## 1. OAuth 2.0 for web-server applications (Google)

### 1.1 Endpoints and metadata [F]

Source: <https://accounts.google.com/.well-known/openid-configuration> (fetched 2026-09-30); <https://developers.google.com/identity/protocols/oauth2/web-server> (page "Last updated 2026-09-14 UTC", checked 2026-09-30).

| Purpose | Value |
| --- | --- |
| issuer | `https://accounts.google.com` |
| authorization_endpoint | `https://accounts.google.com/o/oauth2/v2/auth` (HTTPS only) |
| token_endpoint | `https://oauth2.googleapis.com/token` |
| revocation_endpoint | `https://oauth2.googleapis.com/revoke` |
| userinfo_endpoint | `https://openidconnect.googleapis.com/v1/userinfo` |
| jwks_uri | `https://www.googleapis.com/oauth2/v3/certs` |
| device_authorization_endpoint | `https://oauth2.googleapis.com/device/code` (not relevant) |
| response_modes_supported | `query`, `fragment`, `form_post` |
| token_endpoint_auth_methods_supported | `client_secret_post`, `client_secret_basic` (no `private_key_jwt`, no mTLS) |
| code_challenge_methods_supported | `plain`, `S256` |
| authorization_response_iss_parameter_supported | `true` (RFC 9207 mix-up defence available) |
| scopes_supported (OIDC) | `openid`, `email`, `profile` |
| id_token_signing_alg_values_supported | `RS256` |

- [I] Fetch the discovery document at start-up, cache it, and pin the expected `issuer`. Do not hard-code the endpoints in more than one place.

### 1.2 Authorization request parameters [F]

Source: web-server guide above.

| Parameter | Google's text / behaviour | Plotinium use [I] |
| --- | --- | --- |
| `client_id`, `redirect_uri`, `response_type=code`, `scope` | Required. `redirect_uri` "must exactly match … the `http` or `https` scheme, case, and trailing slash ('/') must all match". | Required. |
| `access_type` | "Valid parameter values are `online`, which is the default value, and `offline`." `offline` makes Google "return a refresh token and an access token the first time that your application exchanges an authorization code for tokens." | `offline` (the background `/mnt/gdrive` sync needs it). |
| `prompt` | "A space-delimited, case-sensitive list … If you don't specify this parameter, the user will be prompted only the first time your project requests access." Values: `none` ("Must not be specified with other values"), `consent`, `select_account`. | `select_account` always, so users on multiple accounts pick one. Add `consent` only when we hold no refresh token for this user (lost, revoked or expired). |
| `include_granted_scopes` | "If you set this parameter's value to true and the authorization request is granted, then the new access token will also cover any scopes to which the user previously granted the application access." | `true` for incremental upgrades (for example `drive.file` → `drive.readonly`). |
| `state` | Recommended. Returned "as a name=value pair in the URL query component". "Since your redirect_uri can be guessed, using a state value can increase your assurance that an incoming connection is the result of an authentication request." Step 4: "you should confirm that the state received from Google matches the state sent". | 256-bit random, single use, server-stored with a 10-minute TTL and bound to the Plotinium session. See §5.3 for the SameSite caveat. |
| `login_hint` | Email or `sub`, used to prefill or select the account. | Use on reconnect (the stored `sub`). |
| `enable_granular_consent` | "Defaults to `true`. If set to `false`, more granular Google Account permissions will be disabled for OAuth client IDs created before 2019. No effect for newer OAuth client IDs". | Omit. We are a new client, so granular consent is always on. |
| `hd` | Hosted-domain hint. If you use it, validate the `hd` claim in the ID token ([OIDC guide](https://developers.google.com/identity/protocols/oauth2/openid-connect), last updated 2026-06-15). | Not used (consumer accounts). |

### 1.3 PKCE (RFC 7636) for a confidential client

- [F] The web-server guide **does not mention** `code_challenge`, `code_verifier` or PKCE (whole-page text search, 2026-09-30).
- [F] The native-app guide documents them: `code_verifier` is 43–128 characters from the unreserved set, and `code_challenge_method` is `S256` (recommended) or `plain` ([native-app guide](https://developers.google.com/identity/protocols/oauth2/native-app), last updated 2026-09-14).
- [F] The discovery document advertises `S256` for the whole authorization server.
- [F] Google's implicit-flow page says: "Google recommends using the Authorization Code flow with PKCE instead" ([JS implicit-flow page](https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow), last updated 2026-09-14).
- [F] RFC 7636 §4.2: "If the client is capable of using 'S256', it MUST use 'S256'." §4.6: a mismatch MUST return `invalid_grant` (<https://www.rfc-editor.org/rfc/rfc7636.html>).
- [F] RFC 9700 §2.1.1 says "For confidential clients, the use of PKCE is RECOMMENDED" and "Authorization servers MUST support PKCE" (<https://www.rfc-editor.org/rfc/rfc9700.html>, BCP 240, January 2025).
- **[S] Spike (small):** send `code_challenge` (S256) together with `client_secret` from a Web-application client on the QA copy. Confirm that (1) the exchange succeeds with the verifier, and (2) it **fails** with a wrong verifier. If (2) does not fail, PKCE gives no protection on Google's side and `state` alone carries the CSRF defence.
- [I] Send PKCE S256 anyway. It is harmless, it matches BCP 240, and a good `state` is required regardless.

### 1.4 Token response, refresh-token lifetime and limits [F]

Sources: web-server guide; [OAuth 2.0 overview](https://developers.google.com/identity/protocols/oauth2) (last updated 2026-05-26); [Manage App Audience](https://support.google.com/cloud/answer/15549945).

- Response fields:
  - `access_token`;
  - `expires_in`: "The remaining lifetime of the access token in seconds." The example shows 3920 s, roughly 1 h;
  - `refresh_token`: "valid until the user revokes access or the refresh token expires";
  - `refresh_token_expires_in`: "only set when the user grants time-based access";
  - `scope`: "The scopes of access granted by the access_token expressed as a list of space-delimited, case-sensitive strings";
  - `token_type: Bearer`;
  - `id_token` when `openid` is requested.
  - "Your application should ignore any unrecognized fields."
- **When a refresh token stops working.** The overview lists these cases:
  - "The user has revoked your app's access."
  - "The refresh token has not been used for six months."
  - "The user changed passwords and the refresh token contains Gmail scopes." This does not apply to us.
  - "The user account has exceeded a maximum number of granted (live) refresh tokens."
  - "The user granted time-based access to your app and the access expired."
  - An admin restricted the scopes (`admin_policy_enforced`).
- **Testing mode, 7 days.** "A Google Cloud Platform project with an OAuth consent screen configured for an external user type and a publishing status of 'Testing' is issued a refresh token expiring in 7 days, unless the only OAuth scopes requested are a subset of name, email address, and user profile". The help centre adds: "Authorizations by a test user will expire seven days from the time of consent."
- **Caps.**
  - "There is currently a limit of 100 refresh tokens per Google Account per OAuth 2.0 client ID. If the limit is reached, creating a new refresh token automatically invalidates the oldest refresh token without warning."
  - "There is also a larger limit on the total number of refresh tokens a user account … can have across all clients … a developer's account used to test an implementation might [exceed it]."
- **Size.** Refresh tokens are up to **512 bytes** and access tokens up to **2048 bytes**. "Google reserves the right to change token size within these limits".
- **Test users.** "Projects configured with a publishing status of Testing are limited to up to 100 test users listed in the OAuth consent screen." A test user sees a warning before consenting.
- **Unused clients.** "OAuth 2.0 clients that have been inactive for six months are automatically deleted" (restorable within 30 days). Sources: [best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices) (2026-05-20) and [policies](https://developers.google.com/identity/protocols/oauth2/policies) (2026-08-05).
- [I] What this means for the demo:
  - Every demo account must be added as a test user by a project owner.
  - Reconnect within 7 days before each gate or viva.
  - Handle `invalid_grant` as "Reconnect Google Drive", not as an error.
  - Keep one refresh token per (Plotinium uid, Google `sub`). Reuse it. Never mint new ones on every login.

### 1.5 Granular consent: detecting what was granted [F]

Sources: [granular permissions](https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions); web-server guide Step 6.

- When the granular screen appears: when an app "request[s] both Sign-In and non-Sign-In scopes, OR … more than one non-Sign-In scope". Sign-In-only requests are all-or-nothing.
- Step 6: "users may not grant your app access to all of them. Your app must verify which scopes were actually granted and gracefully handle situations where some permissions are denied, typically by disabling the features that rely on those denied scopes."
- Exceptions: apps with domain-wide delegation, or apps marked *Trusted* by an admin, bypass the granular screen.
- **Detection:** read the `scope` field of **every** token response, both the code exchange and each refresh. Store the granted set. Gate features on it.
- [I] A refresh can come back with a *smaller* set if the user removes access in their Google Account, so re-evaluate the gate after every refresh.

### 1.6 Revocation [F]

Sources: web-server guide; RFC 7009.

- Request: `POST https://oauth2.googleapis.com/revoke` with `token=<access or refresh token>`, `Content-Type: application/x-www-form-urlencoded`.
- "If the token is an access token and it has a corresponding refresh token, the refresh token will also be revoked."
- **Google differs from RFC 7009 here.** Success is HTTP 200, and "For error conditions, a status code 400 is returned along with an error code". RFC 7009 §2.2 says to return 200 even for an invalid token ([RFC 7009](https://www.rfc-editor.org/rfc/rfc7009.html)). Treat a 400 `invalid_token` as "already revoked".
- "**Key Point: Revocation removes all OAuth 2.0 scopes previously granted to a project, invalidating any issued access or refresh tokens for all clients registered under that project.**" [I] Disconnecting on one device disconnects every device, which is the right behaviour for "Disconnect Google Drive".
- RFC 7009 §2.2.1: on 503 "the client must assume the token still exists and may retry". [I] Queue the revoke for retry. Still delete our copy immediately.
- Users can also remove access themselves from their Google Account ("Third-party apps & services"). The web-server guide links to <https://support.google.com/accounts/answer/13533235>. We learn about it only through `invalid_grant`, or through Cross-Account Protection events (§8.6).

### 1.7 Error codes [F]

Source: web-server guide.

| Where | Code | Meaning (Google) | Plotinium handling [I] |
| --- | --- | --- | --- |
| Authorization endpoint | `access_denied` (redirect `error=`) | The user refused consent. | Show "Not connected"; no retry loop. |
| Authorization endpoint | `admin_policy_enforced` | "unable to authorize one or more scopes … due to the policies of their Google Workspace administrator" | Explain; suggest a personal account. |
| Authorization endpoint | `disallowed_useragent` | The authorization endpoint was opened in an embedded user-agent. | We use a real browser window, so this should not occur. |
| Authorization endpoint | `org_internal` | The client is restricted to one Cloud Organization. | This is a misconfiguration. |
| Authorization endpoint | `invalid_client` | "The OAuth client secret is incorrect." | Page the operator. |
| Authorization endpoint | `deleted_client` | Deleted manually or because it was unused; "can be restored within 30 days". | Page the operator. |
| Authorization endpoint | `redirect_uri_mismatch` | "does not match an authorized redirect URI" (also "may refer to the OAuth out-of-band (OOB) flow that has been deprecated") | Configuration error. |
| Authorization endpoint | `invalid_request` | Malformed, missing parameters, or "an authorization method that Google doesn't support". | Bug. |
| Token endpoint (code exchange) | `invalid_grant` | "The supplied authorization code is invalid or in the wrong format." | Restart the flow. |
| Token endpoint (refresh) | `invalid_grant` | "the token may have expired or has been invalidated … Otherwise, the user account may have been deleted or disabled." | Delete the stored token, mark the connection `needs-reconnect`, stop the sync. |

### 1.8 Redirect-URI rules; is `http://localhost` allowed? [F]

Source: web-server guide, "Redirect URI validation rules".

- Must use HTTPS; "Localhost URIs (including localhost IP address URIs) are exempt from this rule."
- No raw IP addresses, except localhost IPs. The host TLD must be on the public suffix list. No `googleusercontent.com`. No userinfo, no `/..`, no open redirects in the query, no fragments, no wildcards or NUL characters.
- "For testing, you can specify URIs that refer to the local machine, such as `http://localhost:8080`."
- RFC 9700 §2.1: "authorization servers MUST utilize exact string matching except for port numbers in `localhost`" (that port exemption is for native apps). Google matches exactly, including the port, for web clients.
- [I] Register these exact URIs, one per origin:
  - `http://localhost:4717/api/drive/oauth/callback` (the user's instance);
  - `http://localhost:4718/api/drive/oauth/callback` (QA);
  - `https://<prod-domain>/api/drive/oauth/callback` (production).
- [I] Always use the hostname `localhost`, never `127.0.0.1`. Our cookies and origin allowlist are keyed to `localhost` (SEC-20).
- [I] Use separate OAuth clients, and ideally separate Cloud projects, for dev and QA versus production. The policies page says so explicitly: "Maintain distinct projects for development, staging, and production environments."

### 1.9 New since 2025: DPoP for refresh tokens [F]

Source: web-server guide.

- "While the use of DPoP is optional, it is recommended for increased security. The security of DPoP relies on the private key being restricted to a single device; we recommend storing it in a way that it cannot be copied off-device, for example by using TPMs, Secure Enclaves, or other hardware-backed keystores."
- "If a valid DPoP proof is used during the exchange, the refresh token Google returns will be DPoP-bound to your key." Bound refresh tokens then require proofs.
- To get a DPoP-bound token when a plain one already exists, the user must revoke, or you must send `prompt=consent`.
- The web-server guide also marks `client_secret` as "Optional" at the token endpoint, in the DPoP context.
- [I] DPoP is **attractive for production**: a stolen database row alone becomes useless. It is **out of scope for the capstone**, because we have no HSM and would keep the DPoP private key next to the database.
- [S] If the ARB wants it, prototype with a key held in a separate secrets file (`*_FILE`, SRV-02).

### 1.10 OpenID Connect identity of the connected account [F]

Source: [OIDC guide](https://developers.google.com/identity/protocols/oauth2/openid-connect).

- "Always use the `sub` field as it is unique to a Google Account even if the user changes their email address".
- ID-token checks: signature against `jwks_uri`; `iss` is `https://accounts.google.com` or `accounts.google.com`; `aud` equals our client ID; `exp` has not passed; plus `hd` if used.
- [I] Request `openid` together with `drive.file` so that we get a stable `sub`. It lets us detect "user connected a different Google account" on reconnect. Drive's `about.get` returns `user.permissionId` and `user.emailAddress` without `openid`, but `sub` is the documented stable key. `openid` is a Sign-In scope. Combined with `drive.file` it makes the granular screen appear, and the user can still untick `drive.file`.

### 1.11 RFC 9700 (OAuth 2.0 Security BCP, BCP 240, Jan 2025) checklist [F → I]

Source: <https://www.rfc-editor.org/rfc/rfc9700.html>.

| RFC 9700 item | Requirement | Plotinium design input [I] |
| --- | --- | --- |
| §2.1 exact redirect matching | MUST | Google enforces it; register exact URIs (§1.8). |
| §2.1 open redirectors | "MUST NOT expose URLs that forward the user's browser to arbitrary URIs obtained from a query parameter" | The callback never redirects to a URL taken from the request. The "return to" window is looked up from server-stored state. |
| §2.1 CSRF | PKCE, or "one-time use CSRF tokens carried in the `state` parameter" bound to the user agent | Both: single-use `state` bound to the session, plus PKCE S256. |
| §2.1 mix-up | "SHOULD use the `iss` parameter" (RFC 9207) when a client talks to several authorization servers | Google advertises `authorization_response_iss_parameter_supported`. Check that `iss` equals `https://accounts.google.com` when present. Low risk: there is one authorization server. |
| §2.1.1 PKCE | Public clients MUST; confidential clients RECOMMENDED; "Authorization servers MUST mitigate PKCE downgrade attacks" | Send S256 (§1.3). |
| §2.1.2 implicit | "SHOULD NOT use the implicit grant" | Do not use the GIS token model or implicit flow. |
| §2.2 replay | Sender-constrain tokens where possible | DPoP later (§1.9). The capstone relies on server-only storage and encryption at rest. |
| §2.3 privilege | Access tokens "SHOULD be restricted to the minimum required" | Least scope (§2). |
| §2.4 ROPC | "MUST NOT be used" | Not applicable. |
| §2.5 client auth | Asymmetric RECOMMENDED | Google supports only `client_secret_*`. Keep the secret in a `*_FILE` secret (SRV-02); never in the repo or the bundle. |
| §2.6 TLS | "Authorization responses MUST NOT be transmitted over unencrypted network connections"; `http` only for loopback | Production is HTTPS (Caddy). Local development is `http://localhost` loopback only. |

---

## 2. Scopes, verification and what Testing allows

### 2.1 Drive scope classification [F]

Source: [Choose Google Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) (last updated 2026-09-03).

| Scope (`https://www.googleapis.com/auth/…`) | Class | Google's description |
| --- | --- | --- |
| `drive.file` | **Non-sensitive (recommended)** | "Create new Drive files, or modify existing files, that you open with an app or that the user shares with an app while using the Google Picker API or the app's file picker." |
| `drive.appdata` / `drive.appfolder` | Non-sensitive | "View and manage the app's own configuration data in your Google Drive." Hidden app folder, invisible to the user. |
| `drive.install` | Non-sensitive | Appear in Drive's "Open with" / "New" menus. |
| `drive.apps.readonly` | Sensitive | "View apps authorized to access your Drive". |
| `drive` | **Restricted** | "View and manage all your Drive files". |
| `drive.readonly` | **Restricted** | "View and download all your Drive files". |
| `drive.metadata` | **Restricted** | "View and manage metadata of files in your Drive". |
| `drive.metadata.readonly` | **Restricted** | "View metadata for files in your Drive". |
| `drive.activity`, `drive.activity.readonly`, `drive.meet.readonly`, `drive.scripts` | Restricted | — |

- [F] The Workspace policy defines a restricted Drive scope as "Any Drive API scope that permits an application to: Read, modify, or manage the content or metadata of a user's Drive files, **without the user individually granting file-by-file access**" ([Workspace user data policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy), 2026-09-03).
- [F] Google's guidance: "Generally, you should choose the most narrowly focused scope possible". "Whenever possible, use non-sensitive scopes as they grant per-file and narrow access". "If your Drive app uses restricted scopes, we recommend migrating to a non-sensitive Drive API scope."
- [F] What each scope allows on the endpoints we care about:
  - `about.get` and `changes.getStartPageToken` accept `drive.file`. The reference pages list it under "Requires one of the following OAuth scopes".
  - `files.list` and `files.update` accept `drive.file`.
- [I] With `drive.file` alone:
  - `about.get` **works**, so we can show quota and account without a restricted scope.
  - `files.list` returns only files the app created or was granted (Picker or "Open with").
  - `changes.list` shows changes only for those files. This last point is [S]: confirm it in the spike.

### 2.2 What a capstone demo can use in Testing [F]

Sources: [When is verification not needed](https://support.google.com/cloud/answer/13464323); [Manage App Audience](https://support.google.com/cloud/answer/15549945); [restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification) (2026-08-19).

- "Apps in development/testing/staging mode are not subject to verification." "If your app is in the development, testing, or staging phases, verification isn't required".
- Personal use: "If the app is for your personal use (fewer than 100 users) … you and your limited number of users can continue using the app without going through verification".
- The Testing cap is 100 listed test users, who see a warning screen. Their authorizations expire in 7 days (§1.4).
- An unverified app **in production** with sensitive or restricted scopes shows the unverified-app screen and has "a hard cap of 100 new users total across the application's entire lifetime", which "cannot be reset".
- Caveat: "All apps that integrate with Google APIs are required to comply with Google's API Services User Data Policy regardless of whether they have been verified."
- [I] **In Testing, any Drive scope, including the restricted `drive`, is technically usable by the ≤ 100 listed test users with no verification and no CASA.** The costs are the 7-day expiry, the warning screen, and manual enrolment of every examiner's Google account. The policy still applies in full.

### 2.3 What production requires [F]

- **Brand verification** is required when an External app shows a name or logo on the consent screen. It "typically takes 2-3 business days". Do not "use any Google product names as part of your name, or any Google product icons, logos, or trademarks as part of your icon or logo" ([brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification), 2026-08-19; [App Identity & Branding](https://support.google.com/cloud/answer/13804963)).
- **The production app needs** a "publicly accessible homepage with app description, terms of service, and privacy policy links on a verified domain" ([policies](https://developers.google.com/identity/protocols/oauth2/policies)).
- **Sensitive-scope verification** needs a scope justification and a **demo video** on YouTube (unlisted). The video must show the consent flow, the app name, the client ID in the address bar, and "the functionality that's enabled by each sensitive and restricted scope" ([sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification), 2026-08-19).
- **Restricted-scope verification** adds four things:
  - An approved app category. For Drive the categories are "Backup and sync", "Productivity and education" ("Apps with a primary user interface that might involve interaction with Drive files, metadata, or permissions"), and "Reporting and security".
  - A security assessment: "Every app that requests access to Google users' restricted data and has the ability to access data from or through a third-party server must go through a security assessment from Google-empanelled security assessors."
  - The Drive scopes guide puts it plainly: "If you store restricted scope data on servers (or transmit), then you must go through a security assessment."
  - Reassessment "at least every 12 months after your assessor's Letter of Assessment (LOA) approval date".
- **CASA** ([Security Assessment](https://support.google.com/cloud/answer/13465431)):
  - It is based on OWASP ASVS and run by the App Defense Alliance.
  - "Applications are assigned to either the AL1 or AL2 assurance level."
  - "All applications must be revalidated every year."
  - The assessment "verifies that the application can securely handle data and delete user data upon request."
  - The result is called a "Letter of Validation" (LOV) on this page and a "Letter of Assessment" (LOA) on the developers page. The naming is inconsistent in Google's own documents.
  - **Cost is not stated** on any page I checked. It is paid to the assessor. [S] Get a quote if production with restricted scopes is ever on the table.
- **Excluded Drive uses** (Workspace policy) include:
  - "Backup of user or app content from a developer's app or project to Drive";
  - "Using Drive as a replacement for a large-scale content delivery network (CDN)";
  - "File cloning tools that enable sharding of user storage and/or circumvention of Drive storage limits".
- [I] **This is an important risk for the "Drive as SSD" framing.** Writing Plotinium's own system data (swap, VFS mirror, backups) to the user's Drive could read as "backup of … app content from a developer's app … to Drive", which is on the **not-allowed** list for Drive scopes.
  - Framing it as the **user's** files that the user chooses to keep in their Drive (a user-visible "Plotinium" folder of their documents) fits "Productivity" and `drive.file`.
  - Framing it as the OS silently paging its internals to Drive does not fit.
  - Do **not** use Drive as a MEM-04/MEM-05 swap tier.

---

## 3. Google user-data policies, Limited Use, and AI/ML

### 3.1 The policies and when they apply [F]

- **Google API Services User Data Policy** (<https://developers.google.com/terms/api-services-user-data-policy>, "Last updated February 15, 2024"). It applies to **all** Google API use.
  - "You must disclose all user data that you access, use, store, delete, or share".
  - A privacy policy must be published and linked in the OAuth client "when your application is made available to the public".
  - If you plan to use a type of data that was not disclosed, "you must update your privacy policy and prompt the user to consent to any changes before you may access that data".
  - The Limited Use and Secure Data Handling sections apply to "the product specified scopes (the 'Sensitive and Restricted Scopes')".
- **Google Workspace API User Data and Developer Policy** (<https://developers.google.com/workspace/workspace-api-user-data-developer-policy>, last updated 2026-09-03). It covers the Drive scopes. Its Limited Use section says: "These requirements apply to data derived from both Sensitive and Restricted scopes."
- **Google APIs Terms of Service** (<https://developers.google.com/terms>, "Last modified: November 9, 2021"), §5e: "Unless expressly permitted by the content owner or by applicable law, you will not … Scrape, build databases, or otherwise create permanent copies of such content, or keep cached copies longer than permitted by the cache header". The Workspace policy repeats it: "(including databases for model training purposes)".
- [I] **Strictly, `drive.file` is non-sensitive, so the Workspace Limited Use section does not bind it.** The general User Data Policy and the ToS still apply. **Recommendation: design as if Limited Use applied to all Drive data.** It costs little, it keeps a later upgrade to restricted scopes cheap, and reviewers will ask about it.

### 3.2 Limited Use: the operative text [F]

From the Workspace policy:

- "Limit your use of data to providing or improving your appropriate use case or features that are visible and prominent in the requesting application's user interface."
- "Transfers of data are not allowed, except:
  - To provide or improve your appropriate use case or user-facing features that are visible and prominent in the requesting application's user interface **and only with the user's consent**;
  - For security purposes (for example, investigating abuse);
  - To comply with applicable laws and/or regulations; or,
  - As part of a merger, acquisition or sale of assets of the developer after obtaining explicit prior consent from the user."
- "All other transfers, uses, or sale of user data is completely prohibited, including: … advertising platforms, data brokers … serving ads … credit-worthiness … **Transferring, selling, or using user data to create, train, or improve a machine learning or artificial intelligence model beyond that specific user's personalized model for the appropriate use case or user-facing feature.**"
- Humans may not read user data unless one of these holds:
  - "You have obtained and documented the user's explicit consent or affirmative agreement to view specific messages, files, or other data";
  - the data is "aggregated and anonymized" for internal operations;
  - it is needed for security;
  - it is needed for legal compliance.
- The required public statement, "in your application or on a website belonging to your web-service", is for example: "**The use of information received from Google Workspace scopes will adhere to the Google User Data Policy, including the Limited Use requirements.**" The general policy's equivalent: "use and transfer to any other app of information received from Google APIs will adhere to Google API Services User Data Policy, including the Limited Use requirements".

### 3.3 In-product disclosure and consent requirements [F]

Workspace policy, "Transparent and accurate notice and control". The disclosure:

- "Must be within the application itself if application-based or in a separate dialog window if web-based";
- "Must be displayed in the normal usage of the application … and not require the user to navigate into a menu or settings";
- must explain the data types and uses, including secondary uses;
- "Cannot be placed only in a privacy policy or terms of service";
- "Cannot be included with other disclosures unrelated to personal and sensitive data collection";
- "Your disclosure must accompany and immediately precede a request for user consent. You must not begin collection prior to obtaining affirmative consent."

The request for consent must:

- "require affirmative user action (for example, tap to accept, tick a check-box …)";
- not treat navigating away as consent;
- not "utilize auto-dismissing or expiring messages".

Two further requirements:

- **New and directly relevant to the agentic shell:** "Applications and services must also request access to user data in context (via incremental auth) … For example, **granularly require users to confirm the MCP, tool, skill, or other agentic behavior invocation.**"
- "You must provide user help documentation that explains how users can manage and delete their data from your app or service."

### 3.4 The questions the task asked [F → I]

**Q1. May Drive content be sent to a third-party LLM (Anthropic) for a feature the user requested?**

- [F] The rules allow it only as a transfer "to provide or improve … user-facing features that are visible and prominent … and only with the user's consent", and never to train a generalized model.
- [F] Anthropic's documented commercial-API terms:
  - "Retained data is never used for model training without your express permission" ([Claude API data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention), checked 2026-09-30);
  - "we automatically delete inputs and outputs on our backend within 30 days", with longer retention (up to 2 years) if flagged by trust and safety ([Anthropic Privacy Center](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)).
- [I] **Yes, under conditions:**
  1. The feature is visible and user-initiated, for example "Summarise this Drive file" or the agent reading a Drive path the user named.
  2. There is a clear in-product disclosure, shown immediately before a consent, stating that the content of selected Drive files is sent to Anthropic, is not used for training, and is retained up to 30 days (longer if flagged).
  3. There is per-invocation confirmation for agentic tool use on Drive data (the policy's "granularly require users to confirm the MCP, tool, skill, or other agentic behavior invocation"). This matches AGT confirmations in `specs/10-ai/agentic-shell.md`.
  4. We send the minimum: only the chunks needed, never whole-Drive sweeps.
  5. The privacy policy names Anthropic as a sub-processor.
  6. For restricted scopes: "Protecting against prompt injection techniques by either using Google Cloud Platform's Model Armor or other prompt injection protection" is a **required** measure (§3.5). Our AI-safety suite (INJ-20, `rag-leak`) is the candidate "other protection". It must cover Drive-sourced text.
  7. [I] We should also consider a Zero Data Retention agreement for production (Anthropic sales).

**Q2. May Drive content be embedded locally for semantic search?**

- [I] **Yes, as a user-facing feature ("find by meaning across my connected Drive"), with conditions.** The "personalized model" carve-out plus Limited Use's "providing … user-facing features" cover per-user embeddings used only for that user's search. They are not used to train a shared model. The embedding model itself is a frozen, pre-trained model.
- Conditions:
  1. Opt in per mount ("Index my Google Drive folder for search"), with a disclosure.
  2. Treat vectors and chunk text as **derived Drive data**: same retention, same deletion.
  3. Keep them per uid and never serve them to another uid. This is already the RAG-03 design: chunk text per uid, filtering at query time.
  4. Purge on disconnect, on revocation or `invalid_grant`, and on account deletion.
  5. Watch the ToS "build databases … permanent copies" clause. The user is the content owner and expressly opts in; for files the user does not own, that permission is weaker [I, flag for review]. Recommendation: index only files where the connected user is an owner or has `canDownload`, and only after opt-in.
- [F] The Plotinium RAG spec stores "authoritative vectors next to the inode table in PostgreSQL" (`specs/10-ai/rag-semantic-search.md` line 20). So **indexing Drive content means storing derived Drive data on our server.** With a restricted scope, that alone triggers the CASA requirement. With `drive.file` it does not, but the measures in §3.5 are still good practice.
- [F] Google exposes a `capabilities.canAccessViaGenAi` file field: "Whether the current user can access this file via Gen AI features" ([File resource](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)).
  - [I] Honour it. If it is `false` (for example an IRM or admin restriction), do not send the file to the LLM and do not index it.
  - Also honour `downloadRestrictions` and `copyRequiresWriterPermission`.
  - [S] What `canAccessViaGenAi` means for third-party apps is not documented beyond that one line.

**Q3. What consent and disclosure do they need?** The three items below cover it.

- A connect-time dialog (our own UI, before we open Google's consent). It says what Plotinium will access (files it creates, or files you pick), where it is stored (our server, encrypted), and how to disconnect and delete. It carries a Limited Use statement link.
- A separate first-use AI dialog for "send to Claude" and for "index for search". Keep it separate because the policy says disclosures "Cannot be included with other disclosures unrelated".
- Per-invocation confirmation for agent tool calls that read Drive.

All consents must be affirmative, logged (audit), and revocable in Settings.

### 3.5 Required security measures for restricted scopes (Workspace policy) [F]

"Required security measures include:

- Using an industry accepted encryption standard to encrypt user data that is: stored on portable devices …; maintained outside of Google's or your systems; transferred across any external network not solely managed by you; and at rest on your systems.
- Transmitting data using secure modern protocols (for example, over HTTPS).
- **Keeping user data and credentials, specifically tokens such as OAuth access and refresh tokens, encrypted at rest.**
- **Ensuring keys and key material are managed appropriately, such as stored in a hardware security module or equivalent-strength key management system.**
- **Protecting against prompt injection techniques** by either using Google Cloud Platform's Model Armor or other prompt injection protection.
- … following the Cloud Application Security Assessment (CASA)."

Recommended: an ISMS "such as outlined in ISO/IEC 27001" and resistance to the "OWASP Top 10".

**Incident duty:** "You agree to promptly notify Google at security@google.com of any known or suspected unauthorized access to the systems, networks, accounts, or other locations where Google Data is stored ('Security Incident') … and … to notify Google … before you make any public statements".

The page also points MCP integrators to the MCP security best practices.

---

## 4. Drive API v3 facts

All pages are under `https://developers.google.com/workspace/drive/api/…`, checked 2026-09-30. The page's own "last updated" date is given where it was shown.

### 4.1 `files.list` [F]

Source: [reference/rest/v3/files/list](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list).

- `corpora`: `user` (default), `domain`, `drive`, `allDrives`. "Prefer `user` or `drive` to `allDrives` for efficiency."
- `driveId`, `includeItemsFromAllDrives`, and `supportsAllDrives` ("Whether the requesting application supports both My Drives and shared drives").
- `spaces`: `drive`, `appDataFolder`.
- `orderBy` keys: `createdTime`, `folder`, `modifiedByMeTime`, `modifiedTime`, `name`, `name_natural`, `quotaBytesUsed`, `recency`, `sharedWithMeTime`, `starred`, `viewedByMeTime`. Add `desc` to reverse.
- `pageSize`: max 1000. `pageToken` takes `nextPageToken`.
- The response carries `incompleteSearch`. If `true`, "some search results might be missing". This can happen when searching multiple corpora ([search guide](https://developers.google.com/workspace/drive/api/guides/search-files), 2026-09-09).
- Deprecated parameters: `corpus` → `corpora`, `supportsTeamDrives` → `supportsAllDrives`, `teamDriveId` → `driveId`.
- `fields`: use partial responses, for example `fields=nextPageToken,files(id,name,mimeType,parents,size,md5Checksum,modifiedTime,version,trashed,capabilities(canEdit,canTrash,canDelete,canDownload,canAccessViaGenAi),shortcutDetails)`. See §4.12.

### 4.2 `q` syntax [F]

Sources: [search guide](https://developers.google.com/workspace/drive/api/guides/search-files); [search terms](https://developers.google.com/workspace/drive/api/guides/ref-search-terms) (2026-09-03).

- Form: `query_term operator value`. Combine with `and`, `or`, `not`.
- Operators: `contains`, `=`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `has`.
- Terms: `name`, `fullText`, `mimeType`, `modifiedTime`, `viewedByMeTime`, `createdTime` (RFC 3339, default UTC), `trashed`, `starred`, `parents`, `owners`, `writers`, `readers`, `sharedWithMe`, `properties`/`appProperties` (`has`), `visibility`, `shortcutDetails.targetId`.
- Folder listing: `'<folderId>' in parents and trashed = false`. Folders have `mimeType = 'application/vnd.google-apps.folder'`.
- **Escaping:** "if a filename contains both an apostrophe (') and a backslash ('\\') character, use a backslash to escape them: `name contains 'quinn\'s paper\\essay'`". [I] Build `q` with one escaping function that has unit tests. Never concatenate user input directly.
- **Matching semantics:** "The contains operator only performs prefix matching for a name term … `name contains 'World'` doesn't [match HelloWorld]". For `fullText`, `contains` matches "entire string tokens".

### 4.3 `files.get` and downloads [F]

Sources: [files/get](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get) (2026-03-20); [download guide](https://developers.google.com/workspace/drive/api/guides/manage-downloads) (2026-09-03).

- `GET https://www.googleapis.com/drive/v3/files/{fileId}`. `alt=media` returns the bytes. "Downloading content with alt=media only works if the file is stored in Drive. To download Google Docs, Sheets, and Slides use files.export instead."
- Partial download: `Range: bytes=500-999`, for blob files only.
- `acknowledgeAbuse`: "Whether the user is acknowledging the risk of downloading known malware or other abusive files. This is only applicable when the alt parameter is set to media and the user is the owner of the file or an organizer of the shared drive". [I] Never set it automatically. It needs an explicit user choice in the UI.
- `capabilities.canDownload` says whether the file may be downloaded.
- `files.download` is a long-running operation. It is the only method for Google Vids.
- Only revisions marked "Keep Forever" can be downloaded.

### 4.4 `files.export` [F]

Sources: [files/export](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export); [export formats](https://developers.google.com/workspace/drive/api/guides/ref-export-formats).

- `GET …/files/{fileId}/export?mimeType=…`. "**Note that the exported content is limited to 10 MB.**"
- The format table:

| Source | Export MIME types |
| --- | --- |
| Google Docs | `text/markdown` (.md), `text/plain`, `text/html`, `application/zip` (HTML zipped), `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document` (.docx), `application/vnd.oasis.opendocument.text`, `application/rtf`, `application/epub+zip` |
| Google Sheets | `.xlsx` (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`), `application/vnd.oasis.opendocument.spreadsheet`, `application/pdf`, `application/zip`, `text/csv` (**first sheet only**), `text/tab-separated-values` (**first sheet only**) |
| Google Slides | `.pptx` (`application/vnd.openxmlformats-officedocument.presentationml.presentation`), `application/vnd.oasis.opendocument.presentation`, `application/pdf`, `text/plain` |
| Google Drawings | `application/pdf`, `image/jpeg`, `image/png`, `image/svg+xml` |
| Apps Script | `application/vnd.google-apps.script+json` |
| Google Vids | `video/mp4`, via `files.download` only, not `export` |

- `exportLinks` (browser URLs per format) exists, but it needs the user's cookies. [I] Do not use it.
- [I] Map Workspace files in `/mnt/gdrive` to **read-only synthesized exports**:
  - Docs → `.md`
  - Sheets → `.csv` of the first sheet, or `.xlsx`
  - Slides → `.txt` or `.pdf`
- [I] Edits to them are `EROFS`/`EPERM` unless we implement import.
- [I] Exports over 10 MB fail. Surface the error as `EFBIG` with a hint.

### 4.5 `files.create` / `files.update` and uploads [F]

Sources: [upload guide](https://developers.google.com/workspace/drive/api/guides/manage-uploads) (2026-09-03); [files/update](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/update); [limits](https://developers.google.com/workspace/drive/api/guides/limits) (2026-09-11).

- Upload base: `https://www.googleapis.com/upload/drive/v3/files`.
  - `uploadType=media`: "a small media file (5 MB or less) without supplying metadata".
  - `uploadType=multipart`: "5 MB or less along with metadata".
  - `uploadType=resumable`: "large files (greater than 5 MB) and when there's a high chance of network interruption".
- Resumable details:
  - The `Location` header returns the session URI. "Session URIs expire after one week".
  - Chunks must be multiples of **256 KB**, except the last. The server returns `308 Resume Incomplete`.
  - Query status with an empty `PUT` and `Content-Range: bytes */<size>`.
  - A `404` means the session expired, so restart. On 5xx, resume or retry.
  - Optional headers: `X-Upload-Content-Type`, `X-Upload-Content-Length`.
- `files.update` is **PATCH**: `PATCH …/upload/drive/v3/files/{fileId}` for media, and `PATCH …/drive/v3/files/{fileId}` for metadata. "This method supports patch semantics".
  - Parameters: `addParents`, `removeParents`, `keepRevisionForever` (max 200 pinned revisions per file), `useContentAsIndexableText`, `ocrLanguage`, `supportsAllDrives`.
  - Maximum file size: "5,120 GB".
- **Single parent:** "A file can only have one parent folder; specifying multiple parents isn't supported." Move = `addParents=<new>&removeParents=<old>`.
- Limits: "Users can upload maximum 750 GB daily across My Drive and shared drives". Max file 5 TB. Max copy 750 GB.
- Error `myDriveHierarchyDepthLimitExceeded`: nesting over 100 folder levels. [I] Map it to `ENAMETOOLONG` or `EMLINK` in the VFS.

### 4.6 Trash versus delete [F]

Source: [trash or delete](https://developers.google.com/workspace/drive/api/guides/delete) (2026-09-03).

- Trash: `files.update` with `{"trashed": true}`. "Files in the trash are automatically deleted after 30 days." Untrash with `trashed: false`.
- Delete: `files.delete` "permanently" deletes and skips the trash. "anyone you've shared the file with loses access to it". When a folder is deleted, "all descendants owned by the user are also deleted".
- `files.emptyTrash` empties the whole trash.
- Only the owner may trash. Otherwise the error is `insufficientFilePermissions`. Check `capabilities.canTrash`, `canDelete` and `canUntrash`.
- [I] VFS `unlink` and `rmdir` on `/mnt/gdrive` should **trash**, never delete, and say so in the UI. Offer "Delete permanently" only as an explicit, confirmed action. This matches the AGT destructive-action confirmation rule.

### 4.7 `about.get` [F]

Source: [about/get](https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get); [About resource](https://developers.google.com/workspace/drive/api/reference/rest/v3/about).

- "The `fields` parameter must be set". It is mandatory for `about`, `comments` and `replies`.
- `storageQuota`:
  - `limit`: "This will not be present if the user has unlimited storage";
  - `usage`: "across all services", and organisation-wide for pooled storage;
  - `usageInDrive`;
  - `usageInDriveTrash`.
- Also: `user` (`displayName`, `emailAddress`, `permissionId`, `photoLink`), `maxUploadSize`, `importFormats`, `exportFormats`, `maxImportSizes`.
- Accepted scopes include `drive.file`.
- [I] `df /mnt/gdrive` and the Settings > Storage bar can read `fields=storageQuota,user` with `drive.file`. `int64` values arrive as JSON **strings**, so parse them with `BigInt` or `Number` and guard the size.

### 4.8 Changes feed [F]

Sources: [manage changes](https://developers.google.com/workspace/drive/api/guides/manage-changes) (2026-09-03); [changes/list](https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list) (2026-07-07).

- `changes.getStartPageToken` returns a token for "the current state of the account".
- `changes.list?pageToken=…` returns either `nextPageToken` (more pages) or `newStartPageToken` (the last page; store it).
- `pageSize`: default 100, max 1000 ("values above 1000 will be coerced to 1000").
- Parameters: `includeRemoved`, `includeCorpusRemovals`, `restrictToMyDrive` (omits appData and shared files not added to My Drive), `spaces`, `driveId`, `includeItemsFromAllDrives`, `supportsAllDrives`.
- `changes.watch` sends push notifications that say only that changes exist. It requires a public HTTPS webhook. The Workspace Events API subscriptions for Drive are "Generally Available" since 2026-05-18 (release notes).
- [I] The capstone runs on `http://localhost` and has no public webhook, so **poll** `changes.list`. Poll only when the Files app shows `/mnt/gdrive`, or at most every 60 s, with backoff. Each `changes.list` call costs 100 quota units (§4.11).
- [S] Page-token retention is **not documented**. Handle an invalid or expired token by doing a full rescan.

### 4.9 Conditional requests and ETags [F]

- v3 **removed** ETags from files. The v2→v3 reference table lists "Files etag n/a" and "files.list etag n/a" ([v2-to-v3 reference](https://developers.google.com/workspace/drive/api/guides/v2-to-v3-reference), 2026-09-03).
- The v3 File resource has no `etag` field (whole-page search).
- The performance page mentions ETags only generically: "If ETags are used by the API…".
- [I] **There is no `If-Match` concurrency control in v3.** Use `version` instead: "A monotonically increasing version number for the file. This reflects every change made to the file on the server, even those not visible to the user".
  - Before a write-back, `files.get fields=version,md5Checksum,headRevisionId`. If the result differs from our base, create a **conflicted copy** instead of overwriting. The VFS sync spec already has this concept.
  - The check-then-write is **not atomic**, so a narrow race remains. Document it as a known limitation.

### 4.10 File fields we need [F]

Source: [File resource](https://developers.google.com/workspace/drive/api/reference/rest/v3/files) (2026-07-14).

- `md5Checksum`, `sha1Checksum`, `sha256Checksum` exist only for blob content; they are "not populated for Docs Editors or shortcut files".
- `headRevisionId`: "currently only available for files with binary content".
- `size`: none for folders and shortcuts. `quotaBytesUsed` includes kept revisions.
- `trashed` versus `explicitlyTrashed`.
- `thumbnailLink`: "short-lived … on the order of hours". [I] The browser cannot load it under our CSP and COEP anyway. Proxy and cache it server-side, or skip thumbnails.
- `capabilities`: 46 flags, including `canEdit`, `canModifyContent`, `canRename`, `canTrash`, `canUntrash`, `canDelete`, `canDownload`, `canAddChildren`, `canListChildren`, `canShare`, `canCopy`, `canReadRevisions` and `canAccessViaGenAi`. [I] Map them to VFS permission bits for the synthesized mode:
  - `r` if `canDownload`;
  - `w` if `canModifyContent`;
  - `x` / `canAddChildren` for directories.
- `isAppAuthorized`: "Whether the file was created or opened by the requesting app". This is useful with `drive.file`.
- `contentRestrictions.readOnly`, `downloadRestrictions.restrictedForReaders/Writers`, `copyRequiresWriterPermission`. A 2025-07-16 release note says download, print and copy restrictions now apply to writers too.
- **Shortcuts:**
  - `mimeType = application/vnd.google-apps.shortcut`, with `shortcutDetails.targetId`, `targetMimeType` (a snapshot taken at creation) and `targetResourceKey`.
  - "A shortcut can only have one parent".
  - [I] Represent them as VFS symlinks to `/mnt/gdrive/.by-id/<targetId>`. Dangling targets give `ENOENT`.
- `resourceKey`: needed for some link-shared items.

### 4.11 Quotas, cost and rate limits [F]

Sources: [limits](https://developers.google.com/workspace/drive/api/guides/limits) (2026-09-11); [release notes](https://developers.google.com/workspace/drive/release-notes) (2026-09-03).

- Since 2026-05-01, "usage quotas will change to be measured in quota units instead of the number of requests. Additionally, Google Workspace users can now only egress 1 TB per day."
- Limits:
  - "Per minute per project: 1,000,000 quota units";
  - "Per minute per user per project: 325,000 quota units";
  - "Per day per project: 1 TB", described as "the maximum number of bytes your Google Cloud project can egress within a 24-hour period before charges apply".
- Unit costs: "Read items, such as files.get: 5 | List items, such as files.list: 100 | Download items, such as files.download: 200 | Edit items, such as files.update: 50".
- **Billing:** "Exceeding the quota request limits is planned to incur charges to your Google Cloud billing account later in 2026." "Full billing details will be shared later in 2026 with at least 90 days' notice".
  - [I] **Do not attach a billing account to the capstone project.** Then quota overruns fail with 403/429 instead of costing money. Re-check this page before each gate.
- Per-user budget [I]: 325,000 units/min ≈ 3,250 `files.list` calls/min, which is ample. The real constraint is the backend rate limit (429). Cap our proxy at, for example, 10 Drive calls/s per user with a token bucket. Use `dsa/` structures if the RFC wants one.

### 4.12 Error model and backoff [F]

Sources: [handle errors](https://developers.google.com/workspace/drive/api/guides/handle-errors) (2026-09-03); limits page.

- Body: `{"error":{"code":…,"message":…,"errors":[{"domain":…,"reason":…,"message":…}]}}`. [I] Switch on `errors[0].reason`, not on the message text.

| HTTP | reason | Action (Google) | VFS mapping [I] |
| --- | --- | --- | --- |
| 400 | `badRequest`, `invalidSharingRequest`, `illegalKeepForeverModification` | Fix the request. | `EINVAL` |
| 401 | `authError` ("Invalid Credentials") | Refresh the access token or request the scope. | Refresh once, then `EACCES` + reconnect. |
| 403 | `userRateLimitExceeded`, `rateLimitExceeded` | Exponential backoff. | `EAGAIN` after retries. |
| 403 | `dailyLimitExceeded` | Project quota reached. | `EAGAIN`, then disable the sync until reset. |
| 403 | `sharingRateLimitExceeded` | — | `EAGAIN` |
| 403 | `storageQuotaExceeded` | "User storage full". | `ENOSPC` / `EDQUOT` |
| 403 | `appNotAuthorizedToFile` | "App lacks ACL access. Use picker, 'Open with' menu, or verify `isAppAuthorized`". | `EACCES` (the typical `drive.file` case) |
| 403 | `insufficientFilePermissions` | No write access. | `EACCES` |
| 403 | `domainPolicy` | "Domain administrators have disabled Drive apps." | `EACCES` + explanation |
| 403 | `teamDriveFileLimitExceeded` / `myDriveHierarchyDepthLimitExceeded` | Limits. | `ENOSPC` / `EMLINK` |
| 403 | `cannotDownloadAbusiveFile` (abuse) | Needs `acknowledgeAbuse`. | `EACCES` + explicit user choice |
| 404 | `notFound` | Also set `supportsAllDrives=true` for shared drives. | `ENOENT` |
| 429 | `rateLimitExceeded` | Exponential backoff. | `EAGAIN` after retries |
| 500/502/503/504 | `backendError` | "Retry using exponential backoff." | `EIO` after retries |

- **Backoff (limits page):** "The wait time is `min(((2^n)+random_number_milliseconds), maximum_backoff)`, with `n` incremented by 1 for each iteration. `maximum_backoff` is typically 32 or 64 seconds." The random jitter is ≤ 1000 ms.
- [I] Cap at 5 retries for interactive calls and 8 for background sync. Only idempotent operations are retried blindly. For a non-resumable create, first check `files.list q="appProperties has {key='plotiniumOpId' and value='…'}"` to avoid duplicates. Set a `plotiniumOpId` appProperty on every create.

### 4.13 Performance [F]

Source: [performance](https://developers.google.com/workspace/drive/api/guides/performance) (2026-09-03).

- Use `fields` everywhere.
- Gzip needs `Accept-Encoding: gzip` **and** a `User-Agent` containing `gzip`.
- PATCH returns the full resource unless `fields` is set.
- **Batch:** `multipart/mixed`, "a maximum of 100 calls per batch request", URLs up to 8,000 characters.

### 4.14 Recent Drive platform changes that matter [F]

Source: release notes.

- 2026-04-22: a Drive **MCP server** (developer preview). [I] Not usable here: it is a preview, and our agent works through syscalls.
- 2026-05-01: quota units and the 1 TB/day egress limit.
- 2026-05-18: Drive events through the Workspace Events API are GA.
- 2025-07-16: download restrictions apply to writers. `DownloadRestriction` is preferred over `copyRequiresWriterPermission`.
- 2025-02-19: folders with limited access (`inheritedPermissionsDisabled`) are GA.

---

## 5. Plotinium's headers versus Google's browser-side pieces

### 5.1 What Plotinium sends today [F from repo]

Sources: `Caddyfile`; `ops/caddy/csp-hash.ts`; `specs/12-security/security-model.md` §4.1.

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`
- `Cross-Origin-Resource-Policy: same-origin`
- `Referrer-Policy: no-referrer`
- CSP: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' <hashes>; style-src 'self' <hashes>; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`
- Trusted Types in Report-Only.
- Session cookie: `plt_sid` / `__Host-plt_sid`, HttpOnly, **SameSite=Strict**.
- The platform relies on `crossOriginIsolated` for SharedArrayBuffer pre-emption, two-thread ORT and `measureUserAgentSpecificMemory` (MEM-01, T-29, SEC-02). **Relaxing COOP or COEP on the OS document is therefore not free.**

### 5.2 Can the Google Picker work? **Not in the OS document as configured.** [F + P + I]

What the Picker needs [F]:

- `https://apis.google.com/js/api.js` then `gapi.load('picker')`.
- An OAuth token (`setOAuthToken`).
- An **API key** (`setDeveloperKey`), where "you must include both your application domain and `https://docs.google.com/*`" in the key's website restrictions.
- `setAppId` with the Cloud project number.
- It "renders in an iframe hosted on `docs.google.com`".
- The `drive.file` scope.
- Sources: [Picker overview](https://developers.google.com/workspace/drive/picker/guides/overview) (2026-09-14); [web picker guide](https://developers.google.com/workspace/drive/picker/guides/web-picker) (2026-09-03).

What blocks it:

1. **CSP [F, from our policy]:** `script-src 'self'` blocks `apis.google.com`. `frame-src` falls back to `default-src 'self'` and blocks the `docs.google.com` iframe. `connect-src 'self'` blocks the gapi XHRs.
2. **COEP `require-corp` [F + P]:**
   - [F] Cross-origin iframes must opt in with COEP and CORP ([web.dev COOP/COEP](https://web.dev/articles/coop-coep)).
   - [P] `curl -sD- https://docs.google.com/picker` on 2026-09-30 returned `cross-origin-resource-policy: same-site`, **no** `Cross-Origin-Embedder-Policy`, and `content-security-policy-report-only: … frame-ancestors 'none'`. So the frame would be blocked under our COEP. That was an unauthenticated 401 response, and a real Picker URL returned 403 to curl, so this is indicative, not conclusive.
   - [P] By contrast, `apis.google.com/js/api.js` does send `cross-origin-resource-policy: cross-origin` and `access-control-allow-origin: *`, so the script itself would load if the CSP allowed it.
3. **`iframe credentialless` [F]:**
   - It "loads from a new empty context" without cookies. It is Chrome 110+ only; Firefox is "Pending" and WebKit gives "No signal" ([Chrome blog](https://developer.chrome.com/blog/iframe-credentialless), 2023).
   - [I] The Picker frame would not have the user's Google session cookies. Whether the OAuth token alone is enough is unknown [S], and the approach is Chromium-only.
4. **`Referrer-Policy: no-referrer` [I]:** An API key restricted by HTTP referrer may fail for requests our page initiates. [S]
5. **Trusted Types [I]:** gapi injects scripts. We are only in Report-Only mode today, but reports will fire.

**Workable variant to spike [S]: a Picker helper window.**

- Serve one dedicated page, for example `/drive-picker.html`, with its own **non-isolated** header set:
  - no COEP;
  - COOP `same-origin-allow-popups` or `unsafe-none`;
  - a page-specific CSP that allows `https://apis.google.com` (script) and `https://docs.google.com` (frame);
  - Referrer-Policy `strict-origin-when-cross-origin`.
- Open it with `window.open(...)` from the OS. Because COOP differs, it lands in a **different browsing context group** ([MDN COOP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy)). The OS document stays isolated.
- The helper receives a short-lived access token from our server, through a same-origin fetch with the session cookie, and runs the Picker. It reports only the picked file IDs back through a `BroadcastChannel`, then closes. The server then fetches the files with the stored token. The IDs are now granted to the app under `drive.file`.
- Costs [I]:
  - a second CSP to maintain in Caddy;
  - one same-origin page that is not cross-origin-isolated. The security review must accept this under T-29: it holds no OS state and no SharedArrayBuffer;
  - an access token reaches a browser page (short-lived, `drive.file` only).
- Needs ARB and security sign-off.

**Alternative without the Picker:**

- With `drive.file` and no Picker, Plotinium can access only files **it** created. Users could still move existing files into the Plotinium folder in drive.google.com.
- [I] **This is not certain to grant access.** `drive.file` is per file, and a file created by another app and moved into our folder is probably **not** authorized for us [S]. The robust way to grant existing files is the Picker or Drive UI "Open with" integration (`drive.install`, Marketplace).

### 5.3 Consent: popup versus redirect, and the callback [F + I]

- [F] COOP `same-origin` places a cross-origin popup in a new browsing context group, and "mutual communication between both windows is disabled" (web.dev). The opener's handle to it reports `closed: true` (MDN).
- [F] GIS documents that its **sign-in** popups need COOP `same-origin-allow-popups` when FedCM is off. When FedCM is on, "the browser directly renders popups and no changes are necessary" ([GIS setup](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid), 2026-04-06).
- [F] The GIS **authorization-code** popup mode returns the code to a JavaScript callback ([code model](https://developers.google.com/identity/oauth2/web/guides/use-code-model), 2026-01-28).
- [I] That mechanism depends on the popup reaching back to the opener, which our COOP severs. **Do not use the GIS popup or token-client flows.** They would also need `script-src accounts.google.com/gsi/client` and more CSP holes. The stack decision already notes that "OAuth popups conflict with COOP" (`specs/15-decisions/stack-decisions.md` C10).
- [I] **A full-page redirect of the OS window is unacceptable.** It unloads the kernel worker (ARC-02), running processes and unsaved editor state.
- **Recommended flow [I]:**
  1. The user clicks "Connect Google Drive" in Settings. The OS calls `POST /api/drive/oauth/start` (same-origin, so the Strict cookie is sent; `Sec-Fetch-Site: same-origin`). The server creates a single-use `state`, a PKCE verifier, and a record {uid, session-id hash, verifier, requested scopes, expiry 10 min}. It returns a **one-time launch URL** on our origin: `/api/drive/oauth/launch?t=<nonce>`.
  2. The OS runs `window.open(launchURL, 'plotinium-gdrive', 'popup,width=520,height=640')`. We keep no reliance on the handle. The launch endpoint 302s to Google's auth endpoint. That is a navigation, so `form-action 'none'` is not involved.
  3. Google redirects to `/api/drive/oauth/callback?code&state&iss`. **This is a cross-site top-level navigation, so our `SameSite=Strict` session cookie is NOT sent.** [F] RFC 6265bis-22: "Same-site cookies in 'Strict' enforcement mode will not be sent along with top-level navigations which are triggered from a cross-site document context", and redirect chains keep the initiator's site ([draft-ietf-httpbis-rfc6265bis](https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis), draft 22, 2025-12-01).
     - The callback must therefore **not** complete the link from `state` alone. That would allow the classic account-linking CSRF, where an attacker's flow is completed by a victim and the victim's Drive ends up linked to the attacker's Plotinium account.
     - Instead, the callback returns a small static page with **no inline script**; its script is loaded as `'self'`. That page `POST`s `{state, code, iss}` to `/api/drive/oauth/complete`. The fetch comes from our own document, so it is same-site: the Strict cookie **is** sent and `Sec-Fetch-Site` is `same-origin`.
     - The server checks that the session matches the one stored with `state`, that `iss` is Google, and that `state` is unused. It then exchanges the code (with `client_secret` + `code_verifier`), validates the ID token (`aud`, `iss`, `exp`), and reads the granted `scope`. It stores the refresh token encrypted and marks the state used.
  4. The server notifies the OS in two ways. It pushes `drive.connected` over the existing `/ws` socket (the preferred path: no new channel), **and** the helper page posts `{type:'gdrive-connected'}` on `new BroadcastChannel('plotinium-gdrive')`, then calls `window.close()`.
     - [F] BroadcastChannel works between same-origin contexts in the same storage partition with no window reference ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API)).
     - [I] Both are first-party top-level documents on our origin, so they share the partition. COOP does not affect BroadcastChannel.
     - **Never put a token on the channel.** Send only a status and the granted scope list.
  5. If the popup is blocked, fall back to opening the same launch URL in a new tab. The UI shows "Waiting for Google…" with a Cancel button and a 10-minute timeout.
- [S] Verify on the QA copy with a `securitypolicyviolation` listener:
  - that the callback page gets the Strict cookie on its follow-up POST;
  - that the BroadcastChannel message arrives;
  - that `crossOriginIsolated` stays `true` in the OS window.

### 5.4 Browser-direct versus server-proxied API calls [F + P + I]

- [P] `www.googleapis.com/drive/v3/about` answered a CORS request with `access-control-allow-origin: <origin>`. Direct browser calls are therefore technically possible and are not blocked by COEP, because they run in CORS mode. They would still need `connect-src https://www.googleapis.com` and an access token in the page.
- [I] The **server proxy** is recommended:
  - tokens never reach the client, which matches SEC and the "secrets never in the client bundle" rule;
  - the CSP stays unchanged;
  - there is one place for rate limiting, backoff, audit and scope checks;
  - the VFS's uid and permission checks stay server-side.
- [I] The cost is that all bytes flow through our server. That is exactly what makes a restricted scope trigger CASA ("from or through a third-party server"), and it is another reason to prefer `drive.file`.

---

## 6. Branding rules [F]

- **Drive naming** ([Drive branding](https://developers.google.com/workspace/drive/api/guides/branding), 2026-09-03):
  - "The first reference to Google Drive should be 'Google Drive™' with the trademark symbol". After that, "Google Drive" or "Drive".
  - **Never** "GDrive" or "Google Docs Drive".
  - Acceptable phrases: "Save to Google Drive", "Works with Google Drive", "Backup to Google Drive".
  - Drive logo: "You can resize the logo, but don't make any other changes". When it is used as a button, "provide a tooltip indicating the action".
  - Attribution: "Google Drive is a trademark of Google Inc. Use of this trademark is subject to Google Permissions." That is Google's text verbatim; it still says "Inc.".
  - Do not imply endorsement.
  - [I] Consequences for our code and UI:
    - Internal identifiers such as `gdrive` are fine in code. User-visible strings must say "Google Drive".
    - The mount point `/mnt/gdrive` is a path, not branding. A friendlier alternative is `/mnt/google-drive`; the ARB decides.
    - Use "Connect Google Drive", not "Sign in with Google". We are not doing sign-in.
- **Our app name** must not contain Google product names or logos (App Identity & Branding). "Plotinium" is fine.
- **Sign in with Google button** ([branding guidelines](https://developers.google.com/identity/branding-guidelines), 2026-07-07):
  - Approved text: "Sign in with Google", "Sign up with Google", "Continue with Google".
  - Standard-colour "G" logo, unchanged. Light, dark and neutral themes.
  - The font is **Google Sans Medium**. Padding is 12 px left and 10 px right on web.
  - These rules cover **sign-in** buttons. The page does not extend them to authorization-only buttons.
  - [I] For "Connect Google Drive", follow the Drive guidelines: Drive logo plus the "Google Drive" name. Self-host the logo SVG, because the CSP means `img-src 'self'`. If we ever add Google sign-in, use the GIS button rules. Self-hosting Google Sans is allowed from Google Fonts, but it must be added to `ui/src/tokens/fonts.css` under decision D15.

---

## 7. Other facts a security or privacy review will ask for

### 7.1 Client credentials [F]

- "Store your OAuth client information in a secure place and protect it, especially your client secret, just as you would a password". "Do not hardcode the credentials, commit them to a code repository or publish them publicly" (policies; best practices).
- "Create a separate OAuth client for each platform".
- [I] Add `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET_FILE` and `DRIVE_TOKEN_KEK_FILE` to the SRV-02 config.
  - These are secret, and production refuses inline values.
  - If they are absent, Drive is **degraded** (hidden) and the rest works, as with `ANTHROPIC_API_KEY`.
  - A `gitleaks` rule for `GOCSPX-` client-secret prefixes should be confirmed [S].

### 7.2 Token storage [F → I]

- [F] "Store tokens securely at rest and never transmit them in plain text." "Revoke tokens as soon as they are no longer needed and delete them permanently from your systems" (best practices).
- [F] For restricted scopes, tokens must be encrypted at rest, with HSM-grade key management (§3.5).
- [I] Design input:
  - Encrypt each refresh token with AES-256-GCM, a random 96-bit nonce, and AAD = `uid|google_sub|provider|key_id`. Use `node:crypto`.
  - The KEK comes from a 0600 secrets file (SRV-02), not from the database. Store a `key_id` to allow rotation.
  - Keep access tokens in server memory only, never persisted. They live about 1 h.
  - Never log tokens. Redact `Authorization`, `code`, `refresh_token`, `access_token` and `id_token` in logs and cassettes; the cassette recorder already never writes request headers.
  - The client only ever sees `{connected, email, scopes, quota}`.
  - An HSM is out of reach for the capstone. State this honestly in SECURITY.md as a gap if restricted scopes are used.

### 7.3 Least privilege [I, grounded in F]

- The default scopes are `openid` + `drive.file`.
- Restricted scopes only through an explicit, in-context, incremental request (`include_granted_scopes=true`) behind a feature flag.
- Never "future proof". Google's policy: "Don't attempt to 'future proof' your access to user data by requesting access to information that might benefit services or features that have not yet been implemented."

### 7.4 Audit [I]

Write append-only audit events, following the AGT-08 audit style: `gdrive.connect`, `gdrive.scopes_granted`, `gdrive.disconnect`, `gdrive.revoke_result`, `gdrive.token_refresh_failed(invalid_grant)`, `gdrive.ai_send(file_id, bytes, model)`, `gdrive.index_optin/optout`, `gdrive.purge_completed`.

- Record file IDs and counts, never content.
- Keep a record of the consent text version the user accepted. The policy requires documented consent for any human access, and "documented" consent is good evidence for AI transfers too.

### 7.5 Disconnect, revocation and account deletion [F → I]

- [F] The policy requires user help documentation explaining "how users can manage and delete their data". CASA verifies that you can "delete user data upon request".
- [I] Disconnect runs as one idempotent job:
  1. Revoke at Google (retry on 5xx/503; treat 400 as already revoked).
  2. Delete the encrypted token rows.
  3. Unmount `/mnt/gdrive` and drop the cached Drive content: server blobs and the client IndexedDB mirror, the latter on the next boot of each device.
  4. Delete derived data: RAG vectors, chunk text, prefetch statistics keyed by Drive IDs.
  5. Write an audit event.
  6. Show completion.
- [I] Run the same job on Plotinium **account deletion**, and when a refresh returns `invalid_grant` because the user revoked in their Google Account. Treat that last case as a user decision: purge after a short grace period (for example 7 days), since in Testing an `invalid_grant` can also mean the 7-day expiry. Distinguish the two where possible, and show "Reconnect or delete Drive data".

### 7.6 Cross-Account Protection (RISC) [F]

- Google can push security events, delivered as JWTs to a public HTTPS receiver ([RISC](https://developers.google.com/identity/protocols/risc), 2026-03-22):
  - `sessions-revoked`;
  - `tokens-revoked`: "If the token is for access to other Google APIs, delete any of the user's OAuth tokens you have stored";
  - `token-revoked`, identified by a token prefix or a double SHA-512 hash;
  - `account-disabled`;
  - and others.
- The best-practices page recommends integrating it.
- [I] It is not possible on `http://localhost`. It is a production-only item. Note it in the RFC as a production obligation.

### 7.7 Incident response [F → I]

- [F] Notify `security@google.com` promptly, and before any public statement.
- [I] The runbook should add:
  1. Rotate the client secret in Cloud Console.
  2. Rotate the KEK and re-encrypt the rows.
  3. Bulk-revoke all stored refresh tokens by calling `/revoke` for each row.
  4. Force every connection to `needs-reconnect`.
  5. Record the incident in SECURITY.md (spec §18 already requires the leaked-key runbook).

### 7.8 Prompt injection from Drive content [F → I]

- [F] Protection is a required measure for restricted scopes (§3.5).
- [I] Drive files are **untrusted input** to the agent and to RAG. Tag them with provenance `gdrive:<fileId>`, and run the existing INJ/`rag-leak` test families on Drive-sourced fixtures. Tool calls that write, trash or share Drive files always need confirmation.

### 7.9 Children, sharing and other items [I]

- The capstone has no child-directed use.
- We never call `permissions.*` (sharing). Excluding the Drive sharing API avoids a large abuse surface; put it explicitly in "Non-goals".

---

## 8. Mapping to Plotinium concepts (inputs, not decisions) [I]

- **Mount:** `/mnt` is a MAY (VFS-02) and is empty in v1. A `gdrive` filesystem mounted at `/mnt/gdrive` per user, with `fs: 'gdrive'`, fits the existing mount table (`FsId`).
  - Since each user has their own Drive, the path should really resolve per uid, for example `/home/<user>/GoogleDrive`, or `/mnt/gdrive` showing only the caller's own Drive. The ARB should choose.
- **Offline (OFF-\*):** Drive content is **not** local-first. Cache what the user opened, and make writes queue in the outbox with the conflict rule of §4.9. Offline, `/mnt/gdrive` is read-only for cached items and returns `EIO`/`ENETDOWN` for the rest.
- **Swap (MEM-04/05):** Do **not** use Drive as a swap tier. That is a policy risk (§2.3), and latency and quota make it a bad fit anyway.
- **dsa/:** Use the graded structures, for example the LRU for the Drive metadata cache keyed by file ID, and whatever queue or heap the scheduler already has for the backoff retry queue. Do not add a library cache.
- **Package boundaries:** apps and ui have no storage access. Drive I/O belongs in `server` (proxy, tokens) and `vfs`/`services` (mount). The Files app sees only VFS syscalls.

---

## 9. Decision inputs

### 9.1 Options

| # | Option | Scopes | Where tokens live | Existing Drive files visible? | Verification / CASA for production | Fit with COOP/COEP/CSP | Main risks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | **Server proxy, app-owned folder** ("Plotinium" folder in the user's Drive as a user-visible "SSD") | `openid`, `drive.file` | Server, encrypted | **No.** Only files Plotinium created, plus anything later granted by the Picker or Open-with. | Brand verification only (non-sensitive). **No CASA.** | Perfect: no header or CSP change. | The user cannot pull in existing Drive files without the Picker. "Moving a file into the folder" probably does not grant access [S]. |
| B | **Option A + Picker in a helper window** | `openid`, `drive.file` (+ API key, project number) | Server; a short-lived access token handed to the helper page | **Yes, file by file**, through the Picker | Brand verification, optionally sensitive-scope review. No CASA. | Needs a second, non-isolated page with its own CSP. The OS document is unchanged. | Spike needed (§5.2). One non-isolated same-origin page (T-29 review). API-key referrer rule versus `no-referrer`. |
| C | **Server proxy with a restricted read scope** | `openid`, `drive.readonly` (or `drive.metadata.readonly` for listing only) | Server, encrypted | **Yes, the whole Drive, read-only** | Restricted-scope verification + **annual CASA** (data passes through our server) + demo video + app category (Productivity). | No header change. | Cost and time of CASA. Heavier policy duties (encryption, KMS/HSM, prompt-injection measures). Unverified: 100-user lifetime cap. |
| D | **Server proxy with full `drive`** | `openid`, `drive` | Server | Yes, read and write everything | Same as C, with more scrutiny. | No header change. | Largest blast radius. Hard to justify under minimum-scope. |
| E | **Browser-only** (GIS token client, direct CORS calls) | any | Browser memory | Depends on the scope | Would avoid the "through a server" CASA trigger for restricted scopes. | **Breaks:** needs COOP relaxation for the GIS popups, CSP `script-src`/`connect-src` holes; no refresh tokens (implicit-style). | Conflicts with the security model, SEC-02 and the §5.3 analysis. **Reject.** |

### 9.2 Recommendation

**(a) Capstone demo (Testing publishing status, External, ≤ 100 test users)**

1. **Ship Option A behind a feature flag (`gdrive`).**
   - Connect happens through the server-driven redirect flow in a popup (§5.3). Scopes: `openid` + `drive.file`, with `access_type=offline`, `prompt=select_account` (plus `consent` when no refresh token is stored), `state` and PKCE S256.
   - Mount the user-visible `Plotinium` folder at the chosen path. It supports read and write of ordinary files, trash-not-delete, `df` from `about.get`, `changes.list` polling, and exports for Workspace files.
   - This is the honest "Drive as your SSD" story: your Plotinium files live in your Google Drive.
2. **Optional, flagged `gdrive.browse` (read-only), test users only.** An incremental request for `drive.readonly`, clearly labelled "Browse all of my Google Drive (read-only)". It shows the full Drive for the demo without the Picker.
   - Testing needs no verification (§2.2).
   - State in the report that production would need restricted verification + CASA (§2.3), or migration to Option B.
   - **Default it off.** Keep it only if the ARB accepts the extra policy burden.
3. **The AI features (send to Claude, semantic index) on Drive data** are separate opt-ins with in-product disclosure and per-invocation confirmation (§3.4). Drive-sourced text goes through the INJ/`rag-leak` suites.
4. **Operational:**
   - Add every demo and examiner Google account as a test user. We need their Gmail addresses in advance.
   - Reconnect within 7 days of each gate.
   - Use a separate Cloud project for QA versus the user's instance.
   - Register the redirect URIs for :4717 and :4718.
   - No billing account on the project.
5. **Spikes before the RFC is final:**
   - PKCE enforcement for web clients (§1.3).
   - The callback cookie and BroadcastChannel path on :4718 (§5.3).
   - Whether files moved into the app folder become visible under `drive.file` (§5.2).
   - `changes.list` visibility under `drive.file` (§2.1).
   - The Picker helper window (§5.2), but only if the time budget allows.

**(b) Future production launch**

1. Stay on `drive.file`, and add **Option B (Picker helper window)** once the spike passes and the security review accepts the non-isolated helper page. This gives per-file access to existing files with no restricted scope and **no CASA**.
2. Before publishing:
   - brand verification;
   - a verified domain with homepage, privacy policy (naming Anthropic as a sub-processor, retention, deletion) and terms;
   - the Limited Use statement (§3.2);
   - user help documentation on managing and deleting data;
   - a demo video if any sensitive scope is added.
3. Add production-only hardening:
   - Cross-Account Protection receiver (§7.6);
   - DPoP-bound refresh tokens with a KMS-held key (§1.9);
   - KEK in a KMS;
   - an incident runbook that includes `security@google.com`;
   - an Anthropic ZDR agreement if feasible.
4. Take a restricted scope (Option C) only if user research shows whole-Drive browsing or search is essential. Before that: budget the annual CASA, pick the Productivity category, and satisfy the §3.5 measures (token encryption with HSM-grade keys, prompt-injection protection).
5. Re-check the Drive quota-billing announcement (§4.11) before launch.

### 9.3 Open questions for the ARB

1. Which mount path: `/mnt/gdrive`, per-uid `/home/<u>/GoogleDrive`, or a per-user view of `/mnt/gdrive`? What happens to root and guest? Recommendation [I]: guests cannot connect, and root cannot see other users' Drive mounts.
2. Is the `gdrive.browse` (`drive.readonly`) demo mode worth its policy and review burden, given it must be removed or verified for production?
3. Do we accept one non-isolated same-origin page (the Picker helper) under T-29?
4. Should Drive content feed the server-side RAG store (vectors in PostgreSQL), or only a client-side, per-device index? The latter reduces server-side storage of Drive-derived data.
5. What is the grace period before purging data after `invalid_grant` (§7.5)?

---

## 10. Source index (all checked 2026-09-30)

| Source | Page date shown |
| --- | --- |
| <https://developers.google.com/identity/protocols/oauth2/web-server> | 2026-09-14 |
| <https://developers.google.com/identity/protocols/oauth2> | 2026-05-26 |
| <https://developers.google.com/identity/protocols/oauth2/native-app> | 2026-09-14 |
| <https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow> | 2026-09-14 |
| <https://developers.google.com/identity/protocols/oauth2/openid-connect> | 2026-06-15 |
| <https://accounts.google.com/.well-known/openid-configuration> | live JSON |
| <https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions> | — |
| <https://developers.google.com/identity/protocols/oauth2/resources/best-practices> | 2026-05-20 |
| <https://developers.google.com/identity/protocols/oauth2/policies> | 2026-08-05 |
| <https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification> | 2026-08-19 |
| <https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification> | 2026-08-19 |
| <https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification> | 2026-08-19 |
| <https://developers.google.com/identity/protocols/risc> | 2026-03-22 |
| <https://developers.google.com/identity/oauth2/web/guides/use-code-model> | 2026-01-28 |
| <https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid> | 2026-04-06 |
| <https://developers.google.com/identity/branding-guidelines> | 2026-07-07 |
| <https://support.google.com/cloud/answer/15549945> (Manage App Audience) | — |
| <https://support.google.com/cloud/answer/13464323> (When is verification not needed) | — |
| <https://support.google.com/cloud/answer/13465431> (Security Assessment / CASA) | — |
| <https://support.google.com/cloud/answer/13804963> (App Identity & Branding) | — |
| <https://support.google.com/accounts/answer/13533235> (user-side third-party access) | — |
| <https://developers.google.com/terms/api-services-user-data-policy> | 2024-02-15 |
| <https://developers.google.com/workspace/workspace-api-user-data-developer-policy> | 2026-09-03 |
| <https://developers.google.com/terms> (Google APIs ToS) | 2021-11-09 |
| <https://developers.google.com/workspace/drive/api/guides/api-specific-auth> | 2026-09-03 |
| <https://developers.google.com/workspace/drive/api/reference/rest/v3/files> | 2026-07-14 |
| <https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list> | — |
| <https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get> | 2026-03-20 |
| <https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export> | 2025-08-26 |
| <https://developers.google.com/workspace/drive/api/reference/rest/v3/files/update> | — |
| <https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get> | — |
| <https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list> | 2026-07-07 |
| <https://developers.google.com/workspace/drive/api/guides/search-files> | 2026-09-09 |
| <https://developers.google.com/workspace/drive/api/guides/ref-search-terms> | 2026-09-03 |
| <https://developers.google.com/workspace/drive/api/guides/manage-downloads> | 2026-09-03 |
| <https://developers.google.com/workspace/drive/api/guides/ref-export-formats> | — |
| <https://developers.google.com/workspace/drive/api/guides/manage-uploads> | 2026-09-03 |
| <https://developers.google.com/workspace/drive/api/guides/delete> | 2026-09-03 |
| <https://developers.google.com/workspace/drive/api/guides/manage-changes> | 2026-09-03 |
| <https://developers.google.com/workspace/drive/api/guides/shortcuts> | 2026-09-03 |
| <https://developers.google.com/workspace/drive/api/guides/performance> | 2026-09-03 |
| <https://developers.google.com/workspace/drive/api/guides/limits> | 2026-09-11 |
| <https://developers.google.com/workspace/drive/api/guides/handle-errors> | 2026-09-03 |
| <https://developers.google.com/workspace/drive/api/guides/v2-to-v3-reference> | 2026-09-03 |
| <https://developers.google.com/workspace/drive/api/guides/branding> | 2026-09-03 |
| <https://developers.google.com/workspace/drive/release-notes> | 2026-09-03 |
| <https://developers.google.com/workspace/drive/picker/guides/overview> | 2026-09-14 |
| <https://developers.google.com/workspace/drive/picker/guides/web-picker> | 2026-09-03 |
| <https://www.rfc-editor.org/rfc/rfc9700.html> (BCP 240) | Jan 2025 |
| <https://www.rfc-editor.org/rfc/rfc7636.html> (PKCE) | Sep 2015 |
| <https://www.rfc-editor.org/rfc/rfc7009.html> (revocation) | Aug 2013 |
| <https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis> (draft 22) | 2025-12-01 |
| <https://web.dev/articles/coop-coep> (Google web.dev) | 2022-06-21 |
| <https://developer.chrome.com/blog/iframe-credentialless> | 2023-01-12 |
| <https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API> (MDN, non-Google) | — |
| <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy> (MDN, non-Google) | — |
| <https://platform.claude.com/docs/en/manage-claude/api-and-data-retention> (Anthropic) | — |
| <https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data> (Anthropic) | — |

**Probe commands [P]** (2026-09-30, 13:12 UTC):

```sh
curl -s -D - -o /dev/null -H "Origin: https://example.com" https://apis.google.com/js/api.js
curl -s -D - -o /dev/null -H "Origin: https://example.com" https://accounts.google.com/gsi/client
curl -s -D - -o /dev/null -H "Origin: https://example.com" https://docs.google.com/picker
curl -s -D - -o /dev/null -H "Origin: https://example.com" https://www.googleapis.com/drive/v3/about
```

Results:

- `api.js`: CORP `cross-origin`, ACAO `*`.
- `gsi/client`: CORP `cross-origin`, `x-frame-options: SAMEORIGIN`.
- `docs.google.com/picker`: 401, CORP `same-site`, no COEP, CSP-Report-Only `frame-ancestors 'none'`.
- `drive/v3/about`: 401, ACAO echoes the origin.
