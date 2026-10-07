import type { ElementTable, EngineInterface, Register, RenderElement } from 'claude-code'

/** An image to show: its own file, the small PNG drawn for it, its size in pixels. */
type Picture = { path: string; thumb: string; width: number; height: number }
type Shown = { label: string; picture: Picture }
type Cells = { columns: number; rows: number }

const MARKER = /\[Image #(\d+)\]/g
const IMAGE_PATH = /\/[^\s'"`<>|;]+\.(?:png|jpe?g|gif|webp|heic|tiff?|bmp)\b/gi
const CMUX = '/Applications/cmux.app/Contents/Resources/bin/cmux'
const CACHE = '/private/tmp/inline-images-cache'

// Terminal cells are about twice as tall as they are wide, and ~8 px wide.
const CELL_ASPECT = 0.5
const CELL_PX = 8
// Thumbnails are drawn from a copy at most this many pixels on the long side,
// so the terminal never scales a full-size screenshot on a redraw.
const THUMB_PX = 480
// Size caps for a picture, in cells: alone in a row, several side by side, and
// the preview above the prompt box. The frame adds a cell on each side.
const SINGLE: Cells = { columns: 32, rows: 8 }
const MULTI: Cells = { columns: 22, rows: 6 }
const PREVIEW: Cells = { columns: 18, rows: 5 }
const GAP = 2
// The narrowest caption: room for a size and the Open button.
const MIN_TILE = 18
const MAX_IMAGES = 6
const POLL_MS = 500
const SEARCH_MS = 5000

// Pictures by image path, or null when the file is gone or cannot be drawn.
// Module state: a reload of the mod starts it over.
const pictures = new Map<string, Picture | null>()
const loading = new Set<string>()
// This session's paste folder, the image numbers in the prompt box, and the
// highest number already sent (-1 until the first check).
let pasteFolder = ''
let draft: number[] = []
let maxSent = -1
let lastSearch = 0
// The first tool row that named each image file: later rows naming it again
// (a screenshot, then a Read of it) show nothing more.
const firstRow = new Map<string, string>()

export const register: Register = on => {
  // Pasted images not sent yet show above the prompt box. Claude Code saves a
  // paste at once, and mods do not hear prompt-box edits in every session, so
  // the paste folder is checked on a timer.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    $.clock.every(POLL_MS, () => void poll($))
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    markSent($, markersOf(e.text))
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const folder = pasteFolder
    const shown = folder ? draft.flatMap(n => shownOf(`${folder}/${n}.png`, `#${n}`)) : []
    if (e.surface !== 'terminal' || e.props.hasSurvey || shown.length === 0) return next(e)
    const els = $.ui.resolve(e)
    const limit = { columns: PREVIEW.columns, rows: Math.max(2, Math.min(PREVIEW.rows, e.props.maxRows - 3)) }
    return (
      <els.Box flexDirection="row" columnGap={GAP} paddingLeft={2}>
        {shown.map((item, i) => (
          <els.Box key={`draft-${i}`} flexDirection="column">
            {framed(els, item, cellsOf(item.picture, limit), `draft-${i}`)}
            <els.Text dimColor>{item.label}</els.Text>
          </els.Box>
        ))}
      </els.Box>
    )
  })

  // Your prompt rows: the pasted pictures under the text.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const row = await next(e)
    if (e.surface !== 'terminal') return row
    const markers = markersOf(e.props.text)
    if (markers.length === 0) return row
    markSent($, markers)
    const folder = pasteFolder || (await pasteFolderOf($))
    if (!folder) return row
    const paths = markers.map(n => `${folder}/${n}.png`)
    request($, paths)
    const shown = markers.flatMap(n => shownOf(`${folder}/${n}.png`, `#${n}`))
    return gallery($.ui.resolve(e), row, shown, e.viewport?.columns, actionsOf($))
  })

  // A tool call that named an image file (Claude read it, wrote it, or took a
  // screenshot into it): the pictures under its row.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const row = await next(e)
    if (e.surface !== 'terminal' || e.props.isRunning) return row
    const shown = toolImages($, [e.props.input], e.requestId)
    return gallery($.ui.resolve(e), row, shown, e.viewport?.columns, actionsOf($))
  })

  // A collapsed group (`Read 3 files`): the pictures of all its calls under its line.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const row = await next(e)
    if (e.surface !== 'terminal' || e.props.isExpanded || e.props.isActive) return row
    const shown = toolImages($, e.props.calls.map(call => call.input), e.requestId)
    return gallery($.ui.resolve(e), row, shown, e.viewport?.columns, actionsOf($))
  })

  // A click on a picture opens it in a cmux preview tab.
  on('ui.message', async ($, e) => {
    const path = (e.data as { path?: unknown } | undefined)?.path
    if (typeof e.element === 'string' && e.element.startsWith('hit-') && typeof path === 'string') {
      void openFile($, path, true)
    }
    return {}
  })
}

