import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const client = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('revoked devices leave the workspace on protected account requests, while failed sign-in remains on its form', async t => {
  const events = [];
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: '请先登录。' }, { status: 401 }));
  const previousWindow = globalThis.window;
  globalThis.window = { dispatchEvent: event => events.push(event.type) };
  t.after(() => { client.setSessionToken({ user: null, needsSetup: false }); if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  client.setSessionToken({ user: { id: 'user' }, csrfToken: 'device-csrf', needsSetup: false });
  for (const path of ['/auth/sessions', '/auth/sessions/logout-others', '/auth/sessions/device-id', '/auth/password', '/auth/logout', '/chats']) {
    events.length = 0;
    await assert.rejects(client.api(path), error => error.status === 401);
    assert.deepEqual(events, ['session-expired'], path);
  }
  for (const path of ['/auth/login', '/auth/setup', '/auth/session', '/auth/invite?token=example', '/auth/invite/accept']) {
    events.length = 0;
    await assert.rejects(client.api(path), error => error.status === 401);
    assert.deepEqual(events, [], path);
  }
  client.setSessionToken({ user: null, needsSetup: false });
  events.length = 0;
  await assert.rejects(client.api('/auth/sessions'));
  assert.deepEqual(events, []);
});
