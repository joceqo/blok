// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it as baseIt } from 'vitest';

import { loadHttpFixture, type HttpFixtureCase } from './http-fixture';
import { createServiceAppWithoutDb } from './service-app';

const CONFIG_ENV_KEYS = [
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'BLOK_SIDECAR_URL',
  'MAILER_HOST',
  'SMTP_HOST',
  'SERVICE_VERSION',
] as const;

const liveBase = (): string | undefined => {
  const value = process.env.BLOK_SERVICE_CONFORMANCE_URL;
  return value === undefined || value === '' ? undefined : value;
};

function requestInit(fixtureCase: HttpFixtureCase): RequestInit {
  const init: RequestInit = { method: fixtureCase.method };
  if (fixtureCase.body !== undefined) {
    init.headers = {
      'Content-Type': 'application/json',
      ...fixtureCase.headers,
    };
    init.body = JSON.stringify(fixtureCase.body);
  } else if (fixtureCase.headers !== undefined) {
    init.headers = fixtureCase.headers;
  }
  return init;
}

async function runCase(fixtureCase: HttpFixtureCase): Promise<Response> {
  const init = requestInit(fixtureCase);
  const urlPath = `http://conformance.local${fixtureCase.path}`;

  if (fixtureCase.noDb === true) {
    return createServiceAppWithoutDb().request(urlPath, init);
  }

  const base = liveBase();
  if (base !== undefined) {
    return fetch(new URL(fixtureCase.path, base).toString(), init);
  }

  return createServiceAppWithoutDb().request(urlPath, init);
}

const fixture = loadHttpFixture('workspaces-shape.json');

describe('service API contract: workspaces-shape.json', () => {
  let savedEnv: Partial<Record<(typeof CONFIG_ENV_KEYS)[number], string>>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of CONFIG_ENV_KEYS) {
      const value = process.env[key];
      if (value !== undefined) {
        savedEnv[key] = value;
      }
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of CONFIG_ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('has cases', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  fixture.cases.forEach((fixtureCase) => {
    const runner =
      fixtureCase.liveOnly === true ? baseIt.skipIf(liveBase() === undefined) : baseIt;

    runner(fixtureCase.name, async () => {
      const response = await runCase(fixtureCase);
      expect(response.status).toBe(fixtureCase.expect.status);

      const contentType = response.headers.get('content-type') ?? '';
      expect(contentType).toContain('application/json');

      const body: unknown = await response.json();
      expect(body).toEqual(fixtureCase.expect.body);
    });
  });
});