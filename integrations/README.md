# condash terminal shell integration

Drop-in shell snippets that make condash's xterm tabs render **semantic
prompts**: a coloured gutter mark next to each prompt boundary (green = exit 0,
red = non-zero) and `Ctrl+Up` / `Ctrl+Down` to jump between prompts.

The snippets emit two standard OSC sequences:

- **OSC 133** — prompt boundary protocol (used by iTerm2, WezTerm, kitty,
  Warp). condash's xterm parses `A` (prompt-start), `B` (prompt-end), `C`
  (command-start), `D;<exit>` (command-end with exit code).
- **OSC 7** — current working directory (`file://host/path`). condash uses it
  to label the tab with the cwd basename (e.g. `condash`, `notes`) instead of
  the static spawn-time label.

## Install

Pick the file matching your shell and source it from your rc:

### bash — `~/.bashrc`

```bash
[[ -f /path/to/condash/integrations/osc133.bash ]] \
    && source /path/to/condash/integrations/osc133.bash
```

### zsh — `~/.zshrc`

```zsh
[[ -f /path/to/condash/integrations/osc133.zsh ]] \
    && source /path/to/condash/integrations/osc133.zsh
```

### fish — `~/.config/fish/config.fish`

```fish
test -f /path/to/condash/integrations/osc133.fish; \
    and source /path/to/condash/integrations/osc133.fish
```

If the snippets are sourced from a non-condash terminal they print invisible
escape sequences only — they do not modify the prompt's visible appearance.

## Verifying

After re-sourcing the rc, run `printf '\e]133;A\a'` — condash should paint a
small accent-coloured gutter mark on that line. Run `false` and you should see
the gutter mark for the next prompt switch to red.
