import ast
import sys
from pathlib import Path

errors = []
for py in Path(__file__).resolve().parent.glob("*.py"):
    try:
        ast.parse(py.read_text(encoding="utf-8"))
    except SyntaxError as e:
        errors.append(f"{py.name}:{e.lineno}: {e.msg}")
        print(f"SYNTAX ERROR in {py.name}: {e}")
if errors:
    sys.exit(1)
print(f"SYNTAX OK — checked {len(list(Path(__file__).resolve().parent.glob('*.py')))} files")
sys.exit(0)
