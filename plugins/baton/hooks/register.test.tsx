import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Run } from '../types'
import { label, toRun } from './register.tsx'


// Stands in for the Baton daemon: the handshake file and POST /rpc.
function daemon(on: On, sessions: unknown[] | null, calls: Array<{ method: string; params: unknown }> = []) {
  mock.env(on, { HOME: '/home/t' })
  mock.clock(on)
  on('fs.read', async () => ({ value: '{"port":4100,"token":"t"}' }))
  on('http.fetch', async ($, e) => {
    if (sessions === null) return { value: { status: 502, ok: false, headers: {}, text: '' } }
    const { method, params } = JSON.parse(e.init?.body ?? '{}') as { method: string; params: unknown }
    calls.push({ method, params })
    const result = method === 'sessions' ? sessions
      : method === 'devices' ? [{ id: 'UDID-1', name: 'iPhone 17 Pro', platformType: 'ios' }]
      : method === 'projects' ? { projects: [{ root: '/Users/v/CoreRun', name: 'CoreRun', targets: [{ name: 'CoreRun TST', kind: 'flutter' }, { name: 'Landing', kind: 'web' }] }] }
      : method === 'bootables' ? [{ id: 'B-1', name: 'iPad Air', platformType: 'ios', running: false }]
      : method === 'logs' ? [{ text: 'Firebase error', error: true }, { text: 'ready', error: false }]
      : []
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ result }) } }
  })
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.toast', async () => ({ value: undefined }))
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('ui.render', async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
}

const SESSIONS = [
  { id: 's1', name: 'CoreRun', kind: 'ios', status: 'running', root: '/Users/v/CoreRun', target: 'UDID-1', capabilities: ['hotRestart', 'stop', 'screenshot'], cpuPct: 12, rssBytes: 200 * 1_048_576 },
  { id: 's2', name: 'app', kind: 'flutter', status: 'starting', root: '/Users/v/mclane360', target: 'iPad Air', progress: 'Building…', capabilities: ['hotReload', 'hotRestart', 'stop', 'screenshot'] },
]
const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const
const PANE = {
  component: 'Pane',
  requestId: 'baton',
  props: { title: 'Baton', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const coreRun: Run = {
  id: 's1', name: 'CoreRun', kind: 'ios', status: 'running', project: 'CoreRun',
  device: 'iPhone 17 Pro', capabilities: ['hotRestart', 'stop', 'screenshot'], cpuPct: 12, rssBytes: 200 * 1_048_576,
  paused: false, canPause: false, canFront: false,
}
const mclane: Run = {
  id: 's2', name: 'app', kind: 'flutter', status: 'starting', project: 'mclane360', progress: 'Building…',
  device: 'iPad Air', capabilities: ['hotReload', 'hotRestart', 'stop', 'screenshot'],
  paused: false, canPause: false, canFront: false,
}

describe('helpers', () => {
  test('a run takes its project from the root and its device by id', async () => {
    const run = toRun(
      { id: 'a', name: 'CoreRun', kind: 'ios', status: 'running', root: '/Users/v/CoreRun/', target: 'UDID-1', capabilities: [] },
      new Map([['UDID-1', 'iPhone 17 Pro']]),
    )
    expect(run.project).toBe('CoreRun')
    expect(run.device).toBe('iPhone 17 Pro')
    expect(label(run)).toBe('CoreRun · iPhone 17 Pro')
    expect(label({ ...mclane, status: 'running' })).toBe('mclane360/app · iPad Air')
  })
})

test('the band stays out of the way with nothing running', async ($, on) => {
  daemon(on, [])
  await $.session.start(START)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'baton', surface, ...BAND })
    expect(await ui.find({ key: 'open' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the band lists live runs from the daemon and hides on request', async ($, on) => {
  daemon(on, SESSIONS)
  await $.session.start(START)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'baton', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /iPhone 17 Pro/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /mclane360 · app/ })).toBeDefined()
    expect(await ui.find({ key: 'open' })).toBeDefined()
    // Each run has its own row of controls; mclane360 is still building, so only Stop and Logs.
    expect(await ui.find({ key: 'restart:s1' })).toBeDefined()
    expect(await ui.find({ key: 'stop:s2' })).toBeDefined()
    expect(await ui.find({ key: 'reload:s2' })).toBeUndefined()
    expect(await ui.find({ key: 'reload-all' })).toBeUndefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'terminal', ...BAND })
  await ui.press({ key: 'hide' })
  expect(await ui.find({ key: 'open' })).toBeUndefined()
  await ui.unmount()
})

test('the panel shows per-run controls by capability', async ($, on) => {
  daemon(on, [SESSIONS[0], { ...SESSIONS[1], status: 'running' }])
  await $.session.start(START)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'baton', surface, ...PANE })
    expect(await ui.find({ key: 'restart:s1' })).toBeDefined()
    expect(await ui.find({ key: 'reload:s1' })).toBeUndefined()
    expect(await ui.find({ key: 'reload:s2' })).toBeDefined()
    expect(await ui.find({ key: 'shot:s2' })).toBeDefined()
    expect(await ui.find({ key: 'stop:s1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /200 MB/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the panel explains itself when Baton is not running', async ($, on) => {
  daemon(on, null)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /Baton isn't running yet/ })).toBeDefined()
  await ui.unmount()
})

test('pressing Restart restarts that one run', async ($, on) => {
  const calls: Array<{ method: string; params: unknown }> = []
  daemon(on, SESSIONS, calls)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'desktop', ...PANE })
  await ui.press({ key: 'restart:s1' })
  expect(calls.find(c => c.method === 'restart')?.params).toEqual({ session: 's1', reason: 'Claude Code pane' })
  await ui.unmount()
})

