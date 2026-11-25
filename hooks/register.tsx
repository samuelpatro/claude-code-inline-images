import type { ElementTable, EngineInterface, Register, RenderElement } from 'claude-code'

/** An image to show: its own file, the small PNG drawn for it, its size in pixels. */
type Picture = { path: string; thumb: string; width: number; height: number }
type Shown = { label: string; picture: Picture }
type Cells = { columns: number; rows: number }

const MARKER = /\[Image #(\d+)\]/g
const IMAGE_PATH = /\/[^\s'"`<>|;]+\.(?:png|jpe?g|gif|webp|heic|tiff?|bmp)\b/gi
const CMUX = '/Applications/cmux.app/Contents/Resources/bin/cmux'
const MAC_CACHE = '/private/tmp/inline-images-cache'
const LINUX_CACHE = '/tmp/inline-images-cache'

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
// The narrowest card inside its border: room for a size and the open button.
const MIN_TILE = 22
const PREVIEW_TILE = 12
const MAX_IMAGES = 6
const POLL_MS = 500
// How often the paste folder is looked for until it exists: at its expected
// place, and less often anywhere under the paste roots.
const SEARCH_MS = 5000
const SCAN_MS = 30000
// Thumbnails made at once.
const LOAD_BATCH = 4

// Pictures by image path, or null when the file is gone or cannot be drawn.
// Module state: a reload of the mod starts it over.
const pictures = new Map<string, Picture | null>()
const loading = new Set<string>()
// Paths a draw asked for. A render's `$` calls end with its dispatch (a redraw
// or an interrupt aborts them), so draws only queue paths and the poll timer
// loads them.
const wanted = new Set<string>()
let isPolling = false
// This session's paste folder, the image numbers in the prompt box, and the
// highest number already sent (-1 until the first check).
let pasteFolder = ''
let draft: number[] = []
let maxSent = -1
let lastSearch = 0
let lastScan = Number.NEGATIVE_INFINITY
let sessionCwd = ''
// The folders Claude Code keeps pastes under: the same for the whole session.
let pasteRoots: string[] | undefined
// macOS has `sips` and `open`; Linux uses ImageMagick and `xdg-open`.
let isMac = true
// The thumbnail folder, made once.
let cacheReady: Promise<unknown> | undefined
// The image paths each tool row names. A draw scans a row's input again only
// when its text grew, not on every redraw.
const namedByRow = new Map<string, { size: number; paths: string[] }>()
// The first tool row that named each image file: later rows naming it again
// (a screenshot, then a Read of it) show nothing more.
const firstRow = new Map<string, string>()

export const register: Register = on => {
  // Pasted images not sent yet show above the prompt box. Claude Code saves a
  // paste at once, and mods do not hear prompt-box edits in every session, so
  // the paste folder is checked on a timer. The timer also loads the pictures
  // draws asked for.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    sessionCwd = e.cwd
    isMac = (await $.session.info()).platform === 'macos'
    $.clock.every(POLL_MS, () => void poll($))
    return result
  })

  // A `/clear` or a resume goes on under a new session id, with no
  // `session.start`: the next conversation has its own paste folder, and an
  // image it names shows again under its own row.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      firstRow.clear()
      namedByRow.clear()
      pasteFolder = ''
      draft = []
      maxSent = -1
      lastSearch = 0
      lastScan = Number.NEGATIVE_INFINITY
    }
    return next(e)
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
    const inner = { columns: Math.max(PREVIEW_TILE, limit.columns), rows: limit.rows }
    // As many cards as the band's width holds, the rest counted.
    const fits = Math.max(1, Math.floor((e.props.bodyColumns - 2 - 3 + GAP) / (inner.columns + 2 + GAP)))
    const visible = shown.slice(0, fits)
    return (
      <els.Box flexDirection="row" columnGap={GAP} paddingLeft={2}>
        {visible.map((item, i) => card(els, item, cellsOf(item.picture, limit), inner, `draft-${i}`))}
        {shown.length > visible.length && <els.Text dimColor>{`+${shown.length - visible.length}`}</els.Text>}
      </els.Box>
    )
  })

  // Your prompt rows: the pasted pictures under the text. A notification or
  // another agent's message names no paste of yours.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const row = await next(e)
    if (e.surface !== 'terminal' || e.props.task || e.props.from) return row
    const markers = markersOf(e.props.text)
    if (markers.length === 0) return row
    markSent($, markers)
    // The poll timer finds the folder and redraws.
    const folder = pasteFolder
    if (!folder) return row
    request(markers.map(n => `${folder}/${n}.png`))
    const shown = markers.flatMap(n => shownOf(`${folder}/${n}.png`, `#${n}`))
    return gallery($.ui.resolve(e), row, shown, e.viewport?.columns, actionsOf($))
  })

  // A tool call that named an image file (Claude read it, wrote it, or took a
  // screenshot into it): the pictures under its row.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const row = await next(e)
    if (e.surface !== 'terminal' || e.props.isRunning) return row
    const shown = toolImages([e.props.input], e.requestId)
    return gallery($.ui.resolve(e), row, shown, e.viewport?.columns, actionsOf($))
  })

  // A collapsed group (`Read 3 files`): the pictures of all its calls under its line.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const row = await next(e)
    if (e.surface !== 'terminal' || e.props.isExpanded || e.props.isActive) return row
    const shown = toolImages(e.props.calls.map(call => call.input), e.requestId)
    return gallery($.ui.resolve(e), row, shown, e.viewport?.columns, actionsOf($))
  })

  // A click on a picture opens it in a cmux preview tab.
  on('ui.message', async ($, e, next) => {
    const path = (e.data as { path?: unknown } | undefined)?.path
    if (!e.element.startsWith('hit-') || typeof path !== 'string') return next(e)
    void openFile($, path, true)
    return {}
  })
}

