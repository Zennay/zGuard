import ast
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def tracked_python_files() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    paths = [Path(item.decode("utf-8")) for item in result.stdout.split(b"\0") if item]
    return sorted(path for path in paths if path.suffix == ".py")


def assert_python_syntax(path: Path) -> None:
    source = (ROOT / path).read_text(encoding="utf-8")
    ast.parse(source, filename=path.as_posix(), mode="exec")


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
