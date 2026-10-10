import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { DASHBOARD_URI, MCP_APP_MIME, dashboardHtml, dashboardText, toDashboardRun } from '../src/mcp/dashboard.ts';
import type { SessionSnapshot } from '../src/core/types.ts';

/**
 * The Baton card a chat host draws inline: `show_dashboard` names the
 * `ui://` page, the page is served as an MCP App, and the runs ride along
 * as structured content.
 */
const ios: SessionSnapshot = {
  id: 'corerun/full@2F77', name: 'CoreRun', kind: 'flutter', status: 'running', root: '/Users/v/NativeApps/CoreRun/',
  target: '2F77F133', capabilities: ['hotReload', 'hotRestart', 'stop', 'screenshot'], startedAt: 0, cpuPct: 12.4, rssBytes: 300 * 1_048_576,
};
const web: SessionSnapshot = {
  id: 'api/delivery-api', name: 'Delivery API', kind: 'web-dev', status: 'running', root: '/x/api',
  target: 'http://127.0.0.1:43121', url: 'http://127.0.0.1:43121', capabilities: ['restartProcess', 'stop'], startedAt: 0,
};

test('a run shows its project and simulator name, and a web run its URL', () => {
  const run = toDashboardRun(ios, new Map([['2F77F133', 'iPhone 17 Pro']]));
  assert.equal(run.project, 'CoreRun');
  assert.equal(run.device, 'iPhone 17 Pro');
  assert.equal(toDashboardRun(web, new Map()).device, undefined);
  assert.match(dashboardText({ runs: [run], at: 0 }), /CoreRun\/CoreRun · iPhone 17 Pro · running/);
  assert.equal(dashboardText({ runs: [], at: 0 }), 'Baton: nothing is running.');
});

test('the card page speaks the MCP Apps handshake and loads nothing from the network', () => {
  const html = dashboardHtml('9.9.9');
  assert.match(html, /ui\/initialize/);
  assert.match(html, /ui\/notifications\/tool-result/);
  assert.match(html, /dashboard_action/);
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=/);
});

const home = mkdtempSync(join(tmpdir(), 'baton-mcp-card-'));
const env = { ...process.env, BATON_HOME: home } as Record<string, string>;
after(() => {
  spawnSync(process.execPath, ['src/cli/index.ts', 'daemon', 'stop'], { env });
  rmSync(home, { recursive: true, force: true });
});

test('show_dashboard points at the card and returns the runs', async () => {
  const client = new Client({ name: 'card-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/mcp/index.ts'], env }));
  try {
    const { tools } = await client.listTools();
    const show = tools.find((t) => t.name === 'show_dashboard');
    assert.equal((show?._meta as any)?.ui?.resourceUri, DASHBOARD_URI);
    assert.ok(tools.find((t) => t.name === 'dashboard_action'));

    const page = await client.readResource({ uri: DASHBOARD_URI });
    assert.equal(page.contents[0]?.mimeType, MCP_APP_MIME);

    const result: any = await client.callTool({ name: 'show_dashboard', arguments: {} });
    assert.deepEqual(result.structuredContent.runs, []);
    const refreshed: any = await client.callTool({ name: 'dashboard_action', arguments: { action: 'refresh' } });
    assert.deepEqual(refreshed.structuredContent.runs, []);
  } finally {
    await client.close();
  }
});
