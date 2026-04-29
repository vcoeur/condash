# condash xterm shell integration — OSC 133 semantic prompts (zsh).
#
# Source from ~/.zshrc:
#     [[ -f /path/to/condash/integrations/osc133.zsh ]] \
#         && source /path/to/condash/integrations/osc133.zsh
#
# Emits OSC 133 sequences around the prompt + OSC 7 cwd. See osc133.bash for
# the protocol summary.

if [[ -n "$ZSH_VERSION" ]]; then
    __condash_osc133_emit_cwd() {
        printf '\e]7;file://%s%s\a' "$HOST" "${PWD// /%20}"
    }

    __condash_osc133_precmd() {
        local last_exit=$?
        if [[ -n "$__condash_osc133_started" ]]; then
            printf '\e]133;D;%d\a' "$last_exit"
        fi
        __condash_osc133_emit_cwd
        printf '\e]133;A\a'
        __condash_osc133_started=1
    }

    __condash_osc133_preexec() {
        printf '\e]133;C\a'
    }

    if [[ -z "$__condash_osc133_installed" ]]; then
        autoload -Uz add-zsh-hook
        add-zsh-hook precmd __condash_osc133_precmd
        add-zsh-hook preexec __condash_osc133_preexec
        # Append B (prompt end) to PROMPT so it fires immediately before the
        # cursor reaches the input position.
        PROMPT="$PROMPT"$'\e]133;B\a'
        __condash_osc133_installed=1
    fi
fi
