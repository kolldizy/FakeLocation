"""Location Studio device bridge.

The bridge is the only component that talks to an iPhone. It runs as a child
process of the Electron main process and speaks newline-delimited JSON over
stdin/stdout; it never accepts shell commands and never evaluates input.
"""

__version__ = "1.0.0"

__all__ = ["__version__"]