/** What a picture's buttons do, made in each hook from its own `$`. */
type Actions = { open: (path: string) => void }

function actionsOf($: EngineInterface): Actions {
  return { open: path => void openFile($, path, false) }
}

/**
 * A picture as a card drawn with box-drawing characters: its name in the top
 * border, its size and an open button in the bottom one. The picture sits
 * centered in an area of `inner` cells, under a clear click layer.
 */
function card(els: ElementTable<'terminal'>, item: Shown, box: Cells, inner: Cells, key: string, actions?: Actions): RenderElement {
  const { Box, Button, Client, Image, Text } = els
  const width = inner.columns + 2
  const title = clip(item.label, inner.columns - 3)
  const size = `${item.picture.width}×${item.picture.height}`
  // The bottom border: ╰─ size ─…─ ↗ ─╯, the size left out when it does not fit.
  const sizeText = actions && size.length + 10 <= width ? ` ${size} ` : ''
  const tail = actions ? 5 : 1
  const fill = Math.max(0, width - 2 - sizeText.length - tail)
  const side = Array.from({ length: inner.rows }, (_, i) => (
    <Text key={`side-${i}`} dimColor>
      │
    </Text>
  ))
  return (
    <Box key={`card-${key}`} flexDirection="column" width={width}>
      <Box>
        <Text dimColor>╭─</Text>
        <Text>{` ${title} `}</Text>
        <Text dimColor>{`${'─'.repeat(Math.max(0, width - 5 - title.length))}╮`}</Text>
      </Box>
      <Box>
        <Box flexDirection="column">{side}</Box>
        <Box width={inner.columns} height={inner.rows} justifyContent="center" alignItems="center">
          <Box width={box.columns} height={box.rows}>
            <Image source={{ file: item.picture.thumb, format: 'png' }} alt={`[${item.label}]`} {...box} />
            <Box position="absolute" top={0} left={0}>
              <Client key={`hit-${key}`} module="./click.ts" width={box.columns} height={box.rows} props={{ path: item.picture.path }} />
            </Box>
          </Box>
        </Box>
        <Box flexDirection="column">{side}</Box>
      </Box>
      <Box>
        <Text dimColor>{`╰─${sizeText}${'─'.repeat(fill)}`}</Text>
        {actions && (
          <Button
            key={`open-${key}`}
            label=" ↗ "
            plain
            dimColor
            hover={{ dimColor: false }}
            onPress={() => actions.open(item.picture.path)}
          />
        )}
        <Text dimColor>{actions ? '─╯' : '╯'}</Text>
      </Box>
    </Box>
  )
}

