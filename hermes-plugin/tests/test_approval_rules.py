"""Tests for core.approval_rules — ApprovalRules, has_nested_quantifiers, has_back_reference."""

import textwrap

import pytest
import yaml

from core.approval_rules import ApprovalRules, has_back_reference, has_nested_quantifiers


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_yaml(tmp_path, rules_dict):
    """Write a rules dict to a YAML file and return the path."""
    file_path = tmp_path / "rules.yaml"
    file_path.write_text(yaml.dump(rules_dict, default_flow_style=False), encoding="utf-8")
    return str(file_path)


# ---------------------------------------------------------------------------
# has_nested_quantifiers
# ---------------------------------------------------------------------------


class TestHasNestedQuantifiers:
    """Detect nested quantifiers that cause ReDoS."""

    @pytest.mark.parametrize(
        "pattern",
        [
            "(a+)+",
            "(a*)*",
            "(ab+)+",
            "(a{1,3})+",
            "(a+){2,5}",
            "(x*)+",
        ],
    )
    def test_detects_nested_quantifiers(self, pattern):
        assert has_nested_quantifiers(pattern) is True, f"Should detect nested quantifiers in: {pattern}"

    @pytest.mark.parametrize(
        "pattern",
        [
            "(a+)",
            "(abc)+",
            "a+",
            "a*",
            "(a|b)+",
            "^git ",
            "^rm ",
        ],
    )
    def test_allows_safe_patterns(self, pattern):
        assert has_nested_quantifiers(pattern) is False, f"Should allow safe pattern: {pattern}"


# ---------------------------------------------------------------------------
# has_back_reference
# ---------------------------------------------------------------------------


class TestHasBackReference:
    """Detect back references like \\1, \\2 in regex patterns."""

    @pytest.mark.parametrize(
        "pattern",
        [
            r"\1",
            r"\2",
            r"\9",
            r"(a)\1",
            r"(<tag>).*\1",
        ],
    )
    def test_detects_back_references(self, pattern):
        assert has_back_reference(pattern) is True, f"Should detect back reference in: {pattern}"

    @pytest.mark.parametrize(
        "pattern",
        [
            "^git ",
            "^rm ",
            r"\d+",
            r"\w+",
            "[a-z]+",
            "(abc)+",
        ],
    )
    def test_allows_normal_patterns(self, pattern):
        assert has_back_reference(pattern) is False, f"Should allow normal pattern: {pattern}"


# ---------------------------------------------------------------------------
# ApprovalRules — loading
# ---------------------------------------------------------------------------


