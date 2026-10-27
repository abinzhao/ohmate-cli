"""Verify the built OHMate entry in a real POSIX pseudo-terminal."""
import os
import pathlib
import pty
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time

binary = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "packages/cli-wrapper/cli.js").resolve()
with tempfile.TemporaryDirectory(prefix="ohmate-console-pty-") as temporary:
    root = pathlib.Path(temporary).resolve()
    master, slave = pty.openpty()
    environment = dict(os.environ, OHMATE_DATA_DIR=str(root / "data"))
    process = subprocess.Popen(
        [shutil.which("node"), str(binary), "--project", str(root)],
        stdin=slave, stdout=slave, stderr=slave, cwd=root, env=environment,
        start_new_session=True,
    )
    os.close(slave)
    transcript = bytearray()

    def await_text(expected):
        start = len(transcript)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if expected.encode() in transcript[start:]:
                return
            readable, _, _ = select.select([master], [], [], 0.2)
            if readable:
                chunk = os.read(master, 65536)
                if not chunk:
                    break
                transcript.extend(chunk)
        raise AssertionError(f"Terminal did not display {expected!r}: {transcript[start:].decode(errors='replace')}")

    def enter(command, expected):
        os.write(master, (command + "\n").encode())
        await_text(expected)

    def wait_exit(expected):
        deadline = time.monotonic() + 10
        while process.poll() is None and time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    transcript.extend(os.read(master, 65536))
                except OSError:
                    pass
        assert process.poll() == expected, transcript.decode(errors="replace")

    try:
        await_text("ohmate> ")
        enter('/execute model.list {}', '"selected": null')
        enter('/execute task.list {}', "task.list: passed")
        enter('/files main.ts', "files: main.ts")
        enter('/tools workspace.read', "tools: workspace.read")
        enter('/write main.ts', "write: main.ts")
        # No context is sent when generation is blocked without a model.
        (root / "main.ts").write_text("export const value = 1;\n")
        enter("Inspect this project", "MODEL_REQUIRED")
        enter('/execute doctor {}', "PROJECT_INVALID")
        os.write(master, b"/exit\n")
        wait_exit(0)
        os.close(master)
        master, slave = pty.openpty()
        process = subprocess.Popen(
            [shutil.which("node"), str(binary), "agent", "chat"],
            stdin=slave, stdout=slave, stderr=slave, cwd=root, env=environment,
            start_new_session=True,
        )
        os.close(slave)
        transcript.clear()
        await_text("ohmate> ")
        process.send_signal(signal.SIGTERM)
        wait_exit(130)
        print("POSIX PTY passed: default console, native commands, context/tools/write paths, no-model block, project preflight, exit, SIGTERM.")
    finally:
        try:
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
                process.wait(timeout=10)
        finally:
            os.close(master)
