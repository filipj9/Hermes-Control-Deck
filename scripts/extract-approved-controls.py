from pathlib import Path

from PIL import Image, ImageChops, ImageFilter


OUTPUT = Path(__file__).resolve().parents[1] / "apps" / "web" / "assets"
SOURCE = OUTPUT / "premium-exact-controls-source.png"
PANEL_SOURCE = OUTPUT / "premium-exact-agent-source.png"

# Tight boxes around the approved hardware. Each crop retains the authored
# highlights and bloom while the mask removes the surrounding panel texture.
CONTROLS = {
    "mode": ((64, 40, 305, 297), "octagon", 40),
    "status": ((361, 40, 597, 297), "octagon", 40),
    "new": ((652, 40, 885, 297), "octagon", 40),
    "rate": ((941, 40, 1179, 297), "octagon", 40),
    "run": ((64, 332, 305, 595), "octagon", 40),
    "log": ((361, 332, 597, 595), "octagon", 40),
    "allow": ((652, 332, 885, 595), "octagon", 40),
    "deny": ((941, 332, 1179, 595), "octagon", 40),
    "task": ((64, 630, 305, 884), "octagon", 40),
    "ok": ((361, 630, 597, 884), "octagon", 40),
    "no": ((652, 630, 885, 884), "octagon", 40),
    "open": ((941, 630, 1179, 884), "octagon", 40),
    "prompt": ((51, 912, 598, 1173), "octagon", 45),
    "stop": ((638, 910, 899, 1177), "ellipse", 0),
    "flow": ((935, 912, 1186, 1173), "octagon", 40),
}


def octagon_mask(size: tuple[int, int], cut: int) -> Image.Image:
    width, height = size
    pad = 8
    mask = Image.new("L", size, 0)
    polygon = Image.new("L", size, 0)
    points = [
        (cut, pad),
        (width - cut - 1, pad),
        (width - pad - 1, cut),
        (width - pad - 1, height - cut - 1),
        (width - cut - 1, height - pad - 1),
        (cut, height - pad - 1),
        (pad, height - cut - 1),
        (pad, cut),
    ]
    from PIL import ImageDraw

    ImageDraw.Draw(polygon).polygon(points, fill=255)
    mask.paste(polygon)
    return mask.filter(ImageFilter.GaussianBlur(0.45))


def ellipse_mask(size: tuple[int, int]) -> Image.Image:
    from PIL import ImageDraw

    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).ellipse((4, 4, size[0] - 5, size[1] - 5), fill=255)
    return mask.filter(ImageFilter.GaussianBlur(0.45))


def main() -> None:
    source = Image.open(SOURCE).convert("RGBA")
    OUTPUT.mkdir(parents=True, exist_ok=True)

    for slot, (box, shape, cut) in CONTROLS.items():
        crop = source.crop(box)
        mask = ellipse_mask(crop.size) if shape == "ellipse" else octagon_mask(crop.size, cut)
        crop.putalpha(ImageChops.multiply(crop.getchannel("A"), mask))
        crop.save(OUTPUT / f"premium-exact-{slot}.png", optimize=True)

    panel_sheet = Image.open(PANEL_SOURCE).convert("RGBA")
    panel = panel_sheet.crop((104, 116, 1748, 711))
    from PIL import ImageDraw

    panel_draw = ImageDraw.Draw(panel)
    panel_draw.polygon(
        [
            (82, 64),
            (panel.width - 82, 64),
            (panel.width - 48, 98),
            (panel.width - 48, panel.height - 95),
            (panel.width - 82, panel.height - 61),
            (82, panel.height - 61),
            (48, panel.height - 95),
            (48, 98),
        ],
        fill=(3, 2, 10, 255),
    )
    panel.save(OUTPUT / "premium-exact-agent-frame.png", optimize=True)

    switch = panel_sheet.crop((790, 215, 1056, 591))
    switch.putalpha(octagon_mask(switch.size, 46))
    switch.save(OUTPUT / "premium-exact-agent-switch.png", optimize=True)

    print(f"Extracted {len(CONTROLS)} controls and agent hardware to {OUTPUT}")


if __name__ == "__main__":
    main()