/** What a picture's buttons do, made in each hook from its own `$`. */
type Actions = { open: (path: string) => void }

function actionsOf($: EngineInterface): Actions {
  return { open: path => void openFile($, path, false) }
}

/** A picture in a thin dim frame, with a clear click layer laid over it. */
function framed(els: ElementTable<'terminal'>, item: Shown, box: Cells, key: string): RenderElement {
  const { Box, Client, Image } = els
  return (
    <Box key={`frame-${key}`} borderStyle="round" borderDimColor width={box.columns + 2} height={box.rows + 2}>
      <Image source={{ file: item.picture.thumb, format: 'png' }} alt={`[${item.label}]`} {...box} />
      <Box position="absolute" top={0} left={0}>
        <Client key={`hit-${key}`} module="./click.ts" width={box.columns} height={box.rows} props={{ path: item.picture.path }} />
      </Box>
    </Box>
  )
}

/**
 * The row with its pictures under it, side by side in tiles of one width:
 * each picture framed, its name, then its size and an Open button.
 */
function gallery(
  els: ElementTable<'terminal'>,
  row: RenderElement,
  shown: Shown[],
  viewportColumns: number | undefined,
  actions: Actions,
): RenderElement {
  if (shown.length === 0) return row
  const { Box, Button, Text } = els
  const width = (viewportColumns ?? 100) - 4
  const visible = shown.slice(0, MAX_IMAGES)
  const isSingle = visible.length === 1
  const limit = isSingle ? SINGLE : MULTI
  const fit = { columns: Math.min(limit.columns, width - 2), rows: limit.rows }
  return (
    <Box flexDirection="column">
      {row}
      <Box flexDirection="row" flexWrap="wrap" columnGap={GAP} rowGap={1} marginLeft={2} marginTop={1}>
        {visible.map((item, i) => {
          const box = cellsOf(item.picture, fit)
          const tile = Math.max(MIN_TILE, (isSingle ? box.columns : fit.columns) + 2)
          return (
            <Box key={`image-${i}`} flexDirection="column" width={tile}>
              <Box width={tile} height={(isSingle ? box.rows : fit.rows) + 2} alignItems="flex-end">
                {framed(els, item, box, `image-${i}`)}
              </Box>
              <Text dimColor wrap="truncate-middle">{item.label}</Text>
              <Box columnGap={2}>
                <Text dimColor>{`${item.picture.width}×${item.picture.height}`}</Text>
                <Button key={`open-${i}`} label="Open" plain dimColor onPress={() => actions.open(item.picture.path)} />
              </Box>
            </Box>
          )
        })}
        {shown.length > visible.length && <Text dimColor>{`+${shown.length - visible.length}`}</Text>}
      </Box>
    </Box>
  )
}

function shownOf(path: string, label: string): Shown[] {
  const picture = pictures.get(path)
  return picture ? [{ label, picture }] : []
}

/** The image files named anywhere in these tool inputs, as far as they are loaded. */
function toolImages($: EngineInterface, inputs: unknown[], requestId: string): Shown[] {
  const named = [...new Set(inputs.flatMap(input => stringsIn(input).flatMap(text => text.match(IMAGE_PATH) ?? [])))]
  for (const path of named) if (!firstRow.has(path)) firstRow.set(path, requestId)
  const paths = named.filter(path => firstRow.get(path) === requestId)
  request($, paths)
  return paths.flatMap(path => shownOf(path, path.slice(path.lastIndexOf('/') + 1)))
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsIn)
  return []
}

