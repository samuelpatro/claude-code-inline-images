# inline-images

A Claude Code mod that shows images right in the terminal chat.

- **Pasted images** show under the prompt that carried them, in place of a bare `[Image #N]`.
- **While you type**, images you pasted but have not sent yet show above the prompt box.
- **Images Claude works on** (a file it reads or writes, a screenshot a command saves) show under that tool call. A collapsed group like `Read 3 files` shows them side by side.

Each picture sits in a thin frame with its name, its size and an **Open** button. Click a picture to open it in the split beside Claude in cmux (a new browser split on the right if there is none). **Open** hands it to your default image app.

## Requirements

- Claude Code 2.1.287 or later (mods are on by default)
- macOS: images are sized and converted with the built-in `sips`
- A terminal that speaks the kitty graphics protocol: Ghostty, kitty, or cmux

Claude Code only draws pictures in terminals it recognizes by name. In cmux (and other Ghostty-based terminals) turn them on in `~/.claude/settings.json`, then start a new session:

```json
{ "env": { "CLAUDE_CODE_FORCE_TERMINAL_IMAGES": "1" } }
```

Without it, each picture shows its alt text, such as `[#3]`.

## Install

In Claude Code:

```
/plugin marketplace add samuelpatro/claude-code-inline-images
/plugin install inline-images@claude-code-inline-images
```

Or load a clone for one session:

```sh
git clone https://github.com/samuelpatro/claude-code-inline-images.git
claude --plugin-dir ./claude-code-inline-images
```

## How it works

- Claude Code saves every pasted image as `<tmp>/claude-<uid>/<project>/<session>/images/<n>.png`. The mod reads those files, so pasted images keep their full quality.
- The mod checks that folder twice a second for images newer than the last one you sent, and shows them above the prompt box. Mods do not hear prompt box edits in every session, so a timer is the reliable way.
- Tool images are found by any image path in a tool call's input (`.png`, `.jpg`, `.gif`, `.webp`, `.heic`, `.tiff`, `.bmp`). An image shows only under the first row that names it.
- Every picture is drawn from a copy at most 480 px on its long side, made once with `sips` and kept in `/private/tmp/inline-images-cache`. The terminal never has to scale a full-size screenshot while you scroll.

Size limits are the `SINGLE`, `MULTI` and `PREVIEW` values at the top of `hooks/register.tsx`, in terminal cells.

## Develop

```sh
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

[MIT](LICENSE)
