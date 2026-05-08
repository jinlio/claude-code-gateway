"""ApprovalRules — YAML-based approval rule engine with regex safety.

Port of openclaw-plugin/src/core/approval-rules.js.
PyYAML for loading rules; fnmatch for path_pattern matching;
re for command_pattern matching.

See: cc-bridge-v3-final-plan.md Section 4, shared/approval-api.md
"""

import fnmatch
import re
import yaml
from typing import Any


def has_nested_quantifiers(pattern: str) -> bool:
    """Detect nested quantifiers like (a+)+ or (a*)* that cause ReDoS."""
    group_quantifier = re.compile(r"\([^)]*[+*{][^)]*\)[+*{]")
    return bool(group_quantifier.search(pattern))


def has_back_reference(pattern: str) -> bool:
    """Detect back references like \\1, \\2 in regex patterns."""
    return bool(re.search(r"\\[1-9]", pattern))


class ApprovalRules:
    """Load and evaluate approval rules from a YAML file.

    Rules are evaluated in order. First matching rule wins.
    Default action is require_approval (fail-closed).
    """

    def __init__(self, rules_path: str) -> None:
        self.rules: list[dict[str, Any]] = self._load_rules(rules_path)

    def _load_rules(self, file_path: str) -> list[dict[str, Any]]:
        """Load rules from YAML, compile regex, and validate safety constraints."""
        with open(file_path, "r", encoding="utf-8") as fh:
            raw = yaml.safe_load(fh)

        rules = raw.get("rules", [])
        for rule in rules:
            cmd_pattern = rule.get("command_pattern")
            if cmd_pattern:
                if len(cmd_pattern) > 100:
                    raise ValueError(
                        f"Rule regex too long (>100): {cmd_pattern}"
                    )
                if has_nested_quantifiers(cmd_pattern):
                    raise ValueError(
                        f"Rule regex has nested quantifiers: {cmd_pattern}"
                    )
                if has_back_reference(cmd_pattern):
                    raise ValueError(
                        f"Rule regex has back references: {cmd_pattern}"
                    )
                try:
                    rule["_compiled_regex"] = re.compile(cmd_pattern)
                except re.error as exc:
                    raise ValueError(
                        f"Rule regex compilation failed: {exc}"
                    ) from exc

        return rules

    def match(
        self, tool_name: str, context: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Match a tool name and context against the rules list.

        Returns {"action": <action>, "sensitive": <bool>}.
        Default if no rule matches: require_approval, sensitive=False.
        """
        if context is None:
            context = {}

        for rule in self.rules:
            # Tool name must match exactly or via * wildcard
            if rule.get("tool") != tool_name and rule.get("tool") != "*":
                continue

            # command_pattern: regex match against context.command
            cmd_pattern = rule.get("command_pattern")
            if cmd_pattern and context.get("command"):
                compiled = rule.get("_compiled_regex")
                if compiled and not compiled.search(context["command"]):
                    continue

            # path_pattern: fnmatch against context.filePath (glob matching)
            path_pattern = rule.get("path_pattern")
            if path_pattern and context.get("filePath"):
                if not fnmatch.fnmatch(context["filePath"], path_pattern):
                    continue

            return {
                "action": rule.get("action", "require_approval"),
                "sensitive": rule.get("sensitive", False),
            }

        # Default: fail-closed
        return {"action": "require_approval", "sensitive": False}