# condash xterm shell integration — OSC 133 semantic prompts (bash).
#
# Source from ~/.bashrc:
#     [[ -f /path/to/condash/integrations/osc133.bash ]] \
#         && source /path/to/condash/integrations/osc133.bash
#
# Emits OSC 133 sequences around the prompt:
#   ESC ] 133 ; A BEL              — prompt start
#   ESC ] 133 ; B BEL              — prompt end / input begins
#   ESC ] 133 ; C BEL              — command start (output begins)
#   ESC ] 133 ; D ; <exit> BEL     — command end + exit code
# And cwd via OSC 7 so the tab label can show the current directory:
#   ESC ] 7 ; file://host/path BEL
#
# Colours the gutter mark of each prompt in condash by exit code:
# green = 0, red = non-zero.

if [[ -n "$BASH_VERSION" ]]; then
    __condash_osc133_emit_cwd() {
        local cwd
        printf -v cwd '%s' "$PWD"
        # rudimentary percent-encoding for spaces, the rest stays as-is.
        printf '\e]7;file://%s%s\a' "$HOSTNAME" "${cwd// /%20}"
    }

    __condash_osc133_pre_cmd() {
        local last_exit=$?
        # Close the previous command (if any).
        if [[ -n "$__condash_osc133_started" ]]; then
            printf '\e]133;D;%d\a' "$last_exit"
        fi
        __condash_osc133_emit_cwd
        printf '\e]133;A\a'
        __condash_osc133_started=1
    }

    __condash_osc133_pre_exec() {
        printf '\e]133;C\a'
    }

    # PROMPT_COMMAND fires before each prompt; trap DEBUG fires before each
    # command. Together they bracket the prompt + command lifecycle.
    if [[ -z "$__condash_osc133_installed" ]]; then
        PROMPT_COMMAND="__condash_osc133_pre_cmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
        # Emit B (prompt end) right before PS1 actually paints, by appending
        # the OSC sequence to PS1.
        PS1="\[\e]133;B\a\]$PS1"
        trap '__condash_osc133_pre_exec' DEBUG
        __condash_osc133_installed=1
    fi
fi
