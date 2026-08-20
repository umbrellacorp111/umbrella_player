import ast
import sys
from pathlib import Path

try:
    with Path(__file__).resolve().with_name('server.py').open('r', encoding='utf-8') as f:
        ast.parse(f.read())
    print('SYNTAX OK')
    sys.exit(0)
except SyntaxError as e:
    print(f'SYNTAX ERROR: {e}')
    sys.exit(1)
