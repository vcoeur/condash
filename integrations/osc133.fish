# condash xterm shell integration — OSC 133 semantic prompts (fish).
#
# Source from ~/.config/fish/config.fish:
#     test -f /path/to/condash/integrations/osc133.fish; \
#         and source /path/to/condash/integrations/osc133.fish

if status is-interactive
    function __condash_osc133_emit_cwd --on-variable PWD
        printf '\e]7;file://%s%s\a' (hostname) (string replace -a ' ' '%20' -- "$PWD")
    end

    function __condash_osc133_preexec --on-event fish_preexec
        printf '\e]133;C\a'
    end

    function __condash_osc133_postexec --on-event fish_postexec
        printf '\e]133;D;%d\a' $status
    end

    function __condash_osc133_prompt
        printf '\e]133;A\a'
        __condash_osc133_emit_cwd
    end

    if not set -q __condash_osc133_installed
        functions -c fish_prompt __condash_osc133_orig_prompt 2>/dev/null
        function fish_prompt
            __condash_osc133_prompt
            if functions -q __condash_osc133_orig_prompt
                __condash_osc133_orig_prompt
            end
            printf '\e]133;B\a'
        end
        set -g __condash_osc133_installed 1
    end
end
