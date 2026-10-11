import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Catalog, Form, Logs, Run, Shot } from '../types'
import { appProcesses, canFront, canPause, frontCommand, isSimulator, parsePs, pausedIds } from './controls.ts'

// Baton's live state above the prompt. The mod reads the same daemon the MCP
// tools drive (handshake in ~/.baton/daemon.json, POST /rpc), so a run Claude
// starts, one started from the terminal and one from the Baton app all show.

const PANE = 'baton'
const POLL_MS = 2000
const DEVICE_POLL_MS = 15000
const SVG_LIMIT = 120_000

const runs = atom({ plugin: 'baton', key: 'runs' } as const, [])
const isOnline = atom({ plugin: 'baton', key: 'isOnline' } as const, false)
const busy = atom({ plugin: 'baton', key: 'busy' } as const, null)
const shot = atom({ plugin: 'baton', key: 'shot' } as const, null)
const isBandHidden = atom({ plugin: 'baton', key: 'isBandHidden' } as const, false)
const catalog = atom({ plugin: 'baton', key: 'catalog' } as const, null)
const form = atom({ plugin: 'baton', key: 'form' } as const, {})
const logs = atom({ plugin: 'baton', key: 'logs' } as const, null)
const armedStop = atom({ plugin: 'baton', key: 'armedStop' } as const, null)
const isCollapsed = atom({ plugin: 'baton', key: 'isCollapsed' } as const, false)
const isNewOpen = atom({ plugin: 'baton', key: 'isNewOpen' } as const, false)

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
type Bootable = { id: string; name: string; platformType: 'ios' | 'android'; running: boolean }
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

const platformOf = (p: string) => (/ios/i.test(p) ? 'ios' : /android/i.test(p) ? 'android' : 'other') as 'ios' | 'android' | 'other'

/** Projects with their targets, and every device to run on or boot. Best-effort on devices. */
async function loadCatalog($: Dollar) {
  try {
    const { projects } = await rpc<{ projects: Array<{ root: string; name: string; targets?: Array<{ name: string; kind: string }> }> }>($, 'projects')
    const cwd = projects[0]?.root
    const [live, bootable] = await Promise.all([
      rpc<Device[]>($, 'devices', { cwd }).catch(() => [] as Device[]),
      rpc<Bootable[]>($, 'bootables', { cwd }).catch(() => [] as Bootable[]),
    ])
    const byId = new Map<string, Catalog['devices'][number]>()
    for (const d of live) {
      devices.set(d.id, d.name)
      byId.set(d.id, { id: d.id, name: d.name, platform: platformOf(d.platformType ?? d.platform ?? ''), running: true })
    }
    for (const b of bootable) if (!byId.has(b.id)) byId.set(b.id, { id: b.id, name: b.name, platform: b.platformType, running: b.running })
    const next: Catalog = {
      projects: projects
        .filter(p => (p.targets ?? []).length > 0)
        .map(p => ({ root: p.root, name: p.name, targets: (p.targets ?? []).map(t => ({ name: t.name, kind: t.kind })) })),
      devices: [...byId.values()].sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name)),
    }
    await update($, catalog, () => next)
  } catch (err) {
    $.ui.toast(`Baton: ${(err as Error).message}`)
  }
}

async function openPanel($: Dollar) {
  await update($, isBandHidden, () => false)
  await $.ui.open({ id: PANE, title: 'Baton' })
  if (!(await read($, catalog))) await loadCatalog($)
}

async function screenshot($: Dollar, run: Run) {
  await update($, busy, () => `shot:${run.id}`)
  try {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
    const out = `${home}/.baton/claude/${run.id}.png`
    const { path } = await rpc<{ path: string }>($, 'screenshot', { session: run.id, out })
    const next: Shot = { runId: run.id, path, at: Date.now() }
    next.svg = await thumbnail($, path)
    await update($, shot, () => next)
    $.ui.toast(`Baton: screenshot of ${run.name} saved`)
  } catch (err) {
    $.ui.toast(`Baton: ${(err as Error).message}`)
  } finally {
    await update($, busy, () => null)
  }
}

