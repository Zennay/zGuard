import ast
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


PYTHON_SHEBANG = re.compile(rb"^#!.*(?:/|\s)python(?:[0-9.]+)?(?:\s|$)")


def has_python_shebang(path: Path) -> bool:
    first_line = (ROOT / path).open("rb").readline(512).rstrip(b"\r\n")
    return bool(PYTHON_SHEBANG.search(first_line))


def tracked_python_files() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    paths = [Path(item.decode("utf-8")) for item in result.stdout.split(b"\0") if item]
    return sorted(
        path
        for path in paths
        if path.suffix.lower() == ".py" or has_python_shebang(path)
    )


def assert_python_syntax(path: Path) -> None:
    source = (ROOT / path).read_text(encoding="utf-8")
    ast.parse(source, filename=path.as_posix(), mode="exec")


if not PYTHON_SHEBANG.search(b"#!/usr/bin/env python3"):
    raise AssertionError("env Python shebang discovery self-test must pass")
if not PYTHON_SHEBANG.search(b"#!/usr/bin/python3"):
    raise AssertionError("direct Python shebang discovery self-test must pass")
if PYTHON_SHEBANG.search(b"#!/usr/bin/env bash"):
    raise AssertionError("non-Python shebang discovery self-test must stay excluded")

ast.parse("value = 1\nprint(value)\n", filename="self-test-valid.py", mode="exec")
try:
    ast.parse("def broken(:\n    pass\n", filename="self-test-invalid.py", mode="exec")
except SyntaxError:
    pass
else:
    raise AssertionError("self-test-invalid.py must raise SyntaxError")

python_files = tracked_python_files()
if not python_files:
    raise AssertionError("repository must contain tracked Python files")

for python_file in python_files:
    try:
        assert_python_syntax(python_file)
    except SyntaxError as error:
        location = f"{python_file}:{error.lineno or 1}:{error.offset or 1}"
        raise AssertionError(f"{location}: Python syntax error: {error.msg}") from error

print(f"Repository Python syntax contract passed for {len(python_files)} tracked files")
