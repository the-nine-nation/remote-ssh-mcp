import assert from "node:assert/strict";
import test from "node:test";
import { checkDenylist } from "../src/denylist.js";

test("denylist blocks the MVP destructive patterns", () => {
  for (const command of [
    "sudo rm -rf /",
    "shutdown -h now",
    "mkfs.ext4 /dev/sda",
    "iptables -F",
    "nft flush ruleset",
  ]) {
    assert.equal(checkDenylist(command).denied, true, command);
  }
});

test("denylist does not block ordinary development commands", () => {
  for (const command of [
    "rm -rf ./dist",
    "git status",
    "systemctl restart app",
    "find / -name '*.log'",
  ]) {
    assert.equal(checkDenylist(command).denied, false, command);
  }
});
