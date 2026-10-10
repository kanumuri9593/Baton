import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Run, Shot } from '../types'

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
}
type Device = { id: string; name: string }
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

export function toRun(s: Snapshot, devices: Map<string, string>): Run {
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
    url: s.url,
    progress: s.progress,
    cpuPct: s.cpuPct,
    rssBytes: s.rssBytes,
    capabilities: s.capabilities ?? [],
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
    const view = list.map(s => toRun(s, devices))
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'baton', description: 'Open the Baton panel: live runs, simulators and screenshots' })
    await poll($)
    $.clock.every(POLL_MS, () => poll($))
    return next(e)
  })

  on('command.run', { command: 'baton' }, async $ => {
    await update($, isBandHidden, () => false)
    await $.ui.open({ id: PANE, title: 'Baton' })
    return { text: 'Baton panel opened.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, runs)
    const live = list.filter(r => r.status === 'running' || r.status === 'starting' || r.status === 'failed')
    if (e.props.hasSurvey || live.length === 0 || (await read($, isBandHidden))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const working = await read($, busy)
    const reloadable = live.filter(r => r.status === 'running' && r.capabilities.includes('hotReload'))
    const shown = live.slice(0, 4)

    return (
      <Box flexDirection="column">
        <Box flexWrap="wrap">
          <Text bold color="claude">Baton </Text>
          {shown.map(run => (
            <Text key={run.id}>
              <Text color={COLOR[run.status]}>{DOT[run.status]} </Text>
              {label(run)}
              <Text dimColor>{run.status === 'running' ? '  ' : ` ${run.progress ?? run.status}  `}</Text>
            </Text>
          ))}
          {live.length > shown.length && <Text dimColor>+{live.length - shown.length} more  </Text>}
        </Box>
        <Box>
          {reloadable.length > 0 && (
            <Button
              key="reload-all"
              label={working === 'reload-all' ? 'Reloading…' : `Reload ${reloadable.length === 1 ? '' : 'all '}`.trim()}
              onPress={() => act($, 'reload-all', 'reload', { ids: reloadable.map(r => r.id), reason: 'Claude Code band' }, 'Baton: reloaded')}
            />
          )}
          <Button key="open" label="Open Baton" onPress={() => $.ui.open({ id: PANE, title: 'Baton' })} />
          <Button key="hide" label="Hide" onPress={() => update($, isBandHidden, () => true)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, runs)
    const online = await read($, isOnline)
    const working = await read($, busy)
    const last = await read($, shot)
    const lastRun = last ? list.find(r => r.id === last.runId) : undefined
    const Svg = e.surface === 'desktop' ? ($.ui.resolve(e) as { Svg?: any }).Svg : undefined

    if (!online) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Baton isn't running yet.</Text>
          <Text dimColor>Ask Claude to run your app, or run `baton app`.</Text>
        </Box>
      )
    }
    if (list.length === 0) {
      return <Text dimColor>No runs yet. Ask Claude to run an app and it shows here.</Text>
    }

    return (
      <Box flexDirection="column">
        {list.map(run => {
          const can = (c: string) => run.status === 'running' && run.capabilities.includes(c)
          const stats = [run.cpuPct != null ? `${Math.round(run.cpuPct)}% CPU` : '', memory(run.rssBytes)].filter(Boolean).join(' · ')
          return (
            <Box key={run.id} flexDirection="column">
              <Text>
                <Text color={COLOR[run.status]}>{DOT[run.status]} </Text>
                <Text bold>{run.name}</Text>
                <Text dimColor>  {run.project} · {run.kind}{run.device ? ` · ${run.device}` : ''}</Text>
              </Text>
              <Text dimColor>
                {'  '}
                {run.status === 'running' ? stats || 'running' : run.progress ?? run.status}
                {run.url ? `  ${run.url}` : ''}
              </Text>
              <Box>
                {can('hotReload') && (
                  <Button key={`reload:${run.id}`} label={working === `reload:${run.id}` ? 'Reloading…' : 'Reload'}
                    onPress={() => act($, `reload:${run.id}`, 'reload', { session: run.id, reason: 'Claude Code panel' }, `Baton: reloaded ${run.name}`)} />
                )}
                {(can('hotRestart') || can('restartProcess')) && (
                  <Button key={`restart:${run.id}`} label={working === `restart:${run.id}` ? 'Restarting…' : 'Restart'}
                    onPress={() => act($, `restart:${run.id}`, 'restart', { session: run.id, reason: 'Claude Code panel' }, `Baton: restarted ${run.name}`)} />
                )}
                {can('screenshot') && (
                  <Button key={`shot:${run.id}`} label={working === `shot:${run.id}` ? 'Capturing…' : 'Screenshot'}
                    onPress={() => screenshot($, run)} />
                )}
                {(run.status === 'running' || run.status === 'starting') && (
                  <Button key={`stop:${run.id}`} label="Stop"
                    onPress={() => act($, `stop:${run.id}`, 'stop', { session: run.id }, `Baton: stopped ${run.name}`)} />
                )}
              </Box>
            </Box>
          )
        })}
        {last && (
          <Box flexDirection="column">
            <Text dimColor>Last screenshot{lastRun ? ` · ${lastRun.name}` : ''}: {last.path}</Text>
            {Svg && last.svg && <Svg key="shot" source={last.svg} alt={`Screenshot of ${lastRun?.name ?? 'the app'}`} width={260} />}
          </Box>
        )}
      </Box>
    )
  })
}
