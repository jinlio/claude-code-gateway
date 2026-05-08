"""Hermes-Agent plugin entry point for Claude Code Gateway.

Delegates registration to core.platform_adapter.register().

This file is loaded by the Hermes plugin loader at runtime.
It uses a conditional import to handle both:
  - Runtime: loaded as part of the plugin directory
  - Testing: core is on sys.path via conftest.py
"""

try:
    from core.platform_adapter import register
except ImportError:
    from .core.platform_adapter import register

__all__ = ["register"]