function markersOf(text: string): number[] {
  return [...new Set([...text.matchAll(MARKER)].map(match => Number(match[1])))]
}

/** Loads the pictures not known yet, then redraws. */
function request($: EngineInterface, paths: string[]): void {
  const missing = paths.filter(path => !pictures.has(path) && !loading.has(path))
  if (missing.length > 0) void loadPictures($, missing)
}

async function loadPictures($: EngineInterface, paths: string[]): Promise<void> {
  let isChanged = false
  for (const path of paths) {
    if (pictures.has(path) || loading.has(path)) continue
    loading.add(path)
    try {
      const picture = await pictureOf($, path)
      // A paste not written yet is looked for again on the next draw.
      if (picture || !path.includes('/images/')) pictures.set(path, picture)
      isChanged = isChanged || picture !== null
    } catch (error) {
      pictures.set(path, null)
      $.ui.log(`inline-images: ${String(error)}`, { to: 'debug' })
    } finally {
      loading.delete(path)
    }
  }
  if (isChanged) $.ui.invalidate('ui.render')
}

/** The image's size and a small PNG copy to draw, made once with macOS `sips`. */
async function pictureOf($: EngineInterface, path: string): Promise<Picture | null> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat?.kind !== 'file' || stat.size === 0) return null
  const size = await sizeOf($, path)
  if (!size) return null
  const isSmallPng = /\.png$/i.test(path) && Math.max(size.width, size.height) <= THUMB_PX
  if (isSmallPng) return { path, thumb: path, ...size }
  const thumb = `${CACHE}/${hashOf(`${path}:${stat.mtimeMs}`)}.png`
  if (!(await $.fs.exists(thumb))) {
    await $.process.run(['/bin/mkdir', '-p', CACHE])
    const made = await $.process.run(['/usr/bin/sips', '-s', 'format', 'png', '-Z', String(THUMB_PX), path, '--out', thumb])
    if (made.exitCode !== 0) return null
  }
  return { path, thumb, ...size }
}

async function sizeOf($: EngineInterface, file: string): Promise<{ width: number; height: number } | undefined> {
  const { exitCode, stdout } = await $.process.run(['/usr/bin/sips', '-g', 'pixelWidth', '-g', 'pixelHeight', file])
  const width = Number(/pixelWidth: (\d+)/.exec(stdout)?.[1])
  const height = Number(/pixelHeight: (\d+)/.exec(stdout)?.[1])
  return exitCode === 0 && width > 0 && height > 0 ? { width, height } : undefined
}