class TestApprovalRulesLoading:
    """Test YAML loading, compilation, and safety validation."""

    def test_valid_yaml_loads_correctly(self, tmp_path):
        rules_yaml = {
            "rules": [
                {"tool": "Bash", "command_pattern": "^git ", "action": "auto_approve"},
                {"tool": "Bash", "command_pattern": "^rm ", "action": "require_approval", "sensitive": True},
                {"tool": "Write", "path_pattern": "*.md", "action": "auto_approve"},
                {"tool": "*", "action": "require_approval"},
            ]
        }
        path = _write_yaml(tmp_path, rules_yaml)
        ar = ApprovalRules(path)
        assert len(ar.rules) == 4

    def test_empty_rules_list_loads(self, tmp_path):
        path = _write_yaml(tmp_path, {"rules": []})
        ar = ApprovalRules(path)
        assert ar.rules == []

    def test_rules_key_missing_loads_empty(self, tmp_path):
        path = _write_yaml(tmp_path, {"other_key": "value"})
        ar = ApprovalRules(path)
        assert ar.rules == []

    def test_regex_too_long_raises_value_error(self, tmp_path):
        long_pattern = "a" * 101  # 101 chars > 100 limit
        rules_yaml = {"rules": [{"tool": "Bash", "command_pattern": long_pattern, "action": "auto_approve"}]}
        path = _write_yaml(tmp_path, rules_yaml)
        with pytest.raises(ValueError, match="too long"):
            ApprovalRules(path)

    def test_regex_at_100_chars_is_ok(self, tmp_path):
        pattern_100 = "a" * 100  # exactly at limit
        rules_yaml = {"rules": [{"tool": "Bash", "command_pattern": pattern_100, "action": "auto_approve"}]}
        path = _write_yaml(tmp_path, rules_yaml)
        ar = ApprovalRules(path)
        assert len(ar.rules) == 1

    def test_nested_quantifiers_in_rule_raises_value_error(self, tmp_path):
        rules_yaml = {"rules": [{"tool": "Bash", "command_pattern": "(a+)+", "action": "auto_approve"}]}
        path = _write_yaml(tmp_path, rules_yaml)
        with pytest.raises(ValueError, match="nested quantifiers"):
            ApprovalRules(path)

    def test_back_reference_in_rule_raises_value_error(self, tmp_path):
        rules_yaml = {"rules": [{"tool": "Bash", "command_pattern": r"(a)\1", "action": "auto_approve"}]}
        path = _write_yaml(tmp_path, rules_yaml)
        with pytest.raises(ValueError, match="back references"):
            ApprovalRules(path)

    def test_invalid_regex_raises_value_error(self, tmp_path):
        rules_yaml = {"rules": [{"tool": "Bash", "command_pattern": "[invalid", "action": "auto_approve"}]}
        path = _write_yaml(tmp_path, rules_yaml)
        with pytest.raises(ValueError, match="compilation failed"):
            ApprovalRules(path)

    def test_compiled_regex_stored_on_rule(self, tmp_path):
        rules_yaml = {"rules": [{"tool": "Bash", "command_pattern": "^git ", "action": "auto_approve"}]}
        path = _write_yaml(tmp_path, rules_yaml)
        ar = ApprovalRules(path)
        assert "_compiled_regex" in ar.rules[0]

    def test_no_command_pattern_skips_compilation(self, tmp_path):
        rules_yaml = {"rules": [{"tool": "Write", "path_pattern": "*.md", "action": "auto_approve"}]}
        path = _write_yaml(tmp_path, rules_yaml)
        ar = ApprovalRules(path)
        assert "_compiled_regex" not in ar.rules[0]


# ---------------------------------------------------------------------------
# ApprovalRules — match
# ---------------------------------------------------------------------------