/** Shortens text in the middle to fit `width` cells. */
function clip(text: string, width: number): string {
  if (text.length <= width) return text
  if (width <= 1) return text.slice(0, Math.max(0, width))
  const head = Math.ceil((width - 1) / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - (width - 1 - head))}`
}

/**
 * The row with its pictures under it as cards, side by side. Several cards
 * share one size, the picture centered in each, so the row reads as a grid.
 */
function gallery(
  els: ElementTable<'terminal'>,
  row: RenderElement,
  shown: Shown[],
  viewportColumns: number | undefined,
  actions: Actions,
): RenderElement {
  if (shown.length === 0) return row
  const { Box, Text } = els
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
          const inner = isSingle ? { columns: Math.max(MIN_TILE, box.columns), rows: box.rows } : fit
          return card(els, item, box, inner, `image-${i}`, actions)
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
function toolImages(inputs: unknown[], requestId: string): Shown[] {
  const texts = inputs.flatMap(stringsIn)
  const size = texts.reduce((sum, text) => sum + text.length, 0)
  let named = namedByRow.get(requestId)
  if (named?.size !== size) {
    named = { size, paths: [...new Set(texts.flatMap(text => text.match(IMAGE_PATH) ?? []))] }
    namedByRow.set(requestId, named)
    for (const path of named.paths) if (!firstRow.has(path)) firstRow.set(path, requestId)
  }
  const paths = named.paths.filter(path => firstRow.get(path) === requestId)
  request(paths)
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

/** Queues the pictures not known yet for the poll timer to load. */
function request(paths: string[]): void {
  for (const path of paths) if (!pictures.has(path) && !loading.has(path)) wanted.add(path)
}

/** Loads the pictures not known yet, a few at a time, then redraws. */
async function loadPictures($: EngineInterface, paths: string[]): Promise<void> {
  const fresh = paths.filter(path => !pictures.has(path) && !loading.has(path))
  if (fresh.length === 0) return
  for (const path of fresh) loading.add(path)
  let isChanged = false
  try {
    const stats = await Promise.all(fresh.map(path => $.fs.stat(path).catch(() => undefined)))
    const files = fresh.flatMap((path, i) => {
      const stat = stats[i]
      return stat?.kind === 'file' && stat.size > 0 ? [{ path, mtimeMs: stat.mtimeMs }] : []
    })
    const sizes = await sizesOf($, files.map(file => file.path))
    const made = new Map<string, Picture | null>()
    for (let start = 0; start < files.length; start += LOAD_BATCH) {
      await Promise.all(
        files.slice(start, start + LOAD_BATCH).map(async (file, i) => {
          const size = sizes[start + i]
          made.set(file.path, size ? await pictureOf($, file.path, file.mtimeMs, size).catch(() => null) : null)
        }),
      )
    }
    for (const path of fresh) {
      const picture = made.get(path) ?? null
      // A paste not written yet is looked for again on the next draw.
      if (picture || !path.includes('/images/')) pictures.set(path, picture)
      isChanged = isChanged || picture !== null
    }
  } catch (error) {
    for (const path of fresh) if (!pictures.has(path)) pictures.set(path, null)
    $.ui.log(`inline-images: ${String(error)}`, { to: 'debug' })
  } finally {
    for (const path of fresh) loading.delete(path)
  }
  if (isChanged) $.ui.invalidate('ui.render')
}

type Size = { width: number; height: number }

/** The small PNG copy to draw for an image, made once with `sips` on macOS, ImageMagick on Linux. */
async function pictureOf($: EngineInterface, path: string, mtimeMs: number, size: Size): Promise<Picture | null> {
  const longSide = Math.max(size.width, size.height)
  if (/\.png$/i.test(path) && longSide <= THUMB_PX) return { path, thumb: path, ...size }
  const cache = isMac ? MAC_CACHE : LINUX_CACHE
  const thumb = `${cache}/${hashOf(`${path}:${mtimeMs}`)}.png`
  if (!(await $.fs.exists(thumb))) {
    cacheReady ??= $.process.run(['/bin/mkdir', '-p', cache])
    await cacheReady
    // `sips -Z` also scales up, so a small image keeps its own size. `[0]` is
    // the first frame, so an animated GIF makes one PNG and not one per frame.
    const side = String(Math.min(THUMB_PX, longSide))
    const argv = isMac
      ? ['/usr/bin/sips', '-s', 'format', 'png', '-Z', side, path, '--out', thumb]
      : ['convert', `${path}[0]`, '-thumbnail', `${side}x${side}`, thumb]
    const made = await $.process.run(argv)
    if (made.exitCode !== 0) {
      cacheReady = undefined // the folder may have been cleaned away
      return null
    }
  }
  return { path, thumb, ...size }
}

/** The pixel sizes of these image files, from one `sips` or `identify` run; undefined for a file it cannot read. */
async function sizesOf($: EngineInterface, files: string[]): Promise<(Size | undefined)[]> {
  if (files.length === 0) return []
  // `identify` prints the sizes the way `sips` does, so one pattern reads both.
  const argv = isMac
    ? ['/usr/bin/sips', '-g', 'pixelWidth', '-g', 'pixelHeight', ...files]
    : ['identify', '-ping', '-format', 'pixelWidth: %w\npixelHeight: %h\n', ...files.map(file => `${file}[0]`)]
  const { exitCode, stdout } = await $.process.run(argv)
  const found = [...stdout.matchAll(/pixelWidth: (\S+)\s+pixelHeight: (\S+)/g)]
  if (exitCode !== 0 || found.length !== files.length) {
    // `sips` leaves out a file that went missing, so the answers no longer
    // line up with the files: ask for each on its own.
    if (files.length === 1) return [undefined]
    return Promise.all(files.map(async file => (await sizesOf($, [file]))[0]))
  }
  return found.map(match => {
    const width = Number(match[1])
    const height = Number(match[2])
    return width > 0 && height > 0 ? { width, height } : undefined
  })
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
 * hand it to the default app: `open` on macOS, `xdg-open` on Linux.
 */
async function openFile($: EngineInterface, path: string, inCmux: boolean): Promise<void> {
  try {
    const clicked = inCmux ? await clickedPane($) : undefined
    if (!clicked) {
      const { exitCode, stderr } = await $.process.run([isMac ? '/usr/bin/open' : 'xdg-open', path])
      if (exitCode !== 0) $.ui.toast(`Could not open ${path.slice(path.lastIndexOf('/') + 1)}: ${stderr.trim()}`)
      return
    }
    const { workspace } = clicked
    const pane = await otherPane($, workspace, clicked.pane)
    const { exitCode, stderr } = pane
      ? await $.process.run([CMUX, 'open', path, '--workspace', workspace, '--pane', pane, '--focus', 'false'])
      : await $.process.run([CMUX, 'new-pane', '--type', 'browser', '--direction', 'right', '--workspace', workspace, '--url', `file://${path}`, '--focus', 'false'])
    if (exitCode !== 0) $.ui.toast(`Could not open ${path.slice(path.lastIndexOf('/') + 1)}: ${stderr.trim()}`)
  } catch (error) {
    $.ui.log(`inline-images: ${String(error)}`, { to: 'debug' })
  }
}

