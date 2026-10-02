# server/src/gateway

Auth gateway (implemented): opaque sessions (`<id>.<secret>`, only SHA-256(secret) stored; 10-day sliding written at most hourly, 30-day absolute, guests 2 h), the `plt_sid` / `__Host-plt_sid` cookie, Argon2id verification under a 2-slot semaphore with dummy verification for unknown and ineligible accounts, the login concurrency gate, CSRF and principal hooks, `su` grants (15 min), guest accounts with a server-minted `/home/guest-XXXX`, password change with rotation, and the security audit events. Still to come with the sync plugin: closing sockets on revocation (the `SessionService.onRevoke` listener), su expiry signals, the WebSocket upgrade checks.

| File                          | Role                                                              |
| ----------------------------- | ----------------------------------------------------------------- |
| `tokens.ts`, `cookies.ts`     | token format, hashing, cookie strings                             |
| `sessions.ts`                 | create, validate (sliding expiry), revoke, revocation listeners   |
| `hooks.ts`                    | request hooks 4-7: session, CSRF, route authentication, principal |
| `routes.ts`                   | `/api/auth/*`                                                     |
| `store.ts`, `kysely-store.ts` | the persistence interface and its PostgreSQL implementation       |
| `homes.ts`                    | `/home/<user>` creation (guests and the first-start seed)         |
| `argon2.ts`, `slots.ts`       | Argon2id PHC hashing, semaphore, non-waiting gate                 |

- **Primary owner:** R5 QA/DevOps
- **Secondary reviewer:** R2 VFS/DB
- **Spec:** [specs/11-server/backend-api.md](../../../specs/11-server/backend-api.md), [specs/12-security/security-model.md](../../../specs/12-security/security-model.md)
- **Requirement IDs:** OFF-03, BOOT-14
