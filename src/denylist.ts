export interface DenyDecision {
  denied: boolean;
  rule?: string;
}

const RULES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  {
    name: "destructive root deletion",
    pattern:
      /(?:^|[;&|]\s*)(?:sudo\s+)?rm\s+(?:(?:-[A-Za-z]*[rf][A-Za-z]*|--recursive|--force)\s+)+(?:--\s+)?\/(?:\s|$|[;&|])/i,
  },
  {
    name: "machine power control",
    pattern:
      /(?:^|[;&|]\s*)(?:sudo\s+)?(?:shutdown|reboot|poweroff|halt)(?:\s|$)/i,
  },
  {
    name: "filesystem formatting",
    pattern: /(?:^|[;&|]\s*)(?:sudo\s+)?mkfs(?:\.[A-Za-z0-9_-]+)?(?:\s|$)/i,
  },
  {
    name: "firewall flush",
    pattern:
      /(?:^|[;&|]\s*)(?:sudo\s+)?(?:iptables\s+(?:-[A-Z]*F[A-Z]*|--flush)|nft\s+flush\s+ruleset)(?:\s|$)/i,
  },
];

export function checkDenylist(command: string): DenyDecision {
  for (const rule of RULES) {
    if (rule.pattern.test(command)) {
      return { denied: true, rule: rule.name };
    }
  }
  return { denied: false };
}
