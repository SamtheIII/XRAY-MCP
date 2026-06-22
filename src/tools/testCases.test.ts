import test from 'node:test';
import assert from 'node:assert/strict';
import { issueKey, projectKey, pickTest } from './testCases';

test('issueKey accepts valid Jira issue keys', () => {
  const v = issueKey('issue ID');
  assert.equal(v.safeParse('TEST-101').success, true);
  assert.equal(v.safeParse('PROJ-1').success, true);
  assert.equal(v.safeParse('AB12-9999').success, true);
});

test('issueKey rejects malformed and injection-shaped input', () => {
  const v = issueKey('issue ID');
  assert.equal(v.safeParse('test-101').success, false); // lowercase
  assert.equal(v.safeParse('TEST').success, false); // no number
  assert.equal(v.safeParse('TEST-').success, false); // trailing dash
  assert.equal(v.safeParse('1TEST-1').success, false); // leading digit
  assert.equal(v.safeParse('TEST-1" OR "1"="1').success, false); // JQL injection attempt
});

test('projectKey accepts and rejects correctly', () => {
  assert.equal(projectKey.safeParse('TEST').success, true);
  assert.equal(projectKey.safeParse('ABC123').success, true);
  assert.equal(projectKey.safeParse('TEST-1').success, false); // keys have no dash
  assert.equal(projectKey.safeParse('lower').success, false);
});

test('pickTest maps a node with status as an object', () => {
  const r = pickTest({
    issueId: '1',
    jira: { key: 'T-1', summary: 'login', status: { name: 'PASS' } },
    testType: { name: 'Manual' },
  });
  assert.equal(r.key, 'T-1');
  assert.equal(r.issueId, '1');
  assert.equal(r.summary, 'login');
  assert.equal(r.status, 'PASS');
  assert.equal(r.type, 'Manual');
});

test('pickTest handles status as a plain string', () => {
  assert.equal(pickTest({ jira: { status: 'TODO' } }).status, 'TODO');
});

test('pickTest is null-safe for missing input', () => {
  const r = pickTest(undefined);
  assert.equal(r.status, null);
  assert.equal(r.steps, undefined);
  assert.equal(r.key, undefined);
});

test('pickTest maps steps when present', () => {
  const r = pickTest({ steps: [{ action: 'a', data: 'd', result: 'r' }] });
  assert.deepEqual(r.steps, [{ action: 'a', data: 'd', result: 'r' }]);
});
