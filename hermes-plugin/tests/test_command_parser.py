"""Tests for core.command_parser — CommandParser, COMMANDS."""

import pytest

from core.command_parser import CommandParser, COMMANDS


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def parser() -> CommandParser:
    return CommandParser()


# ---------------------------------------------------------------------------
# COMMANDS list
# ---------------------------------------------------------------------------

class TestCommandsList:
    """Verify the COMMANDS constant."""

    def test_commands_count(self) -> None:
        assert len(COMMANDS) == 10

    def test_commands_contains_all_expected(self) -> None:
        expected = [
            "cc", "cc_start", "cc_stop", "cc_status", "cc_answer",
            "cc_approve", "cc_deny", "cc_revert", "cc_context", "cc_mode",
        ]
        assert COMMANDS == expected

    def test_commands_are_unique(self) -> None:
        assert len(COMMANDS) == len(set(COMMANDS))


# ---------------------------------------------------------------------------
# parse — known commands
# ---------------------------------------------------------------------------

class TestParseKnownCommands:
    """parse() returns {"command": ..., "args": ..., "unknown": False} for known commands."""

    def test_cc_with_args(self, parser: CommandParser) -> None:
        result = parser.parse("/cc do something")
        assert result == {"command": "cc", "args": "do something", "unknown": False}

    def test_cc_start_no_args(self, parser: CommandParser) -> None:
        result = parser.parse("/cc_start")
        assert result == {"command": "cc_start", "args": "", "unknown": False}

    def test_cc_approve_with_id(self, parser: CommandParser) -> None:
        result = parser.parse("/cc_approve abc123")
        assert result == {"command": "cc_approve", "args": "abc123", "unknown": False}

    def test_cc_revert_with_flag(self, parser: CommandParser) -> None:
        result = parser.parse("/cc_revert --confirm")
        assert result == {"command": "cc_revert", "args": "--confirm", "unknown": False}

    def test_cc_mode_efficient(self, parser: CommandParser) -> None:
        result = parser.parse("/cc_mode efficient")
        assert result == {"command": "cc_mode", "args": "efficient", "unknown": False}

    def test_cc_mode_strict(self, parser: CommandParser) -> None:
        result = parser.parse("/cc_mode strict")
        assert result == {"command": "cc_mode", "args": "strict", "unknown": False}

    def test_cc_stop_no_args(self, parser: CommandParser) -> None:
        result = parser.parse("/cc_stop")
        assert result == {"command": "cc_stop", "args": "", "unknown": False}

    def test_cc_status_no_args(self, parser: CommandParser) -> None:
        result = parser.parse("/cc_status")
        assert result == {"command": "cc_status", "args": "", "unknown": False}

    def test_cc_answer_with_text(self, parser: CommandParser) -> None:
        result = parser.parse("/cc_answer yes do it")
        assert result == {"command": "cc_answer", "args": "yes do it", "unknown": False}

    def test_cc_deny_with_id(self, parser: CommandParser) -> None:
        result = parser.parse("/cc_deny def456")
        assert result == {"command": "cc_deny", "args": "def456", "unknown": False}

    def test_cc_no_args(self, parser: CommandParser) -> None:
        result = parser.parse("/cc")
        assert result == {"command": "cc", "args": "", "unknown": False}

    def test_cc_context_no_args(self, parser: CommandParser) -> None:
        result = parser.parse("/cc_context")
        assert result == {"command": "cc_context", "args": "", "unknown": False}


# ---------------------------------------------------------------------------
# parse — unknown commands
# ---------------------------------------------------------------------------

class TestParseUnknownCommands:
    """parse() returns {"command": None, "args": ..., "unknown": True} for unknown commands."""

    def test_unknown_cmd(self, parser: CommandParser) -> None:
        result = parser.parse("/unknown_cmd test")
        assert result == {"command": None, "args": "/unknown_cmd test", "unknown": True}

    def test_unknown_cmd_no_args(self, parser: CommandParser) -> None:
        result = parser.parse("/foobar")
        assert result == {"command": None, "args": "/foobar", "unknown": True}

    def test_typo_in_command(self, parser: CommandParser) -> None:
        result = parser.parse("/cc_satrt")
        assert result["unknown"] is True
        assert result["command"] is None


# ---------------------------------------------------------------------------
# parse — invalid / empty input
# ---------------------------------------------------------------------------

class TestParseInvalidInput:
    """parse() returns None for non-slash input, empty string, or None."""

    def test_no_slash(self, parser: CommandParser) -> None:
        result = parser.parse("no slash")
        assert result is None

    def test_empty_string(self, parser: CommandParser) -> None:
        result = parser.parse("")
        assert result is None

    def test_none_input(self, parser: CommandParser) -> None:
        result = parser.parse(None)
        assert result is None

    def test_whitespace_only(self, parser: CommandParser) -> None:
        result = parser.parse("   ")
        assert result is None

    def test_leading_whitespace_with_slash(self, parser: CommandParser) -> None:
        result = parser.parse("  /cc test")
        assert result == {"command": "cc", "args": "test", "unknown": False}

    def test_only_slash(self, parser: CommandParser) -> None:
        result = parser.parse("/")
        assert result == {"command": None, "args": "/", "unknown": True}


# ---------------------------------------------------------------------------
# getCommands
# ---------------------------------------------------------------------------

class TestGetCommands:
    """getCommands() returns the full list of 10 command names."""

    def test_returns_ten_items(self, parser: CommandParser) -> None:
        cmds = parser.getCommands()
        assert len(cmds) == 10

    def test_returns_list(self, parser: CommandParser) -> None:
        cmds = parser.getCommands()
        assert isinstance(cmds, list)

    def test_contains_cc(self, parser: CommandParser) -> None:
        cmds = parser.getCommands()
        assert "cc" in cmds

    def test_returns_copy(self, parser: CommandParser) -> None:
        """Mutating the returned list must not affect the original COMMANDS."""
        cmds = parser.getCommands()
        cmds.append("extra")
        assert len(COMMANDS) == 10


# ---------------------------------------------------------------------------
# getHelpText
# ---------------------------------------------------------------------------

class TestGetHelpText:
    """getHelpText() returns a formatted help string containing all command names."""

    def test_contains_all_command_names(self, parser: CommandParser) -> None:
        help_text = parser.getHelpText()
        for cmd in COMMANDS:
            assert f"/{cmd}" in help_text

    def test_starts_with_header(self, parser: CommandParser) -> None:
        help_text = parser.getHelpText()
        assert help_text.startswith("CC Bridge 命令列表:")

    def test_is_non_empty_string(self, parser: CommandParser) -> None:
        help_text = parser.getHelpText()
        assert isinstance(help_text, str)
        assert len(help_text) > 0

    def test_has_ten_lines_plus_header(self, parser: CommandParser) -> None:
        help_text = parser.getHelpText()
        lines = help_text.strip().split("\n")
        # 1 header line + 10 command lines = 11
        assert len(lines) == 11
