import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Logs, Run } from '../types'
import { appProcesses, canFront, canPause, frontCommand, isSimulator, parsePs, pausedIds } from './controls.ts'

// Baton's live state above the prompt. The mod reads the same daemon the MCP
// tools drive (handshake in ~/.baton/daemon.json, POST /rpc), so a run Claude
// starts, one started from the terminal and one from the Baton app all show.

const PANE = 'baton'
const POLL_MS = 2000
const DEVICE_POLL_MS = 15000

const runs = atom({ plugin: 'baton', key: 'runs' } as const, [])
const isOnline = atom({ plugin: 'baton', key: 'isOnline' } as const, false)
const busy = atom({ plugin: 'baton', key: 'busy' } as const, null)
const isBandHidden = atom({ plugin: 'baton', key: 'isBandHidden' } as const, false)
const logs = atom({ plugin: 'baton', key: 'logs' } as const, null)

type Handshake = { port: number; token: string }
type Snapshot = {
  id: string
  name: string
  kind: string
  status: Run['status']
  root?: string
  target?: string
  url?: string
  progress?: string
  cpuPct?: number
  rssBytes?: number
  capabilities?: string[]
  pid?: number
}
type Device = { id: string; name: string; platformType?: string; platform?: string }
type Dollar = EngineInterface

const DOT: Record<Run['status'], string> = {
  starting: '◐',
  running: '●',
  stopped: '○',
  failed: '✕',
}
const COLOR: Record<Run['status'], string> = {
  starting: 'warning',
  running: 'success',
  stopped: 'inactive',
  failed: 'error',
}

export function toRun(s: Snapshot, devices: Map<string, string>, paused: string[] = [], mac = false): Run {
  const root = (s.root ?? '').replace(/[\\/]+$/, '')
  const project = root.split(/[\\/]/).pop() || s.name
  // A web run's target is its browser or URL; only a simulator or device name is worth showing.
  const known = s.target ? devices.get(s.target) : undefined
  const device = known ?? (s.target && !/^(https?:|web|chrome|edge|browser)/i.test(s.target) && s.target.length <= 24 ? s.target : undefined)
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    status: s.status,
    project,
    device,
    root: s.root,
    deviceId: s.target,
    url: s.url,
    progress: s.progress,
    cpuPct: s.cpuPct,
    rssBytes: s.rssBytes,
    capabilities: s.capabilities ?? [],
    paused: paused.includes(s.id),
    canPause: canPause(s, mac),
    canFront: canFront(s, mac),
  }
}

