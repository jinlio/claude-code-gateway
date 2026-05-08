"""Pytest configuration for hermes-cc-gateway tests."""

import sys
from pathlib import Path

# Ensure the project root (containing the 'core' package) is on sys.path
# so that `from core.xxx import Yyy` works without installing the package.
PROJECT_ROOT = Path(__file__).resolve().parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

# Prevent pytest from collecting the root __init__.py (which has relative
# imports that fail outside a proper package context).
collect_ignore = ["__init__.py"]
