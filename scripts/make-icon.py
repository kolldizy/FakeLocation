"""Generate ``build/icon.ico`` for the Windows build.

Run once per icon change; the generated ``.ico`` is committed so that
``npm run dist`` never needs this script (or Pillow) on a clean checkout.

    python scripts/make-icon.py

Requires Pillow (``pip install pillow``). This is a build-tooling script, not a
runtime dependency of the app or of the device bridge.
"""

from __future__ import annotations

import pathlib

from PIL import Image, ImageDraw

SIZE = 1024  # drawn at 4x then downsampled, so the committed icon is anti-aliased
OUTPUT = pathlib.Path(__file__).resolve().parent.parent / "build" / "icon.ico"
ICON_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]

BACKGROUND_TOP = (11, 16, 28)
BACKGROUND_BOTTOM = (16, 26, 44)
GRID = (32, 52, 84)
PLATE_EDGE = (46, 78, 120)
CYAN = (111, 224, 255)
ICE = (186, 240, 255)
VIOLET = (138, 122, 255)
MAGENTA = (255, 87, 214)


def vertical_gradient(size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    image = Image.new("RGB", (1, size))
    for y in range(size):
        ratio = y / max(size - 1, 1)
        image.putpixel(
            (0, y),
            tuple(round(top[channel] + (bottom[channel] - top[channel]) * ratio) for channel in range(3)),
        )
    return image.resize((size, size), Image.NEAREST)


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size * 4 - 1, size * 4 - 1), radius=radius * 4, fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def glow(layer: Image.Image, centre: tuple[int, int], radius: int, colour: tuple[int, int, int]) -> None:
    """Paint a soft radial glow by stacking translucent discs."""
    draw = ImageDraw.Draw(layer, "RGBA")
    steps = 28
    for step in range(steps, 0, -1):
        ratio = step / steps
        alpha = int(52 * (1 - ratio) ** 1.6) + 2
        x, y = centre
        r = int(radius * ratio)
        draw.ellipse((x - r, y - r, x + r, y + r), fill=(*colour, alpha))


def build_icon() -> Image.Image:
    base = vertical_gradient(SIZE, BACKGROUND_TOP, BACKGROUND_BOTTOM).convert("RGBA")

    # Faint technical grid, so the plate reads as a "workspace" even at 256px.
    grid = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    grid_draw = ImageDraw.Draw(grid)
    step = SIZE // 16
    for offset in range(step, SIZE, step):
        weight = 1 if offset % (step * 4) else 2
        grid_draw.line((offset, 0, offset, SIZE), fill=(*GRID, 40 if weight == 1 else 70), width=weight)
        grid_draw.line((0, offset, SIZE, offset), fill=(*GRID, 40 if weight == 1 else 70), width=weight)
    base = Image.alpha_composite(base, grid)

    centre = (SIZE // 2, int(SIZE * 0.46))

    # Outer violet halo and cyan crosshair: the "simulation beam" motif.
    aura = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    glow(aura, centre, int(SIZE * 0.40), VIOLET)
    glow(aura, centre, int(SIZE * 0.30), CYAN)
    base = Image.alpha_composite(base, aura)

    draw = ImageDraw.Draw(base, "RGBA")
    ring = int(SIZE * 0.255)
    draw.ellipse(
        (centre[0] - ring, centre[1] - ring, centre[0] + ring, centre[1] + ring),
        outline=(*ICE, 235),
        width=int(SIZE * 0.028),
    )
    tick = int(SIZE * 0.075)
    arm = int(SIZE * 0.022)
    for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        start = (centre[0] + dx * (ring + tick), centre[1] + dy * (ring + tick))
        end = (centre[0] + dx * (ring + tick + arm * 2), centre[1] + dy * (ring + tick + arm * 2))
        draw.line((*start, *end), fill=(*CYAN, 220), width=int(SIZE * 0.024))

    # Location pin: a teardrop with a punched hole, magenta core.
    pin_radius = int(SIZE * 0.135)
    pin_centre = (centre[0], centre[1] - int(SIZE * 0.012))
    tip = (pin_centre[0], pin_centre[1] + int(SIZE * 0.235))
    draw.polygon(
        [
            (pin_centre[0] - pin_radius * 0.72, pin_centre[1] + pin_radius * 0.72),
            (pin_centre[0] + pin_radius * 0.72, pin_centre[1] + pin_radius * 0.72),
            tip,
        ],
        fill=(*ICE, 255),
    )
    draw.ellipse(
        (
            pin_centre[0] - pin_radius,
            pin_centre[1] - pin_radius,
            pin_centre[0] + pin_radius,
            pin_centre[1] + pin_radius,
        ),
        fill=(*ICE, 255),
    )
    hole = int(pin_radius * 0.44)
    draw.ellipse(
        (pin_centre[0] - hole, pin_centre[1] - hole, pin_centre[0] + hole, pin_centre[1] + hole),
        fill=(*MAGENTA, 255),
    )

    # Rim light on the plate edge.
    draw.rounded_rectangle(
        (0, 0, SIZE - 1, SIZE - 1),
        radius=int(SIZE * 0.22),
        outline=(*PLATE_EDGE, 200),
        width=int(SIZE * 0.008),
    )

    base.putalpha(rounded_mask(SIZE, int(SIZE * 0.22)))
    return base


def main() -> None:
    icon = build_icon().resize((256, 256), Image.LANCZOS)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    icon.save(OUTPUT, format="ICO", sizes=ICON_SIZES)
    print(f"wrote {OUTPUT} ({OUTPUT.stat().st_size} bytes, sizes: {ICON_SIZES})")


if __name__ == "__main__":
    main()
