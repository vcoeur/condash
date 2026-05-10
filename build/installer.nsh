; Custom electron-builder NSIS hook — append the install directory to
; the per-user PATH so `condash` and `condash-cli` are reachable from any
; shell, matching Linux's /usr/bin/condash[-cli] symlinks. See GitHub
; issue #119.
;
; Implementation notes:
;
; - electron-builder defaults are oneClick=true, perMachine=false → per-user
;   install. Per-user PATH lives at HKCU\Environment\PATH and needs no
;   admin token. If a future release switches to perMachine, this hook
;   needs the HKLM equivalent under
;   "System\CurrentControlSet\Control\Session Manager\Environment".
;
; - electron-builder builds NSIS with warnings-as-errors. StrFunc.nsh's
;   `${StrStr}` / `${UnStrRep}` declarations emit Function definitions
;   that NSIS reports as "not referenced" (warning 6010), so we avoid
;   StrFunc entirely. The substring scan below uses only built-in
;   StrCpy/IntOp/StrCmp + LogicLib's `${If}`.
;
; - customUnInstall is intentionally a no-op. Reliable substring removal
;   in pure NSIS without a string-helper plugin adds significant code
;   without much payoff: stale PATH entries pointing at a deleted dir
;   are harmless on Windows (the loader ignores them), and the install
;   side dedups so reinstalls don't accumulate duplicates.

!include "LogicLib.nsh"
!include "WinMessages.nsh"

!macro customInstall
  Push $0  ; current PATH
  Push $1  ; INSTDIR length
  Push $2  ; PATH length
  Push $3  ; scan offset
  Push $4  ; current slice
  Push $5  ; "found" flag

  ReadRegStr $0 HKCU "Environment" "PATH"
  StrLen $1 "$INSTDIR"

  ${If} $0 == ""
    WriteRegExpandStr HKCU "Environment" "PATH" "$INSTDIR"
  ${Else}
    StrLen $2 $0
    StrCpy $5 ""
    StrCpy $3 0
    condash_path_scan:
      IntCmp $3 $2 0 0 condash_path_done
      StrCpy $4 $0 $1 $3
      StrCmp $4 "$INSTDIR" condash_path_found
      IntOp $3 $3 + 1
      Goto condash_path_scan
    condash_path_found:
      StrCpy $5 "1"
    condash_path_done:
    ${If} $5 == ""
      WriteRegExpandStr HKCU "Environment" "PATH" "$0;$INSTDIR"
    ${EndIf}
  ${EndIf}

  ; Broadcast WM_SETTINGCHANGE so already-running shells / Explorer pick
  ; up the new PATH without a logoff.
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000

  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