// The desktop app draws an Svg; a small JPEG inside one is the screenshot.
// macOS ships `sips`, which shrinks it below the Svg size limit.
async function thumbnail($: Dollar, path: string): Promise<string | undefined> {
  const small = path.replace(/\.png$/, '.thumb.jpg')
  let source = path
  let mime = 'image/png'
  try {
    const made = await $.process.run(['sips', '-Z', '520', '-s', 'format', 'jpeg', '-s', 'formatOptions', '60', path, '--out', small])
    if (made.exitCode === 0) {
      source = small
      mime = 'image/jpeg'
    }
  } catch {
    // Not macOS: fall back to the PNG when it is small enough.
  }
  try {
    const { base64 } = (await $.fs.read(source, { as: 'bytes' })) as { base64: string }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 520"><image width="260" height="520" preserveAspectRatio="xMidYMid meet" href="data:${mime};base64,${base64}"/></svg>`
    return svg.length <= SVG_LIMIT ? svg : undefined
  } catch {
    return undefined
  }
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

/**
 * Baton's one workspace, drawn in the band above the prompt and in the /baton
 * pane alike: a header with the all-apps actions, a row per run with its own
 * controls, an inline New run row, and a run's logs or screenshot opened under
 * its row. A tree taller than the band scrolls in it.
 */
async function workspace($: Dollar, e: any, site: Site) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const els = $.ui.resolve(e) as { Select?: any; Svg?: any }
  const Select = els.Select
  const Svg = e.surface === 'desktop' || e.surface === 'vscode' || e.surface === 'mobile' ? els.Svg : undefined
  const list = await read($, runs)
  const working = await read($, busy)
  const armed = await read($, armedStop)
  const collapsed = site === 'band' && (await read($, isCollapsed))
  const newOpen = site === 'pane' || (await read($, isNewOpen))
  const log = await read($, logs)
  const last = await read($, shot)
  const cat = await read($, catalog)
  const picks = await read($, form)
  const width: number = e.props.bodyColumns ?? 100
  const wide = width >= 90

  const running = list.filter(r => r.status === 'running')
  const live = list.filter(LIVE)
  const reloadable = running.filter(r => r.capabilities.includes('hotReload') && !r.paused)
  const pausable = running.filter(r => r.canPause)
  const allPaused = pausable.length > 0 && pausable.every(r => r.paused)
  const pausedCount = running.filter(r => r.paused).length
  const starting = live.length - running.length
  const failed = list.filter(r => r.status === 'failed').length

  // An icon control: a coloured glyph on a quiet button, its name as the
  // accessible label and as a tooltip that shows while the pointer is on it.
  const icon = (key: string, glyph: string, tip: string, color: string, onPress: () => unknown, opts: { on?: boolean } = {}) => (
    <Box key={`i:${key}`} position="relative" marginLeft={1}>
      <Button key={key} plain label={tip} onPress={onPress}>
        <Text color={color} bold inverse={opts.on}>{glyph}</Text>
      </Button>
      <Box position="absolute" top={1} left={0} display="none" hover={{ display: 'flex' }}>
        <Text inverse> {tip} </Text>
      </Box>
    </Box>
  )
  const confirmStop = async (id: string, ids: string[], done: string) => {
    if (armed !== id) {
      await update($, armedStop, () => id)
      $.clock.after(4000, async () => {
        if ((await read($, armedStop)) === id) await update($, armedStop, () => null)
      })
      return
    }
    await update($, armedStop, () => null)
    await act($, `stop:${id}`, 'stop', ids.length === 1 && id !== 'all' ? { session: ids[0] } : { ids }, done)
  }

  const chip = (key: string, glyph: string, n: number, color: string, label: string) =>
    n > 0 && <Text key={key} color={color}>  {glyph} {n}<Text dimColor> {label}</Text></Text>

  const header = (
    <Box key="head" flexDirection="row" justifyContent="space-between" flexWrap="wrap">
      <Text>
        <Text bold color="claude">◆ Baton</Text>
        {chip('c-run', '●', running.length - pausedCount, 'success', 'running')}
        {chip('c-pause', '❚❚', pausedCount, 'warning', 'paused')}
        {chip('c-start', '◐', starting, 'warning', 'starting')}
        {chip('c-fail', '✕', failed, 'error', 'failed')}
      </Text>
      <Box flexDirection="row" flexWrap="wrap">
        {icon('new', newOpen && site === 'band' ? '－' : '＋', newOpen && site === 'band' ? 'Close New run' : 'New run', 'claude',
          () => (site === 'band' ? openNew($, !newOpen) : loadCatalogGuarded($)), { on: newOpen && site === 'band' })}
        {reloadable.length > 1 && icon('reload-all', '⚡︎', 'Reload all', 'warning',
          () => act($, 'reload-all', 'reload', { ids: reloadable.map(r => r.id), reason: `Claude Code ${site}` }, 'Baton: reloaded'))}
        {pausable.length > 1 && icon('pause-all', allPaused ? '▶' : '❚❚', allPaused ? 'Resume all' : 'Pause all', allPaused ? 'success' : 'warning',
          () => guarded($, 'pause-all', () => signal($, pausable.filter(r => r.paused === allPaused).map(r => r.id), !allPaused)))}
        {running.filter(r => r.canFront).length > 1 && icon('front-all', '⧉', 'Bring all to front', 'suggestion', () => guarded($, 'front-all', () => front($, running)))}
        {live.length > 1 && icon('stop-all', armed === 'all' ? `■ Stop ${live.length}?` : '■', armed === 'all' ? `Press again to stop all ${live.length}` : 'Stop all', 'error',
          () => confirmStop('all', live.map(r => r.id), 'Baton: stopped all'), { on: armed === 'all' })}
        {site === 'band' && icon('collapse', collapsed ? '▾' : '▴', collapsed ? 'Expand' : 'Collapse', 'subtle', () => update($, isCollapsed, c => !c))}
        {site === 'band' && icon('open', '⤢', 'Open in a side panel', 'subtle', () => openPanel($))}
        {site === 'band' && icon('hide', '✕', 'Hide until /baton', 'subtle', () => update($, isBandHidden, () => true))}
      </Box>
    </Box>
  )
  if (collapsed) return <Box flexDirection="column">{header}</Box>

  // New run, inline: project, target, device, Run; and boot a simulator.
  const project = cat?.projects.find(p => p.root === picks.root) ?? cat?.projects[0]
  const target = project?.targets.find(t => t.name === picks.target) ?? project?.targets[0]
  const runnable = cat?.devices.filter(d => d.running) ?? []
  const device = runnable.find(d => d.id === picks.device)
  const bootable = cat?.devices.filter(d => !d.running && d.platform !== 'other') ?? []
  const toBoot = bootable.find(d => d.id === picks.boot) ?? bootable[0]
  const pick = (patch: Form) => update($, form, f => ({ ...f, ...patch }))
  const newRow = newOpen && (
    <Box key="newrun" flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      {!cat && <Text dimColor>{working === 'catalog' ? 'Finding projects and simulators…' : 'Loading projects…'}</Text>}
      {cat && cat.projects.length === 0 && <Text dimColor>No projects yet. Ask Claude to run one and it shows here.</Text>}
      {cat && project && target && (
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2}>
          {Select ? (
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              <Select key="project" label="Project" value={project.root}
                options={cat.projects.map(p => ({ value: p.root, label: p.name }))}
                onSelect={(v: string) => pick({ root: v, target: undefined })} />
              <Select key="target" label="Target" value={target.name}
                options={project.targets.map(t => ({ value: t.name, label: `${t.name} · ${t.kind}` }))}
                onSelect={(v: string) => pick({ target: v })} />
              <Select key="device" label="On" value={device?.id ?? ''}
                options={[{ value: '', label: 'Default' }, ...runnable.map(d => ({ value: d.id, label: d.name }))]}
                onSelect={(v: string) => pick({ device: v || undefined })} />
            </Box>
          ) : (
            <Text dimColor>{project.name} · {target.name}{device ? ` · ${device.name}` : ''}  </Text>
          )}
          <Button key="run" variant="primary" label={working === 'run' ? 'Starting…' : '▶ Run'}
            onPress={() => guarded($, 'run', async () => {
              await rpc($, 'run', { cwd: project.root, target: target.name, deviceId: device?.id })
              if (site === 'band') await update($, isNewOpen, () => false)
              return `Baton: starting ${target.name}${device ? ` on ${device.name}` : ''}`
            })} />
        </Box>
      )}
      {cat && toBoot && (
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2}>
          {Select ? (
            <Select key="boot" label="Boot" value={toBoot.id}
              options={bootable.map(d => ({ value: d.id, label: d.name }))}
              onSelect={(v: string) => pick({ boot: v })} />
          ) : <Text dimColor>Boot {toBoot.name}  </Text>}
          <Button key="boot-device" dimColor label={working === 'boot' ? 'Booting…' : 'Boot'}
            onPress={() => guarded($, 'boot', async () => {
              await rpc($, 'boot', { id: toBoot.id })
              await loadCatalog($)
              return `Baton: ${toBoot.name} is booting`
            })} />
          <Button key="refresh" dimColor label={working === 'catalog' ? 'Refreshing…' : 'Refresh'} onPress={() => loadCatalogGuarded($)} />
        </Box>
      )}
    </Box>
  )

  const rows = list.map(run => {
    const can = (c: string) => run.status === 'running' && !run.paused && run.capabilities.includes(c)
    const kind = deviceKind(run)
    const state = run.paused ? 'paused' : run.status === 'running'
      ? [run.cpuPct != null ? `${Math.round(run.cpuPct)}%` : '', memory(run.rssBytes)].filter(Boolean).join(' · ')
      : run.progress ?? run.status
    const dotColor = run.paused || run.status === 'starting' ? 'warning' : COLOR[run.status]
    const full = `${run.project} · ${run.name}${run.device ? ` · ${run.device}` : ''}`
    const ended = !LIVE(run)
    const controls = (
      <Box flexDirection="row" flexWrap="wrap">
        {can('hotReload') && icon(`reload:${run.id}`, working === `reload:${run.id}` ? '…' : '⚡︎', 'Hot reload', 'warning',
          () => act($, `reload:${run.id}`, 'reload', { session: run.id, reason: `Claude Code ${site}` }, `Baton: reloaded ${shortName(run)}`))}
        {(can('hotRestart') || can('restartProcess')) && icon(`restart:${run.id}`, working === `restart:${run.id}` ? '…' : '↻', 'Restart', 'suggestion',
          () => act($, `restart:${run.id}`, 'restart', { session: run.id, reason: `Claude Code ${site}` }, `Baton: restarted ${shortName(run)}`))}
        {run.status === 'running' && run.canPause && icon(`pause:${run.id}`, run.paused ? '▶' : '❚❚', run.paused ? 'Resume' : 'Pause', run.paused ? 'success' : 'warning',
          () => guarded($, `pause:${run.id}`, () => signal($, [run.id], !run.paused)))}
        {can('screenshot') && icon(`shot:${run.id}`, working === `shot:${run.id}` ? '…' : '◉', 'Screenshot', 'merged', () => screenshot($, run))}
        {icon(`logs:${run.id}`, '☰', log?.runId === run.id ? 'Hide logs' : 'Logs', 'text',
          () => (log?.runId === run.id ? update($, logs, () => null) : loadLogs($, run.id, run.name)), { on: log?.runId === run.id })}
        {run.status === 'running' && run.canFront && icon(`front:${run.id}`, '⧉', 'Bring to front', 'suggestion', () => guarded($, `front:${run.id}`, () => front($, [run])))}
        {!ended && icon(`stop:${run.id}`, armed === run.id ? '■ Stop?' : '■', armed === run.id ? 'Press again to stop' : 'Stop', 'error',
          () => confirmStop(run.id, [run.id], `Baton: stopped ${shortName(run)}`), { on: armed === run.id })}
        {ended && run.root && icon(`again:${run.id}`, working === `again:${run.id}` ? '…' : '▶', 'Run again', 'success', () => guarded($, `again:${run.id}`, async () => {
          await rpc($, 'run', { cwd: run.root, target: run.name, deviceId: run.deviceId })
          await rpc($, 'forget', { session: run.id }).catch(() => undefined)
          return `Baton: starting ${shortName(run)} again`
        }))}
        {ended && icon(`dismiss:${run.id}`, '✕', 'Dismiss', 'subtle', () => act($, `dismiss:${run.id}`, 'forget', { session: run.id }, `Baton: dismissed ${shortName(run)}`))}
      </Box>
    )
    const glyph = Svg
      ? <Svg key={`dev:${run.id}`} source={DEVICE_SVG[kind]} alt={kind} width={14} height={14} />
      : <Text dimColor>{DEVICE_GLYPH[kind]}</Text>
    const info = (
      <Box key={`info:${run.id}`} flexDirection="row" flexGrow={1} flexShrink={1} alignItems="center" position="relative">
        <Text color={dotColor}>{run.paused ? '❚❚' : DOT[run.status]} </Text>
        {glyph}
        <Box width={wide ? 22 : undefined} flexShrink={1} marginLeft={1}>
          <Text bold={!ended} dimColor={ended} wrap="truncate-end">{shortName(run)}</Text>
        </Box>
        <Box width={wide ? 20 : undefined} flexShrink={1} marginLeft={1}>
          <Text dimColor wrap="truncate-end">{shortDevice(run)}</Text>
        </Box>
        <Box flexShrink={1} marginLeft={1}>
          <Text color={run.paused ? 'warning' : run.status === 'failed' ? 'error' : undefined} dimColor={!run.paused && run.status !== 'failed'} wrap="truncate-end">{state}</Text>
        </Box>
        <Box position="absolute" top={1} left={2} display="none" hover={{ display: 'flex' }}>
          <Text inverse> {full}{run.url ? ` · ${run.url}` : ''} </Text>
        </Box>
      </Box>
    )
    const openLog = log?.runId === run.id ? log : null
    const openShot = last?.runId === run.id ? last : null
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
        {openLog && (
          <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} marginLeft={2}>
            {openLog.lines.length === 0
              ? <Text dimColor>No output yet.</Text>
              : openLog.lines.slice(site === 'band' ? -8 : -40).map((l, i) => (
                <Text key={`l${i}`} color={l.error ? 'error' : undefined} dimColor={!l.error} wrap="truncate-end">{l.text}</Text>
              ))}
          </Box>
        )}
        {openShot && (
          <Box flexDirection="row" alignItems="flex-start" marginLeft={2}>
            {Svg && openShot.svg && <Svg key={`img:${run.id}`} source={openShot.svg} alt={`Screenshot of ${run.name}`} width={site === 'band' ? 120 : 260} />}
            <Box flexDirection="column" marginLeft={1}>
              <Text dimColor wrap="truncate-middle">{openShot.path}</Text>
              {icon(`shotclose:${run.id}`, '✕', 'Close screenshot', 'subtle', () => update($, shot, () => null))}
            </Box>
          </Box>
        )}
      </Box>
    )
  })

  return (
    <Box flexDirection="column">
      {header}
      {newRow}
      {rows}
      {list.length === 0 && <Text dimColor>No runs yet. Pick a project above and press Run, or ask Claude to run an app.</Text>}
    </Box>
  )
}

async function openNew($: Dollar, open: boolean) {
  await update($, isNewOpen, () => open)
  if (open && !(await read($, catalog))) await loadCatalogGuarded($)
}

async function loadCatalogGuarded($: Dollar) {
  await guarded($, 'catalog', async () => {
    await loadCatalog($)
    return undefined
  })
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
