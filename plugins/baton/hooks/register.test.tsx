import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { Run } from '../types'
import { label, shortDevice, shortName, toRun } from './register.tsx'


// Stands in for the Baton daemon: the handshake file and POST /rpc.
function daemon(on: On, sessions: unknown[] | null, calls: Array<{ method: string; params: unknown }> = [], below?: string) {
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
  on('prompt.fill', async ($, e) => {
    calls.push({ method: 'prompt.fill', params: { text: e.text, mode: e.mode } })
    return { isFilled: true }
  })
  on('prompt.submit', async ($, e) => {
    calls.push({ method: 'prompt.submit', params: { text: e.text } })
    return { text: e.text }
  })
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('ui.render', async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return below ? <Text key="below">{below}</Text> : <Box key="engine" />
  })
}

const SESSIONS = [
  { id: 's1', name: 'CoreRun', kind: 'ios', status: 'running', root: '/Users/v/CoreRun', target: 'UDID-1', capabilities: ['hotRestart', 'stop', 'screenshot'], cpuPct: 12, rssBytes: 200 * 1_048_576 },
  { id: 's2', name: 'app', kind: 'flutter', status: 'starting', root: '/Users/v/fieldapp', target: 'iPad Air', progress: 'Building…', capabilities: ['hotReload', 'hotRestart', 'stop', 'screenshot'] },
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
const fieldapp: Run = {
  id: 's2', name: 'app', kind: 'flutter', status: 'starting', project: 'fieldapp', progress: 'Building…',
  device: 'iPad Air', capabilities: ['hotReload', 'hotRestart', 'stop', 'screenshot'],
  paused: false, canPause: false, canFront: false,
}

describe('helpers', () => {
  test('names and devices are shortened for one clean line', () => {
    expect(shortName({ name: 'CoreRun TST (full dart-defines)', project: 'CoreRun' })).toBe('CoreRun TST')
    expect(shortName({ name: 'iOS Simulator (DEV / dev flavor)', project: 'FieldApp-main' })).toBe('FieldApp DEV')
    expect(shortName({ name: 'app', project: 'fieldapp' })).toBe('fieldapp')
    expect(shortDevice({ device: 'iPad Pro (12.9-inch) (4th generation)', kind: 'ios' })).toBe('iPad Pro 12.9″')
    expect(shortDevice({ url: 'http://localhost:5173/', kind: 'web' })).toBe('localhost:5173')
  })

  test('a run takes its project from the root and its device by id', async () => {
    const run = toRun(
      { id: 'a', name: 'CoreRun', kind: 'ios', status: 'running', root: '/Users/v/CoreRun/', target: 'UDID-1', capabilities: [] },
      new Map([['UDID-1', 'iPhone 17 Pro']]),
    )
    expect(run.project).toBe('CoreRun')
    expect(run.device).toBe('iPhone 17 Pro')
    expect(label(run)).toBe('CoreRun · iPhone 17 Pro')
    expect(label({ ...fieldapp, status: 'running' })).toBe('fieldapp/app · iPad Air')
  })
})

test('the band stays out of the way with nothing running', async ($, on) => {
  daemon(on, [])
  await $.session.start(START)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'baton', surface, ...BAND })
    expect(await ui.find({ key: 'add' })).toBeUndefined()
    await ui.unmount()
  }
})


test('the band stacks above another plugin band instead of hiding it', async ($, on) => {
  daemon(on, SESSIONS, [], 'X-ray band')
  await $.session.start(START)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'baton', surface, ...BAND })
    expect(await ui.find({ key: 'add' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /X-ray band/ })).toBeDefined()
    await ui.unmount()
  }
})

const ROW = ['logs', 'debug', 'play', 'pause', 'stop', 'front']
const ALL = ['add', 'play-all', 'pause-all', 'stop-all', 'front-all']

test('every run gets the same six buttons, and the header acts on all', async ($, on) => {
  daemon(on, SESSIONS)
  await $.session.start(START)
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const site of [BAND, PANE]) {
      const ui = await $.ui.mount({ plugin: 'baton', surface, ...site })
      for (const id of ['s1', 's2']) for (const b of ROW) expect(await ui.find({ key: `${b}:${id}` })).toBeDefined()
      for (const b of ALL) expect(await ui.find({ key: b })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /iPhone 17 Pro/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /200 MB/ })).toBeDefined()
      // Icons, not words: a desktop draws a Button's label in place of its glyph.
      expect((await ui.find({ key: 'play:s1' }))?.text).toBe('▶\uFE0E')
      expect((await ui.find({ key: 'stop-all' }))?.text).toBe('⏹\uFE0E')
      for (const b of await ui.findAll({ type: 'Button' })) expect((b as { props?: { label?: string } }).props?.label ?? '').not.toMatch(/[A-Za-z]/)
      await ui.unmount()
    }
  }
})

