import axios from 'axios';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getToken } from '../auth';

const XRAY_GQL = 'https://xray.cloud.getxray.app/api/v2/graphql';

const stepSchema = z.object({
  action: z.string(),
  data: z.string().optional(),
  result: z.string(),
});

export const issueKey = (label: string) =>
  z
    .string()
    .regex(/^[A-Z][A-Z0-9]+-\d+$/, `Invalid ${label} — expected a Jira issue key like TEST-101`);

export const projectKey = z
  .string()
  .regex(/^[A-Z][A-Z0-9]+$/, 'Invalid project key — expected a Jira project key like TEST');

interface JiraFields {
  key?: string;
  summary?: string;
  status?: { name?: string } | string | null;
}
interface StepNode {
  action?: string;
  data?: string;
  result?: string;
}
interface TestNode {
  issueId?: string;
  testType?: { name?: string };
  steps?: StepNode[];
  jira?: JiraFields;
}
interface TestRunNode {
  id?: string;
  status?: { name?: string };
  test?: { jira?: JiraFields };
}
interface CoveringTestNode {
  issueId?: string;
  jira?: JiraFields;
}
interface Paged<T> {
  total?: number;
  results?: T[];
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function toolError(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true as const };
}

// GraphQL errors arrive in a 200 response body — wrap them to avoid leaking the
// raw axios error, which carries the Bearer token in its request config.
class GqlError extends Error {}

function fail(err: unknown) {
  if (err instanceof GqlError) return toolError(`Xray GraphQL error: ${err.message}`);
  if (axios.isAxiosError(err)) {
    return toolError(
      err.response
        ? `Xray API returned status ${err.response.status}`
        : 'Xray API request failed (network error)',
    );
  }
  if (err instanceof Error) return toolError(err.message);
  return toolError('Unexpected server error');
}

async function gql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const token = await getToken();
  const res = await axios.post(
    XRAY_GQL,
    { query, variables },
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = res.data as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) {
    throw new GqlError(body.errors.map((e) => e.message).join('; '));
  }
  return body.data as T;
}

export function pickTest(r: TestNode | undefined | null) {
  const jira = r?.jira ?? {};
  const rawStatus = jira.status;
  const status =
    typeof rawStatus === 'object' && rawStatus !== null ? rawStatus.name ?? null : rawStatus ?? null;
  return {
    key: jira.key,
    issueId: r?.issueId,
    summary: jira.summary,
    status,
    type: r?.testType?.name,
    steps: Array.isArray(r?.steps)
      ? r.steps.map((s) => ({ action: s.action, data: s.data, result: s.result }))
      : undefined,
  };
}

async function resolveTestIssueId(testKey: string): Promise<string> {
  const data = await gql<{ getTests?: Paged<TestNode> }>(
    `query($jql: String) { getTests(jql: $jql, limit: 1) { results { issueId } } }`,
    { jql: `key = "${testKey}"` },
  );
  const id = data?.getTests?.results?.[0]?.issueId;
  if (!id) throw new GqlError(`Test ${testKey} not found`);
  return id;
}

async function fetchAllTestRuns(
  executionKey: string,
): Promise<{ found: boolean; runs: TestRunNode[] }> {
  const PAGE = 100;
  const runs: TestRunNode[] = [];
  const seen = new Set<string>();
  let start = 0;
  let total = Infinity;
  let found = false;

  while (start < total) {
    const data = await gql<{
      getTestExecutions?: { results?: Array<{ testRuns?: Paged<TestRunNode> }> };
    }>(
      `query($jql: String, $start: Int!, $limit: Int!) {
        getTestExecutions(jql: $jql, limit: 1) {
          results {
            testRuns(start: $start, limit: $limit) {
              total
              results { id status { name } test { jira(fields: ["key"]) } }
            }
          }
        }
      }`,
      { jql: `key = "${executionKey}"`, start, limit: PAGE },
    );
    const exec = data?.getTestExecutions?.results?.[0];
    if (!exec) return { found: false, runs: [] };
    found = true;

    const page = exec.testRuns?.results ?? [];
    total = exec.testRuns?.total ?? page.length;

    let added = 0;
    for (const run of page) {
      const id = run.id;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      runs.push(run);
      added++;
    }
    if (added === 0) break; // empty page or repeated page with no ids — stop
    start += PAGE;
  }

  return { found, runs };
}

