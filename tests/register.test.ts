import type { Args, On, RenderElement, RenderInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const MAC = { platform: 'macos', root: '/private/tmp/claude-501', uid: '501' } as const
// TMPDIR as libpam-tmpdir sets it, with the trailing slash it may carry.
const LINUX = { platform: 'linux', root: '/tmp/user/1000/claude-1000', uid: '1000', tmpdir: '/tmp/user/1000/' } as const
const FOLDER = `${MAC.root}/-Users-x/s1/images`

/** Answers the engine calls the mod makes: files, sips or ImageMagick, and the paste folder. */
function machine(on: On, runs: Args<'process.run'>[] = [], host: typeof MAC | typeof LINUX = MAC) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.info', () => ({ value: { transcriptPath: '/tmp/t.jsonl', platform: host.platform } }))
  on('env.get', ($, e) => ({ value: e.name === 'TMPDIR' && 'tmpdir' in host ? host.tmpdir : undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.id', () => ({ value: 's1' }))
  on('fs.list', ($, e) => ({
    value: e.path === host.root ? [{ name: '-Users-x', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] : [],
  }))
  on('fs.exists', ($, e) => ({ value: e.path === `${host.root}/-Users-x/s1/images` }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1000, mtimeMs: 1, isLink: false } }))
  on('process.run', ($, e) => {
    runs.push(e)
    // `sips -g pixelWidth -g pixelHeight <files>` answers one block per file,
    // and `identify -ping -format <format> <files>` one line pair per file.
    const sips = e.argv.slice(5).map(file => `${file}\n  pixelWidth: 1200\n  pixelHeight: 800\n`).join('')
    const identify = e.argv.slice(4).map(() => 'pixelWidth: 1200\npixelHeight: 800\n').join('')
    const stdout = e.argv[0] === '/usr/bin/id' ? `${host.uid}\n` : e.argv.includes('-g') ? sips : e.argv[0] === 'identify' ? identify : '/var/x/\n'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

const START = { cwd: '/Users/x', surface: 'terminal', isInteractive: true } as const

test('a pasted image draws framed under the prompt, from a small thumbnail', async ($, on) => {
  // Past the paste-folder search interval, so the first poll looks for it.
  const clock = mock.clock(on, { now: 10_000 })
  const runs: Args<'process.run'>[] = []
  const ROW: RenderElement = { type: 'Text', children: ['> [Image #2] look'] }
  on('ui.render', { component: 'UserMessage' }, () => ROW)
  machine(on, runs)
  const input = {
    component: 'UserMessage',
    surface: 'terminal',
    requestId: 'm1',
    viewport: { columns: 120, rows: 40 },
    props: { text: '[Image #2] look', origin: { kind: 'composer' }, isExpanded: false },
  } as RenderInput<'UserMessage'>

  await $.session.start(START)
  expect(await $.ui.render(input)).toMatchObject(ROW)
  // The timer finds the paste folder and asks for a redraw, which queues the
  // picture for the next tick.
  await clock.advance(500)
  expect(await $.ui.render(input)).toMatchObject(ROW)
  await clock.advance(500)
  const drawn = JSON.stringify(await $.ui.render(input))
  expect(drawn).toContain('/private/tmp/inline-images-cache/')
  expect(drawn).toContain("╭─")
  expect(drawn).toContain(`"path":"${FOLDER}/2.png"`)
  expect(drawn).toContain('1200×800')
  expect(runs.some(run => run.argv.includes('-Z') && run.argv.includes('480'))).toBe(true)
})

test('an image file shows under the first tool row that names it, not again', async ($, on) => {
  const clock = mock.clock(on)
  const runs: Args<'process.run'>[] = []
  const TOOL_ROW: RenderElement = { type: 'Text', children: ['Read(shot.png)'] }
  on('ui.render', { component: 'ToolUse' }, () => TOOL_ROW)
  machine(on, runs)
  const rowOf = (requestId: string) =>
    ({
      component: 'ToolUse',
      surface: 'terminal',
      requestId,
      viewport: { columns: 120, rows: 40 },
      props: { tool_use_id: requestId, tool: 'Read', input: { file_path: '/tmp/x/shot.png' }, isRunning: false, isErrored: false, isInterrupted: false },
    }) as RenderInput<'ToolUse'>

  await $.session.start(START)
  expect(await $.ui.render(rowOf('toolu_1'))).toMatchObject(TOOL_ROW)
  // A draw only queues the picture: no process runs in its dispatch, which a
  // redraw or an interrupt would abort.
  await clock.settle()
  expect(runs).toEqual([])
  await clock.advance(500)
  const first = JSON.stringify(await $.ui.render(rowOf('toolu_1')))
  expect(first).toContain('"path":"/tmp/x/shot.png"')
  expect(first).toContain(" shot.png ")
  expect(await $.ui.render(rowOf('toolu_2'))).toMatchObject(TOOL_ROW)

  // After a /clear the next conversation shows the image again.
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as Args<'session.end'>)
  expect(JSON.stringify(await $.ui.render(rowOf('toolu_2')))).toContain('"path":"/tmp/x/shot.png"')
})

test('several images in one tool call are sized by a single sips run', async ($, on) => {
  const clock = mock.clock(on)
  const runs: Args<'process.run'>[] = []
  on('ui.render', { component: 'ToolUse' }, () => ({ type: 'Text', children: ['Bash(compare)'] }))
  machine(on, runs)
  const input = {
    component: 'ToolUse',
    surface: 'terminal',
    requestId: 'toolu_3',
    viewport: { columns: 120, rows: 40, isFullscreen: true },
    props: { tool_use_id: 'toolu_3', tool: 'Bash', input: { command: 'compare /tmp/y/a.png /tmp/y/b.jpg /tmp/y/c.webp' }, isRunning: false, isErrored: false, isInterrupted: false },
  } as RenderInput<'ToolUse'>

  await $.session.start(START)
  await $.ui.render(input)
  await clock.advance(500)
  const drawn = JSON.stringify(await $.ui.render(input))
  for (const name of ['a.png', 'b.jpg', 'c.webp']) expect(drawn).toContain(`"path":"/tmp/y/${name}"`)
  expect(runs.filter(run => run.argv.includes('-g')).length).toBe(1)
  expect(runs.filter(run => run.argv.includes('-Z')).length).toBe(3)
})

test('on Linux a paste is found under TMPDIR and drawn from an ImageMagick thumbnail', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  const runs: Args<'process.run'>[] = []
  const ROW: RenderElement = { type: 'Text', children: ['> [Image #1] look'] }
  on('ui.render', { component: 'UserMessage' }, () => ROW)
  machine(on, runs, LINUX)
  const input = {
    component: 'UserMessage',
    surface: 'terminal',
    requestId: 'm1',
    viewport: { columns: 120, rows: 40 },
    props: { text: '[Image #1] look', origin: { kind: 'composer' }, isExpanded: false },
  } as RenderInput<'UserMessage'>

  await $.session.start(START)
  await $.ui.render(input)
  await clock.advance(500)
  await $.ui.render(input)
  await clock.advance(500)
  const drawn = JSON.stringify(await $.ui.render(input))
  expect(drawn).toContain('"file":"/tmp/inline-images-cache/')
  expect(drawn).toContain(`"path":"${LINUX.root}/-Users-x/s1/images/1.png"`)
  expect(drawn).toContain('1200×800')
  expect(runs.some(run => run.argv[0] === 'identify' && run.argv.includes(`${LINUX.root}/-Users-x/s1/images/1.png[0]`))).toBe(true)
  expect(runs.some(run => run.argv[0] === 'convert' && run.argv.includes('480x480'))).toBe(true)
  expect(runs.some(run => run.argv[0] === '/usr/bin/sips' || run.argv[0] === '/usr/bin/getconf')).toBe(false)
})