const SIM = '11111111-2222-3333-4444-555555555555'
const MAC_SESSIONS = [
  { id: 's1', name: 'CoreRun', kind: 'flutter', status: 'running', root: '/Users/v/CoreRun', target: SIM, pid: 50, capabilities: ['hotReload', 'stop'] },
]

// A Mac: `uname` says Darwin, `ps` shows the app inside that simulator, `kill` and `open` are recorded.
function mac(on: On, argvs: string[][], stat = 'S') {
  on('process.run', async ($, e) => {
    argvs.push([...e.argv])
    const stdout = e.argv[0] === 'uname' ? 'Darwin\n'
      : e.argv[0] === 'ps' ? `  50     1 S    flutter run\n  90     1 ${stat}    /Users/v/Library/Developer/CoreSimulator/Devices/${SIM}/data/Containers/Bundle/Application/X/Runner.app/Runner\n`
      : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

test('on a Mac a run row pauses the simulator app and brings it forward', async ($, on) => {
  const argvs: string[][] = []
  daemon(on, MAC_SESSIONS)
  mac(on, argvs)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'desktop', ...BAND })
  await ui.press({ key: 'pause:s1' })
  expect(argvs.find(a => a[0] === 'kill')).toEqual(['kill', '-STOP', '90'])
  await ui.press({ key: 'front:s1' })
  expect(argvs.find(a => a[0] === 'open')).toEqual(['open', '-a', 'Simulator'])
  await ui.unmount()
})

test('a paused app shows Resume and continues on press', async ($, on) => {
  const argvs: string[][] = []
  daemon(on, MAC_SESSIONS)
  mac(on, argvs, 'T')
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /paused/ })).toBeDefined()
  await ui.press({ key: 'pause:s1' })
  expect(argvs.find(a => a[0] === 'kill')).toEqual(['kill', '-CONT', '90'])
  await ui.unmount()
})

test('Stop all asks for a confirm first', async ($, on) => {
  const calls: Array<{ method: string; params: unknown }> = []
  daemon(on, SESSIONS, calls)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'desktop', ...BAND })
  await ui.press({ key: 'stop-all' })
  expect(calls.find(c => c.method === 'stop')).toBeUndefined()
  await ui.press({ key: 'stop-all' })
  expect(calls.find(c => c.method === 'stop')?.params).toEqual({ ids: ['s1', 's2'] })
  await ui.unmount()
})

test('New run starts the picked target, boots a simulator and shows logs', async ($, on) => {
  const calls: Array<{ method: string; params: unknown }> = []
  daemon(on, SESSIONS, calls)
  await $.session.start(START)
  const band = await $.ui.mount({ plugin: 'baton', surface: 'desktop', ...BAND })
  await band.press({ key: 'open' })
  await band.unmount()
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'desktop', ...PANE })
  await ui.select({ key: 'target', value: 'Landing' })
  await ui.select({ key: 'device', value: 'UDID-1' })
  await ui.press({ key: 'run' })
  expect(calls.find(c => c.method === 'run')?.params).toEqual({ cwd: '/Users/v/CoreRun', target: 'Landing', deviceId: 'UDID-1' })
  await ui.press({ key: 'boot-device' })
  expect(calls.find(c => c.method === 'boot')?.params).toEqual({ id: 'B-1' })
  await ui.press({ key: 'logs:s1' })
  expect(await ui.find({ type: 'Text', text: /Firebase error/ })).toBeDefined()
  await ui.unmount()
})

test('the band collapses to its header and starts a finished run again', async ($, on) => {
  const calls: Array<{ method: string; params: unknown }> = []
  daemon(on, [{ ...SESSIONS[0], status: 'failed' }], calls)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'desktop', ...BAND })
  await ui.press({ key: 'again:s1' })
  expect(calls.find(c => c.method === 'run')?.params).toEqual({ cwd: '/Users/v/CoreRun', target: 'CoreRun', deviceId: 'UDID-1' })
  await ui.press({ key: 'collapse' })
  expect(await ui.find({ key: 'again:s1' })).toBeUndefined()
  expect(await ui.find({ key: 'new' })).toBeDefined()
  await ui.unmount()
})

test('New run opens inline in the band', async ($, on) => {
  const calls: Array<{ method: string; params: unknown }> = []
  daemon(on, SESSIONS, calls)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'desktop', ...BAND })
  expect(await ui.find({ key: 'run' })).toBeUndefined()
  await ui.press({ key: 'new' })
  await ui.press({ key: 'run' })
  expect(calls.find(c => c.method === 'run')?.params).toEqual({ cwd: '/Users/v/CoreRun', target: 'CoreRun TST', deviceId: undefined })
  await ui.unmount()
})