class TestApprovalRulesMatch:
    """Test rule matching logic: tool name, patterns, first-match-wins, defaults."""

    @pytest.fixture()
    def rules(self, tmp_path):
        """Standard rules set for match tests."""
        rules_yaml = {
            "rules": [
                {"tool": "Bash", "command_pattern": "^git ", "action": "auto_approve"},
                {"tool": "Bash", "command_pattern": "^rm ", "action": "require_approval", "sensitive": True},
                {"tool": "Write", "path_pattern": "*.md", "action": "auto_approve"},
                {"tool": "*", "action": "require_approval"},
            ]
        }
        path = _write_yaml(tmp_path, rules_yaml)
        return ApprovalRules(path)

    # -- Exact tool match --

    def test_exact_tool_match(self, rules):
        result = rules.match("Bash", {"command": "git status"})
        assert result["action"] == "auto_approve"

    # -- * wildcard match --

    def test_wildcard_tool_match(self, rules):
        result = rules.match("Read", {})
        # Falls through to the * rule
        assert result["action"] == "require_approval"

    # -- command_pattern regex match --

    def test_command_pattern_regex_match(self, rules):
        result = rules.match("Bash", {"command": "git commit -m 'test'"})
        assert result["action"] == "auto_approve"

    def test_command_pattern_regex_mismatch_skips_rule(self, rules):
        result = rules.match("Bash", {"command": "ls -la"})
        # Does NOT match ^git or ^rm, falls to * rule
        assert result["action"] == "require_approval"

    # -- path_pattern fnmatch --

    def test_path_pattern_fnmatch_match(self, rules):
        result = rules.match("Write", {"filePath": "README.md"})
        assert result["action"] == "auto_approve"

    def test_path_pattern_fnmatch_mismatch_skips_rule(self, rules):
        result = rules.match("Write", {"filePath": "main.py"})
        # Does NOT match *.md, falls to * rule
        assert result["action"] == "require_approval"

    # -- First matching rule wins --

    def test_first_matching_rule_wins(self, rules):
        # "git status" matches both the ^git rule and the * rule,
        # but the ^git rule comes first
        result = rules.match("Bash", {"command": "git status"})
        assert result["action"] == "auto_approve"
        assert result["sensitive"] is False  # ^git rule is not sensitive

    # -- Default when no rules match --

    def test_default_returns_require_approval_when_no_rules_match(self, tmp_path):
        path = _write_yaml(tmp_path, {"rules": []})
        ar = ApprovalRules(path)
        result = ar.match("Bash", {"command": "anything"})
        assert result == {"action": "require_approval", "sensitive": False}

    # -- sensitive flag propagation --

    def test_sensitive_flag_propagation(self, rules):
        result = rules.match("Bash", {"command": "rm -rf /"})
        assert result["action"] == "require_approval"
        assert result["sensitive"] is True

    def test_sensitive_flag_defaults_to_false(self, rules):
        result = rules.match("Bash", {"command": "git status"})
        assert result["sensitive"] is False

    # -- Tool name mismatch skips rule --

    def test_tool_name_mismatch_skips_rule(self, rules):
        # "Write" tool does not match the Bash ^git rule
        result = rules.match("Write", {"command": "git status"})
        # command is set but the tool is Write, so it skips Bash rules
        # and matches *.md or the * rule
        assert result["action"] in ("auto_approve", "require_approval")

    # -- command_pattern mismatch skips rule --

    def test_command_pattern_mismatch_skips_rule(self, rules):
        result = rules.match("Bash", {"command": "echo hello"})
        # Does not match ^git or ^rm, falls to *
        assert result["action"] == "require_approval"
        assert result["sensitive"] is False

    # -- path_pattern mismatch skips rule --

    def test_path_pattern_mismatch_skips_rule(self, rules):
        result = rules.match("Write", {"filePath": "script.sh"})
        assert result["action"] == "require_approval"

    # -- context None defaults to empty dict --

    def test_match_with_none_context(self, rules):
        result = rules.match("Read", None)
        # No command or filePath, falls to * rule
        assert result["action"] == "require_approval"

    # -- command_pattern without context.command skips the check --

    def test_command_pattern_no_command_in_context(self, tmp_path):
        rules_yaml = {
            "rules": [
                {"tool": "Bash", "command_pattern": "^git ", "action": "auto_approve"},
            ]
        }
        path = _write_yaml(tmp_path, rules_yaml)
        ar = ApprovalRules(path)
        # command_pattern exists but context has no command => rule still matches
        # because there is no command to test against
        result = ar.match("Bash", {})
        assert result["action"] == "auto_approve"

    # -- path_pattern without context.filePath skips the check --

    def test_path_pattern_no_filepath_in_context(self, tmp_path):
        rules_yaml = {
            "rules": [
                {"tool": "Write", "path_pattern": "*.md", "action": "auto_approve"},
            ]
        }
        path = _write_yaml(tmp_path, rules_yaml)
        ar = ApprovalRules(path)
        # path_pattern exists but context has no filePath => rule still matches
        result = ar.match("Write", {})
        assert result["action"] == "auto_approve"

    # -- Action defaults to require_approval if not specified --

    def test_action_defaults_to_require_approval(self, tmp_path):
        rules_yaml = {"rules": [{"tool": "Bash"}]}
        path = _write_yaml(tmp_path, rules_yaml)
        ar = ApprovalRules(path)
        result = ar.match("Bash", {})
        assert result["action"] == "require_approval"
