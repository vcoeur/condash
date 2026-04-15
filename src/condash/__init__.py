"""condash — standalone desktop dashboard for markdown-based conception items."""

from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _pkg_version

try:
    __version__ = _pkg_version("condash")
except PackageNotFoundError:  # pragma: no cover — running from a non-installed checkout
    __version__ = "0.0.0+unknown"