export function label(run: Run): string {
  const where = run.device ?? (run.url ? run.url.replace(/^https?:\/\//, '') : run.kind)
  return run.project === run.name ? `${run.name} · ${where}` : `${run.project}/${run.name} · ${where}`
}

function memory(bytes?: number): string {
  if (bytes == null) return ''
  return `${Math.round(bytes / 1_048_576)} MB`
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

let handshake: Handshake | null = null
let devices = new Map<string, string>()
let lastDevicePoll = 0
let snapshots: Snapshot[] = []
let mac: boolean | undefined

async function isMac($: Dollar): Promise<boolean> {
  if (mac === undefined) {
    try {
      mac = (await $.process.run(['uname', '-s'])).stdout.trim() === 'Darwin'
    } catch {
      mac = false
    }
  }
  return mac
}

async function processes($: Dollar) {
  try {
    return parsePs((await $.process.run(['ps', '-axo', 'pid=,ppid=,stat=,command='], { timeoutMs: 5000 })).stdout)
  } catch {
    return []
  }
}

async function handshakePath($: Dollar): Promise<string> {
  const custom = await $.env.get('BATON_HOME')
  if (custom) return `${custom}/daemon.json`
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  return `${home}/.baton/daemon.json`
}

async function rpc<T>($: Dollar, method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!handshake) {
    handshake = JSON.parse(await $.fs.read(await handshakePath($))) as Handshake
  }
  const res = await $.http.fetch(`http://127.0.0.1:${handshake.port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${handshake.token}` },
    body: JSON.stringify({ method, params }),
  })
  const body = JSON.parse(res.text || '{}') as { result?: T; error?: string }
  if (!res.ok || body.error) {
    if (res.status === 401) handshake = null
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return body.result as T
}

async function poll($: Dollar) {
  try {
    const list = await rpc<Snapshot[]>($, 'sessions')
    const now = Date.now()
    if (now - lastDevicePoll > DEVICE_POLL_MS && list.some(s => s.target)) {
      lastDevicePoll = now
      const roots = [...new Set(list.map(s => s.root).filter(Boolean))].slice(0, 3)
      const next = new Map(devices)
      for (const cwd of roots) {
        try {
          for (const d of await rpc<Device[]>($, 'devices', { cwd })) next.set(d.id, d.name)
        } catch {
          // A project without device tooling just shows its URL or kind.
        }
      }
      devices = next
    }
    snapshots = list
    const onMac = await isMac($)
    const pausable = list.filter(s => s.status === 'running' && canPause(s, onMac))
    const paused = pausable.length ? pausedIds(pausable, await processes($), onMac) : []
    const view = list.map(s => toRun(s, devices, paused, onMac))
    const open = await read($, logs)
    if (open) await loadLogs($, open.runId, open.name)
    if (!same(view, await read($, runs))) await update($, runs, () => view)
    if (!(await read($, isOnline))) await update($, isOnline, () => true)
  } catch {
    handshake = null
    if (await read($, isOnline)) await update($, isOnline, () => false)
  }
}

async function act($: Dollar, key: string, method: string, params: Record<string, unknown>, done: string) {
  await update($, busy, () => key)
  try {
    const result = await rpc<Array<{ code?: number; message?: string }>>($, method, params)
    const failed = Array.isArray(result) ? result.filter(r => r.code != null && r.code !== 0) : []
    $.ui.toast(failed.length ? `Baton: ${failed[0]?.message ?? 'failed'}` : done)
  } catch (err) {
    $.ui.toast(`Baton: ${(err as Error).message}`)
  } finally {
    await update($, busy, () => null)
    await poll($)
  }
}

async function guarded($: Dollar, key: string, work: () => Promise<string | undefined>) {
  await update($, busy, () => key)
  try {
    const done = await work()
    if (done) $.ui.toast(done)
  } catch (err) {
    $.ui.toast(`Baton: ${(err as Error).message}`)
  } finally {
    await update($, busy, () => null)
    await poll($)
  }
}

/** SIGSTOP or SIGCONT the app processes of these runs. */
async function signal($: Dollar, ids: string[], stop: boolean): Promise<string> {
  const procs = await processes($)
  const pids: string[] = []
  for (const id of ids) {
    const s = snapshots.find(r => r.id === id)
    if (!s) continue
    const marker = isSimulator(s) ? `/Devices/${s.target}/data/Containers/Bundle/Application/` : undefined
    const app = marker ? procs.filter(p => p.command.includes(marker)) : appProcesses(s, procs)
    pids.push(...app.map(p => String(p.pid)))
  }
  if (pids.length === 0) throw new Error(`no app process to ${stop ? 'pause' : 'resume'} yet`)
  const res = await $.process.run(['kill', stop ? '-STOP' : '-CONT', ...pids])
  if (res.exitCode !== 0) throw new Error(res.stderr.trim() || 'kill failed')
  return `Baton: ${stop ? 'paused' : 'resumed'} ${ids.length === 1 ? (snapshots.find(r => r.id === ids[0])?.name ?? '') : `${ids.length} apps`}`
}

async function front($: Dollar, runs: Run[]): Promise<string> {
  const pick = runs.filter(r => r.canFront)
  if (pick.length === 0) throw new Error('nothing to bring forward')
  const seen = new Set<string>()
  for (const r of pick) {
    const s = snapshots.find(x => x.id === r.id)
    if (!s) continue
    const argv = frontCommand(s)
    if (seen.has(argv.join(' '))) continue
    seen.add(argv.join(' '))
    await $.process.run(argv)
  }
  return pick.length === 1 ? `Baton: ${pick[0]!.name} is in front` : 'Baton: brought the apps forward'
}

async function loadLogs($: Dollar, runId: string, name: string) {
  try {
    const lines = await rpc<Array<{ text: string; error: boolean }>>($, 'logs', { session: runId, tail: 40 })
    const next: Logs = { runId, name, lines: lines.map(l => ({ text: l.text, error: !!l.error })) }
    if (!same(next, await read($, logs))) await update($, logs, () => next)
  } catch (err) {
    $.ui.toast(`Baton: ${(err as Error).message}`)
    await update($, logs, () => null)
  }
}

async function openPanel($: Dollar) {
  await update($, isBandHidden, () => false)
  await $.ui.open({ id: PANE, title: 'Baton' })
}

type DeviceKind = 'phone' | 'tablet' | 'android' | 'web' | 'process'

function deviceKind(run: Run): DeviceKind {
  const d = `${run.device ?? ''} ${run.kind}`
  if (/ipad|tab/i.test(d)) return 'tablet'
  if (/android|pixel|emulator/i.test(d) || run.kind === 'android') return 'android'
  if (run.device) return 'phone'
  if (run.url || /web|vite|next|chrome/i.test(run.kind)) return 'web'
  return 'process'
}

const stroke = (c: string, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="${c}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
const DEVICE_SVG: Record<DeviceKind, string> = {
  phone: stroke('#8e96a3', '<rect x="4.5" y="1.5" width="7" height="13" rx="1.8"/><path d="M7 12.4h2"/>'),
  tablet: stroke('#8e96a3', '<rect x="2.5" y="2" width="11" height="12" rx="1.6"/><path d="M7 12h2"/>'),
  android: stroke('#3ddc84', '<rect x="4.5" y="1.5" width="7" height="13" rx="1.8"/><path d="M7 12.4h2"/>'),
  web: stroke('#5fa8f5', '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2.2 2 9.8 0 12M8 2c-2 2.2-2 9.8 0 12"/>'),
  process: stroke('#8e96a3', '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 7l2 1.5L5 10M8.5 10H11"/>'),
}
const DEVICE_GLYPH: Record<DeviceKind, string> = { phone: '▯', tablet: '▭', android: '▯', web: '◍', process: '›_' }

const GENERIC = /^(ios|android)( simulator| emulator)?$|^(app|web|run|main|default)$/i

/** "CoreRun TST (full dart-defines)" → "CoreRun TST"; "iOS Simulator (DEV / dev flavor)" in McLane360-main → "McLane360 DEV". */
export function shortName(run: Pick<Run, 'name' | 'project'>): string {
  const base = run.name.replace(/\s*\(.*\)\s*$/, '').trim()
  if (base && !GENERIC.test(base)) return base
  const project = run.project.replace(/[-_](main|master|app)$/i, '')
  const flavor = /\(([A-Z][A-Z0-9]{1,5})\b/.exec(run.name)?.[1]
  return flavor ? `${project} ${flavor}` : project
}

/** "iPad Pro (12.9-inch) (4th generation)" → "iPad Pro 12.9″"; URLs lose their scheme. */
export function shortDevice(run: Pick<Run, 'device' | 'url' | 'kind'>): string {
  if (run.device) {
    return run.device
      .replace(/\s*\((\d+(?:\.\d+)?)-inch\)/i, ' $1″')
      .replace(/\s*\((?:\d+(?:st|nd|rd|th) generation|[^)]*generation)\)/i, '')
      .trim()
  }
  if (run.url) return run.url.replace(/^https?:\/\//, '').replace(/\/$/, '')
  return run.kind
}

type Site = 'band' | 'pane'

const LIVE = (r: Run) => r.status === 'running' || r.status === 'starting'

// Media-player glyphs every developer reads at a glance. U+FE0E keeps them as
// text, so they take the colour given instead of turning into emoji.
const G = {
  play: '▶︎',
  pause: '⏸︎',
  stop: '⏹︎',
  logs: '☰',
  debug: '🐞',
  front: '⧉',
  add: '＋',
  dismiss: '✕',
} as const

/** What ▶ does for this run: run it again, resume it, or apply the latest edit. */
function playAction(run: Run): 'again' | 'resume' | 'reload' | 'restart' | null {
  if (!LIVE(run)) return run.root ? 'again' : null
  if (run.paused) return 'resume'
  if (run.status !== 'running') return null
  if (run.capabilities.includes('hotReload')) return 'reload'
  if (run.capabilities.includes('hotRestart') || run.capabilities.includes('restartProcess')) return 'restart'
  return null
}

async function play($: Dollar, run: Run, site: Site): Promise<string | undefined> {
  const name = shortName(run)
  switch (playAction(run)) {
    case 'again':
      // The finished session holds its id until it is forgotten; the new run reuses it.
      await rpc($, 'forget', { session: run.id }).catch(() => undefined)
      await rpc($, 'run', { cwd: run.root, target: run.name, deviceId: run.deviceId })
      return `Baton: starting ${name}`
    case 'resume':
      return signal($, [run.id], false)
    case 'reload':
      await rpc($, 'reload', { session: run.id, reason: `Claude Code ${site}` })
      return `Baton: reloaded ${name}`
    case 'restart':
      await rpc($, 'restart', { session: run.id, reason: `Claude Code ${site}` })
      return `Baton: restarted ${name}`
    default:
      return undefined
  }
}

/** Hand the run to Claude: one turn that reads its errors and logs and fixes the cause. */
async function debug($: Dollar, run: Run) {
  await $.prompt.submit({
    text: `Debug ${run.name}${run.device ? ` on ${run.device}` : ''} (Baton session ${run.id}): read its recent errors and logs with Baton, find the cause, fix it, then check_change to confirm.`,
  })
}

/** Put Baton's run command in the prompt box, ready for a target name. */
async function startNew($: Dollar) {
  const { isFilled } = await $.prompt.fill({ text: '/baton:run ', mode: 'replace' })
  if (!isFilled) $.ui.toast('Baton: type /baton:run <target> to start a run')
}

/**
 * Baton's one workspace, drawn in the band above the prompt and in the /baton
 * pane alike: a header whose buttons act on every run, then one row per run
 * with the same buttons for that run alone. Every button is one click and sits
 * in the same place on every row; one that does not apply is drawn dim.
 */
async function workspace($: Dollar, e: any, site: Site) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const Svg = e.surface === 'desktop' || e.surface === 'vscode' || e.surface === 'mobile' ? ($.ui.resolve(e) as { Svg?: any }).Svg : undefined
  const list = await read($, runs)
  const working = await read($, busy)
  const log = await read($, logs)
  const width: number = e.props.bodyColumns ?? 100
  const wide = width >= 80

  const running = list.filter(r => r.status === 'running')
  const live = list.filter(LIVE)
  const pausable = running.filter(r => r.canPause && !r.paused)
  const paused = running.filter(r => r.paused)
  const playable = list.filter(r => playAction(r) !== null)
  const frontable = running.filter(r => r.canFront)
  const failed = list.filter(r => r.status === 'failed').length

  // One button: a coloured glyph, its name for screen readers. Dim and inert
  // when it does not apply, so the row keeps its shape.
  const btn = (key: string, glyph: string, name: string, color: string, enabled: boolean, onPress: () => unknown) => (
    <Box key={`b:${key}`} marginLeft={1}>
      <Button key={key} plain label={name} onPress={enabled ? onPress : () => undefined}>
        <Text color={enabled ? color : undefined} dimColor={!enabled} bold={enabled}>{working === key ? '…' : glyph}</Text>
      </Button>
    </Box>
  )

  const header = (
    <Box key="head" flexDirection="row" justifyContent="space-between" alignItems="center">
      <Text>
        <Text bold color="claude">◆ Baton</Text>
        {running.length - paused.length > 0 && <Text color="success">  ● {running.length - paused.length}</Text>}
        {paused.length > 0 && <Text color="warning">  {G.pause} {paused.length}</Text>}
        {live.length > running.length && <Text color="warning">  ◐ {live.length - running.length}</Text>}
        {failed > 0 && <Text color="error">  ✕ {failed}</Text>}
      </Text>
      <Box flexDirection="row">
        {btn('add', G.add, 'New run', 'claude', true, () => startNew($))}
        {btn('play-all', G.play, 'Play all', 'success', playable.length > 0, () => guarded($, 'play-all', async () => {
          for (const r of playable) await play($, r, site).catch(() => undefined)
          return `Baton: played ${playable.length} ${playable.length === 1 ? 'run' : 'runs'}`
        }))}
        {btn('pause-all', G.pause, 'Pause all', 'warning', pausable.length > 0, () => guarded($, 'pause-all', () => signal($, pausable.map(r => r.id), true)))}
        {btn('stop-all', G.stop, 'Stop all', 'error', live.length > 0, () => act($, 'stop-all', 'stop', { ids: live.map(r => r.id) }, 'Baton: stopped all'))}
        {btn('front-all', G.front, 'Bring all to front', 'suggestion', frontable.length > 0, () => guarded($, 'front-all', () => front($, frontable)))}
        {site === 'band' && btn('hide', G.dismiss, 'Hide until /baton', 'subtle', true, () => update($, isBandHidden, () => true))}
      </Box>
    </Box>
  )

  const rows = list.map(run => {
    const kind = deviceKind(run)
    const ended = !LIVE(run)
    const state = run.paused ? 'paused' : run.status === 'running'
      ? [run.cpuPct != null ? `${Math.round(run.cpuPct)}%` : '', memory(run.rssBytes)].filter(Boolean).join(' · ')
      : run.progress ?? run.status
    const dotColor = run.paused || run.status === 'starting' ? 'warning' : COLOR[run.status]
    const action = playAction(run)
    const glyph = Svg
      ? <Svg key={`dev:${run.id}`} source={DEVICE_SVG[kind]} alt={kind} width={14} height={14} />
      : <Text dimColor>{DEVICE_GLYPH[kind]}</Text>
    const info = (
      <Box key={`info:${run.id}`} flexDirection="row" flexGrow={1} flexShrink={1} alignItems="center">
        <Text color={dotColor}>{DOT[run.status]} </Text>
        {glyph}
        <Box width={wide ? 20 : undefined} flexShrink={1} marginLeft={1}>
          <Text bold={!ended} dimColor={ended} wrap="truncate-end">{shortName(run)}</Text>
        </Box>
        <Box width={wide ? 20 : undefined} flexShrink={1} marginLeft={1}>
          <Text dimColor wrap="truncate-end">{shortDevice(run)}</Text>
        </Box>
        <Box flexShrink={1} marginLeft={1}>
          <Text color={run.paused ? 'warning' : run.status === 'failed' ? 'error' : undefined} dimColor={!run.paused && run.status !== 'failed'} wrap="truncate-end">{state}</Text>
        </Box>
      </Box>
    )
    const showingLogs = log?.runId === run.id
    const controls = (
      <Box flexDirection="row" flexShrink={0}>
        {btn(`logs:${run.id}`, G.logs, showingLogs ? 'Hide logs' : 'Logs', showingLogs ? 'claude' : 'text', true,
          () => (showingLogs ? update($, logs, () => null) : loadLogs($, run.id, run.name)))}
        {btn(`debug:${run.id}`, G.debug, 'Debug with Claude', 'error', true, () => debug($, run))}
        {btn(`play:${run.id}`, G.play, action === 'again' ? 'Run again' : action === 'resume' ? 'Resume' : action === 'restart' ? 'Restart' : 'Hot reload', 'success',
          action !== null, () => guarded($, `play:${run.id}`, () => play($, run, site)))}
        {btn(`pause:${run.id}`, G.pause, 'Pause', 'warning', run.status === 'running' && run.canPause && !run.paused,
          () => guarded($, `pause:${run.id}`, () => signal($, [run.id], true)))}
        {ended
          ? btn(`dismiss:${run.id}`, G.dismiss, 'Dismiss', 'subtle', true, () => act($, `dismiss:${run.id}`, 'forget', { session: run.id }, `Baton: dismissed ${shortName(run)}`))
          : btn(`stop:${run.id}`, G.stop, 'Stop', 'error', true, () => act($, `stop:${run.id}`, 'stop', { session: run.id }, `Baton: stopped ${shortName(run)}`))}
        {btn(`front:${run.id}`, G.front, 'Bring to front', 'suggestion', run.status === 'running' && run.canFront, () => guarded($, `front:${run.id}`, () => front($, [run])))}
      </Box>
    )
    return (
      <Box key={`run:${run.id}`} flexDirection="column">
        {wide ? (
          <Box flexDirection="row" justifyContent="space-between" alignItems="center">
            {info}
            {controls}
          </Box>
        ) : (
          <Box flexDirection="column">{info}{controls}</Box>
        )}
        {showingLogs && (
          <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} marginLeft={2}>
            {log.lines.length === 0
              ? <Text dimColor>No output yet.</Text>
              : log.lines.slice(site === 'band' ? -8 : -40).map((l, i) => (
                <Text key={`l${i}`} color={l.error ? 'error' : undefined} dimColor={!l.error} wrap="truncate-end">{l.text}</Text>
              ))}
          </Box>
        )}
      </Box>
    )
  })

  return (
    <Box flexDirection="column">
      {header}
      {rows}
      {list.length === 0 && <Text dimColor>No runs yet. Press {G.add} to start one, or ask Claude to run an app.</Text>}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'baton', description: 'Open the Baton workspace: every run with its controls, new runs and simulators' })
    await poll($)
    $.clock.every(POLL_MS, () => poll($))
    return next(e)
  })

  on('command.run', { command: 'baton' }, async $ => {
    await openPanel($)
    return { text: 'Baton opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, runs)
    if (e.props.hasSurvey || !(await read($, isOnline)) || list.length === 0 || (await read($, isBandHidden))) return next(e)
    return workspace($, e, 'band')
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    if (!(await read($, isOnline))) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Baton isn't running yet.</Text>
          <Text dimColor>Ask Claude to run your app, or run `baton app`.</Text>
        </Box>
      )
    }
    return workspace($, e, 'pane')
  })
}