/**
 * Where the click landed: cmux's focused workspace and pane, asked at click
 * time. The CMUX_WORKSPACE_ID this process started with goes stale when its
 * tab moves to another workspace or the session is attached from elsewhere.
 */
async function clickedPane($: EngineInterface): Promise<{ workspace: string; pane: string } | undefined> {
  if ((await $.env.get('CMUX_SURFACE_ID')) === undefined || !(await $.fs.exists(CMUX))) return undefined
  const { exitCode, stdout } = await $.process.run([CMUX, 'identify', '--no-caller'])
  if (exitCode !== 0) return undefined
  const focused = (JSON.parse(stdout) as { focused?: { workspace_ref?: unknown; pane_ref?: unknown } | null }).focused
  return typeof focused?.workspace_ref === 'string' && typeof focused.pane_ref === 'string'
    ? { workspace: focused.workspace_ref, pane: focused.pane_ref }
    : undefined
}

/** A pane of the workspace other than the clicked one, docks left out. */
async function otherPane($: EngineInterface, workspace: string, clicked: string): Promise<string | undefined> {
  const listed = await $.process.run([CMUX, 'list-panes', '--workspace', workspace])
  for (const line of listed.stdout.split('\n')) {
    const ref = /pane:\d+/.exec(line)?.[0]
    if (ref && ref !== clicked && !line.includes('[dock')) return ref
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

/** Loads the pictures draws asked for, and shows the pasted images newer than the last one sent. */
async function poll($: EngineInterface): Promise<void> {
  if (isPolling) return
  isPolling = true
  try {
    if (wanted.size > 0) {
      const paths = [...wanted]
      wanted.clear()
      await loadPictures($, paths)
    }
    if (!pasteFolder) {
      const now = await $.clock.now()
      if (now - lastSearch < SEARCH_MS) return
      lastSearch = now
      pasteFolder = await pasteFolderOf($, now)
      if (!pasteFolder) {
        if (maxSent < 0) maxSent = 0 // no folder yet: nothing pasted in this session
        return
      }
      // Prompt rows drawn before the folder was known can show their pictures now.
      $.ui.invalidate('ui.render')
    }
    const folder = pasteFolder
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
  } finally {
    isPolling = false
  }
}

/**
 * Claude Code keeps pastes in <tmp>/claude-<uid>/<project>/<session>/images,
 * <tmp> being /private/tmp or the user's temp folder on macOS, /tmp on Linux,
 * the project named after the working directory. That place is checked first;
 * every project folder only now and then, for a session started elsewhere.
 */
async function pasteFolderOf($: EngineInterface, now: number): Promise<string> {
  const session = await $.session.id()
  pasteRoots ??= await pasteRootsOf($)
  const project = sessionCwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (project) {
    for (const root of pasteRoots) {
      const candidate = `${root}/${project}/${session}/images`
      if (await $.fs.exists(candidate)) return candidate
    }
  }
  if (now - lastScan < SCAN_MS) return ''
  lastScan = now
  for (const root of pasteRoots) {
    for (const entry of await $.fs.list(root).catch(() => [])) {
      const candidate = `${root}/${entry.name}/${session}/images`
      if (entry.kind === 'dir' && entry.name !== project && (await $.fs.exists(candidate))) return candidate
    }
  }
  return ''
}

async function pasteRootsOf($: EngineInterface): Promise<string[]> {
  const uid = (await $.process.run(['/usr/bin/id', '-u'])).stdout.trim()
  if (!isMac) return [`/tmp/claude-${uid}`]
  const userTmp = (await $.process.run(['/usr/bin/getconf', 'DARWIN_USER_TEMP_DIR'])).stdout.trim().replace(/\/+$/, '')
  return [`/private/tmp/claude-${uid}`, `${userTmp}/claude-${uid}`]
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
