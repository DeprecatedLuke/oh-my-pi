# Interactive Terminal

Runs a command inside a real PTY (TTY) with an interactive floating terminal overlay.

Use this tool when a command needs a real terminal and plain `bash` fails (for example: `sudo`, `ssh`, `docker exec -it`, `vim`, `htop`, password prompts, or full-screen TUIs).

Do not use this for normal non-interactive commands that work with `bash`.

<instruction>
- Use this after seeing TTY-related failures (`stdin is not a tty`, `requires a terminal`, etc.).
- The user can type directly into the overlay while the command runs.
- Pressing `Esc` force-kills the running command and closes the overlay.
- Agent execution is blocked until the interactive command exits or is dismissed.
</instruction>

<input>
```typescript
{
	command: string;      // Command to execute in a PTY
	cwd?: string;         // Working directory (defaults to current cwd)
	timeout?: number;     // Timeout in seconds (optional)
	size?: {              // PTY size override (defaults to ~90% of terminal)
		cols?: number;      // Number of columns
		rows?: number;      // Number of rows
	}
}
```
</input>

<output>
Returns:
- Exit code (or null if terminated)
- Captured stdout text
- Final terminal screen snapshot as plain text fallback
</output>