function hashOf(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

/**
 * Opens an image. In cmux, a click puts it in the split beside Claude: the
 * workspace's other pane, or a new browser split on the right when there is
 * none (later clicks reuse it). The Open button, and anywhere outside cmux,
 * hand it to the Mac's default app.
 */
async function openFile($: EngineInterface, path: string, inCmux: boolean): Promise<void> {
  try {
    const workspace = inCmux ? await $.env.get('CMUX_WORKSPACE_ID') : undefined
    const surface = inCmux ? await $.env.get('CMUX_SURFACE_ID') : undefined
    const hasCmux = workspace !== undefined && surface !== undefined && (await $.fs.exists(CMUX))
    if (!hasCmux) {
      const { exitCode, stderr } = await $.process.run(['/usr/bin/open', path])
      if (exitCode !== 0) $.ui.toast(`Could not open ${path.slice(path.lastIndexOf('/') + 1)}: ${stderr.trim()}`)
      return
    }
    const pane = await otherPane($, workspace, surface)
    const { exitCode, stderr } = pane
      ? await $.process.run([CMUX, 'open', path, '--workspace', workspace, '--pane', pane, '--focus', 'false'])
      : await $.process.run([CMUX, 'new-pane', '--type', 'browser', '--direction', 'right', '--workspace', workspace, '--url', `file://${path}`, '--focus', 'false'])
    if (exitCode !== 0) $.ui.toast(`Could not open ${path.slice(path.lastIndexOf('/') + 1)}: ${stderr.trim()}`)
  } catch (error) {
    $.ui.log(`inline-images: ${String(error)}`, { to: 'debug' })
  }
}

/** A pane of the workspace other than the one Claude runs in, docks left out. */
async function otherPane($: EngineInterface, workspace: string, surface: string): Promise<string | undefined> {
  const listed = await $.process.run([CMUX, 'list-panes', '--workspace', workspace])
  const panes = listed.stdout.split('\n').flatMap(line => {
    const ref = /pane:\d+/.exec(line)?.[0]
    return ref && !line.includes('[dock') ? [ref] : []
  })
  for (const pane of panes) {
    const surfaces = await $.process.run([CMUX, 'list-pane-surfaces', '--workspace', workspace, '--pane', pane, '--id-format', 'both'])
    if (!surfaces.stdout.includes(surface)) return pane
  }
  return undefined
}

function markSent($: EngineInterface, markers: number[]): void {
  const highest = Math.max(maxSent, ...markers)
  if (highest <= maxSent) return
  maxSent = highest
  draft = draft.filter(n => n > maxSent)
  $.ui.invalidate('ui.render')
}

/** Shows the pasted images newer than the last one sent. */
async function poll($: EngineInterface): Promise<void> {
  try {
    if (!pasteFolder) {
      const now = await $.clock.now()
      if (now - lastSearch < SEARCH_MS) return
      lastSearch = now
    }
    const folder = await pasteFolderOf($)
    if (!folder) {
      if (maxSent < 0) maxSent = 0 // no folder yet: nothing pasted in this session
      return
    }
    const numbers = (await $.fs.list(folder)).flatMap(entry => {
      const match = /^(\d+)\.png$/.exec(entry.name)
      return match ? [Number(match[1])] : []
    })
    if (maxSent < 0) {
      maxSent = Math.max(0, ...numbers)
      return
    }
    const fresh = numbers.filter(n => n > maxSent).sort((a, b) => a - b)
    if (fresh.join() === draft.join()) return
    draft = fresh
    await loadPictures($, fresh.map(n => `${folder}/${n}.png`))
    $.ui.invalidate('ui.render')
  } catch (error) {
    $.ui.log(`inline-images: ${String(error)}`, { to: 'debug' })
  }
}

/** Claude Code keeps pastes in <tmp>/claude-<uid>/<project>/<session>/images. */
async function pasteFolderOf($: EngineInterface): Promise<string> {
  if (pasteFolder) return pasteFolder
  const session = await $.session.id()
  const uid = (await $.process.run(['/usr/bin/id', '-u'])).stdout.trim()
  const userTmp = (await $.process.run(['/usr/bin/getconf', 'DARWIN_USER_TEMP_DIR'])).stdout.trim().replace(/\/+$/, '')
  for (const base of [`/private/tmp/claude-${uid}`, `${userTmp}/claude-${uid}`]) {
    for (const entry of await $.fs.list(base).catch(() => [])) {
      const candidate = `${base}/${entry.name}/${session}/images`
      if (entry.kind === 'dir' && (await $.fs.exists(candidate))) {
        pasteFolder = candidate
        return pasteFolder
      }
    }
  }
  return ''
}

/** The largest box of cells that keeps the picture's shape within the limits. */
function cellsOf(picture: Picture, limit: Cells): Cells {
  const rowsPerColumn = (picture.height / picture.width) * CELL_ASPECT
  let columns = Math.max(4, Math.min(limit.columns, Math.ceil(picture.width / CELL_PX)))
  let rows = Math.max(1, Math.round(columns * rowsPerColumn))
  if (rows > limit.rows) {
    rows = limit.rows
    columns = Math.max(1, Math.round(rows / rowsPerColumn))
  }
  return { columns: Math.min(columns, 255), rows: Math.min(rows, 255) }
}
