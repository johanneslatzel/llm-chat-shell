# Configuration

Permission settings load from a strict-JSON config file pointed to by the
`LLM_CHAT_SHELL_CONFIG` environment variable (see [Environment Variables](env.md)).
When the variable is unset, defaults apply: `defaultPermission` `deny`, `defaultType`
`command`, `defaultAccess` `read`, no rules, no per-workspace overrides.

The file is strict JSON (no comments). An unreadable file, invalid JSON, or an invalid
shape makes `ShellConfiguration` throw at construction; it never silently falls back to
permissive defaults.

## Sections

- `globalPermissions`: the global settings as a full `{ "defaultPermission", "defaultType", "defaultAccess", "permissionRules" }` set (defaults: `"deny"`, `"command"`, `"read"`, `[]`)
- `workspacePermissions`: an object keyed by resolved workspace root path, each value a full `{ "defaultPermission", "defaultType", "defaultAccess", "permissionRules" }` set

A workspace root with no `workspacePermissions` entry falls back to the global settings
in `globalPermissions`.

## Rules

Each rule is `{ "pattern", "action", "access", "type" }`:

- `pattern` — picomatch glob. `**` is a true globstar only after a slash or at the start
  of the pattern; paths containing a slash need `**/**` (or a concrete prefix), while
  slash-less targets like `out.txt` are covered by `*`.
- `action` — `"allow"` or `"deny"`.
- `access` — optional `"read"` (the effective `defaultAccess`) or `"write"`. A `write`
  rule only applies in a workspace whose root grants write access; in a read-only
  workspace it is denied with a `write-access` reason.
- `type` — optional `"command"` (the effective `defaultType`) or `"redirect"`, selecting
  the family the rule authorizes.

### Rule families

A single `permissionRules` list holds both families. A rule's effective type is its
`type` or the section's `defaultType`: `"command"` rules match **command cores only** —
the command name and arguments, with redirects stripped — while `"redirect"` rules match
**redirect targets only**. The two families never authorize each other.

### Redirects

Redirects default to **deny**: a target with no matching `"redirect"` rule is denied even
when the command is allowed and `defaultPermission` is `"allow"`. Evaluation binds the
redirect mode to a rule tier:

- `output` redirects (`>`, `>>`, `>|`, `&>`, `&>>`, `<>`) require a write-class allow
  redirect rule, additionally gated by workspace write access.
- `input` redirects (`<`) require a read-class allow redirect rule (`access` omitted or
  `"read"`).

Targets are matched **literally**: no `~`, environment-variable, or path resolution, and
`/dev/null` needs an explicit rule. fd-dups (`2>&1`, `>&2`, `<&N`) and heredocs/here-strings
(`<<`, `<<<`) access no file and need no redirect rule.

## Example

```json
{
    "globalPermissions": {
        "defaultPermission": "deny",
        "defaultType": "command",
        "defaultAccess": "read",
        "permissionRules": [
            { "pattern": "git *", "action": "allow" },
            { "pattern": "git push *", "action": "allow", "access": "write" },
            { "pattern": "rm *", "action": "deny" },
            { "pattern": "/tmp/**", "action": "allow", "access": "write", "type": "redirect" }
        ]
    },
    "workspacePermissions": {
        "/path/to/ws-a": {
            "defaultPermission": "allow",
            "defaultType": "command",
            "defaultAccess": "read",
            "permissionRules": [
                { "pattern": "rm *", "action": "deny" },
                { "pattern": "*.log", "action": "allow", "access": "write", "type": "redirect" }
            ]
        }
    }
}
```

A ready-to-copy example lives in [`shell-config.example.json`](../shell-config.example.json).