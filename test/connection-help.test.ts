import assert from "node:assert/strict";
import test from "node:test";
import { connectionHelp } from "../src/connection-help.js";

test("connection guidance distinguishes trust, authentication, network and setup failures", () => {
  const cases = [
    ["REMOTE HOST IDENTIFICATION HAS CHANGED! Host key verification failed.", "host_key_changed"],
    ["Host key verification failed.", "host_key_untrusted"],
    ["Permission denied (publickey).", "authentication_failed"],
    ["Could not resolve hostname prod", "hostname_unresolved"],
    ["Connection refused", "host_unreachable"],
    ["SSH connection or shell handshake exceeded 20s", "connection_timeout"],
    ["spawn /missing/ssh ENOENT", "ssh_not_found"],
    ["Can't open user config file /missing: No such file or directory", "ssh_config_unreadable"],
    ["SSH process exited with code 255", "connection_failed"],
  ];
  for (const [message, reason] of cases) {
    const help = connectionHelp(message!);
    assert.equal(help.reason, reason);
    assert.ok(help.hint.length > 0);
    assert.doesNotMatch(help.hint, /StrictHostKeyChecking=no/);
  }
});
