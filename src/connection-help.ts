/** Suggestions only: OpenSSH remains responsible for authentication and trust. */
export function connectionHelp(message: string): { reason: string; hint: string } {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(message)) {
    return { reason: "host_key_changed", hint: "Verify the server fingerprint with its administrator before updating known_hosts in your local terminal." };
  }
  if (/host key verification failed|no .* host key is known/i.test(message)) {
    return { reason: "host_key_untrusted", hint: "Connect to this alias in your local terminal using the same SSH config, verify the fingerprint, and trust the host before retrying ssh_open." };
  }
  if (/permission denied.*(?:publickey|password|keyboard-interactive)|authentication failed|too many authentication failures/i.test(message)) {
    return { reason: "authentication_failed", hint: "Check the configured User and SSH agent in your local terminal. Confirm this alias works with BatchMode=yes and the same SSH config; never send passwords or private keys to MCP." };
  }
  if (/could not resolve hostname|name or service not known/i.test(message)) {
    return { reason: "hostname_unresolved", hint: "Check HostName in the selected SSH config and your DNS/VPN connection. After editing aliases, call ssh_hosts(reload=true)." };
  }
  if (/connection refused|no route to host|network is unreachable/i.test(message)) {
    return { reason: "host_unreachable", hint: "Check the server, SSH port, VPN, firewall, and any ProxyJump host, then retry ssh_open." };
  }
  if (/timed out|handshake exceeded/i.test(message)) {
    return { reason: "connection_timeout", hint: "Check connectivity and ProxyJump first. Confirm the remote account can start Bash; increase SSH_MCP_OPEN_TIMEOUT_SEC only if the connection is working but slow." };
  }
  if (/spawn .*ENOENT/i.test(message)) {
    return { reason: "ssh_not_found", hint: "Install the OpenSSH client or set SSH_MCP_SSH_PATH to its executable, then restart MCP." };
  }
  if (/can't open user config file|cannot open.*config/i.test(message)) {
    return { reason: "ssh_config_unreadable", hint: "Check that SSH_MCP_SSH_CONFIG or sshConfigPath points to a readable SSH config file." };
  }
  return { reason: "connection_failed", hint: "Test this alias in your local terminal with the same SSH config and BatchMode=yes. The remote account needs Bash, base64, stty, and a writable /tmp directory." };
}