async function fetchAllCoveringTests(
  requirementKey: string,
): Promise<{ found: boolean; tests: CoveringTestNode[] }> {
  const PAGE = 100;
  const tests: CoveringTestNode[] = [];
  const seen = new Set<string>();
  let start = 0;
  let total = Infinity;
  let found = false;

  while (start < total) {
    const data = await gql<{
      getCoverableIssues?: {
        results?: Array<{ tests?: Paged<CoveringTestNode> }>;
      };
    }>(
      `query($jql: String, $start: Int!, $limit: Int!) {
        getCoverableIssues(jql: $jql, limit: 1) {
          results {
            tests(start: $start, limit: $limit) {
              total
              results { issueId jira(fields: ["key", "summary"]) }
            }
          }
        }
      }`,
      { jql: `key = "${requirementKey}"`, start, limit: PAGE },
    );
    const issue = data?.getCoverableIssues?.results?.[0];
    if (!issue) return { found: false, tests: [] };
    found = true;

    const page = issue.tests?.results ?? [];
    total = issue.tests?.total ?? page.length;

    let added = 0;
    for (const t of page) {
      const id = t.issueId;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      tests.push(t);
      added++;
    }
    if (added === 0) break;
    start += PAGE;
  }

  return { found, tests };
}

export function registerTestCaseTools(server: McpServer) {
  server.registerTool(
    'get_test_case',
    {
      description: 'Fetch a test case and its steps by Jira issue ID (e.g. TEST-101)',
      inputSchema: { issueId: issueKey('issue ID') },
    },
    async ({ issueId }) => {
      try {
        const data = await gql<{ getTests?: Paged<TestNode> }>(
          `query($jql: String) {
            getTests(jql: $jql, limit: 1) {
              results {
                issueId
                testType { name }
                steps { action data result }
                jira(fields: ["key", "summary", "status"])
              }
            }
          }`,
          { jql: `key = "${issueId}"` },
        );
        const r = data?.getTests?.results?.[0];
        if (!r) return toolError(`Test case ${issueId} not found`);
        return ok(pickTest(r));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'create_test_case',
    {
      description: 'Create a new manual test case with steps in Xray',
      inputSchema: {
        projectKey: projectKey.describe('Jira project key (e.g. TEST)'),
        summary: z.string().min(1).describe('Test case title'),
        steps: z.array(stepSchema).optional().describe('Test steps'),
      },
    },
    async ({ projectKey, summary, steps = [] }) => {
      try {
        const data = await gql<{ createTest?: { test?: TestNode; warnings?: string[] } }>(
          `mutation($steps: [CreateStepInput], $jira: JSON!) {
            createTest(testType: { name: "Manual" }, steps: $steps, jira: $jira) {
              test { issueId testType { name } jira(fields: ["key", "summary", "status"]) }
              warnings
            }
          }`,
          { steps, jira: { fields: { summary, project: { key: projectKey } } } },
        );
        const test = data?.createTest?.test;
        if (!test) return toolError('Xray did not return the created test (createTest was empty)');
        return ok({ test: pickTest(test), warnings: data.createTest?.warnings });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'create_test_execution',
    {
      description: 'Create a test execution in Xray and add a test case to it',
      inputSchema: {
        projectKey: projectKey.describe('Jira project key (e.g. TEST)'),
        summary: z.string().min(1).describe('Title for the test execution (e.g. Sprint 5 Regression Run)'),
        testCaseId: issueKey('test case ID').describe('Jira issue ID of the test case to include (e.g. TEST-101)'),
      },
    },
    async ({ projectKey, summary, testCaseId }) => {
      try {
        const testIssueId = await resolveTestIssueId(testCaseId);
        const data = await gql<{
          createTestExecution?: {
            testExecution?: { issueId?: string; jira?: JiraFields };
            warnings?: string[];
          };
        }>(
          `mutation($testIds: [String], $jira: JSON!) {
            createTestExecution(testIssueIds: $testIds, jira: $jira) {
              testExecution { issueId jira(fields: ["key", "summary"]) }
              warnings
            }
          }`,
          { testIds: [testIssueId], jira: { fields: { summary, project: { key: projectKey } } } },
        );
        const te = data?.createTestExecution?.testExecution;
        if (!te) {
          return toolError('Xray did not return the created test execution (createTestExecution was empty)');
        }
        return ok({
          executionKey: te.jira?.key,
          executionIssueId: te.issueId,
          addedTest: testCaseId,
          warnings: data.createTestExecution?.warnings,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'update_test_run_status',
    {
      description: 'Update the status of a test case run inside a test execution (PASSED, FAILED, TODO, EXECUTING, BLOCKED)',
      inputSchema: {
        executionId: issueKey('execution ID').describe('Jira issue ID of the test execution (e.g. TEST-200)'),
        testCaseId: issueKey('test case ID').describe('Jira issue ID of the test case (e.g. TEST-101)'),
        status: z.enum(['PASSED', 'FAILED', 'TODO', 'EXECUTING', 'BLOCKED']).describe('Status to set on the test run'),
      },
    },
    async ({ executionId, testCaseId, status }) => {
      try {
        const { found, runs } = await fetchAllTestRuns(executionId);
        if (!found) return toolError(`Test execution ${executionId} not found`);

        const run = runs.find((r) => r.test?.jira?.key === testCaseId);
        if (!run) {
          return toolError(`Test case ${testCaseId} not found in execution ${executionId}`);
        }
        if (!run.id) return toolError(`Test run for ${testCaseId} has no id; cannot update`);

        await gql(
          `mutation($id: String!, $status: String!) { updateTestRunStatus(id: $id, status: $status) }`,
          { id: run.id, status },
        );
        return ok({ executionId, testCaseId, runId: run.id, status });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'search_test_cases',
    {
      description: 'Search for test cases by keyword, label, or status using a JQL query',
      inputSchema: {
        query: z.string().min(1).describe('JQL query string (e.g. "project = TEST", "labels = smoke", "summary ~ login")'),
        limit: z.number().int().positive().max(100).optional().describe('Maximum number of results to return (default 10)'),
      },
    },
    async ({ query, limit = 10 }) => {
      try {
        const data = await gql<{ getTests?: Paged<TestNode> }>(
          `query($jql: String, $limit: Int!) {
            getTests(jql: $jql, limit: $limit) {
              total
              results {
                issueId
                testType { name }
                steps { action data result }
                jira(fields: ["key", "summary", "status"])
              }
            }
          }`,
          { jql: query, limit },
        );
        const results = (data?.getTests?.results ?? []).map(pickTest);
        return ok({ matched: data?.getTests?.total ?? results.length, returned: results.length, testCases: results });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'get_test_execution_report',
    {
      description: 'Get a pass/fail summary report for a test execution',
      inputSchema: {
        executionId: issueKey('execution ID').describe('Jira issue ID of the test execution (e.g. TEST-200)'),
      },
    },
    async ({ executionId }) => {
      try {
        const { found, runs } = await fetchAllTestRuns(executionId);
        if (!found) return toolError(`Test execution ${executionId} not found`);

        const counts: Record<string, number> = {};
        for (const r of runs) {
          const s = r.status?.name ?? 'UNKNOWN';
          counts[s] = (counts[s] ?? 0) + 1;
        }
        return ok({
          executionId,
          total: runs.length,
          summary: counts,
          runs: runs.map((r) => ({ testCaseId: r.test?.jira?.key, status: r.status?.name })),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'get_tests_for_requirement',
    {
      description: 'Get all test cases that cover a Jira story or requirement',
      inputSchema: {
        requirementId: issueKey('requirement ID').describe('Jira issue ID of the requirement or story (e.g. PROJ-42)'),
      },
    },
    async ({ requirementId }) => {
      try {
        const { found, tests: rawTests } = await fetchAllCoveringTests(requirementId);
        if (!found) return toolError(`Requirement ${requirementId} not found`);

        const tests = rawTests.map((t) => ({
          key: t.jira?.key,
          issueId: t.issueId,
          summary: t.jira?.summary,
        }));
        return ok({ requirementId, total: tests.length, testCases: tests });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
