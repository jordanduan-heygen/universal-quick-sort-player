from __future__ import annotations

import multiprocessing

from quicksortplayer.dev import main


if __name__ == "__main__":
    multiprocessing.freeze_support()
    raise SystemExit(main())
