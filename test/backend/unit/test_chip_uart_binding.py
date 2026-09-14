"""Which UART a custom chip's vx_uart_attach binds to.

The runtime used to send every chip's vx_uart_write to one fixed UART and feed
every chip from that same one, whatever the diagram said. A module wired to
Serial2 therefore heard what the sketch printed on Serial and answered into a
UART nothing was listening on.

`uart_map` is {gpio: uart_id} for the UART pins the diagram wires to the chip,
built in the frontend from the board's UART pin table. The runtime resolves the
chip's own vx_uart_config rx / tx pin handles through pin_map to GPIOs and then
through uart_map to the UART number.

Fixture: the KQ-130F model, a 9600 8N1 module, in test/fixtures/chip-nets.

Run from the repo root:
    pytest test/backend/unit/test_chip_uart_binding.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Ensure backend/ is importable (for direct execution; pytest uses conftest.py)
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'backend'))

pytest.importorskip('wasmtime', reason='chip runtime needs wasmtime')

from app.services.wasm_chip_runtime import CHIP_UART, WasmChipRuntime  # noqa: E402

# The fixture compiler sits next to this file; the unit directory is a
# package, so it is reached by path rather than through pytest's rootdir.
sys.path.insert(0, str(Path(__file__).parent))
from chip_fixtures import chips_available, compiled_chip  # noqa: E402

pytestmark = pytest.mark.skipif(not chips_available(),
                                reason='wasi-sdk not available to compile the chip fixtures')

# The KQ-130F wiring in the xKoin proof: the module's RX is on the board's TX2
# and its TX on the board's RX2. GPIO 17 is TX2 in the ESP32 UART table, GPIO 18
# is a pin the sketch remapped, which is why one end resolving is enough.
PIN_MAP = {'TX': 18, 'RX': 17}


def _runtime(uart_map):
    sent: list[tuple[int, bytes]] = []
    rt = WasmChipRuntime(
        compiled_chip('kq130f'),
        {'label': 'kq130f', 'bit_period_us': 200.0},
        lambda _payload: None,
        pin_map=PIN_MAP,
        uart_writer=lambda uart, data: sent.append((uart, bytes(data))),
        uart_map=uart_map,
    )
    rt.run_chip_setup()
    return rt, sent


def test_binds_to_the_uart_the_diagram_wires():
    rt, _sent = _runtime({17: 2})
    assert rt.uart_config is not None, 'the model did not attach a UART at all'
    assert rt.uart_id == 2


def test_either_end_of_the_pair_resolves_the_same_uart():
    """The chip's RX is on the board's TX and its TX on the board's RX, so a
    map carrying only one of the two still names the right UART."""
    from_rx, _ = _runtime({17: 2})
    from_tx, _ = _runtime({18: 2})
    assert from_rx.uart_id == 2
    assert from_tx.uart_id == 2


def test_falls_back_when_no_wire_resolves():
    """No map at all, and a map for a GPIO this chip is not on. Neither may
    land the chip on UART0, which is the serial monitor on every ESP32."""
    empty, _ = _runtime({})
    unrelated, _ = _runtime({4: 2})
    assert empty.uart_id == CHIP_UART
    assert unrelated.uart_id == CHIP_UART
    assert CHIP_UART != 0


def test_writes_leave_on_the_bound_uart(monkeypatch):
    """A module only writes to its UART when it has decoded a burst off the
    LINE, so this drives a real one: chip A is fed by its host, the frame
    crosses the net, and chip B forwards the payload to the UART it is bound
    to. The models measure edge intervals, hence the virtual clock."""
    from app.services.wasm_chip_runtime import ChipNetBus

    now = [0]
    monkeypatch.setattr(WasmChipRuntime, 'sim_now_nanos', lambda _self: now[0])
    bus = ChipNetBus()

    def _plc(label, base, uart_map):
        sent: list[tuple[int, bytes]] = []
        rt = WasmChipRuntime(
            compiled_chip('kq130f'),
            {'label': label, 'bit_period_us': 200.0, 'line_noise_percent': 0.0},
            lambda _payload: None,
            pin_map={'TX': base, 'RX': base + 1},
            uart_writer=lambda uart, data: sent.append((uart, bytes(data))),
            net_map={'LINE': 'mains'},
            net_bus=bus,
            uart_map=uart_map,
        )
        rt.run_chip_setup()
        return rt, sent

    a_rt, a_sent = _plc('plcA', 10, {11: 2})
    b_rt, b_sent = _plc('plcB', 30, {31: 2})
    assert a_rt.uart_id == 2 and b_rt.uart_id == 2

    msg = b'xkoin plc 1\n'
    for byte in msg:
        a_rt.feed_uart_byte(byte)

    for _ in range(4_000_000):
        if b''.join(d for _u, d in b_sent) == msg:
            break
        deadlines = [d for d in (a_rt.next_timer_deadline(), b_rt.next_timer_deadline())
                     if d is not None]
        if not deadlines:
            break
        now[0] = max(now[0], min(deadlines))
        a_rt.fire_due_timers()
        b_rt.fire_due_timers()

    assert b''.join(d for _u, d in b_sent) == msg, b_sent
    assert {u for u, _d in b_sent} == {2}, b_sent
    assert a_sent == []                 # a module never hears its own burst


def test_a_second_chip_can_sit_on_a_different_uart():
    """Two modules on one board, wired to different UARTs, must not be lumped
    together: the worker dispatches uart_tx by each runtime's uart_id."""
    on_two, _ = _runtime({17: 2})
    on_one, _ = _runtime({17: 1})
    assert on_two.uart_id == 2
    assert on_one.uart_id == 1
