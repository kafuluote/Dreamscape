// Insomnia-compatible hooks run in a short-lived Node process, never in the WebView.
// This is a compatibility boundary, not a sandbox: enable only trusted local plugins/scripts.
const { createRequire } = require('node:module');
const path = require('node:path');
const assert = require('node:assert/strict');

async function run(input) {
  const request = structuredClone(input.request);
  const response = input.response ? structuredClone(input.response) : null;
  const environment = structuredClone(input.environment || {});
  const stores = structuredClone(input.stores || {});
  const logs = [];
  const tests = [];
  const log = (...args) => {
    if (logs.length < 500)
      logs.push(
        args
          .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
          .join(' ')
          .slice(0, 8000),
      );
  };
  console.log = console.info = console.warn = console.error = log;
  const pairs = (key) => ({
    get: (name) =>
      request[key].find((p) => p.name.toLowerCase() === name.toLowerCase() && !p.disabled)?.value ?? null,
    set: (name, value) => {
      request[key] = request[key].filter((p) => p.name.toLowerCase() !== name.toLowerCase());
      request[key].push({ name, value: String(value), disabled: false });
    },
    remove: (name) => {
      request[key] = request[key].filter((p) => p.name.toLowerCase() !== name.toLowerCase());
    },
  });
  const headers = pairs('headers');
  const params = pairs('parameters');
  const requestContext = {
    getId: () => request.id,
    getName: () => request.name,
    getUrl: () => request.url,
    setUrl: (value) => {
      request.url = value;
    },
    getMethod: () => request.method,
    setMethod: (value) => {
      request.method = value;
    },
    getHeaders: () => request.headers,
    getHeader: headers.get,
    hasHeader: (name) => headers.get(name) !== null,
    setHeader: headers.set,
    addHeader: headers.set,
    removeHeader: headers.remove,
    getParameters: () => request.parameters,
    getParameter: params.get,
    hasParameter: (name) => params.get(name) !== null,
    setParameter: params.set,
    addParameter: params.set,
    removeParameter: params.remove,
    getBody: () => request.body,
    setBody: (body) => {
      request.body = body;
    },
    getAuthentication: () => request.authentication,
    setAuthenticationParameter: (name, value) => {
      request.authentication[name] = value;
    },
    getEnvironment: () => environment,
    getEnvironmentVariable: (name) => environment[name],
    setCookie: (name, value) =>
      headers.set('Cookie', [headers.get('Cookie'), `${name}=${value}`].filter(Boolean).join('; ')),
    settingSendCookies: (value) => {
      request.settings.sendCookies = value;
    },
    settingStoreCookies: (value) => {
      request.settings.storeCookies = value;
    },
    settingFollowRedirects: (value) => {
      request.settings.followRedirects = value !== 'off';
    },
  };
  const responseContext = response && {
    getStatusCode: () => response.status,
    getStatusMessage: () => response.statusText,
    getBody: () => Buffer.from(response.bodyBase64, 'base64'),
    setBody: (body) => {
      const bytes = Buffer.from(body);
      response.body = bytes.toString('utf8');
      response.bodyBase64 = bytes.toString('base64');
      response.size = bytes.length;
    },
    getHeader: (name) =>
      response.headers.find((p) => p.name.toLowerCase() === name.toLowerCase())?.value ?? null,
    getHeaders: () => response.headers,
    getTime: () => response.elapsedMs,
    getBytesRead: () => response.size,
    getUrl: () => response.url,
    getRequestId: () => response.requestId,
  };
  for (const directory of input.plugins || []) {
    const requirePlugin = createRequire(path.join(directory, 'package.json'));
    const manifest = requirePlugin('./package.json');
    const plugin = requirePlugin(path.resolve(directory, manifest.main || 'index.js'));
    stores[directory] ??= {};
    const store = stores[directory];
    const context = {
      request: requestContext,
      response: responseContext,
      store: {
        hasItem: async (key) => Object.hasOwn(store, key),
        getItem: async (key) => store[key] ?? null,
        setItem: async (key, value) => {
          store[key] = value;
        },
        removeItem: async (key) => {
          delete store[key];
        },
        clear: async () => {
          for (const key of Object.keys(store)) delete store[key];
        },
        all: async () => Object.entries(store).map(([key, value]) => ({ key, value })),
      },
      app: {
        getInfo: () => ({ version: '0.1.0', platform: process.platform }),
        alert: async (...args) => log(...args),
      },
    };
    const hooks = input.phase === 'request' ? plugin.requestHooks : plugin.responseHooks;
    for (const hook of hooks || []) await hook(context);
  }
  const script = input.phase === 'request' ? request.preRequestScript : request.afterResponseScript;
  if (input.scriptsEnabled && script?.trim()) {
    function expect(actual) {
      const result = {
        equal: (expected) => assert.equal(actual, expected),
        eql: (expected) => assert.deepEqual(actual, expected),
        include: (expected) => assert.ok(actual.includes(expected)),
        property: (key) => {
          assert.ok(Object.hasOwn(actual, key));
          return expect(actual[key]);
        },
        above: (value) => assert.ok(actual > value),
        below: (value) => assert.ok(actual < value),
        a: (kind) => assert.equal(typeof actual, kind),
      };
      result.deep = { equal: (expected) => assert.deepEqual(actual, expected) };
      result.to = result.be = result.have = result;
      return result;
    }
    const env = {
      get: (key) => environment[key],
      set: (key, value) => {
        environment[key] = value;
      },
      unset: (key) => {
        delete environment[key];
      },
      toObject: () => ({ ...environment }),
    };
    const insomnia = {
      environment: env,
      baseEnvironment: env,
      variables: env,
      request: {
        ...requestContext,
        addHeader: (value, text) =>
          typeof value === 'object'
            ? headers.set(value.key || value.name, value.value)
            : headers.set(value, text),
        removeHeader: headers.remove,
        url: request.url,
        method: request.method,
        body: request.body,
      },
      response: response && {
        ...responseContext,
        code: response.status,
        status: response.statusText,
        responseTime: response.elapsedMs,
        json: () => JSON.parse(response.body),
        text: () => response.body,
      },
      test: (name, test) => {
        try {
          test();
          tests.push({ name, passed: true });
          log(`PASS ${name}`);
        } catch (error) {
          tests.push({ name, passed: false });
          log(`FAIL ${name}: ${error.message}`);
        }
      },
      expect,
    };
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction('insomnia', 'console', 'require', script)(insomnia, console, require);
  }
  return { request, response, environment, stores, logs, tests };
}

module.exports = { run };
if (require.main === module || process.env.INSOMNIA_PLUGIN_WORKER === '1') {
  const write = process.stdout.write.bind(process.stdout);
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > 64 * 1024 * 1024) process.exit(2);
  });
  process.stdin.on('end', async () => {
    try {
      write(JSON.stringify({ ok: true, result: await run(JSON.parse(input)) }));
    } catch (error) {
      write(JSON.stringify({ ok: false, error: error.message }));
      process.exitCode = 1;
    }
  });
}
