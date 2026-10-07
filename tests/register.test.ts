import type { Args, On, RenderElement, RenderInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const FOLDER = '/private/tmp/claude-501/-Users-x/s1/images'

/** Answers the engine calls the mod makes: files, sips and the paste folder. */
function machine(on: On, runs: Args<'process.run'>[] = []) {
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.id', () => ({ value: 's1' }))
  on('fs.list', ($, e) => ({
    value: e.path === '/private/tmp/claude-501' ? [{ name: '-Users-x', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] : [],
  }))
  on('fs.exists', ($, e) => ({ value: e.path === FOLDER }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1000, mtimeMs: 1, isLink: false } }))
  on('process.run', ($, e) => {
    runs.push(e)
    const stdout =
      e.argv[0] === '/usr/bin/id' ? '501\n' : e.argv.includes('-g') ? '  pixelWidth: 1200\n  pixelHeight: 800\n' : '/var/x/\n'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

test('a pasted image draws framed under the prompt, from a small thumbnail', async ($, on) => {
  const clock = mock.clock(on)
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

  expect(await $.ui.render(input)).toEqual(ROW)
  await clock.settle()
  const drawn = JSON.stringify(await $.ui.render(input))
  expect(drawn).toContain('/private/tmp/inline-images-cache/')
  expect(drawn).toContain('"borderStyle":"round"')
  expect(drawn).toContain(`"path":"${FOLDER}/2.png"`)
  expect(drawn).toContain('1200×800')
  expect(runs.some(run => run.argv.includes('-Z') && run.argv.includes('480'))).toBe(true)
})

test('an image file shows under the first tool row that names it, not again', async ($, on) => {
  const clock = mock.clock(on)
  const TOOL_ROW: RenderElement = { type: 'Text', children: ['Read(shot.png)'] }
  on('ui.render', { component: 'ToolUse' }, () => TOOL_ROW)
  machine(on)
  const rowOf = (requestId: string) =>
    ({
      component: 'ToolUse',
      surface: 'terminal',
      requestId,
      viewport: { columns: 120, rows: 40 },
      props: { tool_use_id: requestId, tool: 'Read', input: { file_path: '/tmp/x/shot.png' }, isRunning: false, isErrored: false, isInterrupted: false },
    }) as RenderInput<'ToolUse'>

  expect(await $.ui.render(rowOf('toolu_1'))).toEqual(TOOL_ROW)
  await clock.settle()
  const first = JSON.stringify(await $.ui.render(rowOf('toolu_1')))
  expect(first).toContain('"path":"/tmp/x/shot.png"')
  expect(first).toContain('"shot.png"')
  expect(await $.ui.render(rowOf('toolu_2'))).toEqual(TOOL_ROW)
})
