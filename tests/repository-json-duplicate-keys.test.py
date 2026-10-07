import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent


class DuplicateKeyError(ValueError):
    pass


def reject_duplicate_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateKeyError(f"duplicate object key {key!r}")
        result[key] = value
    return result


def parse_without_duplicate_keys(source):
    return json.loads(source, object_pairs_hook=reject_duplicate_pairs)


try:
    parse_without_duplicate_keys('{"sentinel":1,"sentinel":2}')
except DuplicateKeyError:
    pass
else:
    raise SystemExit("Duplicate-key detector self-test failed")

tracked = subprocess.check_output(
    ["git", "-C", str(ROOT), "ls-files", "-z"],
    text=True,
).split("\0")
json_files = sorted(path for path in tracked if path.endswith(".json"))

if not json_files:
    raise SystemExit("No tracked JSON files found")

for relative in json_files:
    source = (ROOT / relative).read_text(encoding="utf-8")
    try:
        parse_without_duplicate_keys(source)
    except json.JSONDecodeError as error:
        raise SystemExit(f"{relative}: invalid JSON: {error}") from error
    except DuplicateKeyError as error:
        raise SystemExit(f"{relative}: {error}") from error

print(f"Repository JSON duplicate-key contract passed for {len(json_files)} tracked JSON files")