test('hide takes the band away until /baton', async ($, on) => {
  daemon(on, SESSIONS)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'desktop', ...BAND })
  await ui.press({ key: 'hide' })
  expect(await ui.find({ key: 'add' })).toBeUndefined()
  await ui.unmount()
})

test('the panel explains itself when Baton is not running', async ($, on) => {
  daemon(on, null)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /Baton isn't running yet/ })).toBeDefined()
  await ui.unmount()
})

test('play applies the edit: hot reload where it can, restart where it cannot', async ($, on) => {
  const calls: Array<{ method: string; params: unknown }> = []
  daemon(on, [SESSIONS[0], { ...SESSIONS[1], status: 'running' }], calls)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'desktop', ...BAND })
  await ui.press({ key: 'play:s1' })
  expect(calls.find(c => c.method === 'restart')?.params).toEqual({ session: 's1', reason: 'Claude Code band' })
  await ui.press({ key: 'play:s2' })
  expect(calls.find(c => c.method === 'reload')?.params).toEqual({ session: 's2', reason: 'Claude Code band' })
  await ui.unmount()
})

test('stop is one click, for a run and for all', async ($, on) => {
  const calls: Array<{ method: string; params: unknown }> = []
  daemon(on, SESSIONS, calls)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'desktop', ...BAND })
  await ui.press({ key: 'stop:s1' })
  expect(calls.find(c => c.method === 'stop')?.params).toEqual({ session: 's1' })
  await ui.press({ key: 'stop-all' })
  expect(calls.filter(c => c.method === 'stop').at(-1)?.params).toEqual({ ids: ['s1', 's2'] })
  await ui.unmount()
})

test('a finished run plays again and can be dismissed', async ($, on) => {
  const calls: Array<{ method: string; params: unknown }> = []
  daemon(on, [{ ...SESSIONS[0], status: 'failed' }], calls)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'desktop', ...BAND })
  await ui.press({ key: 'play:s1' })
  expect(calls.find(c => c.method === 'run')?.params).toEqual({ cwd: '/Users/v/CoreRun', target: 'CoreRun', deviceId: 'UDID-1' })
  await ui.press({ key: 'dismiss:s1' })
  expect(calls.find(c => c.method === 'forget')?.params).toEqual({ session: 's1' })
  await ui.unmount()
})

test('logs open under the row, debug hands the run to Claude, + puts the run command in the prompt', async ($, on) => {
  const calls: Array<{ method: string; params: unknown }> = []
  daemon(on, SESSIONS, calls)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'desktop', ...BAND })
  await ui.press({ key: 'logs:s1' })
  expect(await ui.find({ type: 'Text', text: /Firebase error/ })).toBeDefined()
  await ui.press({ key: 'logs:s1' })
  expect(await ui.find({ type: 'Text', text: /Firebase error/ })).toBeUndefined()
  await ui.press({ key: 'debug:s1' })
  expect((calls.find(c => c.method === 'prompt.submit')?.params as { text: string }).text).toMatch(/^Debug CoreRun on iPhone 17 Pro \(Baton session s1\)/)
  await ui.press({ key: 'add' })
  expect(calls.find(c => c.method === 'prompt.fill')?.params).toEqual({ text: '/baton:run ', mode: 'replace' })
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


test('on a Mac pause stops the simulator app, play resumes it, front raises Simulator', async ($, on) => {
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

test('front raises that run\'s own simulator window, and front-all raises every one', async ($, on) => {
  const IPAD = 'B1A1BE95-E9D6-4134-B214-AA82BA076A8B'
  const argvs: string[][] = []
  daemon(on, [...MAC_SESSIONS, { ...MAC_SESSIONS[0]!, id: 's2', name: 'FieldApp', root: '/Users/v/FieldApp', target: IPAD, pid: 51 }])
  mac(on, argvs)
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'desktop', ...BAND })
  const shown = () => argvs.filter(a => a[0] === 'osascript').map(a => /deviceUDID: "([^"]+)"/.exec(a.at(-1)!)?.[1])
  await ui.press({ key: 'front:s2' })
  expect(shown()).toEqual([IPAD])
  await ui.press({ key: 'front:s1' })
  expect(shown()).toEqual([IPAD, SIM])
  argvs.length = 0
  await ui.press({ key: 'front-all' })
  expect(argvs.filter(a => a[0] === 'open')).toEqual([['open', '-a', 'Simulator']])
  expect(shown()).toEqual([SIM, IPAD])
  await ui.unmount()
})

test('a paused app reads paused, and play continues it', async ($, on) => {
  const argvs: string[][] = []
  daemon(on, MAC_SESSIONS)
  mac(on, argvs, 'T')
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'baton', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /paused/ })).toBeDefined()
  await ui.press({ key: 'play:s1' })
  expect(argvs.find(a => a[0] === 'kill')).toEqual(['kill', '-CONT', '90'])
  await ui.unmount()
})
