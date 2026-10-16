# Development instructions

- Treat this plugin as trusted code running with the daemon user's permissions.
- Use English for agent-to-agent communication. Follow the human's language for replies.
- Preserve runtime boundaries between client, server and shared modules.
- Debug and run checks in isolated Docker containers. Do not mount host daemon state, credentials, home directories or the Docker socket, or publish daemon ports.
- Do not install, reload or enable this plugin on a live daemon without explicit target-specific authorization.
- Keep secrets, runtime configuration, conversation transcripts and local test artifacts out of Git.
- Use built-in file tools for navigation. Do not enable additional code-navigation services implicitly.
- Obtain independent review before delivering behavior changes. Distinguish offline checks, integration checks and live acceptance.
- Before publishing text on the owner's behalf, show the exact final text and destination and obtain explicit approval.
