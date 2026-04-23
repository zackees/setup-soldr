"""Guard against missing action helper entrypoints.

This mirrors the static check added in `soldr` after PR #202 exposed a vendored
`ensure_rust_toolchain.py` copy that defined `main()` but never invoked it,
causing the setup action bootstrap to silently no-op before `verify_soldr.py`
failed.
"""

import ast
import re
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
ACTION_YML = REPO_ROOT / "action.yml"
EXPECTED_ENTRYPOINTS = {
    ".github/actions/setup-soldr/resolve_setup.py",
    ".github/actions/setup-soldr/ensure_rust_toolchain.py",
    ".github/actions/setup-soldr/ensure_soldr.py",
    ".github/actions/setup-soldr/verify_soldr.py",
}


def _script_paths_from_action() -> set[str]:
    action = ACTION_YML.read_text(encoding="utf-8")
    return set(
        re.findall(
            r'run:\s+python "\$\{\{\s*github\.action_path\s*\}\}/'
            r'(\.github/actions/setup-soldr/[A-Za-z0-9_]+\.py)"',
            action,
        )
    )


def _is_main_guard(node: ast.If) -> bool:
    test = node.test
    return (
        isinstance(test, ast.Compare)
        and isinstance(test.left, ast.Name)
        and test.left.id == "__name__"
        and len(test.ops) == 1
        and isinstance(test.ops[0], ast.Eq)
        and len(test.comparators) == 1
        and isinstance(test.comparators[0], ast.Constant)
        and test.comparators[0].value == "__main__"
    )


def _node_contains_main_call(node: ast.AST) -> bool:
    return any(
        isinstance(candidate, ast.Call)
        and isinstance(candidate.func, ast.Name)
        and candidate.func.id == "main"
        for candidate in ast.walk(node)
    )


def _contains_main_call(statements: list[ast.stmt]) -> bool:
    for statement in statements:
        if _node_contains_main_call(statement):
            return True
    return False


def test_action_python_entrypoints_match_expected_scripts() -> None:
    assert _script_paths_from_action() == EXPECTED_ENTRYPOINTS


def test_action_python_entrypoints_define_and_invoke_main() -> None:
    for relative_path in sorted(EXPECTED_ENTRYPOINTS):
        module = ast.parse((REPO_ROOT / relative_path).read_text(encoding="utf-8"))
        defines_main = any(
            isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == "main"
            for node in module.body
        )
        guarded_main_call = any(
            isinstance(node, ast.If)
            and _is_main_guard(node)
            and _contains_main_call(node.body)
            for node in module.body
        )

        assert defines_main, f"{relative_path} must define main()"
        assert (
            guarded_main_call
        ), f"{relative_path} must invoke main() under if __name__ == '__main__'"
