"""
The compile lock must protect the BUILD DIRECTORY, not the FQBN.

`_prepare_persistent_project_dir` keys the persistent build dir on
(idf_target, variant). arduino-esp32's boards.txt gives several boards the same
variant — `esp32` and `esp32cam` are both `build.variant=esp32` — so those FQBNs
share one directory. The lock used to be keyed on the FQBN, which left them free
to build in it at the same time.

That is not a theoretical race. Measured against staging: compiling
`esp32:esp32:esp32` and `esp32:esp32:esp32cam` concurrently returned
BYTE-IDENTICAL firmware (same sha256, 285504 bytes) and the esp32cam caller got
the other sketch's binary — verified by embedding a unique marker string in each
sketch and finding the wrong one in the returned image. In the product that
surfaced as a gallery example running someone else's program: open two ESP32
examples in two tabs, and the first tab shows the second's serial log and does
nothing itself.

Run from the repo root:
    python -m pytest test/backend/unit/test_compile_build_lock.py -v
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'backend'))

from app.api.routes import compile as compile_module


class BuildIdentityTests(unittest.TestCase):
    def test_boards_sharing_a_variant_share_one_lock(self):
        """esp32 and esp32cam build in the same dir, so they must serialise."""
        plain = compile_module._target_lock('esp32:esp32:esp32')
        cam = compile_module._target_lock('esp32:esp32:esp32cam')
        self.assertIs(
            plain,
            cam,
            'esp32 and esp32cam share one persistent build dir (both are '
            'build.variant=esp32); handing them different locks lets them '
            'corrupt each other and swap binaries.',
        )

    def test_the_same_board_still_serialises(self):
        self.assertIs(
            compile_module._target_lock('esp32:esp32:esp32'),
            compile_module._target_lock('esp32:esp32:esp32'),
        )

    def test_different_chips_still_run_in_parallel(self):
        """The lock must not become a global one — that would halve throughput."""
        xtensa = compile_module._target_lock('esp32:esp32:esp32')
        riscv = compile_module._target_lock('esp32:esp32:esp32c3')
        self.assertIsNot(
            xtensa,
            riscv,
            'different IDF targets have separate build dirs and should still '
            'compile concurrently up to the semaphore cap.',
        )

    def test_unknown_boards_share_the_default_pair(self):
        """An unrecognised FQBN resolves to the default (esp32, esp32) pair.

        That is not a hole: those compiles genuinely land in the same build dir,
        because the compiler derives the dir from the same two functions. Sharing
        a lock here is the safe direction — serialising more than necessary only
        costs throughput, while serialising less corrupts a build.
        """
        a = compile_module._build_identity('definitely:not:a:board')
        b = compile_module._build_identity('also:not:a:board')
        self.assertEqual(a, b)
        self.assertIs(
            compile_module._target_lock('definitely:not:a:board'),
            compile_module._target_lock('also:not:a:board'),
        )


if __name__ == '__main__':
    unittest.main()
