/**
 * Exec-guard policy — pure, deterministic, I/O-free.
 *
 * Realizes the (quarantined) Tech Spec 05 command-whitelist intent as plugin-local
 * policy. NOTE on honesty: the blockedCommands denylist is DEFENSE-IN-DEPTH /
 * observability, NOT a security guarantee — substring matching has false positives
 * and negatives. The REAL boundary is: execFile with shell:false (argv never reaches
 * a shell) + a fail-closed master switch (allowShell, default OFF) + an exact-match
 * executable allowlist + rejection of shell-control metacharacters.
 *
 * Policy lives here (plugin-local), not in @openstarry/core or the frozen SDK, so the
 * microkernel stays pure and no frozen interface is touched.
 */

export interface ExecGuardPolicy {
  /** Master switch. Default OFF — when false the tool denies every invocation. */
  allowShell: boolean;
  /** Exact executable names permitted (e.g. ["node", "git"]). Empty = nothing allowed. */
  allowedCommands: string[];
  /** Defense-in-depth substring denylist checked against the joined command line. */
  blockedCommands: string[];
  /** Reject invocations with more than this many args. */
  maxArgs: number;
  /** execFile timeout (ms) so a hung child cannot wedge the agent. */
  timeoutMs: number;
}

export const DEFAULT_EXEC_GUARD_POLICY: ExecGuardPolicy = {
  allowShell: false,
  allowedCommands: [],
  blockedCommands: [
    "rm -rf",
    "rm -fr",
    "mkfs",
    "sudo",
    "curl|sh",
    "wget|sh",
    ":(){",
    "format ",
    "del /f",
    "shutdown",
  ],
  maxArgs: 64,
  timeoutMs: 10000,
};

export function resolvePolicy(cfg?: Partial<ExecGuardPolicy>): ExecGuardPolicy {
  return { ...DEFAULT_EXEC_GUARD_POLICY, ...(cfg ?? {}) };
}

/** Shell-control / injection metacharacters. Rejected in the command and every arg. */
const CONNECTORS = /(&&|\|\||\||;|`|\$\(|>|<|\n|\r|&)/;

export function hasConnectorInjection(s: string): boolean {
  return CONNECTORS.test(s);
}

export type ExecVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Decide whether `command` + `args` may run under `p`. Pure: same input → same output,
 * no I/O. Order: master switch → arg-count → injection → denylist → allowlist.
 */
export function evaluate(command: string, args: string[], p: ExecGuardPolicy): ExecVerdict {
  if (!p.allowShell) {
    return { ok: false, reason: "command execution disabled (allowShell=false)" };
  }
  if (args.length > p.maxArgs) {
    return { ok: false, reason: `too many args (${args.length} > ${p.maxArgs})` };
  }
  for (const token of [command, ...args]) {
    if (hasConnectorInjection(token)) {
      return { ok: false, reason: `shell-control/injection token in '${token}'` };
    }
  }
  const joined = [command, ...args].join(" ").toLowerCase();
  for (const blocked of p.blockedCommands) {
    if (joined.includes(blocked.toLowerCase())) {
      return { ok: false, reason: `matches denylist entry '${blocked}'` };
    }
  }
  if (!p.allowedCommands.includes(command)) {
    return { ok: false, reason: `command '${command}' not in allowlist` };
  }
  return { ok: true };
}
