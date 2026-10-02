import { describe, expect, it } from 'vitest';

import { ConfigError, originAllowlist, parseConfig, sessionCookieName } from './config.ts';

const SECRET = 'a'.repeat(24) + 'Zq9!x7Lm3#Vb6$Nc2%Hd8&Ks';
const noFiles = (path: string): string => {
  throw new Error(`unexpected read of ${path}`);
};
const files =
  (map: Record<string, string>) =>
  (path: string): string => {
    const v = map[path];
    if (v === undefined) throw new Error('ENOENT');
    return v;
  };

function problemsOf(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
  throw new Error('expected a ConfigError');
}

const PRODUCTION_OK = {
  PLOTINIUM_ENV: 'production',
  APP_ORIGIN: 'https://plotinium.example.me',
  DATABASE_URL: 'postgres://plotinium_app@db:5432/plotinium',
  DATABASE_PASSWORD_FILE: '/run/plotinium/app_password',
  FAULT_INJECTION: '0',
};

describe('SRV-02 configuration', () => {
  it('SRV-02 the local defaults parse without any secret and derive the origin from PLOTINIUM_PORT', () => {
    const c = parseConfig({}, noFiles);
    expect(c.env).toBe('local');
    expect(c.port).toBe(3000);
    expect(c.appOrigin).toBe('http://localhost:4717');
    expect(c.database).toBeNull();
    expect(c.faultInjection).toBe(false);
    expect(c.llm.mode).toBe('live');
    expect(c.llm.apiKey).toBeUndefined();
    expect(c.leaseTtlMs).toBe(30_000);
    expect(c.heartbeatMs).toBe(10_000);
    expect(c.trustProxyCidrs).toEqual(['172.30.47.0/24']);
    expect(Object.isFrozen(c) && Object.isFrozen(c.llm.budget)).toBe(true);
    expect(parseConfig({ PLOTINIUM_PORT: '4718' }, noFiles).appOrigin).toBe(
      'http://localhost:4718',
    );
  });

  it('SRV-02 the compose.yaml environment parses and reads the database password from its file', () => {
    const c = parseConfig(
      {
        PLOTINIUM_ENV: 'local',
        PLOTINIUM_PORT: '4717',
        DATABASE_URL: 'postgres://plotinium_app@db:5432/plotinium',
        DATABASE_PASSWORD_FILE: '/run/plotinium/app_password',
        FAULT_INJECTION: '1',
        LEASE_TTL_MS: '15000',
        AI: '1',
      },
      files({ '/run/plotinium/app_password': `${SECRET}\n` }),
    );
    expect(c.database?.password).toBe(SECRET);
    expect(c.faultInjection).toBe(true);
    expect(c.leaseTtlMs).toBe(15_000);
    expect(c.heartbeatMs).toBe(5_000);
  });

  it('SRV-02 a valid production configuration is accepted', () => {
    const c = parseConfig(PRODUCTION_OK, files({ '/run/plotinium/app_password': SECRET }));
    expect(c.env).toBe('production');
    expect(sessionCookieName(c)).toBe('__Host-plt_sid');
  });

  it('SRV-02 startup refuses production with FAULT_INJECTION=1, a missing secret, a short secret or a known development value, naming the variable but not its value', () => {
    const faulty = problemsOf(() =>
      parseConfig(
        { ...PRODUCTION_OK, FAULT_INJECTION: '1' },
        files({ '/run/plotinium/app_password': SECRET }),
      ),
    );
    expect(faulty.join('\n')).toMatch(/FAULT_INJECTION/);

    const { DATABASE_PASSWORD_FILE: _omit, ...noSecret } = PRODUCTION_OK;
    expect(problemsOf(() => parseConfig(noSecret, noFiles)).join('\n')).toMatch(
      /DATABASE_PASSWORD_FILE: required/,
    );

    const short = 'tooShort-7Xq';
    const shortProblems = problemsOf(() =>
      parseConfig(PRODUCTION_OK, files({ '/run/plotinium/app_password': short })),
    );
    expect(shortProblems.join('\n')).toMatch(/DATABASE_PASSWORD_FILE: shorter than 32 bytes/);
    expect(shortProblems.join('\n')).not.toContain(short);

    const dev = '0'.repeat(64);
    const devProblems = problemsOf(() =>
      parseConfig(PRODUCTION_OK, files({ '/run/plotinium/app_password': dev })),
    );
    expect(devProblems.join('\n')).toMatch(/known development value/);
    expect(devProblems.join('\n')).not.toContain(dev);
  });

  it('SRV-02 production refuses http origins, extra origins, a password in DATABASE_URL and an inline API key', () => {
    const secretInUrl = 'hunter2-hunter2-hunter2-hunter2-hunter2';
    const p = problemsOf(() =>
      parseConfig(
        {
          ...PRODUCTION_OK,
          APP_ORIGIN: 'http://plotinium.example.me',
          ALLOWED_ORIGINS: 'http://localhost:5173',
          DATABASE_URL: `postgres://plotinium_app:${secretInUrl}@db:5432/plotinium`,
          ANTHROPIC_API_KEY: 'sk-ant-inline-key-that-must-not-appear-in-output',
        },
        files({ '/run/plotinium/app_password': SECRET }),
      ),
    ).join('\n');
    expect(p).toMatch(/APP_ORIGIN: must be https/);
    expect(p).toMatch(/ALLOWED_ORIGINS: must be empty/);
    expect(p).toMatch(/DATABASE_URL: must not contain a password/);
    expect(p).toMatch(/ANTHROPIC_API_KEY: must be given as ANTHROPIC_API_KEY_FILE/);
    expect(p).not.toContain(secretInUrl);
    expect(p).not.toContain('sk-ant-inline');
  });

  it('SRV-02 startup refuses LLM_MODE=record in production and anything but replay in ci', () => {
    expect(
      problemsOf(() =>
        parseConfig(
          { ...PRODUCTION_OK, LLM_MODE: 'record', LLM_RECORD_BUDGET_USD: '5' },
          files({ '/run/plotinium/app_password': SECRET }),
        ),
      ).join('\n'),
    ).toMatch(/LLM_MODE: must be live in production/);
    expect(
      problemsOf(() => parseConfig({ PLOTINIUM_ENV: 'ci', LLM_MODE: 'live' }, noFiles)).join('\n'),
    ).toMatch(/LLM_MODE: ci accepts only replay/);
    expect(parseConfig({ PLOTINIUM_ENV: 'ci' }, noFiles).llm.mode).toBe('replay');
    expect(problemsOf(() => parseConfig({ LLM_MODE: 'record' }, noFiles)).join('\n')).toMatch(
      /LLM_RECORD_BUDGET_USD/,
    );
  });

  it('SRV-02 an invalid value is reported by variable name without echoing the value', () => {
    const p = problemsOf(() =>
      parseConfig(
        { PORT: 'not-a-port-s3cr3t', LEASE_TTL_MS: '999', FAULT_INJECTION: 'yes', AI: '2' },
        noFiles,
      ),
    );
    const text = p.join('\n');
    for (const name of ['PORT', 'LEASE_TTL_MS', 'FAULT_INJECTION', 'AI'])
      expect(text).toContain(name);
    expect(text).not.toContain('s3cr3t');
  });

  it('SRV-02 an unreadable secret file is a configuration problem, not a crash', () => {
    const p = problemsOf(() =>
      parseConfig(
        { DATABASE_URL: 'postgres://x@db/p', DATABASE_PASSWORD_FILE: '/nope' },
        files({}),
      ),
    );
    expect(p).toEqual(['DATABASE_PASSWORD_FILE: cannot read the file']);
  });

  it('SRV-06 the origin allowlist is exact and the cookie name follows the scheme (C10)', () => {
    const c = parseConfig(
      { ALLOWED_ORIGINS: 'http://localhost:5173/, http://127.0.0.1:5173' },
      noFiles,
    );
    expect([...originAllowlist(c)]).toEqual([
      'http://localhost:4717',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ]);
    expect(sessionCookieName(c)).toBe('plt_sid');
    expect(
      problemsOf(() => parseConfig({ APP_ORIGIN: 'http://localhost:4717/app' }, noFiles)),
    ).toEqual(['APP_ORIGIN: must be an origin (scheme, host, port only)']);
  });
});
