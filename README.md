# Paseo node sync

Experimental Paseo plugin for explicit, one-way synchronization between paired nodes over SSH.
The UI exposes enrollment, synchronization status, conflicts, history and rollback controls.

Requires Paseo 0.11.1 or later. Only selected items should be enrolled. Review the source and transport configuration before enabling synchronization.

## Status

Development snapshot extracted from an active laboratory worktree, including uncommitted changes.
This is not a stable release. Full acceptance of this exact snapshot is pending.
The laboratory Docker integration harness is maintained separately and is not included in this initial extraction.

## Development

Dependencies are pinned in `package-lock.json`. Use an isolated Docker container with a Node version supporting native TypeScript execution
and your approved package registry. Run `npm run typecheck` and `npm test` in the container.
Do not mount host daemon state, SSH credentials or the Docker socket into a debugging container.

This publication does not install the plugin, enroll items, pair nodes or change any live daemon.
