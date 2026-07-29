#!/bin/sh
# Test double for the local OpenSSH process. It deliberately has no PTY, so it
# can validate framing/state/death handling but not the successful Ctrl-C path.
exec env PS1= PS2= PROMPT_COMMAND= HISTFILE=/dev/null bash --noprofile --norc
